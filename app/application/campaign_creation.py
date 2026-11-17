"""Campaign creation workflow: validation, durable operations and reconciliation."""

import asyncio
import re
import uuid
from typing import Any

from app.application.dto import (
    CampaignCreateDTO,
    CampaignCreationResult,
    ConfiguredResources,
    CreateCampaignCommand,
    StreamCreateDTO,
    StreamFilterInput,
    StreamOfferInput,
)
from app.application.ports import (
    CampaignCreationOperationRepository,
    KeitaroClientPort,
    SettingsRepository,
)
from app.domain.campaign_creation import (
    CampaignCreationOperation,
    OperationStatus,
    is_terminal,
    make_alias,
)


class CampaignInputError(ValueError):
    """Campaign input is invalid or references a missing offer."""


class CampaignConfigurationError(ValueError):
    """Operator configuration is missing or references an unusable resource."""


class OperationNotFoundError(KeyError):
    """No durable operation exists for the requested UUID."""


def _client_error_status(exc: Exception) -> int | None:
    """Read a client error's ``status`` field without importing an adapter."""
    status = getattr(exc, "status", None)
    return status if isinstance(status, int) else None


class CampaignCreationService:
    """Orchestrates campaign creation through application-owned ports."""

    def __init__(
        self,
        client: KeitaroClientPort,
        operations: CampaignCreationOperationRepository,
        settings: SettingsRepository,
        *,
        reconcile_attempts: int = 3,
        page_size: int = 100,
        max_pages: int = 3,
    ):
        """Wire workflow dependencies and bounded reconciliation limits."""
        self._client = client
        self._operations = operations
        self._settings = settings
        self._reconcile_attempts = reconcile_attempts
        self._page_size = page_size
        self._max_pages = max_pages

    async def create(self, command: CreateCampaignCommand) -> CampaignCreationResult:
        """Validate a request, persist a new operation and execute the workflow."""
        name = command.name.strip()
        if not name:
            raise CampaignInputError("campaign name must not be empty")
        country_code = command.country_code.strip().upper()
        if not re.fullmatch(r"[A-Z]{2}", country_code):
            raise CampaignInputError("country_code must be an ISO-2 code")
        if command.offer_id <= 0:
            raise CampaignInputError("offer_id must be positive")

        config = await self._config()
        domain_id, group_id, traffic_source_id = self._required_ids(config)
        await self._verify_offer(command.offer_id)
        await self._verify_resources(config)

        operation_uuid = str(uuid.uuid4())
        operation = await asyncio.to_thread(
            self._operations.add,
            CampaignCreationOperation(
                operation_uuid=operation_uuid,
                alias=make_alias(operation_uuid),
                name=name,
                country_code=country_code,
                offer_id=command.offer_id,
                domain_id=domain_id,
                group_id=group_id,
                traffic_source_id=traffic_source_id,
            ),
        )
        return await self._execute(operation, config.redirect_url)

    async def resume(self, operation_uuid: str) -> CampaignCreationResult:
        """Resume a durable operation without repeating confirmed mutations."""
        operation = await asyncio.to_thread(
            self._operations.get_by_uuid, operation_uuid
        )
        if operation is None:
            raise OperationNotFoundError(f"unknown operation {operation_uuid}")
        if is_terminal(operation.status):
            return self._to_result(operation)
        config = await self._config()
        return await self._execute(operation, config.redirect_url, resuming=True)

    async def _config(self) -> ConfiguredResources:
        """Load operator configuration without blocking the event loop."""
        return await asyncio.to_thread(self._settings.get_config)

    @staticmethod
    def _required_ids(config: ConfiguredResources) -> tuple[int, int, int]:
        """Return configured IDs or reject missing ones before any mutation."""
        values: list[int] = []
        for label, value in (
            ("domain", config.domain_id),
            ("campaign group", config.group_id),
            ("traffic source", config.traffic_source_id),
        ):
            if value is None:
                raise CampaignConfigurationError(f"{label} ID is not configured")
            values.append(value)
        return values[0], values[1], values[2]

    @staticmethod
    def _campaign_id(operation: CampaignCreationOperation) -> int:
        """Return the confirmed campaign ID required for stream steps."""
        if operation.keitaro_campaign_id is None:
            raise RuntimeError("campaign ID is required before stream creation")
        return operation.keitaro_campaign_id

    async def _verify_offer(self, offer_id: int) -> None:
        """Confirm that the selected offer exists in Keitaro."""
        try:
            await self._client.get_offer(offer_id)
        except Exception as exc:
            if _client_error_status(exc) == 404:
                raise CampaignInputError(f"offer {offer_id} does not exist") from exc
            raise

    async def _verify_resources(self, config: ConfiguredResources) -> None:
        """Resolve configured IDs through read-only Keitaro calls."""
        domains = await self._client.list_domains()
        self._require_resource(domains, config.domain_id, "domain")
        groups = await self._client.list_groups("campaigns")
        self._require_resource(groups, config.group_id, "campaign group")
        sources = await self._client.list_traffic_sources()
        self._require_resource(sources, config.traffic_source_id, "traffic source")

    @staticmethod
    def _require_resource(
        items: list[Any], resource_id: int | None, label: str
    ) -> None:
        """Require a matching resource; check state only when the DTO exposes it."""
        match = next((item for item in items if item.id == resource_id), None)
        if match is None:
            raise CampaignConfigurationError(f"{label} {resource_id} not found")
        state = getattr(match, "state", None)
        if state is not None and str(state).lower() != "active":
            raise CampaignConfigurationError(f"{label} {resource_id} is not active")

    async def _save(
        self,
        operation: CampaignCreationOperation,
        status: OperationStatus | None = None,
        error: str | None = None,
    ) -> None:
        """Persist operation state through the synchronous repository port."""
        if status is not None and status is not operation.status:
            operation.transition_to(status, error)
        elif error is not None:
            operation.error_message = error
        await asyncio.to_thread(self._operations.save, operation)

    async def _execute(
        self,
        operation: CampaignCreationOperation,
        redirect_url: str,
        *,
        resuming: bool = False,
    ) -> CampaignCreationResult:
        """Run only the missing steps of a durable operation."""
        if resuming and not await self._precheck(operation):
            return self._to_result(operation)
        if operation.keitaro_campaign_id is None and not await self._create_campaign(
            operation
        ):
            return self._to_result(operation)
        if operation.flow_country_id is None and not await self._create_country_flow(
            operation, redirect_url
        ):
            return self._to_result(operation)
        if operation.flow_offer_id is None and not await self._create_offer_flow(
            operation
        ):
            return self._to_result(operation)
        return await self._verify_and_complete(operation)

    async def _precheck(self, operation: CampaignCreationOperation) -> bool:
        """Reconcile missing steps on resume before considering any new POST."""
        steps = (
            ("campaign", "keitaro_campaign_id"),
            ("country_flow", "flow_country_id"),
            ("offer_flow", "flow_offer_id"),
        )
        allow_zero = operation.status is not OperationStatus.AMBIGUOUS
        for stage, field in steps:
            if getattr(operation, field) is not None:
                continue
            if not await self._recover_resource(
                operation, stage, allow_zero=allow_zero
            ):
                return False
        return True

    async def _recover_resource(
        self,
        operation: CampaignCreationOperation,
        stage: str,
        *,
        allow_zero: bool,
    ) -> bool:
        """Adopt a single reconciled resource; never re-POST an ambiguous step."""
        matches = await self._reconcile(operation, stage)
        if len(matches) == 1:
            self._adopt(operation, stage, matches[0])
            await self._save(
                operation,
                status=OperationStatus.AMBIGUOUS,
                error=f"{stage}: adopted one reconciled resource on resume",
            )
            return True
        if len(matches) > 1 or not allow_zero:
            await self._save(
                operation,
                status=OperationStatus.AMBIGUOUS,
                error=f"{stage}: unresolved on resume ({len(matches)} matches)",
            )
            return False
        return True

    async def _create_campaign(self, operation: CampaignCreationOperation) -> bool:
        """Create the Keitaro campaign with the operation-derived alias."""
        payload = CampaignCreateDTO(
            alias=operation.alias,
            name=operation.name,
            domain_id=operation.domain_id,
            group_id=operation.group_id,
            traffic_source_id=operation.traffic_source_id,
        )
        try:
            campaign = await self._client.create_campaign(payload)
        except Exception as exc:
            return await self._handle_mutation_failure(operation, exc, stage="campaign")
        operation.keitaro_campaign_id = campaign.id
        await self._save(
            operation,
            status=(
                OperationStatus.PARTIAL
                if operation.status is OperationStatus.STARTED
                else None
            ),
        )
        return True

    async def _create_country_flow(
        self, operation: CampaignCreationOperation, redirect_url: str
    ) -> bool:
        """Create the forced GEO flow with the country filter and redirect."""
        payload = StreamCreateDTO(
            campaign_id=self._campaign_id(operation),
            type="forced",
            name=f"{operation.alias}-country",
            schema="redirect",
            action_type="http",
            action_payload=redirect_url,
            filters=[
                StreamFilterInput(
                    name="country", mode="accept", payload=[operation.country_code]
                )
            ],
            comments=operation.operation_uuid,
        )
        try:
            stream = await self._client.create_stream(payload)
        except Exception as exc:
            return await self._handle_mutation_failure(
                operation, exc, stage="country_flow"
            )
        operation.flow_country_id = stream.id
        await self._save(operation)
        return True

    async def _create_offer_flow(self, operation: CampaignCreationOperation) -> bool:
        """Create the default offer flow carrying 100% of the selected offer."""
        payload = StreamCreateDTO(
            campaign_id=self._campaign_id(operation),
            type="default",
            name=f"{operation.alias}-offer",
            schema="landings",
            action_type="http",
            offers=[
                StreamOfferInput(offer_id=operation.offer_id, share=100, state="active")
            ],
            comments=operation.operation_uuid,
        )
        try:
            stream = await self._client.create_stream(payload)
        except Exception as exc:
            return await self._handle_mutation_failure(
                operation, exc, stage="offer_flow"
            )
        operation.flow_offer_id = stream.id
        await self._save(operation)
        return True

    async def _handle_mutation_failure(
        self,
        operation: CampaignCreationOperation,
        exc: Exception,
        *,
        stage: str,
    ) -> bool:
        """Classify a failed mutation without ever blindly retrying it."""
        status = _client_error_status(exc)
        if status is None:
            raise
        if status != 0:
            target = (
                None
                if operation.status is OperationStatus.AMBIGUOUS
                else OperationStatus.FAILED
            )
            await self._save(operation, status=target, error=f"{stage}: {exc}")
            return False

        matches = await self._reconcile(operation, stage)
        if len(matches) == 1:
            self._adopt(operation, stage, matches[0])
            await self._save(
                operation,
                status=OperationStatus.AMBIGUOUS,
                error=f"{stage}: adopted one reconciled resource",
            )
            return True
        await self._save(
            operation,
            status=OperationStatus.AMBIGUOUS,
            error=f"{stage}: outcome ambiguous ({len(matches)} matches)",
        )
        return False

    async def _reconcile(
        self, operation: CampaignCreationOperation, stage: str
    ) -> list[Any]:
        """Run bounded read-only reconciliation for an ambiguous mutation."""
        if stage == "campaign":
            return await self._find_campaigns(operation.alias)
        flow_type = "forced" if stage == "country_flow" else "default"
        if operation.keitaro_campaign_id is None:
            return []
        return await self._find_streams(
            operation.keitaro_campaign_id, operation.operation_uuid, flow_type
        )

    async def _find_campaigns(self, alias: str) -> list[Any]:
        """Find campaigns by alias across bounded pages and attempts."""
        matches: list[Any] = []
        for _ in range(self._reconcile_attempts):
            for page in range(self._max_pages):
                batch = await self._client.list_campaigns(
                    offset=page * self._page_size, limit=self._page_size
                )
                matches.extend(
                    campaign for campaign in batch if campaign.alias == alias
                )
            if matches:
                break
        return matches

    async def _find_streams(
        self, campaign_id: int, marker: str, flow_type: str
    ) -> list[Any]:
        """Find streams by operation marker and expected flow type."""
        matches: list[Any] = []
        for _ in range(self._reconcile_attempts):
            streams = await self._client.list_campaign_streams(campaign_id)
            matches = [
                stream
                for stream in streams
                if stream.comments == marker and stream.type == flow_type
            ]
            if matches:
                break
        return matches

    @staticmethod
    def _adopt(operation: CampaignCreationOperation, stage: str, resource: Any) -> None:
        """Persist the ID of exactly one reconciled remote resource in memory."""
        if stage == "campaign":
            operation.keitaro_campaign_id = resource.id
        elif stage == "country_flow":
            operation.flow_country_id = resource.id
        else:
            operation.flow_offer_id = resource.id

    async def _verify_and_complete(
        self, operation: CampaignCreationOperation
    ) -> CampaignCreationResult:
        """Read back resources before allowing the operation to become created."""
        campaign_id = self._campaign_id(operation)
        try:
            campaign = await self._client.get_campaign(campaign_id)
            streams = await self._client.list_campaign_streams(campaign_id)
        except Exception as exc:
            if _client_error_status(exc) is None:
                raise
            await self._save(
                operation,
                status=(
                    None
                    if operation.status is OperationStatus.AMBIGUOUS
                    else OperationStatus.AMBIGUOUS
                ),
                error=f"readback failed: {exc}",
            )
            return self._to_result(operation)

        country_ok = any(
            stream.id == operation.flow_country_id
            and stream.comments == operation.operation_uuid
            and stream.type == "forced"
            for stream in streams
        )
        offer_ok = any(
            stream.id == operation.flow_offer_id
            and stream.comments == operation.operation_uuid
            and stream.type == "default"
            for stream in streams
        )
        if (
            campaign.id != operation.keitaro_campaign_id
            or campaign.alias != operation.alias
            or not country_ok
            or not offer_ok
        ):
            await self._save(
                operation,
                status=(
                    None
                    if operation.status is OperationStatus.AMBIGUOUS
                    else OperationStatus.AMBIGUOUS
                ),
                error="readback verification failed",
            )
            return self._to_result(operation)

        await self._save(operation, status=OperationStatus.CREATED)
        return self._to_result(operation)

    @staticmethod
    def _to_result(
        operation: CampaignCreationOperation,
    ) -> CampaignCreationResult:
        """Build the public result from the durable operation."""
        return CampaignCreationResult(
            operation_uuid=operation.operation_uuid,
            alias=operation.alias,
            status=operation.status,
            campaign_id=operation.keitaro_campaign_id,
            country_flow_id=operation.flow_country_id,
            offer_flow_id=operation.flow_offer_id,
            error_message=operation.error_message,
        )

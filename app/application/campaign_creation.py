"""Campaign creation workflow: atomic step claims, reconciliation and verification."""

import asyncio
import re
import uuid
from typing import Any

from app.application.dto import (
    CampaignCreateDTO,
    CampaignCreationResult,
    ConfiguredResources,
    CreateCampaignCommand,
    CreateCampaignOutcome,
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
    CreationStage,
    OperationStatus,
    StepState,
    get_step,
    is_terminal,
    make_alias,
    set_step,
)


class CampaignInputError(ValueError):
    """Campaign input is invalid or references a missing offer."""


class CampaignConfigurationError(ValueError):
    """Operator configuration is missing or references an unusable resource."""


class OperationNotFoundError(KeyError):
    """No durable operation exists for the requested UUID."""


class IdempotencyKeyReused(ValueError):
    """An idempotency UUID was already used with different client intent."""

    def __init__(self, operation_uuid: str):
        """Keep the conflicting identity structured."""
        self.operation_uuid = operation_uuid
        super().__init__(f"idempotency key {operation_uuid} was reused")


class IdempotencyKeyConflict(RuntimeError):
    """The operation UUID or derived alias is already reserved by another key."""


def campaign_intent_fingerprint(command: CreateCampaignCommand) -> tuple[str, str, int]:
    """Return the normalized user intent used for idempotency comparison."""
    return (
        command.name.strip(),
        command.country_code.strip().upper(),
        command.offer_id,
    )


def stored_intent_fingerprint(
    operation: CampaignCreationOperation,
) -> tuple[str, str, int]:
    """Return the same fingerprint from a persisted operation."""
    return (operation.name, operation.country_code, operation.offer_id)


def _client_error_status(exc: Exception) -> int | None:
    """Read a client error's ``status`` field without importing an adapter."""
    status = getattr(exc, "status", None)
    return status if isinstance(status, int) else None


def _is_definitive_rejection(status: int | None) -> bool:
    """Treat only explicit 4xx (except timeout/throttling) as a definitive rejection."""
    return status is not None and 400 <= status < 500 and status not in (408, 429)


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
        """Create an operation with a generated UUID (backward-compatible entry)."""
        return (await self.create_idempotent(command, str(uuid.uuid4()))).result

    async def create_idempotent(
        self, command: CreateCampaignCommand, operation_uuid: str
    ) -> CreateCampaignOutcome:
        """Create or replay one durable operation using a client-owned UUID."""
        if type(operation_uuid) is not str or not operation_uuid:
            raise CampaignInputError("operation_uuid must be a non-empty string")
        fingerprint = campaign_intent_fingerprint(command)
        existing = await asyncio.to_thread(self._operations.get_by_uuid, operation_uuid)
        if existing is not None:
            if stored_intent_fingerprint(existing) != fingerprint:
                raise IdempotencyKeyReused(operation_uuid)
            return CreateCampaignOutcome(self._to_result(existing), False)

        (
            name,
            country_code,
            config,
            domain_id,
            group_id,
            traffic_source_id,
        ) = await self._validate_and_preflight(command)
        operation = CampaignCreationOperation(
            operation_uuid=operation_uuid,
            alias=make_alias(operation_uuid),
            name=name,
            country_code=country_code,
            offer_id=command.offer_id,
            domain_id=domain_id,
            group_id=group_id,
            traffic_source_id=traffic_source_id,
            redirect_url=config.redirect_url,
        )
        stored, created = await asyncio.to_thread(
            self._operations.get_or_create, operation
        )
        if not created:
            if stored_intent_fingerprint(stored) != fingerprint:
                raise IdempotencyKeyReused(operation_uuid)
            return CreateCampaignOutcome(self._to_result(stored), False)
        return CreateCampaignOutcome(await self._execute(stored), True)

    async def get(self, operation_uuid: str) -> CampaignCreationResult:
        """Return a durable operation without resuming or mutating it."""
        operation = await asyncio.to_thread(
            self._operations.get_by_uuid, operation_uuid
        )
        if operation is None:
            raise OperationNotFoundError(f"unknown operation {operation_uuid}")
        return self._to_result(operation)

    async def resume(self, operation_uuid: str) -> CampaignCreationResult:
        """Resume a durable operation using its persisted intent, not current config."""
        operation = await asyncio.to_thread(
            self._operations.get_by_uuid, operation_uuid
        )
        if operation is None:
            raise OperationNotFoundError(f"unknown operation {operation_uuid}")
        if is_terminal(operation.status):
            return self._to_result(operation)
        return await self._execute(operation)

    async def _validate_and_preflight(
        self, command: CreateCampaignCommand
    ) -> tuple[str, str, ConfiguredResources, int, int, int]:
        """Validate client intent and read-only config before any durable write."""
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
        return name, country_code, config, domain_id, group_id, traffic_source_id

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
            raise RuntimeError("campaign ID is required before stream steps")
        return operation.keitaro_campaign_id

    @staticmethod
    def _remote_id(
        operation: CampaignCreationOperation, stage: CreationStage
    ) -> int | None:
        """Return the operation's remote ID for one stage."""
        if stage is CreationStage.CAMPAIGN:
            return operation.keitaro_campaign_id
        if stage is CreationStage.COUNTRY_FLOW:
            return operation.flow_country_id
        return operation.flow_offer_id

    @staticmethod
    def _copy_state(
        target: CampaignCreationOperation, source: CampaignCreationOperation
    ) -> None:
        """Adopt freshly loaded state so a stale snapshot cannot overwrite it."""
        target.status = source.status
        target.keitaro_campaign_id = source.keitaro_campaign_id
        target.flow_country_id = source.flow_country_id
        target.flow_offer_id = source.flow_offer_id
        target.error_message = source.error_message
        target.campaign_step = source.campaign_step
        target.country_flow_step = source.country_flow_step
        target.offer_flow_step = source.offer_flow_step

    async def _reload(
        self, operation: CampaignCreationOperation
    ) -> CampaignCreationOperation | None:
        """Load the current durable state through the repository port."""
        return await asyncio.to_thread(
            self._operations.get_by_uuid, operation.operation_uuid
        )

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
        """Persist non-step operation state through the repository port."""
        if status is not None and status is not operation.status:
            operation.transition_to(status, error)
        elif error is not None:
            operation.error_message = error
        saved = await asyncio.to_thread(self._operations.save, operation)
        if saved is not operation:
            self._copy_state(operation, saved)

    async def _execute(
        self, operation: CampaignCreationOperation
    ) -> CampaignCreationResult:
        """Claim or reconcile each step in order; only one worker may POST a step."""
        current = operation
        for stage in CreationStage:
            state = get_step(current, stage)
            if state is StepState.CONFIRMED:
                continue
            if state is StepState.NOT_STARTED:
                if not await self._start_step(current, stage):
                    return self._to_result(current)
            elif not await self._recover_step(current, stage):
                return self._to_result(current)
        return await self._verify_and_complete(current)

    async def _start_step(
        self, operation: CampaignCreationOperation, stage: CreationStage
    ) -> bool:
        """Claim a step; a losing worker reloads and reconciles without mutating."""
        claimed = await asyncio.to_thread(
            self._operations.claim_step, operation.operation_uuid, stage
        )
        if claimed is not None:
            set_step(operation, stage, StepState.IN_FLIGHT)
            return await self._post_and_confirm(operation, stage)
        fresh = await self._reload(operation)
        if fresh is None:
            return False
        self._copy_state(operation, fresh)
        state = get_step(operation, stage)
        if state is StepState.CONFIRMED:
            return True
        if state is StepState.IN_FLIGHT:
            return await self._recover_step(operation, stage)
        return False

    async def _post_and_confirm(
        self, operation: CampaignCreationOperation, stage: CreationStage
    ) -> bool:
        """POST once after an atomic claim, then persist confirmation."""
        try:
            resource = await self._post_step(operation, stage)
        except Exception as exc:
            return await self._handle_step_failure(operation, stage, exc)
        self._adopt(operation, stage, resource)
        set_step(operation, stage, StepState.CONFIRMED)
        target = (
            OperationStatus.PARTIAL
            if stage is CreationStage.CAMPAIGN
            and operation.status is OperationStatus.STARTED
            else None
        )
        confirmed = await asyncio.to_thread(
            self._operations.confirm_step,
            operation.operation_uuid,
            stage,
            remote_id=resource.id,
            status=target,
            error=None,
        )
        if confirmed is None:
            fresh = await self._reload(operation)
            if fresh is None:
                return False
            self._copy_state(operation, fresh)
            return get_step(operation, stage) is StepState.CONFIRMED
        self._copy_state(operation, confirmed)
        return True

    async def _post_step(
        self, operation: CampaignCreationOperation, stage: CreationStage
    ) -> Any:
        """Perform the single mutating request for one step."""
        if stage is CreationStage.CAMPAIGN:
            return await self._client.create_campaign(
                CampaignCreateDTO(
                    alias=operation.alias,
                    name=operation.name,
                    domain_id=operation.domain_id,
                    group_id=operation.group_id,
                    traffic_source_id=operation.traffic_source_id,
                )
            )
        if stage is CreationStage.COUNTRY_FLOW:
            return await self._client.create_stream(
                StreamCreateDTO(
                    campaign_id=self._campaign_id(operation),
                    type="forced",
                    name=f"{operation.alias}-country",
                    schema="redirect",
                    action_type="http",
                    action_payload=operation.redirect_url,
                    filters=[
                        StreamFilterInput(
                            name="country",
                            mode="accept",
                            payload=[operation.country_code],
                        )
                    ],
                    comments=operation.operation_uuid,
                )
            )
        return await self._client.create_stream(
            StreamCreateDTO(
                campaign_id=self._campaign_id(operation),
                type="default",
                name=f"{operation.alias}-offer",
                schema="landings",
                action_type="http",
                offers=[
                    StreamOfferInput(
                        offer_id=operation.offer_id, share=100, state="active"
                    )
                ],
                comments=operation.operation_uuid,
            )
        )

    async def _handle_step_failure(
        self,
        operation: CampaignCreationOperation,
        stage: CreationStage,
        exc: Exception,
    ) -> bool:
        """Classify a failed POST and reconcile only when the outcome is uncertain."""
        status = _client_error_status(exc)
        definitive = _is_definitive_rejection(status)
        if operation.status is OperationStatus.AMBIGUOUS:
            target = None
        elif definitive:
            target = OperationStatus.FAILED
        else:
            target = OperationStatus.AMBIGUOUS
        if definitive:
            error = f"{stage.value}: definitive rejection ({exc})"
        else:
            error = f"{stage.value}: uncertain outcome ({exc})"
        marked = await asyncio.to_thread(
            self._operations.mark_step_ambiguous,
            operation.operation_uuid,
            stage,
            status=target,
            error=error,
        )
        if marked is None:
            fresh = await self._reload(operation)
            if fresh is None:
                return False
            self._copy_state(operation, fresh)
            return get_step(operation, stage) is StepState.CONFIRMED
        self._copy_state(operation, marked)
        if _is_definitive_rejection(status):
            return False
        return await self._recover_step(operation, stage)

    async def _recover_step(
        self, operation: CampaignCreationOperation, stage: CreationStage
    ) -> bool:
        """Reconcile an attempted step; adoption is confirmed only by read-back."""
        matches = await self._reconcile(operation, stage)
        if len(matches) == 1:
            self._adopt(operation, stage, matches[0])
            return await self._verify_step(operation, stage)
        marked = await asyncio.to_thread(
            self._operations.mark_step_ambiguous,
            operation.operation_uuid,
            stage,
            status=(
                None
                if operation.status is OperationStatus.AMBIGUOUS
                else OperationStatus.AMBIGUOUS
            ),
            error=f"{stage.value}: unresolved ({len(matches)})",
        )
        if marked is None:
            fresh = await self._reload(operation)
            if fresh is not None:
                self._copy_state(operation, fresh)
                return get_step(operation, stage) is StepState.CONFIRMED
            return False
        self._copy_state(operation, marked)
        return False

    async def _reconcile(
        self, operation: CampaignCreationOperation, stage: CreationStage
    ) -> list[Any]:
        """Run bounded read-only reconciliation for one attempted step."""
        if stage is CreationStage.CAMPAIGN:
            return await self._find_campaigns(operation.alias)
        if operation.keitaro_campaign_id is None:
            return []
        flow_type = "forced" if stage is CreationStage.COUNTRY_FLOW else "default"
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
    def _adopt(
        operation: CampaignCreationOperation, stage: CreationStage, resource: Any
    ) -> None:
        """Persist the ID of a reconciled or confirmed remote resource in memory."""
        if stage is CreationStage.CAMPAIGN:
            operation.keitaro_campaign_id = resource.id
        elif stage is CreationStage.COUNTRY_FLOW:
            operation.flow_country_id = resource.id
        else:
            operation.flow_offer_id = resource.id

    async def _verify_step(
        self, operation: CampaignCreationOperation, stage: CreationStage
    ) -> bool:
        """Confirm one step's full remote configuration via read-only calls."""
        try:
            if stage is CreationStage.CAMPAIGN:
                campaign = await self._client.get_campaign(self._campaign_id(operation))
                matches = self._campaign_matches(operation, campaign)
            else:
                streams = await self._client.list_campaign_streams(
                    self._campaign_id(operation)
                )
                stream = next(
                    (
                        item
                        for item in streams
                        if item.id == self._remote_id(operation, stage)
                    ),
                    None,
                )
                if stage is CreationStage.COUNTRY_FLOW:
                    matches = stream is not None and self._country_flow_matches(
                        operation, stream
                    )
                else:
                    matches = stream is not None and self._offer_flow_matches(
                        operation, stream
                    )
        except Exception as exc:
            await self._mark_unverified(operation, stage, f"readback failed: {exc}")
            return False
        if not matches:
            await self._mark_unverified(
                operation, stage, "readback verification failed"
            )
            return False
        confirmed = await asyncio.to_thread(
            self._operations.confirm_step,
            operation.operation_uuid,
            stage,
            remote_id=self._remote_id(operation, stage),
            status=None,
            error=None,
        )
        if confirmed is None:
            fresh = await self._reload(operation)
            if fresh is not None:
                self._copy_state(operation, fresh)
            return get_step(operation, stage) is StepState.CONFIRMED
        self._copy_state(operation, confirmed)
        return True

    async def _mark_unverified(
        self,
        operation: CampaignCreationOperation,
        stage: CreationStage,
        error: str,
    ) -> None:
        """Keep an unverified step recoverable without repeating its POST."""
        marked = await asyncio.to_thread(
            self._operations.mark_step_ambiguous,
            operation.operation_uuid,
            stage,
            status=(
                None
                if operation.status is OperationStatus.AMBIGUOUS
                else OperationStatus.AMBIGUOUS
            ),
            error=error,
        )
        if marked is None:
            fresh = await self._reload(operation)
            if fresh is not None:
                self._copy_state(operation, fresh)
        else:
            self._copy_state(operation, marked)
        if operation.status in (
            OperationStatus.CREATED,
            OperationStatus.FAILED,
            OperationStatus.ABANDONED,
        ):
            return
        await self._save(
            operation,
            status=OperationStatus.AMBIGUOUS,
            error=error,
        )

    @staticmethod
    def _campaign_matches(operation: CampaignCreationOperation, campaign: Any) -> bool:
        """Compare a read-back campaign with the persisted operation intent."""
        return (
            campaign.id == operation.keitaro_campaign_id
            and campaign.alias == operation.alias
            and campaign.name == operation.name
            and campaign.domain_id == operation.domain_id
            and campaign.group_id == operation.group_id
            and campaign.traffic_source_id == operation.traffic_source_id
        )

    @staticmethod
    def _country_flow_matches(
        operation: CampaignCreationOperation, stream: Any
    ) -> bool:
        """Compare a read-back GEO flow with the persisted operation intent."""
        filters = list(stream.filters)
        return (
            stream.id == operation.flow_country_id
            and stream.campaign_id == operation.keitaro_campaign_id
            and stream.comments == operation.operation_uuid
            and stream.type == "forced"
            and stream.schema == "redirect"
            and stream.action_type == "http"
            and stream.action_payload == operation.redirect_url
            and len(filters) == 1
            and filters[0].name == "country"
            and filters[0].mode == "accept"
            and list(filters[0].payload) == [operation.country_code]
        )

    @staticmethod
    def _offer_flow_matches(operation: CampaignCreationOperation, stream: Any) -> bool:
        """Compare a read-back offer flow with the persisted operation intent."""
        offers = list(stream.offers)
        return (
            stream.id == operation.flow_offer_id
            and stream.campaign_id == operation.keitaro_campaign_id
            and stream.comments == operation.operation_uuid
            and stream.type == "default"
            and stream.schema == "landings"
            and not stream.filters
            and len(offers) == 1
            and offers[0].offer_id == operation.offer_id
            and offers[0].share == 100
            and offers[0].state == "active"
        )

    async def _verify_and_complete(
        self, operation: CampaignCreationOperation
    ) -> CampaignCreationResult:
        """Verify every step before allowing the created status."""
        for stage in CreationStage:
            if not await self._verify_step(operation, stage):
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

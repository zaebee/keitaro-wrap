"""Unit and mocked workflow tests for Slice 3 campaign creation."""

import asyncio
from dataclasses import replace
from typing import cast

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.application.campaign_creation import (
    CampaignConfigurationError,
    CampaignCreationService,
    CampaignInputError,
    OperationNotFoundError,
)
from app.application.dto import (
    CampaignCreateDTO,
    CampaignDTO,
    ConfiguredResources,
    CreateCampaignCommand,
    DomainDTO,
    GroupDTO,
    OfferDTO,
    OfferStreamDTO,
    StreamCreateDTO,
    StreamDTO,
    StreamFilterDTO,
    TrafficSourceDTO,
)
from app.application.ports import KeitaroClientPort
from app.db.base import Base
from app.db.models import AppSettings
from app.db.repositories import (
    SqlAlchemyCampaignCreationOperations,
    SqlAlchemySettingsRepository,
)
from app.domain.campaign_creation import (
    CampaignCreationOperation,
    CreationStage,
    InvalidOperationTransition,
    OperationStatus,
    StepState,
    get_step,
    is_terminal,
    make_alias,
    set_step,
)
from app.keitaro_client.client import KeitaroError

REDIRECT_A = "https://a.example/redirect"
REDIRECT_B = "https://b.example/redirect"


def config(redirect_url: str = REDIRECT_A) -> ConfiguredResources:
    """Return an operator configuration with a non-default redirect URL."""
    return ConfiguredResources(
        domain_id=1,
        group_id=2,
        traffic_source_id=3,
        redirect_url=redirect_url,
    )


def command() -> CreateCampaignCommand:
    """Return a valid campaign creation command."""
    return CreateCampaignCommand(name=" Test campaign ", country_code="us", offer_id=7)


class FakeClient:
    """Async Keitaro client double recording mutations and readback calls."""

    def __init__(self):
        """Initialize empty remote state and preflight resources."""
        self.domains = [DomainDTO(id=1, name="d", state="active")]
        self.groups = [GroupDTO(id=2, name="g", type="campaigns")]
        self.sources = [TrafficSourceDTO(id=3, name="s", state="active")]
        self.failures: dict[str, Exception] = {}
        self.calls: list[str] = []
        self.group_queries: list[str] = []
        self.create_campaign_calls: list[CampaignCreateDTO] = []
        self.create_stream_calls: list[StreamCreateDTO] = []
        self.list_campaigns_calls = 0
        self.list_streams_calls = 0
        self.campaign_matches: list[CampaignDTO] | None = None
        self.stream_matches: list[StreamDTO] | None = None
        self.campaigns: dict[int, CampaignDTO] = {}
        self.streams: dict[int, list[StreamDTO]] = {}
        self._next_id = 100

    def _next(self) -> int:
        self._next_id += 1
        return self._next_id

    async def list_domains(self):
        """Return configured domains."""
        return self.domains

    async def list_groups(self, gtype: str):
        """Return campaign groups and record the query type."""
        self.group_queries.append(gtype)
        return self.groups

    async def list_traffic_sources(self):
        """Return configured traffic sources."""
        return self.sources

    async def get_offer(self, offer_id: int):
        """Return the selected offer or a configured failure."""
        if "get_offer" in self.failures:
            raise self.failures["get_offer"]
        return OfferDTO(id=offer_id, name="offer")

    async def create_campaign(self, payload: CampaignCreateDTO):
        """Record a campaign POST and apply a configured failure."""
        self.calls.append("create_campaign")
        self.create_campaign_calls.append(payload)
        if "create_campaign" in self.failures:
            raise self.failures["create_campaign"]
        campaign = CampaignDTO(
            id=self._next(),
            name=payload.name,
            alias=payload.alias,
            domain_id=payload.domain_id,
            group_id=payload.group_id,
            traffic_source_id=payload.traffic_source_id,
        )
        self.campaigns[campaign.id] = campaign
        return campaign

    async def list_campaigns(self, offset: int = 0, limit: int = 100):
        """Return a bounded page of alias reconciliation candidates."""
        self.calls.append("list_campaigns")
        self.list_campaigns_calls += 1
        matches = (
            self.campaign_matches
            if self.campaign_matches is not None
            else list(self.campaigns.values())
        )
        return matches[offset : offset + limit]

    async def get_campaign(self, campaign_id: int):
        """Return a stored campaign or a configured readback failure."""
        self.calls.append("get_campaign")
        if "get_campaign" in self.failures:
            raise self.failures["get_campaign"]
        return self.campaigns[campaign_id]

    async def list_campaign_streams(self, campaign_id: int):
        """Return stored streams or a configured readback failure."""
        self.calls.append("list_campaign_streams")
        self.list_streams_calls += 1
        if "list_campaign_streams" in self.failures:
            raise self.failures["list_campaign_streams"]
        return (
            list(self.stream_matches)
            if self.stream_matches is not None
            else list(self.streams.get(campaign_id, []))
        )

    async def create_stream(self, payload: StreamCreateDTO):
        """Record a stream POST and apply a configured step failure."""
        self.calls.append("create_stream")
        self.create_stream_calls.append(payload)
        key = f"create_stream:{len(self.create_stream_calls)}"
        if key in self.failures:
            raise self.failures[key]
        stream = StreamDTO(
            id=self._next(),
            campaign_id=payload.campaign_id,
            type=payload.type,
            name=payload.name,
            schema=payload.schema,
            action_type=payload.action_type,
            action_payload=payload.action_payload,
            filters=[
                StreamFilterDTO(name=f.name, mode=f.mode, payload=list(f.payload))
                for f in payload.filters
            ],
            offers=[
                OfferStreamDTO(offer_id=o.offer_id, share=o.share, state=o.state)
                for o in payload.offers
            ],
            comments=payload.comments,
        )
        self.streams.setdefault(payload.campaign_id, []).append(stream)
        return stream

    async def get_stream(self, stream_id: int):
        """Unused by Slice 3."""
        raise NotImplementedError

    async def update_stream(self, stream_id: int, payload: object):
        """Unused by Slice 3."""
        raise NotImplementedError

    async def delete_stream(self, stream_id: int) -> None:
        """Unused by Slice 3."""
        raise NotImplementedError

    async def list_stream_types(self):
        """Return an empty discovery list."""
        return []

    async def list_stream_schemas(self):
        """Return an empty discovery list."""
        return []

    async def list_stream_filters(self):
        """Return an empty discovery list."""
        return []

    async def list_stream_actions(self):
        """Return an empty discovery list."""
        return []


class FakeOperations:
    """In-memory campaign operation repository."""

    def __init__(self):
        """Initialize empty indexed storage."""
        self.by_uuid: dict[str, CampaignCreationOperation] = {}
        self.by_alias: dict[str, CampaignCreationOperation] = {}
        self.saves: list[tuple[OperationStatus, str | None]] = []

    def add(self, operation: CampaignCreationOperation) -> CampaignCreationOperation:
        """Store a new operation with a generated row id."""
        operation.id = len(self.by_uuid) + 1
        self.by_uuid[operation.operation_uuid] = operation
        self.by_alias[operation.alias] = operation
        return operation

    def get_or_create(
        self, operation: CampaignCreationOperation
    ) -> tuple[CampaignCreationOperation, bool]:
        """Store a new operation or return an existing one."""
        existing = self.get_by_uuid(operation.operation_uuid)
        if existing is not None:
            return existing, False
        return self.add(operation), True

    def get_by_uuid(self, operation_uuid: str) -> CampaignCreationOperation | None:
        """Load by UUID."""
        return self.by_uuid.get(operation_uuid)

    def get_by_alias(self, alias: str) -> CampaignCreationOperation | None:
        """Load by alias."""
        return self.by_alias.get(alias)

    def save(self, operation: CampaignCreationOperation) -> CampaignCreationOperation:
        """Record a persisted state change without regressing terminal status."""
        stored = self.by_uuid.get(operation.operation_uuid)
        if stored is not None:
            terminal = (
                OperationStatus.CREATED,
                OperationStatus.FAILED,
                OperationStatus.ABANDONED,
            )
            if stored.status in terminal and stored.status is not operation.status:
                return replace(stored)
            stored.__dict__.update(operation.__dict__)
        self.saves.append((operation.status, operation.error_message))
        return operation

    def claim_step(
        self, operation_uuid: str, stage: CreationStage
    ) -> CampaignCreationOperation | None:
        """Claim a step only if it is still not_started."""
        entry = self.by_uuid.get(operation_uuid)
        if entry is None or get_step(entry, stage) is not StepState.NOT_STARTED:
            return None
        set_step(entry, stage, StepState.IN_FLIGHT)
        return replace(entry)

    def confirm_step(
        self,
        operation_uuid: str,
        stage: CreationStage,
        *,
        remote_id: int | None,
        status: OperationStatus | None,
        error: str | None,
    ) -> CampaignCreationOperation | None:
        """Confirm a claimed step, idempotently for the same remote ID."""
        entry = self.by_uuid.get(operation_uuid)
        if entry is None:
            return None
        if get_step(entry, stage) is StepState.CONFIRMED:
            stored_id = self._remote_id_for(entry, stage)
            return replace(entry) if stored_id == remote_id else None
        if get_step(entry, stage) not in (StepState.IN_FLIGHT, StepState.AMBIGUOUS):
            return None
        set_step(entry, stage, StepState.CONFIRMED)
        self._set_remote_id(entry, stage, remote_id)
        if status is not None:
            entry.status = status
        if error is not None:
            entry.error_message = error
        return replace(entry)

    def mark_step_ambiguous(
        self,
        operation_uuid: str,
        stage: CreationStage,
        *,
        status: OperationStatus | None,
        error: str | None,
    ) -> CampaignCreationOperation | None:
        """Move a claimed step to ambiguous, never downgrading confirmed."""
        entry = self.by_uuid.get(operation_uuid)
        if entry is None or get_step(entry, stage) not in (
            StepState.IN_FLIGHT,
            StepState.AMBIGUOUS,
        ):
            return None
        set_step(entry, stage, StepState.AMBIGUOUS)
        if status is not None:
            entry.status = status
        if error is not None:
            entry.error_message = error
        return replace(entry)

    @staticmethod
    def _set_remote_id(
        entry: CampaignCreationOperation, stage: CreationStage, remote_id: int | None
    ) -> None:
        """Assign a remote ID to the step's field."""
        if stage is CreationStage.CAMPAIGN:
            entry.keitaro_campaign_id = remote_id
        elif stage is CreationStage.COUNTRY_FLOW:
            entry.flow_country_id = remote_id
        else:
            entry.flow_offer_id = remote_id

    @classmethod
    def _remote_id_for(
        cls, entry: CampaignCreationOperation, stage: CreationStage
    ) -> int | None:
        """Read the remote ID stored for a step."""
        if stage is CreationStage.CAMPAIGN:
            return entry.keitaro_campaign_id
        if stage is CreationStage.COUNTRY_FLOW:
            return entry.flow_country_id
        return entry.flow_offer_id


class IsolatedOperations(FakeOperations):
    """Repository double returning fresh snapshots, like a database round-trip."""

    def get_by_uuid(self, operation_uuid: str) -> CampaignCreationOperation | None:
        """Return a copy so two workers cannot share stale in-memory state."""
        entry = super().get_by_uuid(operation_uuid)
        return replace(entry) if entry is not None else None


class FakeSettings:
    """In-memory settings repository."""

    def __init__(self, resources: ConfiguredResources):
        """Store the returned configuration."""
        self.resources = resources

    def get_config(self) -> ConfiguredResources:
        """Return configured resources."""
        return self.resources


def service(
    client: FakeClient,
    operations: FakeOperations | None = None,
    resources: ConfiguredResources | None = None,
    **kwargs,
) -> CampaignCreationService:
    """Wire a service to test doubles."""
    return CampaignCreationService(
        cast(KeitaroClientPort, client),
        operations or FakeOperations(),
        FakeSettings(resources or config()),
        **kwargs,
    )


def operation(
    *,
    uuid: str = "uuid-1",
    status: OperationStatus = OperationStatus.STARTED,
    campaign_step: StepState = StepState.NOT_STARTED,
    country_step: StepState = StepState.NOT_STARTED,
    offer_step: StepState = StepState.NOT_STARTED,
    campaign_id: int | None = None,
    country_id: int | None = None,
    offer_id: int | None = None,
    redirect_url: str = REDIRECT_A,
) -> CampaignCreationOperation:
    """Build a durable operation with explicit step states."""
    return CampaignCreationOperation(
        operation_uuid=uuid,
        alias=make_alias(uuid),
        name="Test campaign",
        country_code="US",
        offer_id=7,
        domain_id=1,
        group_id=2,
        traffic_source_id=3,
        redirect_url=redirect_url,
        status=status,
        campaign_step=campaign_step,
        country_flow_step=country_step,
        offer_flow_step=offer_step,
        keitaro_campaign_id=campaign_id,
        flow_country_id=country_id,
        flow_offer_id=offer_id,
    )


def remote_campaign(op: CampaignCreationOperation, campaign_id: int) -> CampaignDTO:
    """Build a campaign DTO matching the operation intent."""
    return CampaignDTO(
        id=campaign_id,
        name=op.name,
        alias=op.alias,
        domain_id=op.domain_id,
        group_id=op.group_id,
        traffic_source_id=op.traffic_source_id,
    )


def remote_stream(
    op: CampaignCreationOperation, stage: CreationStage, stream_id: int
) -> StreamDTO:
    """Build a stream DTO matching the operation intent."""
    if op.keitaro_campaign_id is None:
        raise ValueError("campaign id is required for a remote stream")
    if stage is CreationStage.COUNTRY_FLOW:
        return StreamDTO(
            id=stream_id,
            campaign_id=op.keitaro_campaign_id,
            type="forced",
            name=f"{op.alias}-country",
            schema="redirect",
            action_type="http",
            action_payload=op.redirect_url,
            filters=[StreamFilterDTO("country", "accept", [op.country_code])],
            comments=op.operation_uuid,
        )
    return StreamDTO(
        id=stream_id,
        campaign_id=op.keitaro_campaign_id,
        type="default",
        name=f"{op.alias}-offer",
        schema="landings",
        action_type="http",
        offers=[OfferStreamDTO(offer_id=op.offer_id, share=100, state="active")],
        comments=op.operation_uuid,
    )


def register_remote(
    client: FakeClient, op: CampaignCreationOperation, *, campaign_id: int = 10
) -> None:
    """Register fully matching remote resources for readback."""
    op.keitaro_campaign_id = campaign_id
    client.campaigns[campaign_id] = remote_campaign(op, campaign_id)
    if op.flow_country_id is not None:
        client.streams[campaign_id] = [
            remote_stream(op, CreationStage.COUNTRY_FLOW, op.flow_country_id)
        ]
    if op.flow_offer_id is not None:
        client.streams.setdefault(campaign_id, []).append(
            remote_stream(op, CreationStage.OFFER_FLOW, op.flow_offer_id)
        )


def confirm_all(entry: CampaignCreationOperation) -> None:
    """Mark all steps confirmed for readback-only resume tests."""
    for stage in CreationStage:
        set_step(entry, stage, StepState.CONFIRMED)


def test_alias_is_short_and_unique():
    """Alias is deterministic and derived from eight UUID hex characters."""
    assert make_alias("12345678-aaaa-bbbb-cccc-dddddddddddd") == "slug-12345678"
    assert make_alias("abcdef01-aaaa-bbbb-cccc-dddddddddddd") != make_alias(
        "12345678-aaaa-bbbb-cccc-dddddddddddd"
    )


@pytest.mark.parametrize(
    ("source", "target"),
    [
        (OperationStatus.STARTED, OperationStatus.PARTIAL),
        (OperationStatus.PARTIAL, OperationStatus.CREATED),
        (OperationStatus.AMBIGUOUS, OperationStatus.CREATED),
        (OperationStatus.AMBIGUOUS, OperationStatus.ABANDONED),
    ],
)
def test_allowed_transitions(source, target):
    """Documented positive transitions are accepted."""
    entry = operation(status=source)
    entry.transition_to(target)
    assert entry.status is target


@pytest.mark.parametrize(
    "status",
    [OperationStatus.CREATED, OperationStatus.FAILED, OperationStatus.ABANDONED],
)
def test_terminal_statuses(status):
    """Created/failed/abandoned are terminal."""
    assert is_terminal(status)


def test_forbidden_transition():
    """A terminal state cannot move, and failed is not proof of absence."""
    entry = operation(status=OperationStatus.FAILED)
    with pytest.raises(InvalidOperationTransition):
        entry.transition_to(OperationStatus.CREATED)


def test_step_states_are_durable_fields():
    """All creation steps start as not_started and are independently writable."""
    entry = operation()
    assert [get_step(entry, stage) for stage in CreationStage] == [
        StepState.NOT_STARTED
    ] * 3
    set_step(entry, CreationStage.CAMPAIGN, StepState.IN_FLIGHT)
    assert entry.campaign_step is StepState.IN_FLIGHT


@pytest.mark.asyncio
async def test_validation_fails_before_mutation():
    """Bad input and missing configuration never mutate Keitaro."""
    client = FakeClient()

    async def attempt(resources: ConfiguredResources, cmd: CreateCampaignCommand):
        await service(client, resources=resources).create(cmd)

    resources = config()
    bad_name = CreateCampaignCommand("  ", "US", 7)
    bad_country = CreateCampaignCommand("n", "USA", 7)
    missing_config = ConfiguredResources(None, 2, 3, REDIRECT_A)
    valid_command = command()
    with pytest.raises(CampaignInputError):
        await attempt(resources, bad_name)
    with pytest.raises(CampaignInputError):
        await attempt(resources, bad_country)
    with pytest.raises(CampaignConfigurationError):
        await attempt(missing_config, valid_command)
    assert client.calls == []


@pytest.mark.asyncio
async def test_inactive_resource_fails_preflight():
    """An inactive configured resource blocks the operation before mutation."""
    client = FakeClient()
    client.domains = [DomainDTO(id=1, name="d", state="disabled")]

    async def attempt():
        await service(client).create(command())

    with pytest.raises(CampaignConfigurationError, match="not active"):
        await attempt()
    assert client.create_campaign_calls == []


@pytest.mark.asyncio
async def test_missing_offer_fails_preflight():
    """A 404 from the offer lookup is an input error, not an operation failure."""
    client = FakeClient()
    client.failures["get_offer"] = KeitaroError(404, "not found")

    async def attempt():
        await service(client).create(command())

    with pytest.raises(CampaignInputError, match="does not exist"):
        await attempt()
    assert client.create_campaign_calls == []


@pytest.mark.asyncio
async def test_success_sequence_payloads_and_readback():
    """A successful operation creates exactly two approved flows and verifies them."""
    client = FakeClient()
    operations = FakeOperations()
    result = await service(client, operations).create(command())

    assert result.status is OperationStatus.CREATED
    assert result.campaign_id is not None
    assert result.country_flow_id is not None
    assert result.offer_flow_id is not None
    assert client.calls == [
        "create_campaign",
        "create_stream",
        "create_stream",
        "get_campaign",
        "list_campaign_streams",
        "list_campaign_streams",
    ]
    campaign_payload = client.create_campaign_calls[0]
    assert campaign_payload.alias == result.alias
    assert (campaign_payload.domain_id, campaign_payload.group_id) == (1, 2)
    geo, offer = client.create_stream_calls
    assert geo.type == "forced"
    assert geo.schema == "redirect"
    assert geo.action_type == "http"
    assert geo.action_payload == REDIRECT_A
    assert [(f.name, f.mode, f.payload) for f in geo.filters] == [
        ("country", "accept", ["US"])
    ]
    assert offer.type == "default"
    assert offer.schema == "landings"
    assert offer.filters == []
    assert [(o.offer_id, o.share, o.state) for o in offer.offers] == [
        (7, 100, "active")
    ]
    assert geo.comments == offer.comments == result.operation_uuid
    assert client.group_queries == ["campaigns"]
    saved = operations.by_uuid[result.operation_uuid]
    assert [get_step(saved, stage) for stage in CreationStage] == [
        StepState.CONFIRMED
    ] * 3


@pytest.mark.parametrize(
    ("key", "expected_status"),
    [
        ("create_campaign", OperationStatus.FAILED),
        ("create_stream:1", OperationStatus.FAILED),
        ("create_stream:2", OperationStatus.FAILED),
    ],
)
@pytest.mark.asyncio
async def test_definitive_failure_stops_without_retry(key, expected_status):
    """Definitive 4xx errors fail the operation without repeating the POST."""
    client = FakeClient()
    client.failures[key] = KeitaroError(422, "validation")

    result = await service(client).create(command())

    assert result.status is expected_status
    assert result.error_message is not None
    assert client.calls.count("create_campaign") == 1
    assert client.calls.count("create_stream") <= 2


@pytest.mark.asyncio
async def test_alias_conflict_is_definitive():
    """Keitaro's 422 alias uniqueness error is never reconciled into a retry."""
    client = FakeClient()
    client.failures["create_campaign"] = KeitaroError(422, "alias used")

    result = await service(client).create(command())

    assert result.status is OperationStatus.FAILED
    assert "alias" in (result.error_message or "")
    assert client.list_campaigns_calls == 0


@pytest.mark.asyncio
async def test_zero_reconciliation_matches_stays_ambiguous():
    """Zero matches after bounded attempts leave the operation ambiguous."""
    client = FakeClient()
    client.failures["create_campaign"] = KeitaroError(0, "timeout")
    client.campaign_matches = []

    result = await service(client, reconcile_attempts=2, max_pages=2).create(command())

    assert result.status is OperationStatus.AMBIGUOUS
    assert result.campaign_id is None
    assert len(client.create_campaign_calls) == 1
    assert client.list_campaigns_calls == 4
    assert "create_stream" not in client.calls


@pytest.mark.asyncio
async def test_one_campaign_match_is_adopted(monkeypatch):
    """Exactly one alias match is adopted and no duplicate campaign is created."""
    fixed_uuid = "abcdef01-aaaa-bbbb-cccc-dddddddddddd"
    monkeypatch.setattr(
        "app.application.campaign_creation.uuid.uuid4", lambda: fixed_uuid
    )
    client = FakeClient()
    client.failures["create_campaign"] = KeitaroError(0, "timeout")
    entry = operation(uuid=fixed_uuid)
    adopted = remote_campaign(entry, 555)
    client.campaigns[555] = adopted
    client.campaign_matches = [adopted]

    result = await service(client).create(command())

    assert result.status is OperationStatus.CREATED
    assert result.campaign_id == 555
    assert len(client.create_campaign_calls) == 1


@pytest.mark.parametrize("count", [2, 3])
@pytest.mark.asyncio
async def test_multiple_matches_stay_ambiguous(count):
    """Multiple alias matches require operator intervention."""
    client = FakeClient()
    client.failures["create_campaign"] = KeitaroError(0, "timeout")
    entry = operation()
    client.campaign_matches = [remote_campaign(entry, 100 + i) for i in range(count)]

    result = await service(client).create(command())

    assert result.status is OperationStatus.AMBIGUOUS
    assert "create_stream" not in client.calls


@pytest.mark.asyncio
async def test_stream_timeout_zero_matches_stays_ambiguous():
    """An ambiguous flow POST is not retried and blocks the next flow."""
    client = FakeClient()
    client.failures["create_stream:1"] = KeitaroError(0, "timeout")
    client.stream_matches = []

    result = await service(client, reconcile_attempts=2).create(command())

    assert result.status is OperationStatus.AMBIGUOUS
    assert result.country_flow_id is None
    assert client.list_streams_calls == 2
    assert len(client.create_stream_calls) == 1


@pytest.mark.parametrize(
    "failure",
    [
        KeitaroError(200, "malformed response"),
        KeyError("id"),
        KeitaroError(503, "service unavailable"),
    ],
)
@pytest.mark.asyncio
async def test_uncertain_campaign_responses_reconcile_without_retry(
    failure, monkeypatch
):
    """Malformed 2xx, DTO errors and 5xx are uncertain, never proof of absence."""
    fixed_uuid = "abcdef01-aaaa-bbbb-cccc-dddddddddddd"
    monkeypatch.setattr(
        "app.application.campaign_creation.uuid.uuid4", lambda: fixed_uuid
    )
    client = FakeClient()
    client.failures["create_campaign"] = failure
    entry = operation(uuid=fixed_uuid)
    adopted = remote_campaign(entry, 321)
    client.campaigns[321] = adopted
    client.campaign_matches = [adopted]

    result = await service(client).create(command())

    assert result.campaign_id == 321
    assert result.status is OperationStatus.CREATED
    assert len(client.create_campaign_calls) == 1


@pytest.mark.parametrize(
    "failure",
    [KeitaroError(200, "malformed response"), KeyError("campaign_id")],
)
@pytest.mark.asyncio
async def test_uncertain_stream_responses_reconcile_without_retry(failure):
    """Malformed stream responses also reconcile rather than re-POST."""
    client = FakeClient()
    operations = FakeOperations()
    entry = operation(status=OperationStatus.PARTIAL, campaign_id=10)
    set_step(entry, CreationStage.CAMPAIGN, StepState.CONFIRMED)
    register_remote(client, entry)
    operations.add(entry)
    client.failures["create_stream:1"] = failure
    client.stream_matches = [remote_stream(entry, CreationStage.COUNTRY_FLOW, 901)]

    workflow = service(client, operations)
    result = await workflow.resume(entry.operation_uuid)

    assert result.country_flow_id == 901
    assert len(client.create_stream_calls) == 2
    assert [c.type for c in client.create_stream_calls] == ["forced", "default"]


@pytest.mark.parametrize(
    ("stage", "post_count"),
    [
        (CreationStage.CAMPAIGN, 0),
        (CreationStage.COUNTRY_FLOW, 1),
        (CreationStage.OFFER_FLOW, 2),
    ],
)
@pytest.mark.asyncio
async def test_crash_before_post_never_reposts(stage, post_count):
    """An in-flight step with no remote match is never re-POSTed on resume."""
    client = FakeClient()
    operations = FakeOperations()
    entry = operation(status=OperationStatus.AMBIGUOUS)
    entry.keitaro_campaign_id = 10 if stage is not CreationStage.CAMPAIGN else None
    entry.flow_country_id = 20 if stage is CreationStage.OFFER_FLOW else None
    if stage is not CreationStage.CAMPAIGN:
        register_remote(client, entry)
    set_step(entry, stage, StepState.IN_FLIGHT)
    for earlier in list(CreationStage)[: list(CreationStage).index(stage)]:
        set_step(entry, earlier, StepState.CONFIRMED)
    operations.add(entry)
    client.campaign_matches = []
    client.stream_matches = []

    result = await service(client, operations).resume(entry.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS
    assert get_step(entry, stage) is StepState.AMBIGUOUS
    assert client.create_campaign_calls == []
    assert client.create_stream_calls == []


@pytest.mark.parametrize(
    "stage",
    [CreationStage.CAMPAIGN, CreationStage.COUNTRY_FLOW, CreationStage.OFFER_FLOW],
)
@pytest.mark.asyncio
async def test_crash_after_remote_success_adopts_without_repost(stage):
    """Exactly one reconciled match is adopted and verified without a re-POST."""
    client = FakeClient()
    operations = FakeOperations()
    stages = list(CreationStage)
    index = stages.index(stage)
    entry = operation(status=OperationStatus.AMBIGUOUS)
    set_step(entry, stage, StepState.IN_FLIGHT)
    for earlier in stages[:index]:
        set_step(entry, earlier, StepState.CONFIRMED)
    for later in stages[index + 1 :]:
        set_step(entry, later, StepState.CONFIRMED)
    if stage is CreationStage.CAMPAIGN:
        entry.flow_country_id = 20
        entry.flow_offer_id = 30
        register_remote(client, entry, campaign_id=777)
        client.campaign_matches = [remote_campaign(entry, 777)]
    else:
        entry.keitaro_campaign_id = 10
        entry.flow_country_id = 20 if stage is CreationStage.OFFER_FLOW else None
        register_remote(client, entry)
        adopted_id = 901 if stage is CreationStage.COUNTRY_FLOW else 902
        country_id = adopted_id if stage is CreationStage.COUNTRY_FLOW else 20
        offer_id = adopted_id if stage is CreationStage.OFFER_FLOW else 30
        entry.flow_country_id = country_id
        entry.flow_offer_id = offer_id
        client.stream_matches = [
            remote_stream(entry, CreationStage.COUNTRY_FLOW, country_id),
            remote_stream(entry, CreationStage.OFFER_FLOW, offer_id),
        ]
    operations.add(entry)

    result = await service(client, operations).resume(entry.operation_uuid)

    assert get_step(entry, stage) is StepState.CONFIRMED
    assert result.campaign_id == (777 if stage is CreationStage.CAMPAIGN else 10)
    assert client.calls.count("create_campaign") == 0
    assert client.calls.count("create_stream") == 0


@pytest.mark.parametrize(
    "stage",
    [CreationStage.CAMPAIGN, CreationStage.COUNTRY_FLOW, CreationStage.OFFER_FLOW],
)
@pytest.mark.asyncio
async def test_crash_with_multiple_matches_stays_ambiguous(stage):
    """Multiple matches after a crash stay ambiguous and block any mutation."""
    client = FakeClient()
    operations = FakeOperations()
    entry = operation(status=OperationStatus.AMBIGUOUS)
    entry.keitaro_campaign_id = 10 if stage is not CreationStage.CAMPAIGN else None
    entry.flow_country_id = 20 if stage is CreationStage.OFFER_FLOW else None
    if stage is not CreationStage.CAMPAIGN:
        register_remote(client, entry)
    set_step(entry, stage, StepState.IN_FLIGHT)
    for earlier in list(CreationStage)[: list(CreationStage).index(stage)]:
        set_step(entry, earlier, StepState.CONFIRMED)
    if stage is CreationStage.CAMPAIGN:
        client.campaign_matches = [
            remote_campaign(entry, 1),
            remote_campaign(entry, 2),
        ]
    else:
        client.stream_matches = [
            remote_stream(entry, stage, 1),
            remote_stream(entry, stage, 2),
        ]
    operations.add(entry)

    result = await service(client, operations).resume(entry.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS
    assert get_step(entry, stage) is StepState.AMBIGUOUS
    assert "create_campaign" not in client.calls
    assert "create_stream" not in client.calls


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("name", "other"),
        ("alias", "other"),
        ("domain_id", 99),
        ("group_id", 99),
        ("traffic_source_id", 99),
    ],
)
@pytest.mark.asyncio
async def test_campaign_verification_mismatch(field, value):
    """Any campaign configuration mismatch prevents the created status."""
    client = FakeClient()
    operations = FakeOperations()
    entry = operation(
        status=OperationStatus.PARTIAL,
        campaign_id=10,
        country_id=20,
        offer_id=30,
    )
    register_remote(client, entry)
    confirm_all(entry)
    setattr(client.campaigns[10], field, value)
    operations.add(entry)

    result = await service(client, operations).resume(entry.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS
    assert get_step(entry, CreationStage.CAMPAIGN) is StepState.CONFIRMED


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema", "landings"),
        ("action_type", "other"),
        ("action_payload", REDIRECT_B),
        ("type", "default"),
        ("campaign_id", 99),
        ("comments", "other"),
    ],
)
@pytest.mark.asyncio
async def test_country_flow_verification_mismatch(field, value):
    """Any GEO flow configuration mismatch prevents the created status."""
    client = FakeClient()
    operations = FakeOperations()
    entry = operation(
        status=OperationStatus.PARTIAL,
        campaign_id=10,
        country_id=20,
        offer_id=30,
    )
    register_remote(client, entry)
    confirm_all(entry)
    setattr(client.streams[10][0], field, value)
    operations.add(entry)

    result = await service(client, operations).resume(entry.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS
    assert get_step(entry, CreationStage.COUNTRY_FLOW) is StepState.CONFIRMED


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("type", "forced"),
        ("schema", "redirect"),
        ("campaign_id", 99),
        ("comments", "other"),
        ("filters", [StreamFilterDTO("country", "accept", ["US"])]),
    ],
)
@pytest.mark.asyncio
async def test_offer_flow_shape_verification_mismatch(field, value):
    """Offer flow shape or marker mismatch prevents the created status."""
    client = FakeClient()
    operations = FakeOperations()
    entry = operation(
        status=OperationStatus.PARTIAL,
        campaign_id=10,
        country_id=20,
        offer_id=30,
    )
    register_remote(client, entry)
    confirm_all(entry)
    setattr(client.streams[10][1], field, value)
    operations.add(entry)

    result = await service(client, operations).resume(entry.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS
    assert get_step(entry, CreationStage.OFFER_FLOW) is StepState.CONFIRMED


@pytest.mark.parametrize(
    ("field", "value"),
    [("offer_id", 99), ("share", 50), ("state", "disabled")],
)
@pytest.mark.asyncio
async def test_offer_flow_offer_verification_mismatch(field, value):
    """Offer ID/share/state mismatches prevent the created status."""
    client = FakeClient()
    operations = FakeOperations()
    entry = operation(
        status=OperationStatus.PARTIAL,
        campaign_id=10,
        country_id=20,
        offer_id=30,
    )
    register_remote(client, entry)
    confirm_all(entry)
    setattr(client.streams[10][1].offers[0], field, value)
    operations.add(entry)

    result = await service(client, operations).resume(entry.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS


@pytest.mark.asyncio
async def test_filter_mismatch_prevents_created():
    """A wrong country filter prevents the created status."""
    client = FakeClient()
    operations = FakeOperations()
    entry = operation(
        status=OperationStatus.PARTIAL,
        campaign_id=10,
        country_id=20,
        offer_id=30,
    )
    register_remote(client, entry)
    confirm_all(entry)
    client.streams[10][0].filters = [
        StreamFilterDTO("country", "reject", ["US"]),
    ]
    operations.add(entry)

    result = await service(client, operations).resume(entry.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS


@pytest.mark.asyncio
async def test_resume_uses_persisted_redirect_url():
    """A redirect URL change after the attempt does not affect recovery."""
    client = FakeClient()
    operations = FakeOperations()
    settings = FakeSettings(config(REDIRECT_A))
    entry = operation(status=OperationStatus.PARTIAL, campaign_id=10)
    set_step(entry, CreationStage.CAMPAIGN, StepState.CONFIRMED)
    register_remote(client, entry)
    operations.add(entry)
    settings.resources = config(REDIRECT_B)

    workflow = CampaignCreationService(
        cast(KeitaroClientPort, client), operations, settings
    )
    result = await workflow.resume(entry.operation_uuid)

    assert result.status is OperationStatus.CREATED
    assert len(client.create_stream_calls) == 2
    assert client.create_stream_calls[0].action_payload == REDIRECT_A


@pytest.mark.asyncio
async def test_resume_unknown_operation():
    """Resuming an unknown UUID fails explicitly."""

    async def attempt():
        await service(FakeClient()).resume("missing")

    with pytest.raises(OperationNotFoundError):
        await attempt()


@pytest.mark.asyncio
async def test_concurrent_resume_posts_step_once():
    """Two concurrent resumes claim a step once; only one POSTs that step."""
    client = FakeClient()
    operations = IsolatedOperations()
    entry = operation(status=OperationStatus.PARTIAL, campaign_id=10)
    set_step(entry, CreationStage.CAMPAIGN, StepState.CONFIRMED)
    register_remote(client, entry)
    operations.add(entry)
    client.stream_matches = []

    first = service(client, operations)
    second = service(client, operations)
    await asyncio.gather(
        first.resume(entry.operation_uuid),
        second.resume(entry.operation_uuid),
    )

    forced_posts = [c for c in client.create_stream_calls if c.type == "forced"]
    assert len(forced_posts) == 1
    assert client.create_campaign_calls == []


def test_repository_atomic_step_claim(tmp_path):
    """Only one claimant can take a step, and stale saves cannot overwrite it."""
    engine = create_engine(f"sqlite:///{tmp_path / 'claim.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    repository = SqlAlchemyCampaignCreationOperations(factory)
    entry = operation()
    repository.add(entry)

    assert (
        repository.claim_step(entry.operation_uuid, CreationStage.CAMPAIGN) is not None
    )
    assert repository.claim_step(entry.operation_uuid, CreationStage.CAMPAIGN) is None
    stale = replace(entry)
    set_step(stale, CreationStage.CAMPAIGN, StepState.NOT_STARTED)
    repository.save(stale)
    loaded = repository.get_by_uuid(entry.operation_uuid)
    assert loaded is not None
    assert loaded.campaign_step is StepState.IN_FLIGHT

    confirmed = repository.confirm_step(
        entry.operation_uuid,
        CreationStage.CAMPAIGN,
        remote_id=55,
        status=OperationStatus.PARTIAL,
        error=None,
    )
    assert confirmed is not None
    assert confirmed.campaign_step is StepState.CONFIRMED
    assert confirmed.keitaro_campaign_id == 55
    assert repository.claim_step(entry.operation_uuid, CreationStage.CAMPAIGN) is None

    downgraded = repository.mark_step_ambiguous(
        entry.operation_uuid,
        CreationStage.CAMPAIGN,
        status=OperationStatus.AMBIGUOUS,
        error="late failure",
    )
    assert downgraded is None
    stored = repository.get_by_uuid(entry.operation_uuid)
    assert stored is not None
    assert stored.campaign_step is StepState.CONFIRMED
    replaced = repository.confirm_step(
        entry.operation_uuid,
        CreationStage.CAMPAIGN,
        remote_id=99,
        status=None,
        error=None,
    )
    assert replaced is None
    after_replace = repository.get_by_uuid(entry.operation_uuid)
    assert after_replace is not None
    assert after_replace.keitaro_campaign_id == 55
    assert (
        repository.confirm_step(
            entry.operation_uuid,
            CreationStage.CAMPAIGN,
            remote_id=55,
            status=None,
            error=None,
        )
        is not None
    )


def test_stale_save_cannot_overwrite_terminal_status(tmp_path):
    """A stale snapshot cannot move a created operation back to partial."""
    engine = create_engine(f"sqlite:///{tmp_path / 'terminal.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    repository = SqlAlchemyCampaignCreationOperations(factory)
    entry = operation()
    repository.add(entry)
    entry.transition_to(OperationStatus.CREATED)
    repository.save(entry)

    stale = replace(entry)
    stale.status = OperationStatus.PARTIAL
    stale.keitaro_campaign_id = 999
    stale.error_message = "stale error"
    repository.save(stale)

    stored = repository.get_by_uuid(entry.operation_uuid)
    assert stored is not None
    assert stored.status is OperationStatus.CREATED
    assert stored.keitaro_campaign_id is None
    assert stored.error_message is None


@pytest.mark.asyncio
async def test_mark_unverified_cannot_downgrade_confirmed():
    """A stale late failure cannot revert a confirmed step or its status."""
    operations = FakeOperations()
    entry = operation(status=OperationStatus.PARTIAL, campaign_id=10)
    set_step(entry, CreationStage.CAMPAIGN, StepState.CONFIRMED)
    operations.add(entry)
    workflow = service(FakeClient(), operations)

    await workflow._mark_unverified(
        replace(entry), CreationStage.CAMPAIGN, "late failure"
    )

    stored = operations.by_uuid[entry.operation_uuid]
    assert get_step(stored, CreationStage.CAMPAIGN) is StepState.CONFIRMED
    assert stored.status is OperationStatus.AMBIGUOUS
    assert stored.error_message == "late failure"


def test_repository_roundtrip(tmp_path):
    """Operation state, steps and redirect intent survive a repository round-trip."""
    engine = create_engine(f"sqlite:///{tmp_path / 'operations.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    repository = SqlAlchemyCampaignCreationOperations(factory)
    entry = operation()
    set_step(entry, CreationStage.CAMPAIGN, StepState.IN_FLIGHT)

    repository.add(entry)
    loaded = repository.get_by_uuid(entry.operation_uuid)

    assert loaded is not None
    assert loaded.alias == entry.alias
    assert loaded.redirect_url == REDIRECT_A
    assert loaded.campaign_step is StepState.IN_FLIGHT
    assert repository.get_by_alias(entry.alias) is not None
    loaded.transition_to(OperationStatus.PARTIAL)
    loaded.flow_country_id = 42
    repository.save(loaded)
    confirmed = repository.confirm_step(
        loaded.operation_uuid,
        CreationStage.CAMPAIGN,
        remote_id=55,
        status=OperationStatus.PARTIAL,
        error=None,
    )
    reloaded = repository.get_by_uuid(entry.operation_uuid)
    assert reloaded is not None
    assert confirmed is not None
    assert reloaded.flow_country_id == 42
    assert reloaded.keitaro_campaign_id == 55
    assert reloaded.campaign_step is StepState.CONFIRMED


def test_settings_repository_prefers_db_values(tmp_path, monkeypatch):
    """Stored app settings override env defaults; redirect URL comes from settings."""
    engine = create_engine(f"sqlite:///{tmp_path / 'settings.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr("app.db.repositories.settings.KEITARO_DEFAULT_DOMAIN_ID", 99)
    monkeypatch.setattr(
        "app.db.repositories.settings.KEITARO_REDIRECT_URL", "https://env.example"
    )
    with factory() as session:
        session.add(
            AppSettings(
                id=1,
                default_domain_id=11,
                default_group_id=12,
                default_traffic_source_id=13,
            )
        )
        session.commit()

    resources = SqlAlchemySettingsRepository(factory).get_config()

    assert resources.domain_id == 11
    assert resources.traffic_source_id == 13
    assert resources.redirect_url == "https://env.example"

"""Unit and mocked workflow tests for Slice 3 campaign creation."""

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
    ConfiguredResources,
    CreateCampaignCommand,
    StreamCreateDTO,
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
    InvalidOperationTransition,
    OperationStatus,
    is_terminal,
    make_alias,
)
from app.keitaro_client.client import KeitaroError


def config() -> ConfiguredResources:
    """Return an operator configuration with a non-default redirect URL."""
    return ConfiguredResources(
        domain_id=1,
        group_id=2,
        traffic_source_id=3,
        redirect_url="https://example.com/redirect",
    )


def command(
    *,
    name: str = " Test campaign ",
    country_code: str = "us",
    offer_id: int = 7,
) -> CreateCampaignCommand:
    """Return a valid campaign creation command with optional overrides."""
    return CreateCampaignCommand(
        name=name, country_code=country_code, offer_id=offer_id
    )


class DomainStub:
    """Domain/source-like DTO with an id and state."""

    def __init__(self, item_id: int, state: str):
        """Store id and state."""
        self.id = item_id
        self.state = state


class GroupStub:
    """Group DTO without a state field (per observed Keitaro contract)."""

    def __init__(self, group_id: int):
        """Store group id."""
        self.id = group_id


class OfferStub:
    """Offer DTO."""

    def __init__(self, offer_id: int):
        """Store offer id."""
        self.id = offer_id


class CampaignStub:
    """Campaign DTO."""

    def __init__(self, campaign_id: int, name: str, alias: str):
        """Store campaign id, name and alias."""
        self.id = campaign_id
        self.name = name
        self.alias = alias


class StreamStub:
    """Stream DTO built from a create payload or reconciliation data."""

    def __init__(
        self,
        stream_id: int,
        payload: StreamCreateDTO | None = None,
        *,
        stream_type: str = "forced",
        marker: str = "",
    ):
        """Copy the fields the workflow validates on readback."""
        self.id = stream_id
        if payload is None:
            self.campaign_id = 0
            self.type = stream_type
            self.comments = marker
            self.name = "remote"
            self.schema = "landings"
            self.action_type = None
            self.action_payload = None
            self.filters: list[object] = []
            self.offers: list[object] = []
        else:
            self.campaign_id = payload.campaign_id
            self.type = payload.type
            self.comments = payload.comments
            self.name = payload.name
            self.schema = payload.schema
            self.action_type = payload.action_type
            self.action_payload = payload.action_payload
            self.filters = list(payload.filters)
            self.offers = list(payload.offers)


class FakeClient:
    """Async Keitaro client double recording mutations and readback calls."""

    def __init__(self):
        """Initialize empty remote state and preflight resources."""
        self.domains: list[object] = [DomainStub(1, "active")]
        self.groups: list[int] = [2]
        self.sources: list[object] = [DomainStub(3, "active")]
        self.failures: dict[str, Exception] = {}
        self.calls: list[str] = []
        self.group_queries: list[str] = []
        self.create_campaign_calls: list[CampaignCreateDTO] = []
        self.create_stream_calls: list[StreamCreateDTO] = []
        self.list_campaigns_calls = 0
        self.list_streams_calls = 0
        self.campaign_matches: list[object] | None = None
        self.campaigns: dict[int, object] = {}
        self.streams: dict[int, list[object]] = {}
        self._next_id = 100

    def _next_id_value(self) -> int:
        self._next_id += 1
        return self._next_id

    async def list_domains(self):
        """Return configured domains."""
        return self.domains

    async def list_groups(self, gtype: str):
        """Return campaign groups and record the query type."""
        self.group_queries.append(gtype)
        return [GroupStub(group_id) for group_id in self.groups]

    async def list_traffic_sources(self):
        """Return configured traffic sources."""
        return self.sources

    async def get_offer(self, offer_id: int):
        """Return the selected offer or a configured failure."""
        if "get_offer" in self.failures:
            raise self.failures["get_offer"]
        return OfferStub(offer_id)

    async def create_campaign(self, payload: CampaignCreateDTO):
        """Record a campaign POST and apply a configured failure."""
        self.calls.append("create_campaign")
        self.create_campaign_calls.append(payload)
        if "create_campaign" in self.failures:
            raise self.failures["create_campaign"]
        campaign = CampaignStub(self._next_id_value(), payload.name, payload.alias)
        self.campaigns[campaign.id] = campaign
        return campaign

    async def list_campaigns(self, offset: int = 0, limit: int = 100):
        """Return a bounded page of alias reconciliation candidates."""
        self.calls.append("list_campaigns")
        self.list_campaigns_calls += 1
        matches = self.campaign_matches or list(self.campaigns.values())
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
        return list(self.streams.get(campaign_id, []))

    async def create_stream(self, payload: StreamCreateDTO):
        """Record a stream POST and apply a configured step failure."""
        self.calls.append("create_stream")
        self.create_stream_calls.append(payload)
        key = f"create_stream:{len(self.create_stream_calls)}"
        if key in self.failures:
            raise self.failures[key]
        stream = StreamStub(self._next_id_value(), payload)
        self.streams.setdefault(payload.campaign_id, []).append(stream)
        return stream

    async def get_stream(self, stream_id: int):
        """Return a stream placeholder (unused by Slice 3)."""
        raise NotImplementedError

    async def update_stream(self, stream_id: int, payload: object):
        """Update a stream placeholder (unused by Slice 3)."""
        raise NotImplementedError

    async def delete_stream(self, stream_id: int) -> None:
        """Delete a stream placeholder (unused by Slice 3)."""
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

    def register_campaign(self, alias: str, campaign_id: int) -> CampaignStub:
        """Register a remote campaign for reconciliation tests."""
        campaign = CampaignStub(campaign_id, "remote", alias)
        self.campaigns[campaign_id] = campaign
        return campaign

    def register_stream(
        self, campaign_id: int, marker: str, flow_type: str, stream_id: int
    ) -> StreamStub:
        """Register a remote stream for reconciliation tests."""
        stream = StreamStub(stream_id, stream_type=flow_type, marker=marker)
        self.streams.setdefault(campaign_id, []).append(stream)
        return stream


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

    def get_by_uuid(self, operation_uuid: str) -> CampaignCreationOperation | None:
        """Load by UUID."""
        return self.by_uuid.get(operation_uuid)

    def get_by_alias(self, alias: str) -> CampaignCreationOperation | None:
        """Load by alias."""
        return self.by_alias.get(alias)

    def save(self, operation: CampaignCreationOperation) -> CampaignCreationOperation:
        """Record a persisted state change."""
        self.saves.append((operation.status, operation.error_message))
        return operation


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


def pending_operation(
    *, status: OperationStatus = OperationStatus.STARTED, uuid: str = "uuid-1"
) -> CampaignCreationOperation:
    """Build an operation record for validation and resume tests."""
    return CampaignCreationOperation(
        operation_uuid=uuid,
        alias=make_alias(uuid),
        name="n",
        country_code="US",
        offer_id=7,
        domain_id=1,
        group_id=2,
        traffic_source_id=3,
        status=status,
    )


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
    operation = pending_operation(status=source)
    operation.transition_to(target)
    assert operation.status is target


@pytest.mark.parametrize(
    "status",
    [OperationStatus.CREATED, OperationStatus.FAILED, OperationStatus.ABANDONED],
)
def test_terminal_statuses(status):
    """Created/failed/abandoned are terminal."""
    assert is_terminal(status)


def test_forbidden_transition():
    """A terminal state cannot move, and failed is not proof of absence."""
    operation = pending_operation(status=OperationStatus.FAILED)
    with pytest.raises(InvalidOperationTransition):
        operation.transition_to(OperationStatus.CREATED)


@pytest.mark.asyncio
async def test_validation_fails_before_mutation():
    """Bad input and missing configuration never mutate Keitaro."""
    client = FakeClient()

    async def attempt(resources: ConfiguredResources, cmd: CreateCampaignCommand):
        await service(client, resources=resources).create(cmd)

    with pytest.raises(CampaignInputError):
        await attempt(config(), command(name="  "))
    with pytest.raises(CampaignInputError):
        await attempt(config(), command(country_code="USA"))
    with pytest.raises(CampaignConfigurationError):
        await attempt(ConfiguredResources(None, 2, 3, "https://example.com"), command())
    assert client.calls == []


@pytest.mark.asyncio
async def test_inactive_resource_fails_preflight():
    """An inactive configured resource blocks the operation before mutation."""
    client = FakeClient()
    client.domains = [DomainStub(1, "disabled")]

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
    ]
    campaign_payload = client.create_campaign_calls[0]
    assert campaign_payload.alias == result.alias
    assert (campaign_payload.domain_id, campaign_payload.group_id) == (1, 2)
    geo, offer = client.create_stream_calls
    assert geo.type == "forced"
    assert geo.schema == "redirect"
    assert geo.action_type == "http"
    assert geo.action_payload == "https://example.com/redirect"
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
    """Definitive HTTP errors fail the operation without repeating the POST."""
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
    client.campaign_matches = [client.register_campaign(make_alias(fixed_uuid), 555)]

    result = await service(client).create(command())

    assert result.status is OperationStatus.CREATED
    assert result.campaign_id == 555
    assert len(client.create_campaign_calls) == 1


@pytest.mark.asyncio
async def test_multiple_campaign_matches_stay_ambiguous():
    """Multiple alias matches require operator intervention."""
    client = FakeClient()
    client.failures["create_campaign"] = KeitaroError(0, "timeout")
    client.campaign_matches = [
        client.register_campaign("one", 1),
        client.register_campaign("two", 2),
    ]

    result = await service(client).create(command())

    assert result.status is OperationStatus.AMBIGUOUS
    assert "create_stream" not in client.calls


@pytest.mark.asyncio
async def test_stream_timeout_zero_matches_stays_ambiguous():
    """An ambiguous flow POST is not retried and blocks the next flow."""
    client = FakeClient()
    client.failures["create_stream:1"] = KeitaroError(0, "timeout")

    result = await service(client, reconcile_attempts=2).create(command())

    assert result.status is OperationStatus.AMBIGUOUS
    assert result.country_flow_id is None
    assert client.list_streams_calls == 2
    assert len(client.create_stream_calls) == 1


@pytest.mark.asyncio
async def test_one_stream_match_is_adopted():
    """Exactly one reconciled stream is adopted without re-POSTing it."""
    client = FakeClient()
    operations = FakeOperations()
    workflow = service(client, operations)
    client.failures["create_stream:1"] = KeitaroError(0, "timeout")

    result = await workflow.create(command())
    assert result.campaign_id is not None
    client.register_stream(result.campaign_id, result.operation_uuid, "forced", 901)
    resumed = await workflow.resume(result.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS
    assert result.country_flow_id is None
    assert resumed.status is OperationStatus.AMBIGUOUS
    assert resumed.country_flow_id == 901
    assert [c.type for c in client.create_stream_calls] == ["forced"]


@pytest.mark.asyncio
async def test_resume_partial_does_not_repeat_confirmed_steps():
    """Resume creates only the missing flow from a durable partial operation."""
    client = FakeClient()
    operations = FakeOperations()
    operation = pending_operation(status=OperationStatus.PARTIAL)
    operation.keitaro_campaign_id = 10
    operation.flow_country_id = 20
    operations.add(operation)
    client.register_campaign(operation.alias, 10)
    client.register_stream(10, operation.operation_uuid, "forced", 20)

    result = await service(client, operations).resume(operation.operation_uuid)

    assert result.status is OperationStatus.CREATED
    assert result.offer_flow_id is not None
    assert client.create_campaign_calls == []
    assert len(client.create_stream_calls) == 1
    assert client.create_stream_calls[0].type == "default"


@pytest.mark.asyncio
async def test_resume_ambiguous_never_reposts():
    """An ambiguous operation with no confirmed campaign is never re-POSTed."""
    client = FakeClient()
    operations = FakeOperations()
    operation = pending_operation(status=OperationStatus.AMBIGUOUS)
    operations.add(operation)

    result = await service(client, operations).resume(operation.operation_uuid)

    assert result.status is OperationStatus.AMBIGUOUS
    assert client.create_campaign_calls == []
    assert "create_stream" not in client.calls


@pytest.mark.asyncio
async def test_readback_failure_is_ambiguous():
    """A failed readback cannot confirm resources, so the operation stays ambiguous."""
    client = FakeClient()
    client.failures["get_campaign"] = KeitaroError(0, "timeout")

    result = await service(client).create(command())

    assert result.status is OperationStatus.AMBIGUOUS
    assert "readback" in (result.error_message or "")


@pytest.mark.asyncio
async def test_verification_mismatch_is_ambiguous(monkeypatch):
    """A readback campaign with a different alias blocks the created status."""
    client = FakeClient()

    async def wrong_campaign(campaign_id: int):
        return CampaignStub(campaign_id, "n", "wrong-alias")

    monkeypatch.setattr(client, "get_campaign", wrong_campaign)

    result = await service(client).create(command())

    assert result.status is OperationStatus.AMBIGUOUS
    assert "verification" in (result.error_message or "")


@pytest.mark.asyncio
async def test_resume_unknown_operation():
    """Resuming an unknown UUID fails explicitly."""

    async def attempt():
        await service(FakeClient()).resume("missing")

    with pytest.raises(OperationNotFoundError):
        await attempt()


def test_repository_roundtrip(tmp_path):
    """Operation state survives a repository round-trip."""
    engine = create_engine(f"sqlite:///{tmp_path / 'operations.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    repository = SqlAlchemyCampaignCreationOperations(factory)
    operation = pending_operation()

    repository.add(operation)
    loaded = repository.get_by_uuid(operation.operation_uuid)

    assert loaded is not None
    assert loaded.alias == operation.alias
    assert loaded.status is OperationStatus.STARTED
    assert repository.get_by_alias(operation.alias) is not None
    loaded.transition_to(OperationStatus.PARTIAL)
    loaded.flow_country_id = 42
    repository.save(loaded)
    reloaded = repository.get_by_uuid(operation.operation_uuid)
    assert reloaded is not None
    assert reloaded.flow_country_id == 42


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

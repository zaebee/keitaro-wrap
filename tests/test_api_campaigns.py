"""Route-level tests for campaign creation, status and idempotency."""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, cast
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.application.campaign_creation import (
    CampaignConfigurationError,
    CampaignCreationService,
    CampaignInputError,
    IdempotencyKeyConflict,
    IdempotencyKeyReused,
    OperationNotFoundError,
)
from app.application.dto import (
    CampaignCreateDTO,
    CampaignCreationResult,
    CampaignDTO,
    ConfiguredResources,
    CreateCampaignCommand,
    DomainDTO,
    GroupDTO,
    OfferDTO,
    TrafficSourceDTO,
)
from app.application.errors import UpstreamError
from app.application.ports import (
    CampaignCreationOperationRepository,
    KeitaroClientPort,
    SettingsRepository,
)
from app.db.base import Base
from app.db.repositories import SqlAlchemyCampaignCreationOperations
from app.domain.campaign_creation import (
    CampaignCreationOperation,
    OperationStatus,
    make_alias,
)
from tests.api_support import CampaignServiceFake, build_client

OPERATION_UUID = "3f1a3a24-1c0d-4c1a-9c1b-6a1d7e6ef8aa"


class _NoopClient:
    """Read-only preflight fake that records mutating calls."""

    def __init__(self):
        """Track post attempts."""
        self.posts = 0

    async def get_offer(self, offer_id: int):
        """Return a valid offer."""
        return OfferDTO(offer_id, "offer", "active")

    async def list_domains(self):
        """Return a configured domain."""
        return [DomainDTO(1, "domain", "active")]

    async def list_groups(self, gtype: str):
        """Return a configured group."""
        return [GroupDTO(2, "group", "campaigns")]

    async def list_traffic_sources(self):
        """Return a configured source."""
        return [TrafficSourceDTO(3, "source", "active")]

    async def create_campaign(self, payload: CampaignCreateDTO):
        """Record a forbidden mutation in this unit test."""
        self.posts += 1
        return CampaignDTO(1, payload.name, payload.alias)

    async def create_stream(self, payload: Any):
        """Record a forbidden stream mutation."""
        self.posts += 1
        return CampaignDTO(2, payload.name)

    async def get_campaign(self, campaign_id: int):
        """Return a campaign read-back."""
        return CampaignDTO(campaign_id, "campaign")

    async def list_campaign_streams(self, campaign_id: int):
        """Return no streams for this stubbed read."""
        return []


class _Settings:
    """Static operator configuration."""

    def get_config(self):
        """Return complete configuration."""
        return ConfiguredResources(1, 2, 3, "https://example.test")


class _RacingOperations:
    """Fake repository forcing both idempotency lookups to miss together."""

    def __init__(self, winner_offer_id: int):
        """Choose which intent wins the simulated unique-constraint race."""
        self.winner_offer_id = winner_offer_id
        self.barrier = threading.Barrier(2)
        self.condition = threading.Condition()
        self.winner: CampaignCreationOperation | None = None

    def get_by_uuid(self, operation_uuid: str) -> CampaignCreationOperation | None:
        """Force both callers past the initial lookup before either inserts."""
        self.barrier.wait(timeout=2)
        return None

    def get_or_create(
        self, operation: CampaignCreationOperation
    ) -> tuple[CampaignCreationOperation, bool]:
        """Return one winner and a fingerprint-bearing loser."""
        with self.condition:
            if operation.offer_id == self.winner_offer_id:
                self.winner = operation
                self.condition.notify_all()
                return operation, True
            while self.winner is None:
                self.condition.wait(timeout=2)
            return self.winner, False


@pytest.mark.asyncio
async def test_create_returns_201_with_location_for_new_operation():
    """The winning creation call gets 201 and a stable Location header."""
    fake = CampaignServiceFake()
    async with build_client(campaign=fake) as client:
        response = await client.post(
            "/campaign-creations",
            json={
                "operation_uuid": OPERATION_UUID,
                "name": "Campaign",
                "country_code": "us",
                "offer_id": 7,
            },
        )
    assert response.status_code == 201
    assert response.headers["location"] == f"/campaign-creations/{OPERATION_UUID}"
    assert response.json()["status"] == "started"
    assert fake.calls[0][2] == OPERATION_UUID


@pytest.mark.asyncio
async def test_create_replay_returns_200_without_location():
    """A same-UUID/same-intent replay is a plain 200."""
    fake = CampaignServiceFake(created=False)
    async with build_client(campaign=fake) as client:
        response = await client.post(
            "/campaign-creations",
            json={
                "operation_uuid": OPERATION_UUID,
                "name": "Campaign",
                "country_code": "US",
                "offer_id": 7,
            },
        )
    assert response.status_code == 200
    assert "location" not in response.headers


@pytest.mark.asyncio
async def test_resume_and_get_return_200():
    """Read and explicit resume both complete synchronously with 200."""
    fake = CampaignServiceFake(
        result=CampaignCreationResult(
            operation_uuid=OPERATION_UUID,
            alias="slug-abcdef12",
            status=OperationStatus.CREATED,
        )
    )
    async with build_client(campaign=fake) as client:
        resumed = await client.post(f"/campaign-creations/{OPERATION_UUID}/resume")
        read = await client.get(f"/campaign-creations/{OPERATION_UUID}")
    assert resumed.status_code == 200
    assert read.status_code == 200
    assert [call[0] for call in fake.calls] == ["resume", "get"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (IdempotencyKeyReused(OPERATION_UUID), 409, "IDEMPOTENCY_KEY_REUSED"),
        (
            IdempotencyKeyConflict("alias reserved"),
            409,
            "IDEMPOTENCY_KEY_CONFLICT",
        ),
        (CampaignInputError("bad input"), 422, "CAMPAIGN_INPUT_REJECTED"),
        (CampaignConfigurationError("no group"), 409, "CAMPAIGN_CONFIGURATION_INVALID"),
        (UpstreamError(502, "upstream"), 502, "KEITARO_UPSTREAM_FAILURE"),
    ],
)
async def test_campaign_errors_are_mapped_with_stable_codes(error, status, code):
    """Application errors become stable structured HTTP errors."""
    fake = CampaignServiceFake(error=error)
    async with build_client(campaign=fake) as client:
        response = await client.post(
            "/campaign-creations",
            json={
                "operation_uuid": OPERATION_UUID,
                "name": "Campaign",
                "country_code": "us",
                "offer_id": 7,
            },
        )
    assert response.status_code == status
    body = response.json()["error"]
    assert body["code"] == code
    assert isinstance(body["details"], dict)


@pytest.mark.asyncio
async def test_campaign_shape_validation_is_transport_level():
    """Invalid UUID and boolean share-like values are rejected before service calls."""
    fake = CampaignServiceFake()
    async with build_client(campaign=fake) as client:
        response = await client.post(
            "/campaign-creations",
            json={
                "operation_uuid": "not-a-uuid",
                "name": "Campaign",
                "country_code": "us",
                "offer_id": 7,
            },
        )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert fake.calls == []


@pytest.mark.asyncio
async def test_missing_operation_is_404():
    """An unknown durable operation is reported as a structured 404."""
    fake = CampaignServiceFake(error=OperationNotFoundError("missing"))
    async with build_client(campaign=fake) as client:
        response = await client.get(f"/campaign-creations/{OPERATION_UUID}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "OPERATION_NOT_FOUND"


@pytest.mark.asyncio
@pytest.mark.parametrize("winner_offer_id", [100, 200])
async def test_concurrent_same_uuid_executes_one_workflow(monkeypatch, winner_offer_id):
    """A losing insert never runs the workflow and sees the winner's fingerprint."""
    executions: list[int] = []

    async def fake_execute(self, operation):
        """Record which operation won execution."""
        executions.append(operation.offer_id)
        return self._to_result(operation)

    monkeypatch.setattr(CampaignCreationService, "_execute", fake_execute)
    service = CampaignCreationService(
        cast(KeitaroClientPort, _NoopClient()),
        cast(CampaignCreationOperationRepository, _RacingOperations(winner_offer_id)),
        cast(SettingsRepository, _Settings()),
    )
    results = await asyncio.gather(
        service.create_idempotent(
            CreateCampaignCommand("Campaign", "us", 100), OPERATION_UUID
        ),
        service.create_idempotent(
            CreateCampaignCommand("Campaign", "us", 200), OPERATION_UUID
        ),
        return_exceptions=True,
    )
    assert executions == [winner_offer_id]
    assert (
        sum(
            1
            for item in results
            if not isinstance(item, BaseException) and item.created
        )
        == 1
    )
    assert sum(isinstance(item, IdempotencyKeyReused) for item in results) == 1


@pytest.mark.parametrize("winner_offer_id", [100, 200])
def test_repository_unique_race_reuses_winner_after_rollback(tmp_path, winner_offer_id):
    """A real UNIQUE loser rolls back and re-reads the winner through a new session."""
    engine = create_engine(f"sqlite:///{tmp_path / 'ops.db'}")
    Base.metadata.create_all(engine)

    class TrackingSession(Session):
        """Record rollback and creation order for the repository race."""

        def __init__(self, *args: Any, **kwargs: Any):
            """Track this session in creation order."""
            super().__init__(*args, **kwargs)
            self.rollback_count = 0
            created_sessions.append(self)

        def rollback(self):
            """Record a real rollback before delegating."""
            self.rollback_count += 1
            rolled_back_sessions.append(self)
            return super().rollback()

    created_sessions: list[TrackingSession] = []
    rolled_back_sessions: list[TrackingSession] = []
    repository = SqlAlchemyCampaignCreationOperations(
        sessionmaker(bind=engine, class_=TrackingSession)
    )
    original_lookup = repository.get_by_uuid
    original_model = repository._operation_model
    barrier = threading.Barrier(2)
    winner_committed = threading.Event()
    lock = threading.Lock()
    initial_reads = 0
    re_read_state: list[dict[str, int]] = []

    def racing_lookup(operation_uuid: str):
        """Force both initial lookups to miss, then delegate the loser's re-read."""
        nonlocal initial_reads
        with lock:
            initial_reads += 1
            call_number = initial_reads
        if call_number <= 2:
            barrier.wait(timeout=5)
            return None
        re_read_state.append(
            {
                "rollbacks": sum(
                    session.rollback_count for session in created_sessions
                ),
                "session_count": len(created_sessions),
            }
        )
        return original_lookup(operation_uuid)

    def racing_model(operation: CampaignCreationOperation):
        """Delay the loser until the winner has committed its INSERT."""
        if operation.offer_id != winner_offer_id:
            assert winner_committed.wait(timeout=5)
        return original_model(operation)

    cast(Any, repository).get_by_uuid = racing_lookup
    cast(Any, repository)._operation_model = racing_model

    operation_uuid = str(uuid4())
    alias = make_alias(operation_uuid)

    def operation_for(offer_id: int, name: str, error: str):
        """Build one contender with the same idempotency identity."""
        return CampaignCreationOperation(
            operation_uuid=operation_uuid,
            alias=alias,
            name=name,
            country_code="US",
            offer_id=offer_id,
            domain_id=1,
            group_id=2,
            traffic_source_id=3,
            redirect_url="https://example.test",
            error_message=error,
        )

    winner = operation_for(winner_offer_id, "Winner", "winner-error")
    loser_offer_id = 200 if winner_offer_id == 100 else 100
    loser = operation_for(loser_offer_id, "Loser", "loser-error")

    def run(contender: CampaignCreationOperation, is_winner: bool):
        """Run one real repository call and signal the winner's commit."""
        outcome = repository.get_or_create(contender)
        if is_winner:
            winner_committed.set()
        return outcome

    with ThreadPoolExecutor(max_workers=2) as pool:
        winner_future = pool.submit(run, winner, True)
        loser_future = pool.submit(run, loser, False)
        winner_outcome = winner_future.result(timeout=10)
        loser_outcome = loser_future.result(timeout=10)

    assert winner_outcome[1] is True
    assert loser_outcome[1] is False
    assert loser_outcome[0].offer_id == winner_offer_id
    assert loser_outcome[0].name == "Winner"
    assert loser_outcome[0].error_message == "winner-error"
    assert re_read_state, "loser must re-read after a real UNIQUE violation"
    assert re_read_state[0]["rollbacks"] >= 1
    read_session = created_sessions[re_read_state[0]["session_count"] - 1]
    assert read_session not in rolled_back_sessions

    stored = original_lookup(operation_uuid)
    assert stored is not None
    assert stored.offer_id == winner_offer_id
    assert stored.name == "Winner"
    assert stored.status is OperationStatus.STARTED
    assert stored.error_message == "winner-error"
    engine.dispose()
    engine.dispose()

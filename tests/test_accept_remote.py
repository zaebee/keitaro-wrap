"""Contract, workflow and real-SQLite CAS tests for Accept-remote resolution."""

import asyncio
from collections.abc import Generator
from dataclasses import replace
from datetime import datetime
from typing import cast

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.application.conflict_resolution import ConflictResolutionService
from app.application.draft import DraftVersionConflict
from app.application.dto import (
    AcceptRemoteCommand,
    AcceptRemoteResult,
    AddOfferCommand,
    FetchedStream,
)
from app.application.errors import (
    ConflictChangedError,
    ConflictResolutionInputError,
    StreamNotFoundError,
)
from app.application.ports import KeitaroClientPort, StreamDraftRepository
from app.db.base import Base
from app.db.models import (
    RemoteOfferSnapshotModel,
    StreamPublicationModel,
    StreamRefModel,
)
from app.db.repositories import SqlAlchemyStreamDraftRepository
from app.domain.publication import PublicationStatus
from app.domain.reconciliation import conflict_fingerprint
from app.keitaro_client.client import KeitaroError
from tests.test_fetch_draft_conflicts import (
    edit,
    fetch,
    offers,
    standard_stream,
)


@pytest.fixture
def factory(tmp_path) -> Generator[sessionmaker[Session], None, None]:
    """Create an isolated file-backed SQLite schema for CAS tests."""
    engine = create_engine(f"sqlite:///{tmp_path / 'accept-remote.db'}")
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, autocommit=False)
    engine.dispose()


OBSERVED = offers(((5, 90), (8, 40)))
CAPTURED_AT = datetime(2026, 3, 3, 10, 0, 0)


def command(version: int = 1, fingerprint: str = "sha256:test") -> AcceptRemoteCommand:
    """Build a valid Accept-remote command for the common test stream."""
    return AcceptRemoteCommand(5, 12, version, fingerprint)


class FakeClient:
    """Read-only client double; every mutation endpoint is a hard failure."""

    def __init__(self, document: object | None = None, error: Exception | None = None):
        """Configure the single targeted GET result."""
        self.document = (
            document
            if document is not None
            else {
                "id": 12,
                "campaign_id": 5,
                "type": "regular",
                "name": "offers",
                "schema": "landings",
                "comments": "marker",
                "offers": [
                    {"offer_id": 5, "share": 90, "state": "active"},
                    {"offer_id": 8, "share": 40, "state": "active"},
                ],
            }
        )
        self.error = error
        self.gets = 0

    async def get_stream_document(self, stream_ref: int):
        """Return the configured document once; retry is never added locally."""
        self.gets += 1
        assert stream_ref == 12
        if self.error is not None:
            raise self.error
        return self.document

    async def create_campaign(self, *args, **kwargs):
        """Forbid campaign creation in this slice."""
        raise AssertionError("unexpected Keitaro mutation")

    async def create_stream(self, *args, **kwargs):
        """Forbid stream creation in this slice."""
        raise AssertionError("unexpected Keitaro mutation")

    async def update_stream(self, *args, **kwargs):
        """Forbid stream updates in this slice."""
        raise AssertionError("unexpected Keitaro mutation")

    async def delete_stream(self, *args, **kwargs):
        """Forbid stream deletion in this slice."""
        raise AssertionError("unexpected Keitaro mutation")


class IdentityClient:
    """Read-only client double that returns an arbitrary identity document."""

    def __init__(self, document: dict[str, object]):
        """Store the document to return from the targeted GET."""
        self.document = document
        self.gets = 0

    async def get_stream_document(self, stream_ref: int):
        """Return the configured identity document once."""
        self.gets += 1
        return self.document


class FakeDrafts:
    """In-memory draft repository recording writes."""

    def __init__(self, view, campaign: int | None = 5):
        """Seed the draft view returned to the service."""
        self.view = view
        self.campaign = campaign
        self.writes: list[tuple[AcceptRemoteCommand, FetchedStream, datetime]] = []

    def get_stream_campaign(self, stream_ref: int) -> int | None:
        """Return the seeded campaign owner."""
        return self.campaign

    def get_view(self, stream_ref: int):
        """Return the seeded draft view."""
        return self.view

    def accept_remote(
        self,
        command: AcceptRemoteCommand,
        observation: FetchedStream,
        captured_at: datetime,
    ) -> AcceptRemoteResult:
        """Record one atomic resolution write."""
        self.writes.append((command, observation, captured_at))
        return AcceptRemoteResult(command.stream_ref, self.view, False, 2)


def service(
    client: FakeClient | IdentityClient, drafts: FakeDrafts
) -> ConflictResolutionService:
    """Wire the workflow to doubles."""
    return ConflictResolutionService(
        cast(KeitaroClientPort, client), cast(StreamDraftRepository, drafts)
    )


def test_success_uses_one_targeted_read_and_forwards_observation():
    """A stale draft resolves from one fresh targeted GET and one repository write."""
    from tests.api_support import sample_draft_view

    view = sample_draft_view(12)
    view = replace(view, is_stale=True, version=1, conflicts_fingerprint="sha256:test")
    client = FakeClient()
    drafts = FakeDrafts(view)

    result = asyncio.run(
        service(client, drafts).accept_remote(command(fingerprint="sha256:test"))
    )

    assert client.gets == 1
    assert drafts.writes and len(drafts.writes) == 1
    written_command, observation, _ = drafts.writes[0]
    assert written_command.expected_version == 1
    assert [offer.share for offer in observation.offers] == [90, 40]
    assert result.noop is False


def test_already_resolved_clean_draft_returns_noop_without_read():
    """A clean draft with matching version and token is an idempotent no-op."""
    from tests.api_support import sample_draft_view

    view = sample_draft_view(12)
    view = replace(view, conflicts_fingerprint="sha256:empty")
    client = FakeClient()
    drafts = FakeDrafts(view)

    result = asyncio.run(
        service(client, drafts).accept_remote(command(fingerprint="sha256:empty"))
    )

    assert result.noop is True
    assert result.draft is view
    assert client.gets == 0
    assert drafts.writes == []


def test_missing_draft_is_typed_refusal():
    """Absence is never reported as a successful resolution."""
    client = FakeClient()
    with pytest.raises(ConflictResolutionInputError):
        asyncio.run(service(client, FakeDrafts(None)).accept_remote(command()))
    assert client.gets == 0


def test_stale_version_and_changed_fingerprint_prevent_remote_read():
    """Both concurrency tokens are checked before any Keitaro call."""
    from tests.api_support import sample_draft_view

    stale_view = sample_draft_view(12)
    stale_view = replace(
        stale_view,
        is_stale=True,
        version=3,
        conflicts_fingerprint="sha256:current",
    )
    client = FakeClient()
    with pytest.raises(DraftVersionConflict):
        asyncio.run(
            service(client, FakeDrafts(stale_view)).accept_remote(
                command(version=2, fingerprint="sha256:current")
            )
        )
    with pytest.raises(ConflictChangedError):
        asyncio.run(
            service(client, FakeDrafts(stale_view)).accept_remote(
                command(version=3, fingerprint="sha256:old")
            )
        )
    assert client.gets == 0


@pytest.mark.parametrize(
    "document,error",
    [
        (None, KeitaroError(0, "timeout")),
        ({"unexpected": True}, None),
        ({"id": 12, "campaign_id": 5, "offers": "bad"}, None),
        (
            {"id": 12, "campaign_id": 5, "offers": [{"offer_id": 5}]},
            None,
        ),
        ({"id": 12, "campaign_id": 99, "offers": []}, None),
    ],
)
def test_read_and_validation_failures_leave_local_state_unwritten(document, error):
    """No retry, no repository write and no mutation on any failed read."""
    from tests.api_support import sample_draft_view

    view = sample_draft_view(12)
    view = replace(view, is_stale=True, conflicts_fingerprint="sha256:test")
    client = FakeClient(document=document, error=error)
    drafts = FakeDrafts(view)
    with pytest.raises((KeitaroError, ConflictResolutionInputError)):
        asyncio.run(
            service(client, drafts).accept_remote(command(fingerprint="sha256:test"))
        )
    assert client.gets == 1
    assert drafts.writes == []


@pytest.mark.parametrize(
    "document",
    [
        {"id": True, "campaign_id": 1, "offers": []},
        {"id": 1, "campaign_id": True, "offers": []},
    ],
)
def test_boolean_identity_is_rejected(document):
    """Boolean IDs must not satisfy an expected numeric identity of 1."""
    from tests.api_support import sample_draft_view

    view = replace(
        sample_draft_view(1),
        is_stale=True,
        conflicts_fingerprint="sha256:test",
    )
    client = IdentityClient(document)
    drafts = FakeDrafts(view, campaign=1)
    command = AcceptRemoteCommand(1, 1, 1, "sha256:test")
    with pytest.raises(ConflictResolutionInputError):
        asyncio.run(service(client, drafts).accept_remote(command))
    assert client.gets == 1
    assert drafts.writes == []


def test_unknown_stream_is_refused_before_read():
    """A stream outside the campaign never reaches the Keitaro client."""
    client = FakeClient()
    with pytest.raises(StreamNotFoundError):
        asyncio.run(
            service(client, FakeDrafts(None, campaign=None)).accept_remote(command())
        )
    assert client.gets == 0


def _stale_draft(factory: sessionmaker[Session]):
    """Seed the common stale draft and return its current view."""
    standard_stream(factory)
    edit(factory, AddOfferCommand(5, 12, 0, 9))
    fetch(factory, OBSERVED)
    repository = SqlAlchemyStreamDraftRepository(factory)
    return repository, repository.get_view(12)


def _observation() -> FetchedStream:
    """Build the targeted fresh observation used by repository tests."""
    return FetchedStream(12, 5, "regular", "offers", "landings", OBSERVED, None)


def test_repository_accept_remote_persists_clean_draft(factory):
    """CAS success replaces baselines, clears conflicts and advances the version."""
    repository, view = _stale_draft(factory)
    assert view is not None
    result = repository.accept_remote(
        command(version=view.version, fingerprint=view.conflicts_fingerprint),
        _observation(),
        CAPTURED_AT,
    )

    assert result.noop is False
    assert result.version == view.version + 1
    assert result.draft is not None
    assert result.draft.is_stale is False
    assert result.draft.conflicts == ()
    assert result.draft.staged_changes == {}
    stored = repository.get_view(12)
    assert stored is not None
    assert (stored.version, stored.is_stale, stored.conflicts) == (
        view.version + 1,
        False,
        (),
    )
    assert stored.baseline_offers == OBSERVED
    with factory() as session:
        ref = session.query(StreamRefModel).filter_by(keitaro_stream_id=12).one()
        assert ref.draft_version_counter == view.version + 1
        snapshot = session.query(RemoteOfferSnapshotModel).one()
        assert snapshot.captured_at == CAPTURED_AT


def test_repository_cas_rejects_stale_version(factory):
    """A version mismatch performs no write at all."""
    repository, view = _stale_draft(factory)
    assert view is not None
    with pytest.raises(DraftVersionConflict):
        repository.accept_remote(
            command(version=view.version + 1, fingerprint=view.conflicts_fingerprint),
            _observation(),
            CAPTURED_AT,
        )
    after = repository.get_view(12)
    assert after == view


def test_repository_cas_rejects_changed_conflicts_after_fetch(factory):
    """A concurrent Fetch changing conflicts wins; the resolution writes nothing."""
    repository, view = _stale_draft(factory)
    assert view is not None
    fetch(factory, offers(((5, 95), (8, 40))))
    after_fetch = repository.get_view(12)
    with pytest.raises(ConflictChangedError):
        repository.accept_remote(
            command(version=view.version, fingerprint=view.conflicts_fingerprint),
            _observation(),
            CAPTURED_AT,
        )
    assert repository.get_view(12) == after_fetch


def test_repository_cas_rejects_newer_snapshot(factory):
    """A newer remote cache capture cannot be overwritten by an older read."""
    repository, view = _stale_draft(factory)
    assert view is not None
    with factory() as session:
        snapshot = session.query(RemoteOfferSnapshotModel).one()
        snapshot.captured_at = datetime(2026, 3, 4, 10, 0, 0)
        session.commit()
    with pytest.raises(ConflictChangedError):
        repository.accept_remote(
            command(version=view.version, fingerprint=view.conflicts_fingerprint),
            _observation(),
            CAPTURED_AT,
        )
    assert repository.get_view(12) == view


def test_repository_cas_rejects_unresolved_publication(factory):
    """The durable publication gate blocks the resolution transaction."""
    repository, view = _stale_draft(factory)
    assert view is not None
    with factory() as session:
        ref = session.query(StreamRefModel).filter_by(keitaro_stream_id=12).one()
        session.add(
            StreamPublicationModel(
                operation_uuid="gate",
                campaign_id=5,
                stream_ref=12,
                stream_ref_id=ref.id,
                status=PublicationStatus.PENDING.value,
                draft_version=view.version,
                request_payload_json="{}",
                remote_baseline_before_json="{}",
                expected_intent_json="{}",
                effective_offers_json="[]",
                staged_offers_json="[]",
            )
        )
        session.commit()
    from app.application.publication import PublicationGateError

    with pytest.raises(PublicationGateError):
        repository.accept_remote(
            command(version=view.version, fingerprint=view.conflicts_fingerprint),
            _observation(),
            CAPTURED_AT,
        )
    assert repository.get_view(12) == view


def test_fingerprint_covers_all_conflict_fields():
    """Canonical fingerprint changes when any semantic conflict field changes."""
    from app.domain.reconciliation import ConflictDetail

    first = (ConflictDetail(12, 5, "share", 60, 90, "remote_share_changed"),)
    second = (ConflictDetail(12, 5, "share", 60, 91, "remote_share_changed"),)
    assert conflict_fingerprint(first) != conflict_fingerprint(second)
    assert conflict_fingerprint(
        tuple(reversed(first + second))
    ) == conflict_fingerprint(first + second)

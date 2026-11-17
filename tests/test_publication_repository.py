"""Real-SQLite tests for durable Slice 6 publication state."""

import json
from collections.abc import Generator
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.application.dto import PublicationPlan
from app.application.publication import (
    PublicationConflictError,
    PublicationGateError,
)
from app.db.base import Base
from app.db.models import (
    RemoteOfferSnapshotModel,
    StreamDraftModel,
    StreamOfferBindingModel,
    StreamPublicationModel,
    StreamRefModel,
)
from app.db.repositories import SqlAlchemyStreamPublicationRepository
from app.domain.draft import StagedOffer
from app.domain.publication import OfferEntry, PublicationStatus
from app.domain.reconciliation import BindingLifecycle, RemoteOffer


@pytest.fixture
def session_factory(tmp_path) -> Generator[sessionmaker[Session], None, None]:
    """Create an isolated in-file SQLite schema for publication tests."""
    engine = create_engine(f"sqlite:///{tmp_path / 'publication.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    yield factory
    engine.dispose()


def seed_stream(session_factory: sessionmaker[Session]) -> None:
    """Create one cached stream with a snapshot, bindings and a dirty draft."""
    now = datetime.now(UTC).replace(tzinfo=None)
    with session_factory() as session:
        ref = StreamRefModel(
            campaign_id=5,
            keitaro_stream_id=12,
            type="regular",
            name="offers",
            schema="landings",
            draft_version_counter=1,
        )
        session.add(ref)
        session.flush()
        offers = (
            {"offer_id": 5, "share": 40, "state": "active", "position": 0},
            {"offer_id": 8, "share": 60, "state": "active", "position": 1},
        )
        session.add(
            RemoteOfferSnapshotModel(
                stream_ref_id=ref.id,
                offers_json=json.dumps(offers),
                captured_at=now,
            )
        )
        for offer_id, share in ((5, 40), (8, 60)):
            session.add(
                StreamOfferBindingModel(
                    stream_ref_id=ref.id,
                    offer_id=offer_id,
                    lifecycle="ACTIVE",
                    is_pinned=False,
                    last_remote_share=share,
                )
            )
        session.add(
            StreamDraftModel(
                stream_ref_id=ref.id,
                baseline_snapshot_json=json.dumps(offers),
                baseline_bindings_json=json.dumps(
                    [
                        {"offer_id": 5, "lifecycle": "ACTIVE", "is_pinned": False},
                        {"offer_id": 8, "lifecycle": "ACTIVE", "is_pinned": False},
                    ]
                ),
                baseline_captured_at=now,
                staged_changes_json=json.dumps({"share_edits": {"8": 60}}),
                version=1,
                is_dirty=True,
            )
        )
        session.commit()


def make_plan(version: int = 1, intent: dict | None = None) -> PublicationPlan:
    """Build an immutable publication plan matching the seeded draft."""
    staged = (
        StagedOffer(5, BindingLifecycle.ACTIVE, False, 40, "active", 0),
        StagedOffer(8, BindingLifecycle.ACTIVE, True, 60, "active", 1),
    )
    return PublicationPlan(
        campaign_id=5,
        stream_ref=12,
        draft_version=version,
        intent=intent or {"share_edits": {"8": 60}},
        staged_offers=staged,
        payload={
            "offers": [
                {"offer_id": 5, "share": 40},
                {"offer_id": 8, "share": 60, "state": "active"},
            ]
        },
        expected_entries=(
            OfferEntry(5, 40),
            OfferEntry(8, 60, "active"),
        ),
        preimage={
            "id": 12,
            "campaign_id": 5,
            "offers": [
                {"offer_id": 5, "share": 40, "state": "active"},
                {"offer_id": 8, "share": 60, "state": "active"},
            ],
        },
        correlation_marker="marker-1",
    )


def observed_offers() -> tuple[RemoteOffer, ...]:
    """Return the verified read-back array."""
    return (
        RemoteOffer(5, 40, "active", 0),
        RemoteOffer(8, 60, "active", 1),
    )


def count_publications(session_factory: sessionmaker[Session]) -> int:
    """Count durable publication rows."""
    with session_factory() as session:
        return (
            session.scalar(select(func.count()).select_from(StreamPublicationModel))
            or 0
        )


def test_create_pending_atomically_verifies_version_and_intent(session_factory):
    """A stale version or a changed intent never creates a durable operation."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    stale_plan = make_plan(version=2)
    with pytest.raises(PublicationConflictError):
        repository.create_pending((stale_plan,))
    changed_plan = make_plan(intent={"share_edits": {"8": 50}})
    with pytest.raises(PublicationConflictError):
        repository.create_pending((changed_plan,))
    assert count_publications(session_factory) == 0
    created = repository.create_pending((make_plan(),))
    assert len(created) == 1
    assert created[0].status is PublicationStatus.PENDING


def test_unresolved_operation_gates_a_second_create(session_factory):
    """The durable gate and partial unique index allow only one live operation."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    repository.create_pending((make_plan(),))
    second = replace(make_plan(), correlation_marker="marker-2")
    with pytest.raises(PublicationGateError):
        repository.create_pending((second,))
    assert count_publications(session_factory) == 1
    assert repository.has_unresolved(5, (12,)) is True


def test_atomic_claim_allows_only_one_worker(session_factory):
    """Only the worker that wins the conditional claim may issue a PUT."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    operation = repository.create_pending((make_plan(),))[0]
    assert repository.claim(operation.id, "worker-a") is not None
    assert repository.claim(operation.id, "worker-b") is None
    with session_factory() as session:
        model = session.get(StreamPublicationModel, operation.id)
        assert model is not None
        assert model.attempt_count == 1
        assert model.worker_token == "worker-a"


def test_finalize_success_commits_all_state_in_one_transaction(session_factory):
    """Verified success advances cache, bindings and draft together."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    operation = repository.create_pending((make_plan(),))[0]
    repository.claim(operation.id, "worker-a")
    finalized = repository.finalize_success(operation.id, observed_offers())
    assert finalized is not None
    assert finalized.status is PublicationStatus.SUCCEEDED
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(StreamDraftModel)) == 0
        pinned = session.query(StreamOfferBindingModel).filter_by(offer_id=8).one()
        assert pinned.is_pinned is True
        ref = session.get(StreamRefModel, 1)
        assert ref is not None
        assert ref.draft_version_counter == 1
        cache = session.scalar(select(RemoteOfferSnapshotModel))
        assert cache is not None
        assert "60" in cache.offers_json


def test_finalize_preserves_sticky_conflict_state(session_factory):
    """A conflict appearing during a PUT is never silently cleared."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    operation = repository.create_pending((make_plan(),))[0]
    repository.claim(operation.id, "worker-a")
    with session_factory() as session:
        draft = session.scalar(select(StreamDraftModel))
        assert draft is not None
        draft.is_stale = True
        draft.conflict_details_json = json.dumps(
            [
                {
                    "stream_ref": 12,
                    "offer_id": 5,
                    "field": "share",
                    "expected": 40,
                    "observed": 55,
                    "reason": "remote_share_changed",
                }
            ]
        )
        session.commit()
    assert repository.finalize_success(operation.id, observed_offers()) is not None
    with session_factory() as session:
        draft = session.scalar(select(StreamDraftModel))
        assert draft is not None
        assert draft.is_stale is True
        assert draft.is_dirty is False
        assert "remote_share_changed" in draft.conflict_details_json


def test_finalize_rejects_a_draft_changed_since_capture(session_factory):
    """A newer draft intent is never cleared by an older publication."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    operation = repository.create_pending((make_plan(),))[0]
    repository.claim(operation.id, "worker-a")
    with session_factory() as session:
        draft = session.scalar(select(StreamDraftModel))
        assert draft is not None
        draft.version = 2
        session.commit()
    assert repository.finalize_success(operation.id, observed_offers()) is None
    latest = repository.get(operation.id)
    assert latest is not None
    assert latest.status is PublicationStatus.IN_PROGRESS


def test_ambiguous_operation_can_be_confirmed_without_a_new_mutation(session_factory):
    """Recovery may move an ambiguous operation to succeeded from read evidence."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    operation = repository.create_pending((make_plan(),))[0]
    repository.claim(operation.id, "worker-a")
    repository.mark_ambiguous(operation.id, "timeout")
    finalized = repository.finalize_success(operation.id, observed_offers())
    assert finalized is not None
    assert finalized.status is PublicationStatus.SUCCEEDED


def test_cancel_is_atomic_when_commit_fails(session_factory):
    """A crash before commit cannot leave ABANDONED with a dirty draft."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    operation = repository.create_pending((make_plan(),))[0]

    def crash(session):
        """Simulate a process crash at commit time."""
        raise RuntimeError("crash before commit")

    event.listen(session_factory, "before_commit", crash)
    try:
        with pytest.raises(RuntimeError, match="crash before commit"):
            repository.cancel(5, 12, "operator cancel")
    finally:
        event.remove(session_factory, "before_commit", crash)
    latest = repository.get(operation.id)
    assert latest is not None
    assert latest.status is PublicationStatus.PENDING
    with session_factory() as session:
        draft = session.scalar(select(StreamDraftModel))
        assert draft is not None
        assert draft.is_dirty is True
        assert draft.version == 1


def test_cancel_rejects_a_changed_draft_without_writing_state(session_factory):
    """Version and intent checks are part of the atomic Cancel transaction."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    operation = repository.create_pending((make_plan(),))[0]
    with session_factory() as session:
        draft = session.scalar(select(StreamDraftModel))
        assert draft is not None
        draft.version = 2
        session.commit()
    with pytest.raises(PublicationConflictError):
        repository.cancel(5, 12, "operator cancel")
    latest = repository.get(operation.id)
    assert latest is not None
    assert latest.status is PublicationStatus.PENDING
    with session_factory() as session:
        draft = session.scalar(select(StreamDraftModel))
        assert draft is not None
        assert draft.version == 2
        assert draft.is_dirty is True


def test_failed_requires_absence_evidence_and_is_cancellable_with_it(session_factory):
    """D25 allows Cancel of failed only when absence evidence is stored."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamPublicationRepository(session_factory)
    operation = repository.create_pending((make_plan(),))[0]
    repository.claim(operation.id, "worker-a")
    with pytest.raises(PublicationConflictError):
        repository.mark_failed(operation.id, "rejected", {})
    failed = repository.mark_failed(operation.id, "rejected", {"source": "operator"})
    assert failed is not None
    assert failed.status is PublicationStatus.FAILED
    cancelled = repository.cancel(5, 12, "operator cancel")
    assert cancelled is not None
    assert cancelled[0].status is PublicationStatus.ABANDONED
    assert repository.has_unresolved(5, (12,)) is False

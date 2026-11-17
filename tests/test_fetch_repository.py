"""Repository and concurrency tests for Fetch reconciliation on SQLite."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.application.dto import FetchedStream, FetchOutcome, FetchSnapshot
from app.db.base import Base
from app.db.models import StreamDraftModel, StreamOfferBindingModel, StreamRefModel
from app.db.repositories import SqlAlchemyStreamReconciliationRepository
from app.domain.reconciliation import (
    ConflictDetail,
    DuplicateRemoteOfferError,
    RemoteOffer,
)

BASE_TIME = datetime(2026, 1, 1, 12, 0, 0)
DRAFT_TIME = datetime(2025, 12, 1, 9, 0, 0)


def offer(offer_id: int, share: int, state: str = "active") -> RemoteOffer:
    """Build a remote offer with an explicit array position."""
    position = {5: 0, 7: 0, 8: 1, 9: 2}.get(offer_id, 0)
    return RemoteOffer(offer_id, share, state, position)


def remote_stream(
    stream_ref: int, offers: tuple[RemoteOffer, ...], campaign_id: int = 5
) -> FetchedStream:
    """Build a validated remote stream observation."""
    return FetchedStream(
        stream_ref=stream_ref,
        campaign_id=campaign_id,
        type="regular",
        name=f"stream-{stream_ref}",
        schema="landings",
        offers=offers,
        comments=None,
    )


def snapshot(
    *streams: FetchedStream, captured_at: datetime = BASE_TIME
) -> FetchSnapshot:
    """Build a Fetch snapshot from validated streams."""
    return FetchSnapshot(5, streams, captured_at)


def dump_offers(offers: tuple[RemoteOffer, ...]) -> str:
    """Serialize offers the way the remote cache stores them."""
    return json.dumps(
        [
            {
                "offer_id": item.offer_id,
                "share": item.share,
                "state": item.state,
                "position": item.position,
            }
            for item in offers
        ]
    )


@pytest.fixture
def session_factory(tmp_path):
    """Create an isolated file-backed SQLite schema for repository tests."""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'fetch.db'}", connect_args={"timeout": 10}
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    yield factory
    engine.dispose()


def seed_draft(
    factory: sessionmaker[Session],
    stream_ref: int,
    baseline: tuple[RemoteOffer, ...],
    staged_changes: dict[str, object],
    *,
    version: int = 7,
    is_dirty: bool = True,
) -> None:
    """Seed a draft directly; S4 has no draft creation workflow."""
    with factory() as session:
        ref = StreamRefModel(
            campaign_id=5,
            keitaro_stream_id=stream_ref,
            type="regular",
            name=f"stream-{stream_ref}",
            schema="landings",
        )
        session.add(ref)
        session.flush()
        session.add(
            StreamDraftModel(
                stream_ref_id=ref.id,
                baseline_snapshot_json=dump_offers(baseline),
                baseline_captured_at=DRAFT_TIME,
                staged_changes_json=json.dumps(staged_changes),
                version=version,
                is_dirty=is_dirty,
                is_stale=False,
            )
        )
        session.commit()


def set_pin(factory: sessionmaker[Session], stream_ref: int, offer_id: int) -> None:
    """Simulate a committed pin from a later slice."""
    with factory() as session:
        ref = (
            session.query(StreamRefModel).filter_by(keitaro_stream_id=stream_ref).one()
        )
        binding = (
            session.query(StreamOfferBindingModel)
            .filter_by(stream_ref_id=ref.id, offer_id=offer_id)
            .one()
        )
        binding.is_pinned = True
        session.commit()


def test_repository_rejects_non_positive_attempt_count(session_factory):
    """The bounded local retry count must be at least one."""
    with pytest.raises(ValueError, match="max_attempts"):
        SqlAlchemyStreamReconciliationRepository(session_factory, max_attempts=0)


def test_unknown_stream_has_no_local_state(session_factory):
    """Read views return empty results for an uncached stream."""
    repository = SqlAlchemyStreamReconciliationRepository(session_factory)
    assert repository.get_stream_ref(999) is None
    assert repository.get_bindings(999) == ()
    assert repository.get_remote_snapshot(999) is None
    assert repository.get_draft(999) is None


def test_first_fetch_creates_refs_bindings_and_remote_cache(session_factory):
    """All streams become refs; only offer-bearing streams gain bindings/cache."""
    repository = SqlAlchemyStreamReconciliationRepository(session_factory)
    result = repository.reconcile(
        snapshot(
            remote_stream(11, ()),
            remote_stream(12, (offer(5, 75), offer(8, 25))),
        )
    )
    assert result == FetchOutcome(
        campaign_id=5,
        stream_count=2,
        reconciled_stream_count=1,
        created_bindings=2,
    )
    assert repository.get_stream_ref(11) is not None
    assert repository.get_bindings(11) == ()
    assert repository.get_remote_snapshot(11) is None
    assert [
        (item.offer_id, item.last_remote_share) for item in repository.get_bindings(12)
    ] == [
        (5, 75),
        (8, 25),
    ]
    cached = repository.get_remote_snapshot(12)
    assert cached is not None
    assert [(item.offer_id, item.position) for item in cached.offers] == [
        (5, 0),
        (8, 1),
    ]
    assert cached.captured_at == BASE_TIME


def test_repeated_fetch_is_idempotent(session_factory):
    """An unchanged observation creates no bindings, transitions or conflicts."""
    repository = SqlAlchemyStreamReconciliationRepository(session_factory)
    observation = snapshot(remote_stream(12, (offer(5, 75),)))
    first = repository.reconcile(observation)
    second = repository.reconcile(observation)

    assert first.created_bindings == 1
    assert second.created_bindings == 0
    assert second.archived_bindings == 0
    assert second.share_updates == 0
    assert second.conflicted_drafts == 0
    assert len(repository.get_bindings(12)) == 1


def test_remote_deletion_and_reappearance_preserve_pin(session_factory):
    """Deletion archives and clears cache; reappearance keeps the committed pin."""
    repository = SqlAlchemyStreamReconciliationRepository(session_factory)
    repository.reconcile(snapshot(remote_stream(12, (offer(7, 40),))))
    set_pin(session_factory, 12, 7)

    removed = repository.reconcile(snapshot(remote_stream(12, ())))
    assert removed.archived_bindings == 1
    archived = repository.get_bindings(12)[0]
    assert (archived.lifecycle, archived.last_remote_share, archived.is_pinned) == (
        "ARCHIVED",
        None,
        True,
    )

    reappeared = repository.reconcile(snapshot(remote_stream(12, (offer(7, 55),))))
    assert reappeared.reactivated_bindings == 1
    active = repository.get_bindings(12)[0]
    assert (active.lifecycle, active.last_remote_share, active.is_pinned) == (
        "ACTIVE",
        55,
        True,
    )


def test_share_conflict_is_sticky_and_draft_state_is_untouched(session_factory):
    """Fetch updates the remote cache but never the draft's own baseline/intent."""
    seed_draft(
        session_factory,
        12,
        (offer(5, 30), offer(8, 70)),
        {"share_edits": {"5": 55}},
    )
    repository = SqlAlchemyStreamReconciliationRepository(session_factory)

    changed = repository.reconcile(
        snapshot(remote_stream(12, (offer(5, 45), offer(8, 70))))
    )
    assert changed.conflicted_drafts == 1
    cached = repository.get_remote_snapshot(12)
    draft = repository.get_draft(12)
    assert cached is not None
    assert draft is not None
    assert cached.offers[0].share == 45
    assert draft.baseline_offers[0].share == 30
    assert draft.is_stale is True
    assert draft.conflicts == (
        ConflictDetail(12, 5, "share", 30, 45, "remote_share_changed"),
    )
    assert draft.staged_changes == {"share_edits": {"5": 55}}
    assert (draft.version, draft.is_dirty) == (7, True)

    restored = repository.reconcile(
        snapshot(remote_stream(12, (offer(5, 30), offer(8, 70))))
    )
    assert restored.conflicted_drafts == 0
    after = repository.get_draft(12)
    assert after is not None
    assert after.is_stale is True
    assert len(after.conflicts) == 1
    assert after.staged_changes == {"share_edits": {"5": 55}}
    assert (after.version, after.is_dirty) == (7, True)


def test_multiple_streams_are_isolated_by_stream_ref(session_factory):
    """The same remote offer id in two streams has two independent bindings."""
    repository = SqlAlchemyStreamReconciliationRepository(session_factory)
    repository.reconcile(
        snapshot(
            remote_stream(11, (offer(7, 60),)),
            remote_stream(12, (offer(7, 40),)),
        )
    )
    first = repository.get_bindings(11)
    second = repository.get_bindings(12)
    assert len(first) == len(second) == 1
    assert first[0].last_remote_share == 60
    assert second[0].last_remote_share == 40
    assert repository.get_remote_snapshot(11) != repository.get_remote_snapshot(12)


def test_invalid_stream_rolls_back_all_streams(session_factory):
    """A duplicate in one stream aborts the whole reconciliation transaction."""
    repository = SqlAlchemyStreamReconciliationRepository(session_factory)
    invalid = snapshot(
        remote_stream(11, (offer(5, 100),)),
        remote_stream(12, (offer(7, 50), offer(7, 50))),
    )
    with pytest.raises(DuplicateRemoteOfferError):
        repository.reconcile(invalid)
    assert repository.get_stream_ref(11) is None
    assert repository.get_stream_ref(12) is None
    assert repository.get_bindings(11) == ()


def test_concurrent_fetches_cannot_create_duplicate_bindings(session_factory):
    """Two racing Fetches leave one consistent binding set per stream."""
    repository = SqlAlchemyStreamReconciliationRepository(session_factory)
    barrier = Barrier(2)

    def run(observation: FetchSnapshot) -> FetchOutcome:
        barrier.wait()
        return repository.reconcile(observation)

    observations = [
        snapshot(remote_stream(100, (offer(5, 100),))),
        snapshot(remote_stream(100, (offer(7, 100),))),
    ]
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(run, item) for item in observations]
        successes = 0
        for future in futures:
            try:
                future.result()
                successes += 1
            except (IntegrityError, OperationalError):
                pass
    assert successes >= 1

    bindings = repository.get_bindings(100)
    cached = repository.get_remote_snapshot(100)
    assert cached is not None
    assert len(bindings) == len({item.offer_id for item in bindings})
    assert {item.offer_id for item in bindings if item.lifecycle == "ACTIVE"} == {
        item.offer_id for item in cached.offers
    }

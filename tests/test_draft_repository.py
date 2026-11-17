"""Real-SQLite repository tests for Slice 5 local draft editing."""

import json
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.application.draft import DraftStaleError, DraftVersionConflict
from app.application.dto import (
    AddOfferCommand,
    CancelDraftCommand,
    RemoveOfferCommand,
    RestoreOfferCommand,
    SetPinCommand,
    SetShareCommand,
)
from app.db.base import Base
from app.db.models import (
    RemoteOfferSnapshotModel,
    StreamDraftModel,
    StreamOfferBindingModel,
    StreamRefModel,
)
from app.db.repositories import SqlAlchemyStreamDraftRepository
from app.domain.allocation import PolicyCase
from app.domain.draft import BaselineBinding, DraftBaselineUnavailable, DraftInputError
from app.domain.reconciliation import BindingLifecycle, ConflictDetail, RemoteOffer

BASE_TIME = datetime(2026, 2, 1, 10, 0, 0)


def dump_offers(offers: tuple[RemoteOffer, ...]) -> str:
    """Serialise offers the way the remote cache stores them."""
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


def dump_bindings(values: tuple[BaselineBinding, ...]) -> str:
    """Serialise an immutable committed-state baseline."""
    return json.dumps(
        [
            {
                "offer_id": item.offer_id,
                "lifecycle": item.lifecycle.value,
                "is_pinned": item.is_pinned,
            }
            for item in values
        ]
    )


def offer(offer_id: int, share: int) -> RemoteOffer:
    """Build a remote offer with a stable position."""
    return RemoteOffer(offer_id, share, "active", {5: 0, 8: 1, 9: 2}[offer_id])


def binding(offer_id: int, pinned: bool = False, archived: bool = False):
    """Build a committed binding for seeding."""
    return BaselineBinding(
        offer_id,
        BindingLifecycle.ARCHIVED if archived else BindingLifecycle.ACTIVE,
        pinned,
    )


@pytest.fixture
def session_factory(tmp_path):
    """Create an isolated file-backed SQLite schema for repository tests."""
    engine = create_engine(f"sqlite:///{tmp_path / 'draft.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    yield factory
    engine.dispose()


def seed_stream(
    factory: sessionmaker[Session],
    *,
    stream_ref: int = 12,
    campaign_id: int = 5,
    offers: tuple[RemoteOffer, ...] = (offer(5, 60), offer(8, 40)),
    bindings: tuple[BaselineBinding, ...] | None = None,
    with_snapshot: bool = True,
) -> None:
    """Seed a remote stream, its snapshot and committed bindings."""
    if bindings is None:
        bindings = tuple(binding(item.offer_id) for item in offers)
    with factory() as session:
        ref = StreamRefModel(
            campaign_id=campaign_id,
            keitaro_stream_id=stream_ref,
            type="regular",
            name=f"stream-{stream_ref}",
            schema="landings",
            draft_version_counter=0,
        )
        session.add(ref)
        session.flush()
        if with_snapshot:
            session.add(
                RemoteOfferSnapshotModel(
                    stream_ref_id=ref.id,
                    offers_json=dump_offers(offers),
                    captured_at=BASE_TIME,
                )
            )
        for item in bindings:
            session.add(
                StreamOfferBindingModel(
                    stream_ref_id=ref.id,
                    offer_id=item.offer_id,
                    lifecycle=item.lifecycle.value,
                    is_pinned=item.is_pinned,
                    last_remote_share=(
                        next(
                            (
                                remote.share
                                for remote in offers
                                if remote.offer_id == item.offer_id
                            ),
                            None,
                        )
                        if item.lifecycle is BindingLifecycle.ACTIVE
                        else None
                    ),
                )
            )
        session.commit()


def seed_draft(
    factory: sessionmaker[Session],
    *,
    stream_ref: int = 12,
    offers: tuple[RemoteOffer, ...] = (offer(5, 60), offer(8, 40)),
    bindings: tuple[BaselineBinding, ...] | None = None,
    staged: dict[str, object] | None = None,
    version: int = 1,
    is_stale: bool = False,
    conflicts: tuple[ConflictDetail, ...] = (),
) -> None:
    """Seed a draft with immutable baselines directly; S5 normally creates it."""
    if bindings is None:
        bindings = tuple(binding(item.offer_id) for item in offers)
    with factory() as session:
        ref = (
            session.query(StreamRefModel).filter_by(keitaro_stream_id=stream_ref).one()
        )
        ref.draft_version_counter = max(ref.draft_version_counter, version)
        session.add(
            StreamDraftModel(
                stream_ref_id=ref.id,
                baseline_snapshot_json=dump_offers(offers),
                baseline_bindings_json=dump_bindings(bindings),
                baseline_captured_at=BASE_TIME,
                staged_changes_json=json.dumps(staged or {}),
                version=version,
                is_dirty=bool(staged),
                is_stale=is_stale,
                conflict_details_json=(
                    json.dumps([item.__dict__ for item in conflicts])
                    if conflicts
                    else None
                ),
            )
        )
        session.commit()


def first_edit_catalog(session_factory):
    """Seed one stream and return a repository for it."""
    seed_stream(session_factory)
    return SqlAlchemyStreamDraftRepository(session_factory)


def test_first_edit_lazily_creates_draft_from_snapshot(session_factory):
    """The immutable baselines come from the current snapshot and bindings."""
    repository = first_edit_catalog(session_factory)
    # The service normally converts DTOs; the repository takes a pure command.
    from app.application.dto import to_domain_command

    result = repository.apply(
        AddOfferCommand(5, 12, 0, 9),
        to_domain_command(AddOfferCommand(5, 12, 0, 9)),
    )
    assert result.created is True
    assert result.noop is False
    assert result.view.version == 1
    assert [item.offer_id for item in result.view.offers] == [5, 8, 9]
    assert [item.share for item in result.view.offers] == [34, 33, 33]

    with session_factory() as session:
        draft = session.query(StreamDraftModel).one()
        assert json.loads(draft.baseline_snapshot_json) == [
            {"offer_id": 5, "share": 60, "state": "active", "position": 0},
            {"offer_id": 8, "share": 40, "state": "active", "position": 1},
        ]
        assert json.loads(draft.baseline_bindings_json) == [
            {"offer_id": 5, "lifecycle": "ACTIVE", "is_pinned": False},
            {"offer_id": 8, "lifecycle": "ACTIVE", "is_pinned": False},
        ]
        assert draft.baseline_captured_at == BASE_TIME
        assert draft.version == 1
        assert draft.is_dirty is True
        bindings = (
            session.query(StreamOfferBindingModel)
            .order_by(StreamOfferBindingModel.offer_id)
            .all()
        )
        assert [(item.is_pinned, item.last_remote_share) for item in bindings] == [
            (False, 60),
            (False, 40),
        ]
        snapshot = session.query(RemoteOfferSnapshotModel).one()
        assert snapshot.offers_json == dump_offers((offer(5, 60), offer(8, 40)))


def test_noop_does_not_create_or_dirty_a_draft(session_factory):
    """Setting the baseline share is a no-op before any write."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    command = SetShareCommand(5, 12, 0, 5, 60)
    result = repository.apply(command, to_domain_command(command))
    assert result.noop is True
    assert result.created is False
    assert result.view.is_dirty is False
    with session_factory() as session:
        assert session.query(StreamDraftModel).count() == 0


def test_semantic_noop_removes_clean_draft(session_factory):
    """Archive then restore a clean offer removes the draft without version reuse."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    remove = RemoveOfferCommand(5, 12, 0, 5)
    first = repository.apply(remove, to_domain_command(remove))
    assert first.noop is False
    assert first.view.version == 1

    restore = RestoreOfferCommand(5, 12, 1, 5)
    second = repository.apply(restore, to_domain_command(restore))
    assert second.noop is True
    assert second.view.version == 1
    assert second.view.is_dirty is False
    assert repository.get_view(12) is None
    with session_factory() as session:
        assert session.query(StreamDraftModel).count() == 0
        ref = session.query(StreamRefModel).filter_by(keitaro_stream_id=12).one()
        assert ref.draft_version_counter == 1


def test_manual_share_auto_pins_and_unpin_clears_fixed_share(session_factory):
    """D19/D20 are persisted as staged intent only."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    share = SetShareCommand(5, 12, 0, 5, 70)
    pinned = repository.apply(share, to_domain_command(share))
    assert [item.share for item in pinned.view.offers] == [70, 30]
    unpin = SetPinCommand(5, 12, 1, 5, False)
    result = repository.apply(unpin, to_domain_command(unpin))
    assert [item.share for item in result.view.offers] == [50, 50]
    assert result.view.staged_changes == {}


def test_stale_draft_blocks_edits_but_allows_local_cancel(session_factory):
    """D22: edits fail with conflict details; Cancel preserves them."""
    seed_stream(session_factory)
    conflict = ConflictDetail(12, 5, "share", 30, 70, "remote_share_changed")
    seed_draft(
        session_factory,
        staged={"share_edits": {"5": 55}},
        is_stale=True,
        conflicts=(conflict,),
    )
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    add = AddOfferCommand(5, 12, 1, 9)
    with pytest.raises(DraftStaleError) as exc:
        repository.apply(add, to_domain_command(add))
    assert exc.value.conflicts == (conflict,)

    cancel = CancelDraftCommand(5, 12, 1)
    result = repository.apply(cancel, to_domain_command(cancel))
    assert result.noop is False
    assert result.view.version == 2
    assert result.view.is_stale is True
    assert result.view.conflicts == (conflict,)
    assert result.view.staged_changes == {}
    with session_factory() as session:
        draft = session.query(StreamDraftModel).one()
        assert draft.is_stale is True
        assert json.loads(draft.conflict_details_json) == [conflict.__dict__]
        assert draft.version == 2


def test_cancel_of_clean_draft_is_noop(session_factory):
    """Cancel with nothing staged does not bump the version."""
    seed_stream(session_factory)
    seed_draft(session_factory, staged={})
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    cancel = CancelDraftCommand(5, 12, 1)
    result = repository.apply(cancel, to_domain_command(cancel))
    assert result.noop is True
    assert result.view.version == 1


def test_optimistic_concurrency_rejects_stale_version(session_factory):
    """A conditional update stops a caller with an outdated version."""
    seed_stream(session_factory)
    seed_draft(session_factory, staged={"share_edits": {"5": 55}}, version=3)
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    stale = SetShareCommand(5, 12, 2, 5, 65)
    with pytest.raises(DraftVersionConflict):
        repository.apply(stale, to_domain_command(stale))
    fresh = SetShareCommand(5, 12, 3, 5, 65)
    result = repository.apply(fresh, to_domain_command(fresh))
    assert result.view.version == 4


def test_invalid_share_is_rejected_before_any_write(session_factory):
    """Out-of-range share input leaves no draft behind."""
    seed_stream(session_factory)
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    bad = SetShareCommand(5, 12, 0, 5, 101)
    with pytest.raises(DraftInputError):
        repository.apply(bad, to_domain_command(bad))
    with session_factory() as session:
        assert session.query(StreamDraftModel).count() == 0


def test_missing_remote_snapshot_blocks_lazy_creation(session_factory):
    """No remote snapshot means no defensible baseline."""
    seed_stream(session_factory, with_snapshot=False)
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    add = AddOfferCommand(5, 12, 0, 9)
    with pytest.raises(DraftInputError, match="snapshot"):
        repository.apply(add, to_domain_command(add))


def test_legacy_draft_without_binding_baseline_fails_explicitly(session_factory):
    """A draft from Slice 4 without immutable bindings cannot be reused."""
    seed_stream(session_factory)
    with session_factory() as session:
        ref = session.query(StreamRefModel).filter_by(keitaro_stream_id=12).one()
        session.add(
            StreamDraftModel(
                stream_ref_id=ref.id,
                baseline_snapshot_json=dump_offers((offer(5, 60), offer(8, 40))),
                baseline_captured_at=BASE_TIME,
                staged_changes_json="{}",
                version=1,
            )
        )
        session.commit()
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    add = AddOfferCommand(5, 12, 1, 9)
    with pytest.raises(DraftBaselineUnavailable):
        repository.apply(add, to_domain_command(add))
    with pytest.raises(DraftBaselineUnavailable):
        repository.get_view(12)


def test_campaign_mismatch_is_rejected(session_factory):
    """A stream from another campaign cannot be edited via this campaign."""
    seed_stream(session_factory, campaign_id=5)
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    add = AddOfferCommand(6, 12, 0, 9)
    with pytest.raises(DraftInputError, match="campaign"):
        repository.apply(add, to_domain_command(add))


def test_streams_are_isolated_and_durable_across_repositories(session_factory):
    """Editing one stream leaves another untouched; a new repo sees the draft."""
    seed_stream(session_factory, stream_ref=12)
    seed_stream(
        session_factory,
        stream_ref=13,
        offers=(offer(5, 100),),
        bindings=(binding(5),),
    )
    from app.application.dto import to_domain_command

    add = AddOfferCommand(5, 12, 0, 9)
    SqlAlchemyStreamDraftRepository(session_factory).apply(add, to_domain_command(add))
    assert SqlAlchemyStreamDraftRepository(session_factory).get_view(13) is None
    view = SqlAlchemyStreamDraftRepository(session_factory).get_view(12)
    assert view is not None
    assert view.version == 1
    assert PolicyCase.UNALLOCATED_REMAINDER not in view.policy_cases


def test_empty_intent_stale_draft_is_retained_unchanged(session_factory):
    """Clean-up never touches a stale draft or its conflict history."""
    seed_stream(session_factory)
    conflict = ConflictDetail(12, 5, "share", 30, 70, "remote_share_changed")
    seed_draft(
        session_factory,
        staged={},
        version=3,
        is_stale=True,
        conflicts=(conflict,),
    )
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    command = CancelDraftCommand(5, 12, 3)
    result = repository.apply(command, to_domain_command(command))
    assert result.noop is True
    view = repository.get_view(12)
    assert view is not None
    assert (view.version, view.is_stale, view.conflicts) == (3, True, (conflict,))
    assert view.staged_changes == {}


def test_true_noop_does_not_delete_or_change_version(session_factory):
    """A command with no effective change leaves a draft untouched."""
    seed_stream(session_factory)
    seed_draft(
        session_factory,
        staged={"share_edits": {"5": 55}, "pin_toggles": {"5": True}},
        version=2,
    )
    repository = SqlAlchemyStreamDraftRepository(session_factory)
    from app.application.dto import to_domain_command

    command = SetPinCommand(5, 12, 2, 5, True)
    result = repository.apply(command, to_domain_command(command))
    assert result.noop is True
    view = repository.get_view(12)
    assert view is not None
    assert view.version == 2
    assert view.staged_changes == {
        "share_edits": {"5": 55},
        "pin_toggles": {"5": True},
    }

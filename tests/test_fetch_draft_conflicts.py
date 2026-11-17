"""S4/S5 integration tests for share conflicts on allocation-affecting drafts."""

import json
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.application.draft import DraftStaleError, DraftVersionConflict
from app.application.dto import (
    AddOfferCommand,
    CancelDraftCommand,
    FetchedStream,
    FetchSnapshot,
    RemoveOfferCommand,
    RestoreOfferCommand,
    SetPinCommand,
    SetShareCommand,
    to_domain_command,
)
from app.db.base import Base
from app.db.models import (
    RemoteOfferSnapshotModel,
    StreamOfferBindingModel,
    StreamRefModel,
)
from app.db.repositories import (
    SqlAlchemyStreamDraftRepository,
    SqlAlchemyStreamReconciliationRepository,
)
from app.domain.draft import BaselineBinding
from app.domain.reconciliation import BindingLifecycle, RemoteOffer

BASE_TIME = datetime(2026, 3, 1, 10, 0, 0)


def offers(items: tuple[tuple[int, int], ...]) -> tuple[RemoteOffer, ...]:
    """Build an ordered remote offer array."""
    return tuple(
        RemoteOffer(offer_id, share, "active", position)
        for position, (offer_id, share) in enumerate(items)
    )


def dump_offers(items: tuple[RemoteOffer, ...]) -> str:
    """Serialise a remote offer array."""
    return json.dumps(
        [
            {
                "offer_id": item.offer_id,
                "share": item.share,
                "state": item.state,
                "position": item.position,
            }
            for item in items
        ]
    )


def binding(offer_id: int, pinned: bool = False, archived: bool = False):
    """Build an immutable committed-state baseline entry."""
    return BaselineBinding(
        offer_id,
        BindingLifecycle.ARCHIVED if archived else BindingLifecycle.ACTIVE,
        pinned,
    )


@pytest.fixture
def factory(tmp_path):
    """Create an isolated file-backed SQLite schema."""
    engine = create_engine(f"sqlite:///{tmp_path / 'integration.db'}")
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, autocommit=False)
    engine.dispose()


def seed_stream(
    factory: sessionmaker[Session],
    remote: tuple[RemoteOffer, ...],
    bindings: tuple[BaselineBinding, ...],
) -> None:
    """Seed a cached remote snapshot and committed bindings."""
    with factory() as session:
        ref = StreamRefModel(
            campaign_id=5,
            keitaro_stream_id=12,
            type="regular",
            name="offers",
            schema="landings",
            draft_version_counter=0,
        )
        session.add(ref)
        session.flush()
        session.add(
            RemoteOfferSnapshotModel(
                stream_ref_id=ref.id,
                offers_json=dump_offers(remote),
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
                            (o.share for o in remote if o.offer_id == item.offer_id),
                            None,
                        )
                        if item.lifecycle is BindingLifecycle.ACTIVE
                        else None
                    ),
                )
            )
        session.commit()


def edit(factory: sessionmaker[Session], command):
    """Apply one S5 command through the real repository."""
    return SqlAlchemyStreamDraftRepository(factory).apply(
        command, to_domain_command(command)
    )


def fetch(factory: sessionmaker[Session], remote: tuple[RemoteOffer, ...]):
    """Reconcile one remote observation through S4 and return the draft view."""
    repository = SqlAlchemyStreamReconciliationRepository(factory)
    snapshot = FetchSnapshot(
        5,
        (FetchedStream(12, 5, "regular", "offers", "landings", remote, None),),
        datetime(2026, 3, 2, 10, 0, 0),
    )
    repository.reconcile(snapshot)
    return repository.get_draft(12)


def conflict_tuples(draft) -> set[tuple[int, str, int | None, int | None, str]]:
    """Return conflicts in a comparable form."""
    return {
        (item.offer_id, item.field, item.expected, item.observed, item.reason)
        for item in draft.conflicts
    }


def standard_stream(factory: sessionmaker[Session]) -> None:
    """Seed the common two-offer stream used by most scenarios."""
    seed_stream(
        factory,
        offers(((5, 60), (8, 40))),
        (binding(5), binding(8)),
    )


@pytest.mark.parametrize(
    "command, remote, expected",
    [
        (
            AddOfferCommand(5, 12, 0, 9),
            offers(((5, 90), (8, 40))),
            (5, "share", 60, 90, "remote_share_changed"),
        ),
        (
            RemoveOfferCommand(5, 12, 0, 5),
            offers(((5, 60), (8, 70))),
            (8, "share", 40, 70, "remote_share_changed"),
        ),
        (
            SetPinCommand(5, 12, 0, 5, True),
            offers(((5, 60), (8, 70))),
            (8, "share", 40, 70, "remote_share_changed"),
        ),
        (
            SetPinCommand(5, 12, 0, 5, True),
            offers(((5, 90), (8, 40))),
            (5, "share", 60, 90, "remote_share_changed"),
        ),
    ],
)
def test_allocation_affecting_intents_detect_remote_share_change(
    factory, command, remote, expected
):
    """Add/archive/pin intents depend on baseline shares (S4/S5 correction)."""
    standard_stream(factory)
    edit(factory, command)
    draft = fetch(factory, remote)
    assert draft is not None
    assert draft.is_stale is True
    assert expected in conflict_tuples(draft)


def test_restore_detects_both_reappearance_and_share_change(factory):
    """A restore draft still detects share changes of other baseline offers."""
    seed_stream(
        factory,
        offers(((5, 25), (8, 100))),
        (binding(5, pinned=True, archived=True), binding(8)),
    )
    edit(factory, RestoreOfferCommand(5, 12, 0, 5))
    draft = fetch(factory, offers(((5, 25), (8, 70))))
    assert draft is not None
    assert (5, "offer", None, 5, "remote_offer_reappeared") in conflict_tuples(draft)
    assert (8, "share", 100, 70, "remote_share_changed") in conflict_tuples(draft)


def test_normalized_empty_draft_is_removed(factory):
    """A clean normalized draft is removed, so later Fetch has no conflict."""
    standard_stream(factory)
    first = edit(factory, SetShareCommand(5, 12, 0, 5, 70))
    edit(factory, SetPinCommand(5, 12, first.view.version, 5, False))
    assert SqlAlchemyStreamDraftRepository(factory).get_view(12) is None
    assert fetch(factory, offers(((5, 90), (8, 40)))) is None


def test_locally_archived_offer_share_is_not_an_allocation_input(factory):
    """An archived offer has effective share 0 and needs no share conflict."""
    standard_stream(factory)
    edit(factory, RemoveOfferCommand(5, 12, 0, 5))
    draft = fetch(factory, offers(((5, 90), (8, 40))))
    assert draft is not None
    assert draft.is_stale is False
    assert conflict_tuples(draft) == set()


def test_conflict_is_sticky_and_cancel_preserves_it(factory):
    """Repeated Fetch does not duplicate; edits block; Cancel keeps conflict."""
    standard_stream(factory)
    edit(factory, AddOfferCommand(5, 12, 0, 9))
    first = fetch(factory, offers(((5, 90), (8, 40))))
    second = fetch(factory, offers(((5, 90), (8, 40))))
    assert first is not None
    assert second is not None
    assert first.conflicts == second.conflicts
    assert len(second.conflicts) == 1

    repository = SqlAlchemyStreamDraftRepository(factory)
    with pytest.raises(DraftStaleError):
        repository.apply(
            AddOfferCommand(5, 12, 1, 10),
            to_domain_command(AddOfferCommand(5, 12, 1, 10)),
        )
    cancel = repository.apply(
        CancelDraftCommand(5, 12, 1),
        to_domain_command(CancelDraftCommand(5, 12, 1)),
    )
    assert cancel.view.is_stale is True
    assert cancel.view.conflicts == first.conflicts
    assert cancel.view.staged_changes == {}


def test_non_unique_integrity_error_is_not_masqueraded(factory, monkeypatch):
    """Only lazy-create unique races map to DraftVersionConflict."""

    def boom(cls, session, prepared, command, plan_intent):
        raise IntegrityError(
            "INSERT", {}, Exception("NOT NULL constraint failed: stream_drafts.version")
        )

    monkeypatch.setattr(
        SqlAlchemyStreamDraftRepository, "_write_plan", classmethod(boom)
    )
    standard_stream(factory)
    repository = SqlAlchemyStreamDraftRepository(factory)
    command = AddOfferCommand(5, 12, 0, 9)
    with pytest.raises(IntegrityError):
        repository.apply(command, to_domain_command(command))


def test_lazy_create_unique_race_maps_to_version_conflict(factory, monkeypatch):
    """A unique violation on the draft stream key is a lost create race."""

    class UniqueError(Exception):
        """Fake sqlite unique violation."""

        sqlite_errorname = "SQLITE_CONSTRAINT_UNIQUE"

        def __str__(self) -> str:
            """Mimic the SQLite message."""
            return "UNIQUE constraint failed: stream_drafts.stream_ref_id"

    def boom(cls, session, prepared, command, plan_intent):
        raise IntegrityError("INSERT", {}, UniqueError())

    monkeypatch.setattr(
        SqlAlchemyStreamDraftRepository, "_write_plan", classmethod(boom)
    )
    standard_stream(factory)
    repository = SqlAlchemyStreamDraftRepository(factory)
    command = AddOfferCommand(5, 12, 0, 9)
    with pytest.raises(DraftVersionConflict):
        repository.apply(command, to_domain_command(command))


def test_manual_share_edit_is_not_a_remote_share_dependency(factory):
    """A manually overridden pinned offer uses its local fixed share."""
    standard_stream(factory)
    edit(factory, SetShareCommand(5, 12, 0, 5, 70))
    draft = fetch(factory, offers(((5, 90), (8, 40))))
    assert draft is not None
    assert draft.is_stale is False
    assert conflict_tuples(draft) == set()


def test_other_baseline_share_change_still_conflicts_with_manual_share(factory):
    """A share edit excludes only its own offer from share conflict checks."""
    standard_stream(factory)
    edit(factory, SetShareCommand(5, 12, 0, 5, 70))
    draft = fetch(factory, offers(((5, 70), (8, 70))))
    assert draft is not None
    assert conflict_tuples(draft) == {(8, "share", 40, 70, "remote_share_changed")}


def test_add_plus_share_edit_conflicts_only_for_other_offer(factory):
    """Adding and manually overriding one offer still watches the other share."""
    standard_stream(factory)
    first = edit(factory, AddOfferCommand(5, 12, 0, 9))
    second = edit(factory, SetShareCommand(5, 12, first.view.version, 5, 70))
    assert second.view.version == 2
    draft = fetch(factory, offers(((5, 90), (8, 70))))
    assert draft is not None
    assert conflict_tuples(draft) == {(8, "share", 40, 70, "remote_share_changed")}


def test_set_share_then_unpin_removes_clean_draft(factory):
    """SetShare → Unpin removes the clean draft and keeps its version counter."""
    standard_stream(factory)
    first = edit(factory, SetShareCommand(5, 12, 0, 5, 70))
    result = edit(factory, SetPinCommand(5, 12, first.view.version, 5, False))
    assert result.view.staged_changes == {}
    assert SqlAlchemyStreamDraftRepository(factory).get_view(12) is None
    with factory() as session:
        ref = session.query(StreamRefModel).filter_by(keitaro_stream_id=12).one()
        assert ref.draft_version_counter == 1


def test_next_edit_after_cleanup_uses_new_snapshot(factory):
    """After cleanup, lazy creation rebases from the latest remote snapshot."""
    standard_stream(factory)
    first = edit(factory, SetShareCommand(5, 12, 0, 5, 70))
    edit(factory, SetPinCommand(5, 12, first.view.version, 5, False))
    fetch(factory, offers(((5, 90), (8, 40))))

    created = edit(factory, AddOfferCommand(5, 12, 0, 9))
    assert created.created is True
    assert created.view.version == 2
    assert [item.share for item in created.view.baseline_offers] == [90, 40]


def test_optimistic_concurrency_across_cleanup_and_recreation(factory):
    """A stale version from before cleanup cannot edit the recreated draft."""
    standard_stream(factory)
    first = edit(factory, SetShareCommand(5, 12, 0, 5, 70))
    edit(factory, SetPinCommand(5, 12, first.view.version, 5, False))
    recreated = edit(factory, AddOfferCommand(5, 12, 0, 9))
    assert recreated.view.version == 2

    stale = AddOfferCommand(5, 12, 1, 10)
    with pytest.raises(DraftVersionConflict):
        edit(factory, stale)


def test_cleanup_result_version_chains_to_next_edit(factory):
    """The returned no-draft sentinel is usable as the next expected_version."""
    standard_stream(factory)
    first = edit(factory, SetShareCommand(5, 12, 0, 5, 70))
    cleanup = edit(factory, SetPinCommand(5, 12, first.view.version, 5, False))
    assert cleanup.view.version == 0

    fetch(factory, offers(((5, 90), (8, 40))))
    created = edit(factory, AddOfferCommand(5, 12, cleanup.view.version, 9))
    assert created.created is True
    assert created.view.version == 2
    assert [item.share for item in created.view.baseline_offers] == [90, 40]

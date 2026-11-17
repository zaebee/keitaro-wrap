"""Pure tests for remote-offer reconciliation primitives."""

from typing import cast

import pytest

from app.domain.reconciliation import (
    BindingLifecycle,
    BindingState,
    ConflictDetail,
    DraftState,
    DuplicateRemoteOfferError,
    InvalidRemoteOfferError,
    RemoteOffer,
    TransitionKind,
    plan_reconciliation,
    validate_remote_offers,
)


def binding(
    offer_id: int,
    lifecycle: BindingLifecycle = BindingLifecycle.ACTIVE,
    share: int | None = 50,
    *,
    is_pinned: bool = False,
) -> BindingState:
    """Build a committed binding state for tests."""
    return BindingState(offer_id, lifecycle, is_pinned, share)


def test_validate_remote_offers_rejects_duplicate_ids():
    """A duplicate offer_id fails explicitly instead of collapsing entries."""
    offers = (RemoteOffer(7, 40, position=0), RemoteOffer(7, 60, position=1))
    with pytest.raises(DuplicateRemoteOfferError, match="duplicate offer_id 7"):
        validate_remote_offers(offers)


@pytest.mark.parametrize(
    "offer",
    [
        RemoteOffer(0, 50),
        RemoteOffer(7, 101),
        RemoteOffer(7, -1),
        RemoteOffer(7, True),
        RemoteOffer(7, 50, state=cast(str | None, 7)),
        RemoteOffer(7, 50, position=-1),
    ],
)
def test_validate_remote_offers_rejects_invalid_values(offer: RemoteOffer):
    """Invalid ids and shares raise a typed validation error."""
    with pytest.raises(InvalidRemoteOfferError):
        validate_remote_offers((offer,))


def test_plan_creates_archives_and_updates_shares():
    """One plan covers additions, deletions and share cache changes."""
    remote = (RemoteOffer(5, 75, "active", 0), RemoteOffer(9, 25, "active", 1))
    previous = (binding(5, share=60), binding(8, share=40))
    plan = plan_reconciliation(
        stream_ref=42, remote_offers=remote, previous_bindings=previous
    )
    by_offer = {item.offer_id: item.kind for item in plan.transitions}
    assert by_offer == {
        5: TransitionKind.SHARE_CHANGED,
        8: TransitionKind.ARCHIVED,
        9: TransitionKind.CREATED,
    }
    assert plan.remote_offers == remote


def test_plan_reactivation_preserves_pin_state():
    """Reactivation never carries a pin change; the binding keeps its own flag."""
    plan = plan_reconciliation(
        stream_ref=42,
        remote_offers=(RemoteOffer(7, 30),),
        previous_bindings=(
            binding(7, BindingLifecycle.ARCHIVED, None, is_pinned=True),
        ),
    )
    assert [(item.offer_id, item.kind) for item in plan.transitions] == [
        (7, TransitionKind.REACTIVATED)
    ]


def test_plan_is_idempotent_for_unchanged_state():
    """An unchanged observation produces neither transitions nor conflicts."""
    plan = plan_reconciliation(
        stream_ref=42,
        remote_offers=(RemoteOffer(7, 30),),
        previous_bindings=(binding(7, share=30),),
    )
    assert plan.transitions == ()
    assert plan.conflicts == ()


def test_draft_conflicts_cover_add_remove_and_reappear():
    """Remote lifecycle differences against a draft baseline are explicit."""
    draft = DraftState(
        baseline_offers=(RemoteOffer(7, 30), RemoteOffer(8, 70)),
        staged_changes={},
        is_stale=False,
        conflicts=(),
    )
    plan = plan_reconciliation(
        stream_ref=42,
        remote_offers=(RemoteOffer(7, 30), RemoteOffer(9, 100)),
        previous_bindings=(binding(8, share=70),),
        draft=draft,
    )
    assert {(item.offer_id, item.reason) for item in plan.conflicts} == {
        (8, "remote_offer_removed"),
        (9, "remote_offer_added"),
    }

    reappeared = plan_reconciliation(
        stream_ref=42,
        remote_offers=(RemoteOffer(7, 30), RemoteOffer(8, 70)),
        previous_bindings=(
            binding(7, share=30),
            binding(8, BindingLifecycle.ARCHIVED, None),
        ),
        draft=draft,
    )
    assert [(item.offer_id, item.reason) for item in reappeared.conflicts] == [
        (8, "remote_offer_reappeared")
    ]


@pytest.mark.parametrize(
    "staged_changes, expected_conflict",
    [
        ({}, False),
        ({"share_edits": {"7": 55}}, False),
        ({"share_edits": {7: 55}}, False),
        ({"pin_toggles": {"7": True}}, True),
        ({"additions": [9]}, True),
        ({"archives": [7]}, False),
    ],
)
def test_share_conflict_tracks_allocation_inputs(staged_changes, expected_conflict):
    """Only intents whose allocation depends on a share create a conflict."""
    plan = plan_reconciliation(
        stream_ref=42,
        remote_offers=(RemoteOffer(7, 45),),
        previous_bindings=(binding(7, share=30),),
        draft=DraftState((RemoteOffer(7, 30),), staged_changes, False, ()),
    )
    expected = (
        (ConflictDetail(42, 7, "share", 30, 45, "remote_share_changed"),)
        if expected_conflict
        else ()
    )
    assert plan.conflicts == expected


def test_share_edits_accept_integer_and_string_keys():
    """Both JSON-derived and in-memory share-edit keys exclude the offer."""
    remote = (RemoteOffer(7, 45),)
    for keys in ({"7": 55}, {7: 55}):
        draft = DraftState((RemoteOffer(7, 30),), {"share_edits": keys}, False, ())
        assert (
            plan_reconciliation(
                stream_ref=42,
                remote_offers=remote,
                previous_bindings=(binding(7, share=30),),
                draft=draft,
            ).conflicts
            == ()
        )


def test_conflicts_are_sticky_and_deduplicated():
    """Old conflict markers survive a later Fetch that returns to the baseline."""
    prior = ConflictDetail(42, 7, "share", 30, 45, "remote_share_changed")
    draft = DraftState(
        (RemoteOffer(7, 30),), {"share_edits": {"7": 55}}, True, (prior,)
    )
    plan = plan_reconciliation(
        stream_ref=42,
        remote_offers=(RemoteOffer(7, 30),),
        previous_bindings=(binding(7, share=30),),
        draft=draft,
    )
    assert plan.conflicts == (prior,)

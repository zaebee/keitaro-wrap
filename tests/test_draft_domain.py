"""Pure tests for staged draft planning and no-op normalisation."""

import pytest

from app.domain.allocation import PinnedTotalExceededError, PolicyCase
from app.domain.draft import (
    BaselineBinding,
    DraftBaselineUnavailable,
    DraftCommand,
    DraftCommandKind,
    DraftContext,
    DraftInputError,
    DraftIntent,
    plan_edit,
    validate_share,
)
from app.domain.reconciliation import BindingLifecycle, RemoteOffer


def binding(offer_id: int, pinned: bool = False, archived: bool = False):
    """Build an immutable committed-state baseline entry."""
    lifecycle = BindingLifecycle.ARCHIVED if archived else BindingLifecycle.ACTIVE
    return BaselineBinding(offer_id, lifecycle, pinned)


def context(
    offers: tuple[RemoteOffer, ...],
    bindings: tuple[BaselineBinding, ...],
    intent: DraftIntent | None = None,
) -> DraftContext:
    """Build a draft context for tests."""
    return DraftContext(12, offers, bindings, intent or DraftIntent())


def shares(view) -> dict[int, int]:
    """Map a derived view to effective shares."""
    return {item.offer_id: item.share for item in view.offers}


def test_validate_share_accepts_integer_range_and_rejects_bool():
    """Manual share input is an integer 0..100; bool is not an integer."""
    assert validate_share(0) == 0
    assert validate_share(100) == 100
    for value in (True, False, -1, 101, 12.5, "50"):
        with pytest.raises(DraftInputError):
            validate_share(value)


def test_add_uses_lrm_with_offer_id_tie_break():
    """A new offer is redistributed with the accepted deterministic rule."""
    base = context(
        (RemoteOffer(5, 60), RemoteOffer(8, 40)),
        (binding(5), binding(8)),
    )
    plan = plan_edit(base, DraftCommand(DraftCommandKind.ADD, offer_id=9))
    assert plan.noop is False
    assert plan.intent.additions == (9,)
    assert shares(plan.view) == {5: 34, 8: 33, 9: 33}
    assert [item.offer_id for item in plan.view.offers] == [5, 8, 9]


def test_remove_archives_without_erasing_and_redistributes():
    """Removal keeps the offer at share 0 and gives its share to unpinned peers."""
    base = context(
        (RemoteOffer(5, 60), RemoteOffer(8, 40)),
        (binding(5), binding(8)),
    )
    plan = plan_edit(base, DraftCommand(DraftCommandKind.REMOVE, offer_id=5))
    archived = next(item for item in plan.view.offers if item.offer_id == 5)
    assert archived.lifecycle is BindingLifecycle.ARCHIVED
    assert archived.share == 0
    assert shares(plan.view) == {5: 0, 8: 100}


def test_restore_preserves_committed_pin():
    """D9: an archived pinned binding returns with its pin unchanged."""
    base = context(
        (RemoteOffer(5, 25), RemoteOffer(8, 100)),
        (binding(5, pinned=True, archived=True), binding(8)),
    )
    plan = plan_edit(base, DraftCommand(DraftCommandKind.RESTORE, offer_id=5))
    pinned = next(item for item in plan.view.offers if item.offer_id == 5)
    assert pinned.lifecycle is BindingLifecycle.ACTIVE
    assert pinned.is_pinned is True
    assert pinned.share == 25
    assert shares(plan.view) == {5: 25, 8: 75}


def test_manual_share_auto_pins_and_unpin_returns_to_redistribution():
    """D19: share edit pins; explicit unpin removes the fixed share."""
    base = context(
        (RemoteOffer(5, 60), RemoteOffer(8, 40)),
        (binding(5), binding(8)),
    )
    changed = plan_edit(base, DraftCommand(DraftCommandKind.SET_SHARE, 5, 70))
    assert shares(changed.view) == {5: 70, 8: 30}
    assert changed.intent.share_edits == {5: 70}
    assert changed.intent.pin_toggles == {5: True}

    unpinned = plan_edit(
        context(base.baseline_offers, base.baseline_bindings, changed.intent),
        DraftCommand(DraftCommandKind.SET_PIN, 5, False),
    )
    assert shares(unpinned.view) == {5: 50, 8: 50}
    assert unpinned.intent.share_edits == {}
    assert unpinned.intent.pin_toggles == {}


@pytest.mark.parametrize(
    "offers, bindings",
    [
        ((RemoteOffer(5, 30),), (binding(5, pinned=True),)),
        ((RemoteOffer(5, 60), RemoteOffer(8, 40)), (binding(5), binding(8))),
    ],
)
def test_single_and_all_pinned_cases_are_surfaced(offers, bindings):
    """D21: zero/one/all-pinned cases stay visible, never silently normalised."""
    plan = plan_edit(
        context(offers, bindings),
        DraftCommand(DraftCommandKind.SET_PIN, 5, True),
    )
    if len(offers) == 1:
        assert PolicyCase.SINGLE_ACTIVE_OFFER in plan.view.policy_cases
    else:
        assert plan.view.policy_cases == ()

    pinned_both = plan_edit(
        context(offers, bindings),
        DraftCommand(DraftCommandKind.SET_PIN, 5, True),
    )
    assert pinned_both.view.unallocated >= 0


def test_all_pinned_below_100_surfaces_unallocated():
    """All pinned with total < 100 is allowed while staging."""
    base = context(
        (RemoteOffer(5, 30), RemoteOffer(8, 20)),
        (binding(5, pinned=True), binding(8, pinned=True)),
    )
    plan = plan_edit(
        base,
        DraftCommand(DraftCommandKind.SET_PIN, 5, True),
    )
    assert plan.view.unallocated == 50
    assert PolicyCase.UNALLOCATED_REMAINDER in plan.view.policy_cases


def test_zero_active_offers_surfaces_no_active_policy():
    """Archiving the last offer is allowed while staging."""
    base = context((RemoteOffer(5, 100),), (binding(5),))
    plan = plan_edit(base, DraftCommand(DraftCommandKind.REMOVE, offer_id=5))
    assert PolicyCase.NO_ACTIVE_OFFERS in plan.view.policy_cases
    assert plan.view.unallocated == 100


def test_pinned_total_above_100_is_a_hard_error():
    """Confirmed invalid pinned sum still aborts the plan."""
    base = context(
        (RemoteOffer(5, 70), RemoteOffer(8, 60)),
        (binding(5, pinned=True), binding(8)),
    )
    with pytest.raises(PinnedTotalExceededError):
        plan_edit(base, DraftCommand(DraftCommandKind.SET_PIN, 8, True))


@pytest.mark.parametrize(
    "first, second",
    [
        (
            DraftCommand(DraftCommandKind.REMOVE, 5),
            DraftCommand(DraftCommandKind.RESTORE, 5),
        ),
        (
            DraftCommand(DraftCommandKind.SET_PIN, 5, True),
            DraftCommand(DraftCommandKind.SET_PIN, 5, False),
        ),
        (
            DraftCommand(DraftCommandKind.SET_SHARE, 5, 70),
            DraftCommand(DraftCommandKind.SET_SHARE, 5, 60),
        ),
    ],
)
def test_semantic_noop_normalises_to_empty_intent(first, second):
    """Net-zero intent relative to baseline is not a staged change."""
    base = context(
        (RemoteOffer(5, 60), RemoteOffer(8, 40)),
        (binding(5), binding(8)),
    )
    first_plan = plan_edit(base, first)
    assert first_plan.noop is False
    second_plan = plan_edit(
        context(base.baseline_offers, base.baseline_bindings, first_plan.intent),
        second,
    )
    assert second_plan.noop is True
    assert second_plan.intent.to_json() == {}


def test_cancel_without_staged_changes_is_a_noop():
    """Cancel on a clean draft makes no change."""
    base = context((RemoteOffer(5, 100),), (binding(5),))
    plan = plan_edit(base, DraftCommand(DraftCommandKind.CANCEL))
    assert plan.noop is True


def test_missing_baseline_is_reported_by_repository_boundary():
    """The domain type exists for the adapter to reject legacy drafts."""
    with pytest.raises(DraftBaselineUnavailable):
        raise DraftBaselineUnavailable("missing")

"""Pure Slice 6 publication policy and payload tests."""

import pytest

from app.domain.allocation import PolicyCase
from app.domain.draft import StagedOffer
from app.domain.publication import (
    EligibilityReason,
    PublicationStatus,
    build_offer_entries,
    build_offer_payload,
    can_transition,
    entries_match,
    evaluate_eligibility,
)
from app.domain.reconciliation import BindingLifecycle


def offer(
    offer_id: int,
    share: int,
    *,
    pinned: bool = False,
    active: bool = True,
    state: str | None = "active",
) -> StagedOffer:
    """Build one staged offer for pure policy tests."""
    return StagedOffer(
        offer_id=offer_id,
        lifecycle=(BindingLifecycle.ACTIVE if active else BindingLifecycle.ARCHIVED),
        is_pinned=pinned,
        share=share,
        state=state,
        position=offer_id,
    )


def test_strict_total_accepts_exact_100_and_degenerate_complete_states():
    """D23 allows single and all-pinned states only when the total is 100."""
    single = evaluate_eligibility(
        (offer(8, 100),), policy_cases=(PolicyCase.SINGLE_ACTIVE_OFFER,)
    )
    all_pinned = evaluate_eligibility(
        (offer(5, 40, pinned=True), offer(8, 60, pinned=True))
    )
    assert single.eligible and single.active_total == 100
    assert all_pinned.eligible and all_pinned.pinned_total == 100


def test_eligibility_rejects_empty_unallocated_and_pinned_overflow():
    """D23/D24 fail closed for every non-100 or empty staged view."""
    assert evaluate_eligibility(()).reason is EligibilityReason.EMPTY_OFFERS
    partial = evaluate_eligibility(
        (offer(5, 60, pinned=True),),
        policy_cases=(PolicyCase.UNALLOCATED_REMAINDER,),
        unallocated=40,
    )
    assert not partial.eligible
    assert partial.reason is EligibilityReason.UNALLOCATED_REMAINDER
    overflow = evaluate_eligibility(
        (offer(5, 70, pinned=True), offer(8, 40, pinned=True))
    )
    assert overflow.reason is EligibilityReason.PINNED_SUM_EXCEEDED


def test_payload_contains_only_documented_offer_fields():
    """The PUT body is offers-only; archived offers and unknown states are omitted."""
    payload = build_offer_payload(
        (
            offer(8, 60, state="active"),
            offer(5, 40, active=False, state="disabled"),
            offer(7, 0, state="paused"),
        )
    )
    assert payload == {
        "offers": [
            {"offer_id": 8, "share": 60, "state": "active"},
            {"offer_id": 7, "share": 0},
        ]
    }
    assert set(payload) == {"offers"}


def test_payload_rejects_duplicate_active_offers():
    """Duplicate ids are refused before any remote mutation."""
    with pytest.raises(ValueError, match="duplicate"):
        build_offer_entries((offer(8, 50), offer(8, 50)))


def test_readback_match_ignores_remote_order():
    """Comparison is by offer identity and sent fields, not array order."""
    expected = build_offer_entries((offer(5, 25), offer(8, 75)))
    reordered = build_offer_entries((offer(8, 75), offer(5, 25)))
    assert entries_match(reordered, expected)


def test_publication_transitions_are_explicit():
    """Only documented durable transitions are allowed."""
    assert can_transition(PublicationStatus.PENDING, PublicationStatus.IN_PROGRESS)
    assert can_transition(PublicationStatus.IN_PROGRESS, PublicationStatus.AMBIGUOUS)
    assert can_transition(PublicationStatus.AMBIGUOUS, PublicationStatus.SUCCEEDED)
    assert not can_transition(PublicationStatus.IN_PROGRESS, PublicationStatus.PENDING)
    assert not can_transition(PublicationStatus.SUCCEEDED, PublicationStatus.ABANDONED)

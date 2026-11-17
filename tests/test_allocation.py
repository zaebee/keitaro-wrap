"""Table-driven tests for the pure allocation domain (D11/D12)."""

import itertools
from typing import cast

import pytest

from app.domain.allocation import (
    AllocatableOffer,
    DuplicateOfferIdError,
    InvalidOfferInputError,
    InvalidShareError,
    OfferShare,
    PinnedTotalExceededError,
    PolicyCase,
    allocate,
)


def offer(offer_id: int, share: int, is_pinned: bool = False) -> AllocatableOffer:
    """Build one active offer input."""
    return AllocatableOffer(offer_id=offer_id, is_pinned=is_pinned, share=share)


def test_equal_distribution_without_pinned_offers():
    """Three unpinned offers split 100 as 34/33/33 by ascending offer_id."""
    result = allocate([offer(3, 0), offer(1, 0), offer(2, 0)])

    assert result.shares == (
        OfferShare(1, False, 34),
        OfferShare(2, False, 33),
        OfferShare(3, False, 33),
    )
    assert result.pinned_total == 0
    assert result.unallocated == 0
    assert result.policy_cases == ()


def test_pinned_shares_are_preserved():
    """A pinned 25% stays fixed while three unpinned offers split 75%."""
    result = allocate([offer(1, 25, True), offer(2, 0), offer(3, 0), offer(4, 0)])

    assert result.shares == (
        OfferShare(1, True, 25),
        OfferShare(2, False, 25),
        OfferShare(3, False, 25),
        OfferShare(4, False, 25),
    )
    assert result.pinned_total == 25
    assert result.unallocated == 0


def test_remainder_goes_to_lowest_offer_ids():
    """One leftover point goes to the lowest unpinned offer_id, not input order."""
    result = allocate([offer(4, 0), offer(1, 24, True), offer(3, 0), offer(2, 0)])

    assert result.shares == (
        OfferShare(1, True, 24),
        OfferShare(2, False, 26),
        OfferShare(3, False, 25),
        OfferShare(4, False, 25),
    )
    assert result.unallocated == 0


def test_input_order_independence():
    """Every permutation of the same active set yields the identical result."""
    offers = [offer(1, 25, True), offer(2, 0), offer(3, 0), offer(4, 0)]
    expected = allocate(offers)

    for permutation in itertools.permutations(offers):
        assert allocate(permutation) == expected


@pytest.mark.parametrize("count", range(1, 9))
def test_even_split_is_complete_and_sorted(count):
    """LRM distributes every point with the offer_id tie-break for 1..8 offers."""
    offers = [offer(offer_id, 0) for offer_id in range(count, 0, -1)]
    base, extra = divmod(100, count)
    expected = tuple(
        OfferShare(offer_id, False, base + (1 if offer_id <= extra else 0))
        for offer_id in range(1, count + 1)
    )

    assert allocate(offers).shares == expected


def test_pinned_total_exactly_100():
    """Fully pinned capacity is valid and leaves no unallocated remainder."""
    result = allocate([offer(2, 40, True), offer(1, 60, True), offer(3, 0)])

    assert result.shares == (
        OfferShare(1, True, 60),
        OfferShare(2, True, 40),
        OfferShare(3, False, 0),
    )
    assert result.pinned_total == 100
    assert result.unallocated == 0
    assert result.policy_cases == ()


def test_pinned_total_above_100_is_rejected():
    """Pinned shares above 100 raise a typed input error."""
    offers = [offer(1, 60, True), offer(2, 50, True)]
    with pytest.raises(PinnedTotalExceededError, match="exceeds 100"):
        allocate(offers)


def test_no_unpinned_offers_exposes_unallocated_remainder():
    """A single pinned offer leaves its remaining capacity explicit."""
    result = allocate([offer(1, 30, True)])

    assert result.shares == (OfferShare(1, True, 30),)
    assert result.pinned_total == 30
    assert result.unallocated == 70
    assert result.policy_cases == (
        PolicyCase.SINGLE_ACTIVE_OFFER,
        PolicyCase.UNALLOCATED_REMAINDER,
    )


def test_all_pinned_below_100_exposes_remainder():
    """All-pinned capacity below 100 is reported, not silently normalized."""
    result = allocate([offer(2, 30, True), offer(1, 20, True)])

    assert result.unallocated == 50
    assert result.policy_cases == (PolicyCase.UNALLOCATED_REMAINDER,)


def test_zero_active_offers():
    """An empty active set yields no shares and an explicit policy case."""
    result = allocate([])

    assert result.shares == ()
    assert result.pinned_total == 0
    assert result.unallocated == 100
    assert result.policy_cases == (
        PolicyCase.NO_ACTIVE_OFFERS,
        PolicyCase.UNALLOCATED_REMAINDER,
    )


def test_single_unpinned_offer_receives_all_capacity():
    """One unpinned offer gets 100% as specified, with the boundary flagged."""
    result = allocate([offer(7, 0)])

    assert result.shares == (OfferShare(7, False, 100),)
    assert result.unallocated == 0
    assert result.policy_cases == (PolicyCase.SINGLE_ACTIVE_OFFER,)


@pytest.mark.parametrize("share", [-1, 101])
def test_out_of_range_share_is_rejected(share):
    """Shares outside 0..100 raise a typed input error."""
    offers = [offer(1, share)]
    with pytest.raises(InvalidShareError):
        allocate(offers)


@pytest.mark.parametrize("share", [cast(int, 12.5), cast(int, True)])
def test_non_integer_share_is_rejected(share):
    """Non-integer shares, including bool, are rejected at runtime."""
    offers = [offer(1, share)]
    with pytest.raises(InvalidShareError):
        allocate(offers)


@pytest.mark.parametrize(
    "bad_id", [cast(int, True), cast(int, 1.5), cast(int, "7"), cast(int, None)]
)
def test_non_integer_offer_id_is_rejected(bad_id):
    """offer_id must be a real int; bool, float, str and None are rejected."""
    offers = [offer(bad_id, 50)]
    with pytest.raises(InvalidOfferInputError, match="offer_id must be an int"):
        allocate(offers)


@pytest.mark.parametrize(
    "bad_flag", [cast(bool, 0), cast(bool, 1), cast(bool, "true"), cast(bool, None)]
)
def test_non_bool_is_pinned_is_rejected(bad_flag):
    """is_pinned must be a real bool, not an int or another value."""
    offers = [offer(1, 50, bad_flag)]
    with pytest.raises(InvalidOfferInputError, match="is_pinned must be a bool"):
        allocate(offers)


def test_offer_id_range_is_not_constrained():
    """No extra offer_id range rule is imposed by the allocator."""
    result = allocate([offer(10**12, 0), offer(-5, 0), offer(0, 0)])

    assert [share.offer_id for share in result.shares] == [-5, 0, 10**12]
    assert [share.share for share in result.shares] == [34, 33, 33]


def test_duplicate_offer_id_is_rejected():
    """Duplicate offer_ids make the ascending tie-break ambiguous."""
    offers = [offer(5, 40), offer(5, 60)]
    with pytest.raises(DuplicateOfferIdError, match="duplicate offer_id 5"):
        allocate(offers)


def test_inputs_are_not_mutated():
    """Callers keep their list and frozen input rows unchanged."""
    offers = [offer(3, 0), offer(1, 20, True), offer(2, 0)]
    snapshot = tuple(offers)

    result = allocate(offers)

    assert offers == list(snapshot)
    assert result.shares == (
        OfferShare(1, True, 20),
        OfferShare(2, False, 40),
        OfferShare(3, False, 40),
    )
    assert isinstance(result.shares, tuple)

"""Deterministic integer offer-share allocation (D11/D12).

The allocator receives the current active offer set and its pinned/share state.
It does not decide add/remove/restore/pin policy, and it performs no I/O.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from enum import Enum


class AllocationError(ValueError):
    """Base class for allocation input that cannot be processed."""


class InvalidShareError(AllocationError):
    """A share is not an integer percentage in the inclusive range 0..100."""


class DuplicateOfferIdError(AllocationError):
    """The same offer_id appears more than once in the active set."""


class PinnedTotalExceededError(AllocationError):
    """Pinned shares sum to more than 100 percent."""


class PolicyCase(Enum):
    """Open product policy boundary surfaced by a calculation, not resolved by it."""

    NO_ACTIVE_OFFERS = "no_active_offers"
    SINGLE_ACTIVE_OFFER = "single_active_offer"
    UNALLOCATED_REMAINDER = "unallocated_remainder"


@dataclass(frozen=True)
class AllocatableOffer:
    """One active offer: its remote id, pin state and current share.

    ``share`` is validated as an integer percentage. Pinned shares are fixed
    inputs; unpinned shares are baseline data only and are recomputed by LRM.
    """

    offer_id: int
    is_pinned: bool
    share: int


@dataclass(frozen=True)
class OfferShare:
    """Allocated share for one offer in the returned, deterministic order."""

    offer_id: int
    is_pinned: bool
    share: int


@dataclass(frozen=True)
class AllocationResult:
    """Explicit result of a pure allocation, including unresolved policy cases."""

    shares: tuple[OfferShare, ...]
    pinned_total: int
    unallocated: int
    policy_cases: tuple[PolicyCase, ...]


def allocate(offers: Iterable[AllocatableOffer]) -> AllocationResult:
    """Allocate 100 integer percentage points using LRM with offer_id tie-break.

    Pinned shares stay unchanged. The remaining capacity is divided evenly over
    active unpinned offers; leftover points go to the lowest offer_ids first.
    Invalid input raises a typed ``AllocationError``. Open policy boundaries are
    returned in ``policy_cases`` with any unallocated remainder, never hidden.
    """
    items = tuple(offers)

    for offer in items:
        if type(offer.share) is not int or not 0 <= offer.share <= 100:
            raise InvalidShareError(
                f"offer {offer.offer_id}: share must be an int in 0..100, "
                f"got {offer.share!r}"
            )

    seen: set[int] = set()
    for offer in items:
        if offer.offer_id in seen:
            raise DuplicateOfferIdError(f"duplicate offer_id {offer.offer_id}")
        seen.add(offer.offer_id)

    pinned = tuple(offer for offer in items if offer.is_pinned)
    unpinned = tuple(offer for offer in items if not offer.is_pinned)
    pinned_total = sum(offer.share for offer in pinned)
    if pinned_total > 100:
        raise PinnedTotalExceededError(
            f"pinned total {pinned_total} exceeds 100 percent"
        )

    remaining = 100 - pinned_total
    allocated: dict[int, int] = {offer.offer_id: offer.share for offer in pinned}
    if unpinned:
        base, extra = divmod(remaining, len(unpinned))
        for index, offer in enumerate(sorted(unpinned, key=lambda item: item.offer_id)):
            allocated[offer.offer_id] = base + (1 if index < extra else 0)

    shares = tuple(
        OfferShare(
            offer_id=offer.offer_id,
            is_pinned=offer.is_pinned,
            share=allocated[offer.offer_id],
        )
        for offer in sorted(items, key=lambda item: item.offer_id)
    )
    unallocated = 100 - sum(share.share for share in shares)

    cases: list[PolicyCase] = []
    if not items:
        cases.append(PolicyCase.NO_ACTIVE_OFFERS)
    if len(items) == 1:
        cases.append(PolicyCase.SINGLE_ACTIVE_OFFER)
    if unallocated:
        cases.append(PolicyCase.UNALLOCATED_REMAINDER)

    return AllocationResult(
        shares=shares,
        pinned_total=pinned_total,
        unallocated=unallocated,
        policy_cases=tuple(cases),
    )

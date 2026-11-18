"""Pure publication eligibility, payload mapping and state transitions (Slice 6)."""

from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum

from app.domain.allocation import PolicyCase
from app.domain.draft import StagedOffer
from app.domain.reconciliation import BindingLifecycle


class PublicationStatus(StrEnum):
    """Durable status of one per-stream publication operation."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    AMBIGUOUS = "ambiguous"
    ABANDONED = "abandoned"


UNRESOLVED_STATUSES: tuple[PublicationStatus, ...] = (
    PublicationStatus.PENDING,
    PublicationStatus.IN_PROGRESS,
    PublicationStatus.AMBIGUOUS,
)

_ALLOWED_TRANSITIONS: dict[PublicationStatus, frozenset[PublicationStatus]] = {
    PublicationStatus.PENDING: frozenset(
        {PublicationStatus.IN_PROGRESS, PublicationStatus.ABANDONED}
    ),
    PublicationStatus.IN_PROGRESS: frozenset(
        {
            PublicationStatus.SUCCEEDED,
            PublicationStatus.FAILED,
            PublicationStatus.AMBIGUOUS,
        }
    ),
    PublicationStatus.SUCCEEDED: frozenset(),
    PublicationStatus.FAILED: frozenset({PublicationStatus.ABANDONED}),
    PublicationStatus.AMBIGUOUS: frozenset(
        {PublicationStatus.SUCCEEDED, PublicationStatus.ABANDONED}
    ),
    PublicationStatus.ABANDONED: frozenset(),
}


class PublicationInputError(ValueError):
    """A publication input cannot be mapped to a safe remote request."""


class EligibilityReason(StrEnum):
    """Why a staged view is not eligible for publication."""

    EMPTY_OFFERS = "empty_offers"
    PINNED_SUM_EXCEEDED = "pinned_sum_exceeded"
    UNALLOCATED_REMAINDER = "unallocated_remainder"
    INVALID_TOTAL = "invalid_total"


@dataclass(frozen=True)
class EligibilityResult:
    """Pure eligibility verdict for one staged stream view."""

    eligible: bool
    active_total: int
    pinned_total: int
    policy_cases: tuple[PolicyCase, ...]
    reason: EligibilityReason | None = None


@dataclass(frozen=True)
class OfferEntry:
    """One documented ``OfferStreamRequest`` entry."""

    offer_id: int
    share: int
    state: str | None = None

    def to_json(self) -> dict[str, object]:
        """Serialise only fields declared by the Keitaro request schema."""
        value: dict[str, object] = {"offer_id": self.offer_id, "share": self.share}
        if self.state is not None:
            value["state"] = self.state
        return value


_WRITABLE_OFFER_STATES = frozenset({"active", "disabled"})


def can_transition(current: PublicationStatus, target: PublicationStatus) -> bool:
    """Return whether one durable publication transition is allowed."""
    return target in _ALLOWED_TRANSITIONS[current]


def evaluate_eligibility(
    offers: Iterable[StagedOffer],
    *,
    policy_cases: tuple[PolicyCase, ...] = (),
    unallocated: int = 0,
) -> EligibilityResult:
    """Apply accepted D23/D24: non-empty active offers with a total of exactly 100."""
    active = tuple(
        offer for offer in offers if offer.lifecycle is BindingLifecycle.ACTIVE
    )
    if not active:
        return EligibilityResult(
            False, 0, 0, policy_cases, EligibilityReason.EMPTY_OFFERS
        )

    pinned_total = sum(offer.share for offer in active if offer.is_pinned)
    if pinned_total > 100:
        return EligibilityResult(
            False,
            sum(offer.share for offer in active),
            pinned_total,
            policy_cases,
            EligibilityReason.PINNED_SUM_EXCEEDED,
        )

    total = sum(offer.share for offer in active)
    if total != 100:
        reason = (
            EligibilityReason.UNALLOCATED_REMAINDER
            if unallocated > 0 or total < 100
            else EligibilityReason.INVALID_TOTAL
        )
        return EligibilityResult(False, total, pinned_total, policy_cases, reason)
    return EligibilityResult(True, total, pinned_total, policy_cases)


def build_offer_entries(offers: Iterable[StagedOffer]) -> tuple[OfferEntry, ...]:
    """Build the exact offers-only request entries from active staged offers."""
    entries: list[OfferEntry] = []
    seen: set[int] = set()
    for offer in offers:
        if offer.lifecycle is not BindingLifecycle.ACTIVE:
            continue
        if type(offer.offer_id) is not int or offer.offer_id <= 0:
            raise PublicationInputError("offer_id must be a positive int")
        if type(offer.share) is not int or not 0 <= offer.share <= 100:
            raise PublicationInputError(
                f"offer {offer.offer_id}: share must be an int in 0..100"
            )
        if offer.offer_id in seen:
            raise PublicationInputError(f"duplicate offer_id {offer.offer_id}")
        seen.add(offer.offer_id)
        state = offer.state if offer.state in _WRITABLE_OFFER_STATES else None
        entries.append(OfferEntry(offer.offer_id, offer.share, state))
    return tuple(entries)


def build_offer_payload(offers: Iterable[StagedOffer]) -> dict[str, object]:
    """Build the exact offers-only PUT body; no stream-level field is copied."""
    return {"offers": [entry.to_json() for entry in build_offer_entries(offers)]}


def entries_match(
    observed: Iterable[OfferEntry], expected: Iterable[OfferEntry]
) -> bool:
    """Compare read-back entries with the sent set, independent of remote order."""
    wanted = {entry.offer_id: entry for entry in expected}
    found = {entry.offer_id: entry for entry in observed}
    return found == wanted

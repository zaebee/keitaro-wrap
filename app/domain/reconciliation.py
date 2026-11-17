"""Pure primitives for reconciling remote stream offers with committed bindings."""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum


class RemoteOfferValidationError(ValueError):
    """A remote offer payload cannot be reconciled safely."""


class InvalidRemoteOfferError(RemoteOfferValidationError):
    """A remote offer has an invalid field type or value."""


class DuplicateRemoteOfferError(RemoteOfferValidationError):
    """A remote offer array contains the same offer_id more than once."""


@dataclass(frozen=True)
class RemoteOffer:
    """One observed remote offer entry, including its position in the array."""

    offer_id: int
    share: int
    state: str | None = None
    position: int = 0


class BindingLifecycle(StrEnum):
    """Committed lifecycle of a wrapper-owned offer binding."""

    ACTIVE = "ACTIVE"
    ARCHIVED = "ARCHIVED"


class TransitionKind(StrEnum):
    """Kind of committed binding change required by a remote observation."""

    CREATED = "CREATED"
    ARCHIVED = "ARCHIVED"
    REACTIVATED = "REACTIVATED"
    SHARE_CHANGED = "SHARE_CHANGED"


@dataclass(frozen=True)
class BindingState:
    """Committed binding state used as a reconciliation input."""

    offer_id: int
    lifecycle: BindingLifecycle
    is_pinned: bool
    last_remote_share: int | None


@dataclass(frozen=True)
class BindingTransition:
    """One atomic change to a committed binding or its remote share cache."""

    offer_id: int
    kind: TransitionKind
    share: int | None = None


@dataclass(frozen=True)
class ConflictDetail:
    """Structured difference between draft intent and a new remote observation."""

    stream_ref: int
    offer_id: int
    field: str
    expected: int | None
    observed: int | None
    reason: str

    def key(self) -> tuple[object, ...]:
        """Return a stable identity for de-duplication across Fetches."""
        return (
            self.stream_ref,
            self.offer_id,
            self.field,
            self.expected,
            self.observed,
            self.reason,
        )


@dataclass(frozen=True)
class DraftState:
    """The staged side of a stream; Fetch may only add conflict markers."""

    baseline_offers: tuple[RemoteOffer, ...]
    staged_changes: Mapping[str, object]
    is_stale: bool
    conflicts: tuple[ConflictDetail, ...]


@dataclass(frozen=True)
class ReconciliationPlan:
    """Pure result of comparing one remote observation with local state."""

    stream_ref: int
    remote_offers: tuple[RemoteOffer, ...]
    transitions: tuple[BindingTransition, ...]
    conflicts: tuple[ConflictDetail, ...]


def validate_remote_offers(offers: Iterable[RemoteOffer]) -> tuple[RemoteOffer, ...]:
    """Validate observed offers, including duplicate ids, without changing them."""
    items = tuple(offers)
    seen: set[int] = set()
    for offer in items:
        if type(offer.offer_id) is not int or offer.offer_id <= 0:
            raise InvalidRemoteOfferError("offer_id must be a positive int")
        if type(offer.share) is not int or not 0 <= offer.share <= 100:
            raise InvalidRemoteOfferError(
                f"offer {offer.offer_id}: share must be an int in 0..100"
            )
        if offer.state is not None and not isinstance(offer.state, str):
            raise InvalidRemoteOfferError(
                f"offer {offer.offer_id}: state must be a string or None"
            )
        if type(offer.position) is not int or offer.position < 0:
            raise InvalidRemoteOfferError(
                f"offer {offer.offer_id}: position must be a non-negative int"
            )
        if offer.offer_id in seen:
            raise DuplicateRemoteOfferError(f"duplicate offer_id {offer.offer_id}")
        seen.add(offer.offer_id)
    return items


def _share_edit_ids(staged_changes: Mapping[str, object]) -> frozenset[int]:
    """Read the offer ids with staged share edits from a draft changes map."""
    raw = staged_changes.get("share_edits")
    if not isinstance(raw, Mapping):
        return frozenset()
    ids: set[int] = set()
    for key in raw:
        if type(key) is int:
            ids.add(key)
        elif isinstance(key, str) and key.isdigit():
            ids.add(int(key))
    return frozenset(ids)


def _merge_conflicts(
    existing: tuple[ConflictDetail, ...], new: tuple[ConflictDetail, ...]
) -> tuple[ConflictDetail, ...]:
    """Keep all prior conflicts, append new ones once, and sort deterministically."""
    merged: dict[tuple[object, ...], ConflictDetail] = {}
    for conflict in (*existing, *new):
        merged.setdefault(conflict.key(), conflict)
    return tuple(
        merged[key]
        for key in sorted(
            merged,
            key=lambda item: (
                item[0],
                item[1],
                item[2],
                str(item[3]),
                str(item[4]),
                item[5],
            ),
        )
    )


def _draft_conflicts(
    *,
    stream_ref: int,
    remote: tuple[RemoteOffer, ...],
    transitions: tuple[BindingTransition, ...],
    draft: DraftState,
) -> tuple[ConflictDetail, ...]:
    """Describe remote differences relative to the draft's own baseline."""
    baseline = {
        offer.offer_id: offer for offer in validate_remote_offers(draft.baseline_offers)
    }
    observed = {offer.offer_id: offer for offer in remote}
    baseline_ids = frozenset(baseline)
    remote_ids = frozenset(observed)
    reappeared = frozenset(
        transition.offer_id
        for transition in transitions
        if transition.kind is TransitionKind.REACTIVATED
    )

    found: list[ConflictDetail] = []
    for offer_id in sorted((remote_ids - baseline_ids) - reappeared):
        found.append(
            ConflictDetail(
                stream_ref, offer_id, "offer", None, offer_id, "remote_offer_added"
            )
        )
    for offer_id in sorted(baseline_ids - remote_ids):
        found.append(
            ConflictDetail(
                stream_ref, offer_id, "offer", offer_id, None, "remote_offer_removed"
            )
        )
    for offer_id in sorted(reappeared & remote_ids):
        found.append(
            ConflictDetail(
                stream_ref,
                offer_id,
                "offer",
                None,
                offer_id,
                "remote_offer_reappeared",
            )
        )
    for offer_id in sorted(
        _share_edit_ids(draft.staged_changes) & baseline_ids & remote_ids
    ):
        expected = baseline[offer_id].share
        actual = observed[offer_id].share
        if expected != actual:
            found.append(
                ConflictDetail(
                    stream_ref,
                    offer_id,
                    "share",
                    expected,
                    actual,
                    "remote_share_changed",
                )
            )
    return _merge_conflicts(draft.conflicts, tuple(found))


def plan_reconciliation(
    *,
    stream_ref: int,
    remote_offers: Iterable[RemoteOffer],
    previous_bindings: Iterable[BindingState],
    draft: DraftState | None = None,
) -> ReconciliationPlan:
    """Plan committed binding transitions and draft conflicts for one stream."""
    remote = validate_remote_offers(remote_offers)
    remote_ids = {offer.offer_id for offer in remote}
    bindings = {binding.offer_id: binding for binding in previous_bindings}

    transitions: list[BindingTransition] = []
    for offer in remote:
        binding = bindings.get(offer.offer_id)
        if binding is None:
            kind = TransitionKind.CREATED
        elif binding.lifecycle is BindingLifecycle.ARCHIVED:
            kind = TransitionKind.REACTIVATED
        elif binding.last_remote_share != offer.share:
            kind = TransitionKind.SHARE_CHANGED
        else:
            continue
        transitions.append(BindingTransition(offer.offer_id, kind, offer.share))

    for offer_id, binding in bindings.items():
        if offer_id not in remote_ids and binding.lifecycle is BindingLifecycle.ACTIVE:
            transitions.append(BindingTransition(offer_id, TransitionKind.ARCHIVED))

    ordered = tuple(
        sorted(transitions, key=lambda item: (item.offer_id, item.kind.value))
    )
    conflicts = (
        ()
        if draft is None
        else _draft_conflicts(
            stream_ref=stream_ref,
            remote=remote,
            transitions=ordered,
            draft=draft,
        )
    )
    return ReconciliationPlan(
        stream_ref=stream_ref,
        remote_offers=remote,
        transitions=ordered,
        conflicts=conflicts,
    )

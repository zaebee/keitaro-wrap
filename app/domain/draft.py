"""Pure staged-draft planning for local offer edits (Slice 5)."""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from enum import StrEnum

from app.domain.allocation import (
    AllocatableOffer,
    AllocationResult,
    PolicyCase,
    allocate,
)
from app.domain.reconciliation import (
    BindingLifecycle,
    RemoteOffer,
    validate_remote_offers,
)


class DraftInputError(ValueError):
    """A draft command cannot be applied to the captured baseline."""


class DraftBaselineUnavailable(ValueError):
    """A draft lacks the immutable baselines required for a reproducible view."""


class DraftCommandKind(StrEnum):
    """Kinds of local staging command."""

    ADD = "add"
    REMOVE = "remove"
    RESTORE = "restore"
    SET_PIN = "set_pin"
    SET_SHARE = "set_share"
    CANCEL = "cancel"


@dataclass(frozen=True)
class DraftCommand:
    """A pure staging command with optional target and value."""

    kind: DraftCommandKind
    offer_id: int | None = None
    value: int | bool | None = None


@dataclass(frozen=True)
class BaselineBinding:
    """Committed lifecycle and pin captured when a draft is created."""

    offer_id: int
    lifecycle: BindingLifecycle
    is_pinned: bool


@dataclass(frozen=True)
class StagedOffer:
    """One offer in the derived staged view."""

    offer_id: int
    lifecycle: BindingLifecycle
    is_pinned: bool
    share: int
    state: str | None
    position: int


@dataclass(frozen=True)
class DraftViewData:
    """Derived staged view plus explicit allocation policy information."""

    offers: tuple[StagedOffer, ...]
    policy_cases: tuple[PolicyCase, ...]
    unallocated: int


@dataclass(frozen=True)
class DraftIntent:
    """Normalised staged intent kept in ``StreamDraft.staged_changes``."""

    additions: tuple[int, ...] = ()
    archives: tuple[int, ...] = ()
    restores: tuple[int, ...] = ()
    pin_toggles: Mapping[int, bool] = field(default_factory=dict)
    share_edits: Mapping[int, int] = field(default_factory=dict)

    @property
    def has_changes(self) -> bool:
        """Return whether any staged intent is present."""
        return bool(
            self.additions
            or self.archives
            or self.restores
            or self.pin_toggles
            or self.share_edits
        )

    def to_json(self) -> dict[str, object]:
        """Serialise with string keys while keeping S4's share_edits mapping."""
        data: dict[str, object] = {}
        if self.additions:
            data["additions"] = list(self.additions)
        if self.archives:
            data["archives"] = list(self.archives)
        if self.restores:
            data["restores"] = list(self.restores)
        if self.pin_toggles:
            data["pin_toggles"] = {
                str(key): value for key, value in sorted(self.pin_toggles.items())
            }
        if self.share_edits:
            data["share_edits"] = {
                str(key): value for key, value in sorted(self.share_edits.items())
            }
        return data


@dataclass(frozen=True)
class DraftContext:
    """Immutable inputs used to derive a staged view."""

    stream_ref: int
    baseline_offers: tuple[RemoteOffer, ...]
    baseline_bindings: tuple[BaselineBinding, ...]
    intent: DraftIntent = field(default_factory=DraftIntent)


@dataclass(frozen=True)
class DraftPlan:
    """Result of applying one command to a draft context."""

    intent: DraftIntent
    view: DraftViewData
    noop: bool


def validate_share(value: object) -> int:
    """Require a non-bool integer percentage in 0..100 (D20)."""
    if type(value) is not int or not 0 <= value <= 100:
        raise DraftInputError(f"share must be an int in 0..100, got {value!r}")
    return value


def _ordered_ids(context: DraftContext) -> tuple[int, ...]:
    """Return known offers in stable order: baseline, additions, archived-only."""
    ids: list[int] = []
    for offer in context.baseline_offers:
        if offer.offer_id not in ids:
            ids.append(offer.offer_id)
    for offer_id in sorted(context.intent.additions):
        if offer_id not in ids:
            ids.append(offer_id)
    for binding in sorted(context.baseline_bindings, key=lambda item: item.offer_id):
        if binding.offer_id not in ids:
            ids.append(binding.offer_id)
    return tuple(ids)


def _view_from_allocations(
    items: list[StagedOffer], result: AllocationResult | None
) -> DraftViewData:
    """Apply allocated shares to active items; archived items keep share 0."""
    if result is None:
        return DraftViewData(tuple(items), (), 0)
    shares = {item.offer_id: item.share for item in result.shares}
    offers = tuple(
        replace(item, share=shares.get(item.offer_id, 0))
        if item.lifecycle is BindingLifecycle.ACTIVE
        else item
        for item in items
    )
    return DraftViewData(offers, result.policy_cases, result.unallocated)


def _derive_view(context: DraftContext, *, apply_intent: bool) -> DraftViewData:
    """Build either the immutable baseline view or the allocated staged view."""
    offers = validate_remote_offers(context.baseline_offers)
    baseline = {offer.offer_id: offer for offer in offers}
    bindings = {item.offer_id: item for item in context.baseline_bindings}
    intent = context.intent if apply_intent else DraftIntent()
    archives = set(intent.archives)
    restores = set(intent.restores)

    items: list[StagedOffer] = []
    for position, offer_id in enumerate(_ordered_ids(context)):
        if apply_intent and offer_id in archives and offer_id not in restores:
            lifecycle = BindingLifecycle.ARCHIVED
        else:
            binding = bindings.get(offer_id)
            lifecycle = (
                binding.lifecycle if binding is not None else BindingLifecycle.ACTIVE
            )
            if apply_intent and offer_id in restores:
                lifecycle = BindingLifecycle.ACTIVE
        binding = bindings.get(offer_id)
        is_pinned = binding.is_pinned if binding is not None else False
        if apply_intent and offer_id in intent.pin_toggles:
            is_pinned = intent.pin_toggles[offer_id]
        baseline_offer = baseline.get(offer_id)
        share = baseline_offer.share if baseline_offer is not None else 0
        if apply_intent and offer_id in intent.share_edits:
            share = intent.share_edits[offer_id]
        if lifecycle is BindingLifecycle.ARCHIVED:
            share = 0
        items.append(
            StagedOffer(
                offer_id=offer_id,
                lifecycle=lifecycle,
                is_pinned=is_pinned,
                share=share,
                state=baseline_offer.state if baseline_offer is not None else None,
                position=position,
            )
        )

    if not apply_intent:
        return _view_from_allocations(items, None)
    active = (
        AllocatableOffer(item.offer_id, item.is_pinned, item.share)
        for item in items
        if item.lifecycle is BindingLifecycle.ACTIVE
    )
    return _view_from_allocations(items, allocate(active))


def _baseline_view(context: DraftContext) -> DraftViewData:
    """Return the allocated view of the immutable baselines."""
    raw = _derive_view(context, apply_intent=False)
    active = (
        AllocatableOffer(item.offer_id, item.is_pinned, item.share)
        for item in raw.offers
        if item.lifecycle is BindingLifecycle.ACTIVE
    )
    return _view_from_allocations(list(raw.offers), allocate(active))


def _staged_view(context: DraftContext, intent: DraftIntent) -> DraftViewData:
    """Return the allocated view produced by an accumulated intent."""
    return _derive_view(
        DraftContext(
            context.stream_ref,
            context.baseline_offers,
            context.baseline_bindings,
            intent,
        ),
        apply_intent=True,
    )


def _require_offer_id(command: DraftCommand) -> int:
    """Return a validated target offer id."""
    if type(command.offer_id) is not int or command.offer_id <= 0:
        raise DraftInputError("offer_id must be a positive int")
    return command.offer_id


def _target_offer(view: DraftViewData, offer_id: int) -> StagedOffer | None:
    """Find an offer in a derived view."""
    return next((item for item in view.offers if item.offer_id == offer_id), None)


def plan_edit(context: DraftContext, command: DraftCommand) -> DraftPlan:
    """Apply one staging command and normalise semantic no-ops."""
    baseline_view = _baseline_view(context)
    baseline_ids = {item.offer_id for item in baseline_view.offers}
    raw_offers = {item.offer_id: item for item in context.baseline_offers}
    raw_bindings = {item.offer_id: item for item in context.baseline_bindings}

    if command.kind is DraftCommandKind.CANCEL:
        noop = not context.intent.has_changes
        return DraftPlan(
            DraftIntent() if not noop else context.intent,
            baseline_view,
            noop,
        )

    offer_id = _require_offer_id(command)
    current = _staged_view(context, context.intent)
    target = _target_offer(current, offer_id)
    additions = set(context.intent.additions)
    archives = set(context.intent.archives)
    restores = set(context.intent.restores)
    pin_toggles = dict(context.intent.pin_toggles)
    share_edits = dict(context.intent.share_edits)

    if command.kind is DraftCommandKind.ADD:
        if target is not None and target.lifecycle is BindingLifecycle.ACTIVE:
            return DraftPlan(context.intent, current, True)
        if offer_id in baseline_ids and target is not None:
            raise DraftInputError(f"offer {offer_id} is archived; use restore")
        additions.add(offer_id)
        archives.discard(offer_id)
        restores.discard(offer_id)

    elif command.kind is DraftCommandKind.REMOVE:
        if target is None or target.lifecycle is BindingLifecycle.ARCHIVED:
            return DraftPlan(context.intent, current, True)
        if offer_id in additions:
            additions.discard(offer_id)
            pin_toggles.pop(offer_id, None)
        else:
            archives.add(offer_id)
            restores.discard(offer_id)
        share_edits.pop(offer_id, None)

    elif command.kind is DraftCommandKind.RESTORE:
        if target is not None and target.lifecycle is BindingLifecycle.ACTIVE:
            return DraftPlan(context.intent, current, True)
        if offer_id not in baseline_ids:
            raise DraftInputError(f"offer {offer_id} has no archived baseline")
        restores.add(offer_id)
        archives.discard(offer_id)

    elif command.kind is DraftCommandKind.SET_PIN:
        if type(command.value) is not bool:
            raise DraftInputError("pin value must be a bool")
        if target is None:
            raise DraftInputError(f"offer {offer_id} is not in the draft baseline")
        if target.is_pinned is command.value:
            return DraftPlan(context.intent, current, True)
        baseline_binding = raw_bindings.get(offer_id)
        baseline_pinned = (
            baseline_binding.is_pinned if baseline_binding is not None else False
        )
        if baseline_pinned is command.value:
            pin_toggles.pop(offer_id, None)
        else:
            pin_toggles[offer_id] = command.value
        if not command.value:
            share_edits.pop(offer_id, None)

    elif command.kind is DraftCommandKind.SET_SHARE:
        share = validate_share(command.value)
        if target is None or target.lifecycle is not BindingLifecycle.ACTIVE:
            raise DraftInputError(f"offer {offer_id} is not active")
        raw_offer = raw_offers.get(offer_id)
        if raw_offer is not None and share == raw_offer.share:
            share_edits.pop(offer_id, None)
            baseline_binding = raw_bindings.get(offer_id)
            if baseline_binding is None or not baseline_binding.is_pinned:
                pin_toggles.pop(offer_id, None)
        else:
            share_edits[offer_id] = share
            pin_toggles[offer_id] = True

    intent = DraftIntent(
        additions=tuple(sorted(additions)),
        archives=tuple(sorted(archives)),
        restores=tuple(sorted(restores)),
        pin_toggles=pin_toggles,
        share_edits=share_edits,
    )
    staged = _staged_view(context, intent)
    if _same_view(staged, baseline_view):
        return DraftPlan(DraftIntent(), baseline_view, True)
    return DraftPlan(intent, staged, False)


def _same_view(left: DraftViewData, right: DraftViewData) -> bool:
    """Compare effective offers for semantic no-op detection."""
    if len(left.offers) != len(right.offers):
        return False
    return all(
        (a.offer_id, a.lifecycle, a.is_pinned, a.share, a.state, a.position)
        == (b.offer_id, b.lifecycle, b.is_pinned, b.share, b.state, b.position)
        for a, b in zip(left.offers, right.offers, strict=True)
    )


def baseline_view(context: DraftContext) -> DraftViewData:
    """Return the public immutable baseline view."""
    return _baseline_view(context)


def staged_view(context: DraftContext, intent: DraftIntent) -> DraftViewData:
    """Return the public allocated view for an accumulated intent."""
    return _staged_view(context, intent)


def load_baseline_bindings(
    values: Iterable[BaselineBinding],
) -> tuple[BaselineBinding, ...]:
    """Return baseline bindings in deterministic offer_id order."""
    return tuple(sorted(values, key=lambda item: item.offer_id))

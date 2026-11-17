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


def _effective_lifecycle(
    offer_id: int,
    binding: BaselineBinding | None,
    archives: set[int],
    restores: set[int],
    apply_intent: bool,
) -> BindingLifecycle:
    """Return lifecycle after staged archive/restore overlays."""
    if apply_intent:
        if offer_id in archives and offer_id not in restores:
            return BindingLifecycle.ARCHIVED
        if offer_id in restores:
            return BindingLifecycle.ACTIVE
    if binding is not None:
        return binding.lifecycle
    return BindingLifecycle.ACTIVE


def _effective_pin(
    offer_id: int,
    binding: BaselineBinding | None,
    pin_toggles: Mapping[int, bool],
    apply_intent: bool,
) -> bool:
    """Return pin state after staged pin overlays."""
    if apply_intent and offer_id in pin_toggles:
        return pin_toggles[offer_id]
    return binding.is_pinned if binding is not None else False


def _effective_share(
    offer_id: int,
    baseline_offer: RemoteOffer | None,
    share_edits: Mapping[int, int],
    lifecycle: BindingLifecycle,
    apply_intent: bool,
) -> int:
    """Return the LRM input share before allocation."""
    if lifecycle is BindingLifecycle.ARCHIVED:
        return 0
    if apply_intent and offer_id in share_edits:
        return share_edits[offer_id]
    return baseline_offer.share if baseline_offer is not None else 0


def _items_from_context(
    context: DraftContext, *, apply_intent: bool
) -> list[StagedOffer]:
    """Build one staged offer per known offer in deterministic order."""
    offers = validate_remote_offers(context.baseline_offers)
    baseline = {offer.offer_id: offer for offer in offers}
    bindings = {item.offer_id: item for item in context.baseline_bindings}
    intent = context.intent if apply_intent else DraftIntent()

    items: list[StagedOffer] = []
    for position, offer_id in enumerate(_ordered_ids(context)):
        binding = bindings.get(offer_id)
        lifecycle = _effective_lifecycle(
            offer_id, binding, set(intent.archives), set(intent.restores), apply_intent
        )
        is_pinned = _effective_pin(offer_id, binding, intent.pin_toggles, apply_intent)
        baseline_offer = baseline.get(offer_id)
        share = _effective_share(
            offer_id,
            baseline_offer,
            intent.share_edits,
            lifecycle,
            apply_intent,
        )
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
    return items


def _derive_view(context: DraftContext, *, apply_intent: bool) -> DraftViewData:
    """Build either the baseline view or the allocated staged view."""
    items = _items_from_context(context, apply_intent=apply_intent)
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


@dataclass
class _IntentState:
    """Mutable working copy of staged intent while planning one command."""

    additions: set[int]
    archives: set[int]
    restores: set[int]
    pin_toggles: dict[int, bool]
    share_edits: dict[int, int]

    @classmethod
    def from_intent(cls, intent: DraftIntent) -> "_IntentState":
        """Create a working copy from persisted intent."""
        return cls(
            set(intent.additions),
            set(intent.archives),
            set(intent.restores),
            dict(intent.pin_toggles),
            dict(intent.share_edits),
        )

    def to_intent(self) -> DraftIntent:
        """Return a normalised immutable intent."""
        return DraftIntent(
            additions=tuple(sorted(self.additions)),
            archives=tuple(sorted(self.archives)),
            restores=tuple(sorted(self.restores)),
            pin_toggles=self.pin_toggles,
            share_edits=self.share_edits,
        )


def _unchanged(intent: DraftIntent, current: DraftViewData) -> DraftPlan:
    """Return a no-op plan preserving the existing intent and view."""
    return DraftPlan(intent, current, True)


def _handle_add(
    state: _IntentState,
    intent: DraftIntent,
    current: DraftViewData,
    target: StagedOffer | None,
    offer_id: int,
    baseline_ids: set[int],
) -> DraftPlan | None:
    """Stage an addition unless the offer is already active."""
    if target is not None and target.lifecycle is BindingLifecycle.ACTIVE:
        return _unchanged(intent, current)
    if offer_id in baseline_ids and target is not None:
        raise DraftInputError(f"offer {offer_id} is archived; use restore")
    state.additions.add(offer_id)
    state.archives.discard(offer_id)
    state.restores.discard(offer_id)
    return None


def _handle_remove(
    state: _IntentState,
    intent: DraftIntent,
    current: DraftViewData,
    target: StagedOffer | None,
    offer_id: int,
) -> DraftPlan | None:
    """Stage an archive or drop a staged addition."""
    if target is None or target.lifecycle is BindingLifecycle.ARCHIVED:
        return _unchanged(intent, current)
    if offer_id in state.additions:
        state.additions.discard(offer_id)
        state.pin_toggles.pop(offer_id, None)
    else:
        state.archives.add(offer_id)
        state.restores.discard(offer_id)
    state.share_edits.pop(offer_id, None)
    return None


def _handle_restore(
    state: _IntentState,
    intent: DraftIntent,
    current: DraftViewData,
    target: StagedOffer | None,
    offer_id: int,
    baseline_ids: set[int],
) -> DraftPlan | None:
    """Stage a reactivation of an offer known to the baseline."""
    if target is not None and target.lifecycle is BindingLifecycle.ACTIVE:
        return _unchanged(intent, current)
    if offer_id not in baseline_ids:
        raise DraftInputError(f"offer {offer_id} has no archived baseline")
    state.restores.add(offer_id)
    state.archives.discard(offer_id)
    return None


def _handle_set_pin(
    state: _IntentState,
    intent: DraftIntent,
    current: DraftViewData,
    target: StagedOffer | None,
    command: DraftCommand,
    offer_id: int,
    raw_bindings: Mapping[int, BaselineBinding],
) -> DraftPlan | None:
    """Stage pin/unpin; unpin also removes a fixed share edit."""
    if type(command.value) is not bool:
        raise DraftInputError("pin value must be a bool")
    if target is None:
        raise DraftInputError(f"offer {offer_id} is not in the draft baseline")
    if target.is_pinned is command.value:
        return _unchanged(intent, current)
    binding = raw_bindings.get(offer_id)
    baseline_pinned = binding.is_pinned if binding is not None else False
    if baseline_pinned is command.value:
        state.pin_toggles.pop(offer_id, None)
    else:
        state.pin_toggles[offer_id] = command.value
    if not command.value:
        state.share_edits.pop(offer_id, None)
    return None


def _handle_set_share(
    state: _IntentState,
    intent: DraftIntent,
    current: DraftViewData,
    target: StagedOffer | None,
    command: DraftCommand,
    offer_id: int,
    raw_offers: Mapping[int, RemoteOffer],
    raw_bindings: Mapping[int, BaselineBinding],
) -> DraftPlan | None:
    """Stage an integer share and its automatic pin (D19/D20)."""
    share = validate_share(command.value)
    if target is None or target.lifecycle is not BindingLifecycle.ACTIVE:
        raise DraftInputError(f"offer {offer_id} is not active")
    raw_offer = raw_offers.get(offer_id)
    if raw_offer is not None and share == raw_offer.share:
        state.share_edits.pop(offer_id, None)
        binding = raw_bindings.get(offer_id)
        if binding is None or not binding.is_pinned:
            state.pin_toggles.pop(offer_id, None)
    else:
        state.share_edits[offer_id] = share
        state.pin_toggles[offer_id] = True
    return None


def _dispatch_command(
    state: _IntentState,
    context: DraftContext,
    command: DraftCommand,
    current: DraftViewData,
    target: StagedOffer | None,
    offer_id: int,
    baseline_ids: set[int],
    raw_offers: Mapping[int, RemoteOffer],
    raw_bindings: Mapping[int, BaselineBinding],
) -> DraftPlan | None:
    """Apply one command to the working intent state."""
    if command.kind is DraftCommandKind.ADD:
        return _handle_add(
            state, context.intent, current, target, offer_id, baseline_ids
        )
    if command.kind is DraftCommandKind.REMOVE:
        return _handle_remove(state, context.intent, current, target, offer_id)
    if command.kind is DraftCommandKind.RESTORE:
        return _handle_restore(
            state, context.intent, current, target, offer_id, baseline_ids
        )
    if command.kind is DraftCommandKind.SET_PIN:
        return _handle_set_pin(
            state, context.intent, current, target, command, offer_id, raw_bindings
        )
    if command.kind is DraftCommandKind.SET_SHARE:
        return _handle_set_share(
            state,
            context.intent,
            current,
            target,
            command,
            offer_id,
            raw_offers,
            raw_bindings,
        )
    raise DraftInputError(f"unsupported command {command.kind}")


def plan_edit(context: DraftContext, command: DraftCommand) -> DraftPlan:
    """Apply one staging command and normalise semantic no-ops."""
    baseline_view = _baseline_view(context)
    if command.kind is DraftCommandKind.CANCEL:
        noop = not context.intent.has_changes
        return DraftPlan(
            DraftIntent() if not noop else context.intent,
            baseline_view,
            noop,
        )

    offer_id = _require_offer_id(command)
    current = _staged_view(context, context.intent)
    state = _IntentState.from_intent(context.intent)
    early = _dispatch_command(
        state,
        context,
        command,
        current,
        _target_offer(current, offer_id),
        offer_id,
        {item.offer_id for item in baseline_view.offers},
        {item.offer_id: item for item in context.baseline_offers},
        {item.offer_id: item for item in context.baseline_bindings},
    )
    if early is not None:
        return early
    intent = state.to_intent()
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

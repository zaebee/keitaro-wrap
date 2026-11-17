"""Application DTOs."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from app.domain.allocation import PolicyCase
from app.domain.campaign_creation import OperationStatus
from app.domain.draft import DraftCommand, DraftCommandKind, StagedOffer
from app.domain.publication import (
    EligibilityReason,
    OfferEntry,
    PublicationStatus,
)
from app.domain.reconciliation import ConflictDetail, RemoteOffer


@dataclass
class DomainDTO:
    """DomainDTO."""

    id: int
    name: str
    state: str | None = None


@dataclass
class GroupDTO:
    """GroupDTO."""

    id: int
    name: str
    type: str | None = None


@dataclass
class TrafficSourceDTO:
    """TrafficSourceDTO."""

    id: int
    name: str
    state: str | None = None


@dataclass
class StreamTypeDTO:
    """StreamTypeDTO."""

    value: str
    name: str


@dataclass
class StreamSchemaDTO:
    """StreamSchemaDTO."""

    value: str
    name: str


@dataclass
class StreamFilterOptionDTO:
    """StreamFilterOptionDTO."""

    value: str
    modes: dict[str, str] | None = None
    group: str | None = None


@dataclass
class StreamActionDTO:
    """StreamActionDTO."""

    key: str
    name: str
    type: str | None = None


@dataclass
class StreamFilterInput:
    """StreamFilterInput."""

    name: str
    mode: str
    payload: list[str] = field(default_factory=list)


@dataclass
class StreamOfferInput:
    """StreamOfferInput."""

    offer_id: int
    share: int
    state: str = "active"


@dataclass
class OfferDTO:
    """OfferDTO."""

    id: int
    name: str
    state: str | None = None
    group_id: int | None = None


@dataclass
class OfferStreamDTO:
    """OfferStreamDTO."""

    offer_id: int
    share: int
    state: str | None = "active"


@dataclass
class StreamFilterDTO:
    """StreamFilterDTO."""

    name: str
    mode: str
    payload: list[str] = field(default_factory=list)


@dataclass
class StreamDTO:
    """StreamDTO."""

    id: int
    campaign_id: int
    type: str
    name: str
    schema: str
    action_type: str | None = None
    action_payload: str | None = None
    filters: list[StreamFilterDTO] = field(default_factory=list)
    offers: list[OfferStreamDTO] = field(default_factory=list)
    comments: str | None = None


@dataclass
class CampaignDTO:
    """CampaignDTO."""

    id: int
    name: str
    alias: str | None = None
    state: str | None = None
    domain_id: int | None = None
    group_id: int | None = None
    traffic_source_id: int | None = None


@dataclass
class CampaignCreateDTO:
    """CampaignCreateDTO."""

    alias: str
    name: str
    domain_id: int | None = None
    group_id: int | None = None
    traffic_source_id: int | None = None


@dataclass
class StreamCreateDTO:
    """StreamCreateDTO."""

    campaign_id: int
    type: str
    name: str
    schema: str
    action_type: str
    action_payload: str | None = None
    filters: list[StreamFilterInput] = field(default_factory=list)
    offers: list[StreamOfferInput] = field(default_factory=list)
    comments: str | None = None


@dataclass
class StreamUpdateDTO:
    """Open-ended PUT body for a stream.

    StreamRequestPut references the full StreamObject in docs/openapi.json, and
    Keitaro also uses runtime-only fields such as action_payload (see
    docs/discovery/keitaro-api.md). The map stays open instead of inventing a
    schema; known offer entries use the StreamOfferInput shape.
    """

    fields: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class CreateCampaignCommand:
    """Validated input for a campaign creation attempt."""

    name: str
    country_code: str
    offer_id: int


@dataclass(frozen=True)
class ConfiguredResources:
    """Operator-owned IDs and redirect destination used by campaign creation."""

    domain_id: int | None
    group_id: int | None
    traffic_source_id: int | None
    redirect_url: str


@dataclass(frozen=True)
class CampaignCreationResult:
    """Public outcome of a campaign creation or resume attempt."""

    operation_uuid: str
    alias: str
    status: OperationStatus
    campaign_id: int | None = None
    country_flow_id: int | None = None
    offer_flow_id: int | None = None
    error_message: str | None = None


@dataclass(frozen=True)
class FetchStreamsCommand:
    """Request to fetch and reconcile all streams of one campaign."""

    campaign_id: int


@dataclass(frozen=True)
class FetchedStream:
    """One remote stream as observed by a Fetch, with ordered offers."""

    stream_ref: int
    campaign_id: int
    type: str
    name: str
    schema: str
    offers: tuple[RemoteOffer, ...]
    comments: str | None = None


@dataclass(frozen=True)
class FetchSnapshot:
    """Validated remote observation reconciled in one local transaction."""

    campaign_id: int
    streams: tuple[FetchedStream, ...]
    captured_at: datetime


@dataclass(frozen=True)
class FetchOutcome:
    """Counts of the local changes produced by one Fetch."""

    campaign_id: int
    stream_count: int
    reconciled_stream_count: int
    created_bindings: int = 0
    archived_bindings: int = 0
    reactivated_bindings: int = 0
    share_updates: int = 0
    conflicted_drafts: int = 0


@dataclass(frozen=True)
class StreamRefView:
    """Cached remote stream identity used by reconciliation tests."""

    stream_ref: int
    campaign_id: int
    type: str
    name: str
    schema: str
    comments: str | None


@dataclass(frozen=True)
class StreamBindingView:
    """Committed binding state of one offer in a stream."""

    offer_id: int
    lifecycle: str
    is_pinned: bool
    last_remote_share: int | None


@dataclass(frozen=True)
class RemoteSnapshotView:
    """Last remote offer observation cached separately from draft snapshots."""

    offers: tuple[RemoteOffer, ...]
    captured_at: datetime


@dataclass(frozen=True)
class StreamDraftView:
    """Staged stream state; Fetch only contributes conflict markers."""

    baseline_offers: tuple[RemoteOffer, ...]
    staged_changes: Mapping[str, object]
    version: int
    is_dirty: bool
    is_stale: bool
    conflicts: tuple[ConflictDetail, ...]


@dataclass(frozen=True)
class DraftCommandBase:
    """Common identity and optimistic-concurrency fields of a draft command."""

    campaign_id: int
    stream_ref: int
    expected_version: int


@dataclass(frozen=True)
class AddOfferCommand(DraftCommandBase):
    """Stage one offer addition."""

    offer_id: int


@dataclass(frozen=True)
class RemoveOfferCommand(DraftCommandBase):
    """Stage one offer archive."""

    offer_id: int


@dataclass(frozen=True)
class RestoreOfferCommand(DraftCommandBase):
    """Stage one archived offer reactivation."""

    offer_id: int


@dataclass(frozen=True)
class SetPinCommand(DraftCommandBase):
    """Stage one pin or unpin intent."""

    offer_id: int
    is_pinned: bool


@dataclass(frozen=True)
class SetShareCommand(DraftCommandBase):
    """Stage one manual share edit."""

    offer_id: int
    share: int


@dataclass(frozen=True)
class CancelDraftCommand(DraftCommandBase):
    """Discard unpublished staged intent without resolving conflicts."""


@dataclass(frozen=True)
class DraftView:
    """Effective staged view returned to the application caller."""

    stream_ref: int
    offers: tuple[StagedOffer, ...]
    baseline_offers: tuple[RemoteOffer, ...]
    staged_changes: Mapping[str, object]
    version: int
    is_dirty: bool
    is_stale: bool
    conflicts: tuple[ConflictDetail, ...]
    policy_cases: tuple[PolicyCase, ...]
    unallocated: int


@dataclass(frozen=True)
class DraftCommandResult:
    """Outcome of one local draft command."""

    view: DraftView
    created: bool = False
    noop: bool = False


@dataclass(frozen=True)
class PushStreamsCommand:
    """Request to publish dirty drafts of one campaign."""

    campaign_id: int
    stream_refs: tuple[int, ...] = ()


@dataclass(frozen=True)
class DirtyDraftView:
    """Durable staged state captured for publication planning."""

    stream_ref: int
    version: int
    intent: Mapping[str, object]
    is_dirty: bool
    is_stale: bool


@dataclass(frozen=True)
class PublicationPlan:
    """Immutable publication intent persisted before any remote mutation."""

    campaign_id: int
    stream_ref: int
    draft_version: int
    intent: Mapping[str, object]
    staged_offers: tuple[StagedOffer, ...]
    payload: Mapping[str, object]
    expected_entries: tuple[OfferEntry, ...]
    preimage: Mapping[str, object]
    correlation_marker: str


@dataclass(frozen=True)
class PublicationOperationView:
    """Durable per-stream publication record returned by the repository."""

    id: int
    operation_uuid: str
    campaign_id: int
    stream_ref: int
    status: PublicationStatus
    draft_version: int
    intent: Mapping[str, object]
    request_payload: Mapping[str, object]
    remote_baseline_before: Mapping[str, object]
    remote_baseline_after: tuple[RemoteOffer, ...] | None
    effective_entries: tuple[OfferEntry, ...]
    staged_offers: tuple[StagedOffer, ...]
    attempt_count: int
    error: str | None
    evidence: Mapping[str, object] | None


@dataclass(frozen=True)
class PushStreamOutcome:
    """Independent outcome of one stream in a Push batch."""

    stream_ref: int
    status: PublicationStatus | None = None
    operation_id: int | None = None
    reason: str | None = None


@dataclass(frozen=True)
class PushResult:
    """Non-atomic batch result with one outcome per selected stream."""

    campaign_id: int
    outcomes: tuple[PushStreamOutcome, ...]


@dataclass(frozen=True)
class RecoveryResult:
    """Counts produced by one bounded startup reconciliation pass."""

    processed: int = 0
    confirmed: int = 0
    unresolved: int = 0
    degraded: int = 0
    remaining: int = 0
    deadline_reached: bool = False


@dataclass(frozen=True)
class CancelPublicationCommand:
    """Request to cancel the publication lifecycle of one stream."""

    campaign_id: int
    stream_ref: int


@dataclass(frozen=True)
class CancelResult:
    """Outcome of one publication-aware Cancel command."""

    stream_ref: int
    status: PublicationStatus | None = None
    reason: str | None = None
    draft_discarded: bool = False


@dataclass(frozen=True)
class PublicationSkip:
    """Reason why a stream was rejected before a durable operation existed."""

    stream_ref: int
    reason: EligibilityReason | str


def to_domain_command(command: DraftCommandBase) -> DraftCommand:
    """Convert an application command to the pure domain representation."""
    if isinstance(command, AddOfferCommand):
        return DraftCommand(DraftCommandKind.ADD, offer_id=command.offer_id)
    if isinstance(command, RemoveOfferCommand):
        return DraftCommand(DraftCommandKind.REMOVE, offer_id=command.offer_id)
    if isinstance(command, RestoreOfferCommand):
        return DraftCommand(DraftCommandKind.RESTORE, offer_id=command.offer_id)
    if isinstance(command, SetPinCommand):
        return DraftCommand(
            DraftCommandKind.SET_PIN,
            offer_id=command.offer_id,
            value=command.is_pinned,
        )
    if isinstance(command, SetShareCommand):
        return DraftCommand(
            DraftCommandKind.SET_SHARE,
            offer_id=command.offer_id,
            value=command.share,
        )
    if isinstance(command, CancelDraftCommand):
        return DraftCommand(DraftCommandKind.CANCEL)
    raise ValueError(f"unsupported draft command {type(command).__name__}")

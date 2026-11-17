"""Application DTOs."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from app.domain.campaign_creation import OperationStatus
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

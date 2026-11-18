"""Transport schemas for the Slice 7 HTTP API."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import UUID4, BaseModel, ConfigDict, Field, StrictInt, StrictStr

from app.application.dto import (
    CampaignCreationResult,
    CommittedStateView,
    DraftCommandResult,
    DraftView,
    FetchOutcome,
    PublicPublicationView,
    PushResult,
    RecoveryResult,
    RemoteSnapshotView,
    StreamRefView,
)
from app.application.publication import CancelResult
from app.domain.allocation import PolicyCase
from app.domain.campaign_creation import OperationStatus
from app.domain.publication import PublicationStatus


class RequestModel(BaseModel):
    """Base model that rejects unknown transport fields."""

    model_config = ConfigDict(extra="forbid")


class ResponseModel(BaseModel):
    """Base model for stable API responses."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class CreateCampaignRequest(RequestModel):
    """Client-owned idempotent campaign creation request."""

    operation_uuid: UUID4
    name: StrictStr
    country_code: StrictStr
    offer_id: StrictInt


class OfferDraftRequest(RequestModel):
    """Versioned draft command targeting one offer."""

    expected_version: StrictInt
    offer_id: StrictInt


class AddDraftRequest(OfferDraftRequest):
    """Stage an offer addition."""


class RemoveDraftRequest(OfferDraftRequest):
    """Stage an offer archive."""


class RestoreDraftRequest(OfferDraftRequest):
    """Stage an archived offer restoration."""


class PinDraftRequest(OfferDraftRequest):
    """Stage an explicit pin or unpin."""


class SetShareDraftRequest(OfferDraftRequest):
    """Stage an integer manual share edit."""

    share: StrictInt


class CancelDraftRequest(RequestModel):
    """Discard local staged intent."""

    expected_version: StrictInt


class PushRequest(RequestModel):
    """Publish selected dirty drafts, or all dirty drafts when empty."""

    stream_refs: list[StrictInt] | None = None


class CampaignCreationResponse(ResponseModel):
    """Current state of one durable campaign creation operation."""

    operation_uuid: str
    alias: str
    status: OperationStatus
    campaign_id: int | None = None
    country_flow_id: int | None = None
    offer_flow_id: int | None = None
    error_message: str | None = None

    @classmethod
    def from_result(cls, result: CampaignCreationResult) -> CampaignCreationResponse:
        """Build a response from the application result."""
        return cls(
            operation_uuid=result.operation_uuid,
            alias=result.alias,
            status=result.status,
            campaign_id=result.campaign_id,
            country_flow_id=result.country_flow_id,
            offer_flow_id=result.offer_flow_id,
            error_message=result.error_message,
        )


class FetchOutcomeResponse(ResponseModel):
    """Counts produced by one whole Fetch reconciliation."""

    campaign_id: int
    stream_count: int
    reconciled_stream_count: int
    created_bindings: int
    archived_bindings: int
    reactivated_bindings: int
    share_updates: int
    conflicted_drafts: int

    @classmethod
    def from_result(cls, result: FetchOutcome) -> FetchOutcomeResponse:
        """Build a response from the Fetch application result."""
        return cls(
            campaign_id=result.campaign_id,
            stream_count=result.stream_count,
            reconciled_stream_count=result.reconciled_stream_count,
            created_bindings=result.created_bindings,
            archived_bindings=result.archived_bindings,
            reactivated_bindings=result.reactivated_bindings,
            share_updates=result.share_updates,
            conflicted_drafts=result.conflicted_drafts,
        )


class StreamRefResponse(ResponseModel):
    """Cached remote stream identity."""

    stream_ref: int
    campaign_id: int
    type: str
    name: str
    stream_schema: str = Field(alias="schema")
    comments: str | None

    @classmethod
    def from_view(cls, view: StreamRefView) -> StreamRefResponse:
        """Build a response from a cached stream reference."""
        return cls(
            stream_ref=view.stream_ref,
            campaign_id=view.campaign_id,
            type=view.type,
            name=view.name,
            stream_schema=view.schema,
            comments=view.comments,
        )


class RemoteOfferResponse(ResponseModel):
    """One offer in a remote snapshot or draft baseline."""

    offer_id: int
    share: int
    state: str | None = None
    position: int


class StreamBindingResponse(ResponseModel):
    """Committed lifecycle and pin state of one binding."""

    offer_id: int
    lifecycle: str
    is_pinned: bool
    last_remote_share: int | None


class RemoteSnapshotResponse(ResponseModel):
    """Last remote offer observation cached by Fetch."""

    offers: list[RemoteOfferResponse]
    captured_at: datetime

    @classmethod
    def from_view(cls, view: RemoteSnapshotView) -> RemoteSnapshotResponse:
        """Build a response from a cached remote snapshot."""
        return cls(
            offers=[RemoteOfferResponse(**offer.__dict__) for offer in view.offers],
            captured_at=view.captured_at,
        )


class CommittedStateResponse(ResponseModel):
    """Committed bindings and remote cache for one stream."""

    stream_ref: int
    bindings: list[StreamBindingResponse]
    snapshot: RemoteSnapshotResponse | None

    @classmethod
    def from_view(cls, view: CommittedStateView) -> CommittedStateResponse:
        """Build a response from the committed-state view."""
        return cls(
            stream_ref=view.stream_ref,
            bindings=[StreamBindingResponse(**item.__dict__) for item in view.bindings],
            snapshot=(
                RemoteSnapshotResponse.from_view(view.snapshot)
                if view.snapshot is not None
                else None
            ),
        )


class ConflictDetailResponse(ResponseModel):
    """Structured sticky conflict discovered by Fetch."""

    stream_ref: int
    offer_id: int
    field: str
    expected: int | None
    observed: int | None
    reason: str


class StagedOfferResponse(ResponseModel):
    """One effective offer in a staged draft view."""

    offer_id: int
    lifecycle: str
    is_pinned: bool
    share: int
    state: str | None
    position: int


class DraftViewResponse(ResponseModel):
    """Effective staged view and its explicit policy information."""

    stream_ref: int
    offers: list[StagedOfferResponse]
    baseline_offers: list[RemoteOfferResponse]
    staged_changes: dict[str, Any]
    version: int
    is_dirty: bool
    is_stale: bool
    conflicts: list[ConflictDetailResponse]
    policy_cases: list[PolicyCase]
    unallocated: int

    @classmethod
    def from_view(cls, view: DraftView) -> DraftViewResponse:
        """Build a response from the application draft view."""
        return cls(
            stream_ref=view.stream_ref,
            offers=[StagedOfferResponse(**offer.__dict__) for offer in view.offers],
            baseline_offers=[
                RemoteOfferResponse(**offer.__dict__) for offer in view.baseline_offers
            ],
            staged_changes=dict(view.staged_changes),
            version=view.version,
            is_dirty=view.is_dirty,
            is_stale=view.is_stale,
            conflicts=[
                ConflictDetailResponse(**item.__dict__) for item in view.conflicts
            ],
            policy_cases=list(view.policy_cases),
            unallocated=view.unallocated,
        )


class DraftStateResponse(ResponseModel):
    """Effective draft view for one stream, or null when no draft exists."""

    stream_ref: int
    draft: DraftViewResponse | None

    @classmethod
    def from_view(cls, stream_ref: int, view: DraftView | None) -> DraftStateResponse:
        """Build a response from an optional application draft view."""
        return cls(
            stream_ref=stream_ref,
            draft=DraftViewResponse.from_view(view) if view is not None else None,
        )


class DraftCommandResultResponse(ResponseModel):
    """Result of one local draft command."""

    view: DraftViewResponse
    created: bool
    noop: bool

    @classmethod
    def from_result(cls, result: DraftCommandResult) -> DraftCommandResultResponse:
        """Build a response from a draft command result."""
        return cls(
            view=DraftViewResponse.from_view(result.view),
            created=result.created,
            noop=result.noop,
        )


class OfferEntryResponse(ResponseModel):
    """Safe projection of one intended published offer."""

    offer_id: int
    share: int
    state: str | None = None


class PublicPublicationResponse(ResponseModel):
    """Allowlisted publication status without internal recovery evidence."""

    operation_uuid: str
    campaign_id: int
    stream_ref: int
    status: PublicationStatus
    draft_version: int
    effective_entries: list[OfferEntryResponse]
    attempt_count: int

    @classmethod
    def from_view(cls, view: PublicPublicationView) -> PublicPublicationResponse:
        """Build a response from the allowlisted application projection."""
        return cls(
            operation_uuid=view.operation_uuid,
            campaign_id=view.campaign_id,
            stream_ref=view.stream_ref,
            status=view.status,
            draft_version=view.draft_version,
            effective_entries=[
                OfferEntryResponse(
                    offer_id=entry.offer_id, share=entry.share, state=entry.state
                )
                for entry in view.effective_entries
            ],
            attempt_count=view.attempt_count,
        )


class PublicationStateResponse(ResponseModel):
    """Latest publication view for one stream, or null when none exists."""

    stream_ref: int
    operation: PublicPublicationResponse | None

    @classmethod
    def from_view(
        cls, stream_ref: int, view: PublicPublicationView | None
    ) -> PublicationStateResponse:
        """Build a response from an optional application publication view."""
        return cls(
            stream_ref=stream_ref,
            operation=PublicPublicationResponse.from_view(view)
            if view is not None
            else None,
        )


class PushStreamOutcomeResponse(ResponseModel):
    """Independent outcome of one stream in a Push batch."""

    stream_ref: int
    status: PublicationStatus | None = None
    operation_id: int | None = None
    reason: str | None = None
    reason_code: str | None = None


class PushResultResponse(ResponseModel):
    """Non-atomic Push result with one outcome per selected stream."""

    campaign_id: int
    outcomes: list[PushStreamOutcomeResponse]

    @classmethod
    def from_result(cls, result: PushResult) -> PushResultResponse:
        """Build a response from a complete Push result."""
        return cls(
            campaign_id=result.campaign_id,
            outcomes=[
                PushStreamOutcomeResponse(
                    stream_ref=outcome.stream_ref,
                    status=outcome.status,
                    operation_id=outcome.operation_id,
                    reason=outcome.reason,
                    reason_code=(
                        outcome.reason_code.value if outcome.reason_code else None
                    ),
                )
                for outcome in result.outcomes
            ],
        )


class CancelResultResponse(ResponseModel):
    """Outcome of a publication-aware Cancel command."""

    stream_ref: int
    status: PublicationStatus | None = None
    reason: str | None = None
    draft_discarded: bool

    @classmethod
    def from_result(cls, result: CancelResult) -> CancelResultResponse:
        """Build a response from a publication Cancel result."""
        return cls(
            stream_ref=result.stream_ref,
            status=result.status,
            reason=result.reason,
            draft_discarded=result.draft_discarded,
        )


class RecoveryResultResponse(ResponseModel):
    """Counts and flags from one bounded recovery pass."""

    processed: int
    confirmed: int
    unresolved: int
    degraded: int
    remaining: int
    deadline_reached: bool

    @classmethod
    def from_result(cls, result: RecoveryResult) -> RecoveryResultResponse:
        """Build a response from a bounded recovery result."""
        return cls(
            processed=result.processed,
            confirmed=result.confirmed,
            unresolved=result.unresolved,
            degraded=result.degraded,
            remaining=result.remaining,
            deadline_reached=result.deadline_reached,
        )

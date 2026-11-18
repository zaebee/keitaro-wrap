"""HTTP API routes for Slice 7 workflows."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import UUID4

from app.api.deps import (
    get_campaign_creation_service,
    get_draft_service,
    get_fetch_service,
    get_publication_service,
)
from app.api.errors import ApiError
from app.api.schemas import (
    AddDraftRequest,
    CampaignCreationResponse,
    CancelDraftRequest,
    CancelResultResponse,
    CommittedStateResponse,
    CreateCampaignRequest,
    DraftCommandResultResponse,
    DraftStateResponse,
    FetchOutcomeResponse,
    OfferDraftRequest,
    PinDraftRequest,
    PublicationStateResponse,
    PublicPublicationResponse,
    PushRequest,
    PushResultResponse,
    RecoveryResultResponse,
    RemoveDraftRequest,
    RestoreDraftRequest,
    SetShareDraftRequest,
    StreamRefResponse,
)
from app.application.campaign_creation import CampaignCreationService
from app.application.draft import DraftService
from app.application.dto import (
    AddOfferCommand,
    CancelDraftCommand,
    CancelPublicationCommand,
    CreateCampaignCommand,
    FetchStreamsCommand,
    PublicationOutcomeReason,
    PushStreamsCommand,
    RemoveOfferCommand,
    RestoreOfferCommand,
    SetPinCommand,
    SetShareCommand,
)
from app.application.fetch import FetchService
from app.application.publication import PublicationService
from app.domain.publication import PublicationStatus

router = APIRouter()

_CANCEL_ERROR_CODES = {
    "RECOVERY_REQUIRED": "PUBLICATION_RECOVERY_REQUIRED",
    "ABSENCE_EVIDENCE_REQUIRED": "PUBLICATION_ABSENCE_EVIDENCE_REQUIRED",
    "NOT_CANCELLABLE": "PUBLICATION_NOT_CANCELLABLE",
    "DRAFT_CHANGED": "PUBLICATION_CONCURRENT_CHANGE",
    "CONCURRENT_PUBLICATION": "PUBLICATION_CONCURRENT_CHANGE",
}


@router.get("/health")
def health():
    """Return service health status."""
    return {"status": "ok"}


@router.post("/campaign-creations")
async def create_campaign(
    request: CreateCampaignRequest,
    response: Response,
    service: Annotated[CampaignCreationService, Depends(get_campaign_creation_service)],
) -> CampaignCreationResponse:
    """Create a durable campaign operation or replay an existing one."""
    outcome = await service.create_idempotent(
        CreateCampaignCommand(
            name=request.name,
            country_code=request.country_code,
            offer_id=request.offer_id,
        ),
        str(request.operation_uuid),
    )
    response.status_code = 201 if outcome.created else 200
    if outcome.created:
        response.headers["Location"] = (
            f"/campaign-creations/{outcome.result.operation_uuid}"
        )
    return CampaignCreationResponse.from_result(outcome.result)


@router.get("/campaign-creations/{operation_uuid}")
async def get_campaign_operation(
    operation_uuid: UUID4,
    service: Annotated[CampaignCreationService, Depends(get_campaign_creation_service)],
) -> CampaignCreationResponse:
    """Read the current state of one durable creation operation."""
    result = await service.get(str(operation_uuid))
    return CampaignCreationResponse.from_result(result)


@router.post(
    "/campaign-creations/{operation_uuid}/resume",
)
async def resume_campaign_operation(
    operation_uuid: UUID4,
    service: Annotated[CampaignCreationService, Depends(get_campaign_creation_service)],
) -> CampaignCreationResponse:
    """Explicitly resume a durable operation using its persisted config snapshot."""
    result = await service.resume(str(operation_uuid))
    return CampaignCreationResponse.from_result(result)


@router.post("/campaigns/{campaign_id}/fetch")
async def fetch_streams(
    campaign_id: Annotated[int, Path(gt=0)],
    service: Annotated[FetchService, Depends(get_fetch_service)],
) -> FetchOutcomeResponse:
    """Fetch all streams of one campaign and reconcile one remote snapshot."""
    result = await service.fetch(FetchStreamsCommand(campaign_id=campaign_id))
    return FetchOutcomeResponse.from_result(result)


@router.get("/campaigns/{campaign_id}/streams")
async def list_streams(
    campaign_id: Annotated[int, Path(gt=0)],
    service: Annotated[FetchService, Depends(get_fetch_service)],
) -> list[StreamRefResponse]:
    """List cached remote stream references for one campaign."""
    views = await service.list_streams(campaign_id)
    return [StreamRefResponse.from_view(view) for view in views]


@router.get(
    "/campaigns/{campaign_id}/streams/{stream_ref}/committed",
)
async def get_committed_state(
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[FetchService, Depends(get_fetch_service)],
) -> CommittedStateResponse:
    """Read committed bindings and the remote snapshot cache for one stream."""
    view = await service.get_committed(campaign_id, stream_ref)
    return CommittedStateResponse.from_view(view)


@router.get(
    "/campaigns/{campaign_id}/streams/{stream_ref}/draft",
)
async def get_draft_state(
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[DraftService, Depends(get_draft_service)],
) -> DraftStateResponse:
    """Read the effective draft view for one campaign stream."""
    view = await service.get_view_for_campaign(campaign_id, stream_ref)
    return DraftStateResponse.from_view(stream_ref, view)


@router.get(
    "/campaigns/{campaign_id}/streams/{stream_ref}/publication",
)
async def get_publication_state(
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> PublicationStateResponse:
    """Read the latest allowlisted publication view for one campaign stream."""
    view = await service.get_latest(campaign_id, stream_ref)
    return PublicationStateResponse.from_view(stream_ref, view)


@router.post(
    "/campaigns/{campaign_id}/streams/{stream_ref}/draft/add",
)
async def add_draft_offer(
    request: AddDraftRequest,
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[DraftService, Depends(get_draft_service)],
) -> DraftCommandResultResponse:
    """Stage an offer addition."""
    result = await service.add(
        AddOfferCommand(
            campaign_id, stream_ref, request.expected_version, request.offer_id
        )
    )
    return DraftCommandResultResponse.from_result(result)


@router.post(
    "/campaigns/{campaign_id}/streams/{stream_ref}/draft/remove",
)
async def remove_draft_offer(
    request: RemoveDraftRequest,
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[DraftService, Depends(get_draft_service)],
) -> DraftCommandResultResponse:
    """Stage an offer archive."""
    result = await service.remove(
        RemoveOfferCommand(
            campaign_id, stream_ref, request.expected_version, request.offer_id
        )
    )
    return DraftCommandResultResponse.from_result(result)


@router.post(
    "/campaigns/{campaign_id}/streams/{stream_ref}/draft/restore",
)
async def restore_draft_offer(
    request: RestoreDraftRequest,
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[DraftService, Depends(get_draft_service)],
) -> DraftCommandResultResponse:
    """Stage an archived offer restoration."""
    result = await service.restore(
        RestoreOfferCommand(
            campaign_id, stream_ref, request.expected_version, request.offer_id
        )
    )
    return DraftCommandResultResponse.from_result(result)


@router.post(
    "/campaigns/{campaign_id}/streams/{stream_ref}/draft/pin",
)
async def pin_draft_offer(
    request: PinDraftRequest,
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[DraftService, Depends(get_draft_service)],
) -> DraftCommandResultResponse:
    """Stage an explicit pin."""
    result = await service.set_pin(
        SetPinCommand(
            campaign_id,
            stream_ref,
            request.expected_version,
            request.offer_id,
            True,
        )
    )
    return DraftCommandResultResponse.from_result(result)


@router.post(
    "/campaigns/{campaign_id}/streams/{stream_ref}/draft/unpin",
)
async def unpin_draft_offer(
    request: OfferDraftRequest,
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[DraftService, Depends(get_draft_service)],
) -> DraftCommandResultResponse:
    """Stage an explicit unpin."""
    result = await service.set_pin(
        SetPinCommand(
            campaign_id,
            stream_ref,
            request.expected_version,
            request.offer_id,
            False,
        )
    )
    return DraftCommandResultResponse.from_result(result)


@router.post(
    "/campaigns/{campaign_id}/streams/{stream_ref}/draft/share",
)
async def set_draft_share(
    request: SetShareDraftRequest,
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[DraftService, Depends(get_draft_service)],
) -> DraftCommandResultResponse:
    """Stage an integer manual share edit."""
    result = await service.set_share(
        SetShareCommand(
            campaign_id,
            stream_ref,
            request.expected_version,
            request.offer_id,
            request.share,
        )
    )
    return DraftCommandResultResponse.from_result(result)


@router.post(
    "/campaigns/{campaign_id}/streams/{stream_ref}/draft/cancel",
)
async def cancel_draft(
    request: CancelDraftRequest,
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[DraftService, Depends(get_draft_service)],
) -> DraftCommandResultResponse:
    """Discard local staged intent without resolving Fetch conflicts."""
    result = await service.cancel(
        CancelDraftCommand(campaign_id, stream_ref, request.expected_version)
    )
    return DraftCommandResultResponse.from_result(result)


@router.post("/campaigns/{campaign_id}/push")
async def push_streams(
    request: PushRequest,
    campaign_id: Annotated[int, Path(gt=0)],
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> PushResultResponse:
    """Publish dirty drafts independently, preserving every per-stream outcome."""
    result = await service.push(
        PushStreamsCommand(
            campaign_id=campaign_id,
            stream_refs=tuple(request.stream_refs or ()),
        )
    )
    response = PushResultResponse.from_result(result)
    if any(
        outcome.reason_code is PublicationOutcomeReason.LIVE_WRITES_DISABLED
        for outcome in result.outcomes
    ):
        raise ApiError(
            503,
            "PUBLICATION_WRITES_DISABLED",
            "offers-only PUT publication writes are disabled",
            {"result": response.model_dump(mode="json")},
        )
    return response


@router.post(
    "/campaigns/{campaign_id}/streams/{stream_ref}/publication/cancel",
)
async def cancel_publication(
    campaign_id: Annotated[int, Path(gt=0)],
    stream_ref: Annotated[int, Path(gt=0)],
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> CancelResultResponse:
    """Cancel a publication lifecycle with D25 reconcile-first semantics."""
    result = await service.cancel(CancelPublicationCommand(campaign_id, stream_ref))
    response = CancelResultResponse.from_result(result)
    if (
        result.reason == "NO_PUBLICATION"
        or result.status is PublicationStatus.ABANDONED
    ):
        return response
    code = _CANCEL_ERROR_CODES.get(result.reason or "", "PUBLICATION_NOT_CANCELLABLE")
    details: dict[str, object] = {"result": response.model_dump(mode="json")}
    if result.status is not None:
        details["status"] = result.status.value
    if result.reason is not None:
        details["reason"] = result.reason
    raise ApiError(409, code, f"publication cancel refused: {result.reason}", details)


@router.get(
    "/publications/recoverable",
)
async def list_recoverable_publications(
    service: Annotated[PublicationService, Depends(get_publication_service)],
    limit: Annotated[int, Query(gt=0, le=100)] = 100,
) -> list[PublicPublicationResponse]:
    """List a bounded public view of unresolved publication operations."""
    views = await service.list_recoverable(limit)
    return [PublicPublicationResponse.from_view(view) for view in views]


@router.post("/publications/recover")
async def recover_publications(
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> RecoveryResultResponse:
    """Run one bounded, read-only reconciliation pass over unresolved operations."""
    result = await service.recover()
    response = RecoveryResultResponse.from_result(result)
    if result.degraded or (result.deadline_reached and result.remaining > 0):
        raise ApiError(
            503,
            "RECOVERY_DEGRADED",
            "publication recovery did not complete",
            {"result": response.model_dump(mode="json")},
        )
    return response

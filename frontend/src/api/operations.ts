import { apiRequest, type CampaignCreationResponse } from "./client";
import type {
  AcceptRemoteRequest,
  AddDraftRequest,
  CancelDraftRequest,
  CancelResultResponse,
  CommittedStateResponse,
  ConflictResolutionResponse,
  CreateCampaignRequest,
  DraftCommandResultResponse,
  DraftStateResponse,
  FetchOutcomeResponse,
  OfferDraftRequest,
  PublicPublicationResponse,
  PublicationStateResponse,
  RecoveryResultResponse,
  RemoveDraftRequest,
  RestoreDraftRequest,
  SetShareDraftRequest,
  StreamRefResponse,
} from "./generated/openapi";

export type {
  CancelResultResponse,
  ConflictResolutionResponse,
  ConflictDetailResponse,
  DraftViewResponse,
  OfferEntryResponse,
  PublicationStateResponse,
  PublicationStatus,
  PublicPublicationResponse,
  RecoveryResultResponse,
  StagedOfferResponse,
} from "./generated/openapi";

export type {
  AcceptRemoteRequest,
  AddDraftRequest,
  CancelDraftRequest,
  CommittedStateResponse,
  CreateCampaignRequest,
  DraftCommandResultResponse,
  DraftStateResponse,
  FetchOutcomeResponse,
  OfferDraftRequest,
  RemoveDraftRequest,
  RestoreDraftRequest,
  SetShareDraftRequest,
  StreamRefResponse,
};

export type CampaignIntent = Omit<CreateCampaignRequest, "operation_uuid">;

export type CreateCampaignOutcome = {
  operation: CampaignCreationResponse;
  created: boolean;
  location: string | null;
};

export async function getHealth(): Promise<{ status: string }> {
  const result = await apiRequest<{ status: string }>("/health");
  return result.data;
}

export async function createCampaign(
  request: CreateCampaignRequest,
): Promise<CreateCampaignOutcome> {
  const result = await apiRequest<CampaignCreationResponse>("/campaign-creations", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return {
    operation: result.data,
    created: result.status === 201,
    location: result.headers.get("location"),
  };
}

export async function getCampaignOperation(
  operationUuid: string,
): Promise<CampaignCreationResponse> {
  const result = await apiRequest<CampaignCreationResponse>(
    `/campaign-creations/${encodeURIComponent(operationUuid)}`,
  );
  return result.data;
}

export async function resumeCampaignOperation(
  operationUuid: string,
): Promise<CampaignCreationResponse> {
  const result = await apiRequest<CampaignCreationResponse>(
    `/campaign-creations/${encodeURIComponent(operationUuid)}/resume`,
    { method: "POST" },
  );
  return result.data;
}

export async function getCampaignStreams(
  campaignId: number,
): Promise<StreamRefResponse[]> {
  const result = await apiRequest<StreamRefResponse[]>(
    `/campaigns/${encodeURIComponent(String(campaignId))}/streams`,
  );
  return result.data;
}

export async function fetchCampaignStreams(
  campaignId: number,
): Promise<FetchOutcomeResponse> {
  const result = await apiRequest<FetchOutcomeResponse>(
    `/campaigns/${encodeURIComponent(String(campaignId))}/fetch`,
    { method: "POST" },
  );
  return result.data;
}

export async function getCommittedState(
  campaignId: number,
  streamRef: number,
): Promise<CommittedStateResponse> {
  const result = await apiRequest<CommittedStateResponse>(
    `${streamPath(campaignId, streamRef)}/committed`,
  );
  return result.data;
}

export async function getDraftState(
  campaignId: number,
  streamRef: number,
): Promise<DraftStateResponse> {
  const result = await apiRequest<DraftStateResponse>(
    `${streamPath(campaignId, streamRef)}/draft`,
  );
  return result.data;
}

function streamPath(campaignId: number, streamRef: number): string {
  return `/campaigns/${encodeURIComponent(String(campaignId))}/streams/${encodeURIComponent(String(streamRef))}`;
}

export async function acceptRemoteConflict(
  campaignId: number,
  streamRef: number,
  body: AcceptRemoteRequest,
): Promise<ConflictResolutionResponse> {
  const result = await apiRequest<ConflictResolutionResponse>(
    `${streamPath(campaignId, streamRef)}/draft/accept-remote`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return result.data;
}

async function postDraftCommand(
  campaignId: number,
  streamRef: number,
  action: string,
  body: AddDraftRequest | RemoveDraftRequest | RestoreDraftRequest | OfferDraftRequest | SetShareDraftRequest | CancelDraftRequest,
): Promise<DraftCommandResultResponse> {
  const result = await apiRequest<DraftCommandResultResponse>(
    `${streamPath(campaignId, streamRef)}/draft/${action}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return result.data;
}

export function addDraftOffer(
  campaignId: number,
  streamRef: number,
  body: AddDraftRequest,
): Promise<DraftCommandResultResponse> {
  return postDraftCommand(campaignId, streamRef, "add", body);
}

export function removeDraftOffer(
  campaignId: number,
  streamRef: number,
  body: RemoveDraftRequest,
): Promise<DraftCommandResultResponse> {
  return postDraftCommand(campaignId, streamRef, "remove", body);
}

export function restoreDraftOffer(
  campaignId: number,
  streamRef: number,
  body: RestoreDraftRequest,
): Promise<DraftCommandResultResponse> {
  return postDraftCommand(campaignId, streamRef, "restore", body);
}

export function pinDraftOffer(
  campaignId: number,
  streamRef: number,
  body: OfferDraftRequest,
): Promise<DraftCommandResultResponse> {
  return postDraftCommand(campaignId, streamRef, "pin", body);
}

export function unpinDraftOffer(
  campaignId: number,
  streamRef: number,
  body: OfferDraftRequest,
): Promise<DraftCommandResultResponse> {
  return postDraftCommand(campaignId, streamRef, "unpin", body);
}

export function setDraftShare(
  campaignId: number,
  streamRef: number,
  body: SetShareDraftRequest,
): Promise<DraftCommandResultResponse> {
  return postDraftCommand(campaignId, streamRef, "share", body);
}

export function cancelLocalDraft(
  campaignId: number,
  streamRef: number,
  body: CancelDraftRequest,
): Promise<DraftCommandResultResponse> {
  return postDraftCommand(campaignId, streamRef, "cancel", body);
}

export const RECOVERABLE_PUBLICATIONS_LIMIT = 100;

export async function getPublicationState(
  campaignId: number,
  streamRef: number,
): Promise<PublicationStateResponse> {
  const result = await apiRequest<PublicationStateResponse>(
    `${streamPath(campaignId, streamRef)}/publication`,
  );
  return result.data;
}

export async function getRecoverablePublications(): Promise<
  PublicPublicationResponse[]
> {
  const result = await apiRequest<PublicPublicationResponse[]>(
    `/publications/recoverable?limit=${RECOVERABLE_PUBLICATIONS_LIMIT}`,
  );
  return result.data;
}

export async function cancelPublication(
  campaignId: number,
  streamRef: number,
): Promise<CancelResultResponse> {
  const result = await apiRequest<CancelResultResponse>(
    `${streamPath(campaignId, streamRef)}/publication/cancel`,
    { method: "POST" },
  );
  return result.data;
}

export async function runRecoveryPass(): Promise<RecoveryResultResponse> {
  const result = await apiRequest<RecoveryResultResponse>(
    "/publications/recover",
    { method: "POST" },
  );
  return result.data;
}

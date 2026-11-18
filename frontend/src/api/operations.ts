import { apiRequest, type CampaignCreationResponse } from "./client";
import type {
  CreateCampaignRequest,
  FetchOutcomeResponse,
  StreamRefResponse,
} from "./generated/openapi";

export type { CreateCampaignRequest, FetchOutcomeResponse, StreamRefResponse };

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

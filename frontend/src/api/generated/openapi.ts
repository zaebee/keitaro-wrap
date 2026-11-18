/**
 * Generated from the wrapper runtime OpenAPI (`app.openapi()`), scoped to S8 contracts.
 * Run `bun run generate:api` from `frontend/` to regenerate.
 * Do not edit manually; docs/openapi.json is the Keitaro Admin API snapshot.
 */

export type OperationStatus = "started" | "partial" | "ambiguous" | "created" | "failed" | "abandoned";

export interface CreateCampaignRequest {
  operation_uuid: string;
  name: string;
  country_code: string;
  offer_id: number;
}

export interface CampaignCreationResponse {
  operation_uuid: string;
  alias: string;
  status: OperationStatus;
  campaign_id?: (number | null);
  country_flow_id?: (number | null);
  offer_flow_id?: (number | null);
  error_message?: (string | null);
}

export interface StreamRefResponse {
  stream_ref: number;
  campaign_id: number;
  type: string;
  name: string;
  schema: string;
  comments: (string | null);
}

export interface FetchOutcomeResponse {
  campaign_id: number;
  stream_count: number;
  reconciled_stream_count: number;
  created_bindings: number;
  archived_bindings: number;
  reactivated_bindings: number;
  share_updates: number;
  conflicted_drafts: number;
}

export interface HTTPValidationError {
  detail?: ValidationError[];
}

export interface ValidationError {
  loc: (string | number)[];
  msg: string;
  type: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

/**
 * Generated from the wrapper runtime OpenAPI (`app.openapi()`), scoped to S8-A contracts.
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

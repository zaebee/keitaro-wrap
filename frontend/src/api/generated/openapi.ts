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

export interface CommittedStateResponse {
  stream_ref: number;
  bindings: StreamBindingResponse[];
  snapshot: (RemoteSnapshotResponse | null);
}

export interface StreamBindingResponse {
  offer_id: number;
  lifecycle: string;
  is_pinned: boolean;
  last_remote_share: (number | null);
}

export interface RemoteSnapshotResponse {
  offers: RemoteOfferResponse[];
  captured_at: string;
}

export interface RemoteOfferResponse {
  offer_id: number;
  share: number;
  state?: (string | null);
  position: number;
}

export interface DraftStateResponse {
  stream_ref: number;
  draft: (DraftViewResponse | null);
}

export interface DraftViewResponse {
  stream_ref: number;
  offers: StagedOfferResponse[];
  baseline_offers: RemoteOfferResponse[];
  staged_changes: Record<string, unknown>;
  version: number;
  is_dirty: boolean;
  is_stale: boolean;
  conflicts: ConflictDetailResponse[];
  policy_cases: PolicyCase[];
  unallocated: number;
}

export interface StagedOfferResponse {
  offer_id: number;
  lifecycle: string;
  is_pinned: boolean;
  share: number;
  state: (string | null);
  position: number;
}

export interface ConflictDetailResponse {
  stream_ref: number;
  offer_id: number;
  field: string;
  expected: (number | null);
  observed: (number | null);
  reason: string;
}

export interface DraftCommandResultResponse {
  view: DraftViewResponse;
  created: boolean;
  noop: boolean;
}

export type PolicyCase = "no_active_offers" | "single_active_offer" | "unallocated_remainder";

export interface OfferDraftRequest {
  expected_version: number;
  offer_id: number;
}

export interface AddDraftRequest {
  expected_version: number;
  offer_id: number;
}

export interface RemoveDraftRequest {
  expected_version: number;
  offer_id: number;
}

export interface RestoreDraftRequest {
  expected_version: number;
  offer_id: number;
}

export interface PinDraftRequest {
  expected_version: number;
  offer_id: number;
}

export interface SetShareDraftRequest {
  expected_version: number;
  offer_id: number;
  share: number;
}

export interface CancelDraftRequest {
  expected_version: number;
}

export type PublicationStatus = "pending" | "in_progress" | "succeeded" | "failed" | "ambiguous" | "abandoned";

export interface OfferEntryResponse {
  offer_id: number;
  share: number;
  state?: (string | null);
}

export interface PublicPublicationResponse {
  operation_uuid: string;
  campaign_id: number;
  stream_ref: number;
  status: PublicationStatus;
  draft_version: number;
  effective_entries: OfferEntryResponse[];
  attempt_count: number;
}

export interface PublicationStateResponse {
  stream_ref: number;
  operation: (PublicPublicationResponse | null);
}

export interface RecoveryResultResponse {
  processed: number;
  confirmed: number;
  unresolved: number;
  degraded: number;
  remaining: number;
  deadline_reached: boolean;
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

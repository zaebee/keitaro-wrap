export type { CampaignCreationResponse } from "./generated/openapi";

export type ApiEnvelope = {
  error?: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
};

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST: "The request has an invalid shape. Check the highlighted fields.",
  CAMPAIGN_INPUT_REJECTED: "The campaign input was rejected by the backend.",
  CAMPAIGN_CONFIGURATION_INVALID:
    "Operator-configured campaign resources are missing or inactive.",
  IDEMPOTENCY_KEY_REUSED:
    "This operation UUID was already used with different campaign details.",
  IDEMPOTENCY_KEY_CONFLICT:
    "Another operation already reserved this campaign identity. Reload and review.",
  OPERATION_NOT_FOUND: "No durable operation exists for this UUID.",
  STREAM_NOT_FOUND: "The requested stream does not belong to this campaign.",
  DRAFT_VERSION_CONFLICT: "The draft changed since it was loaded. Reload before retrying.",
  DRAFT_STALE_CONFLICT: "This draft has sticky conflicts and cannot be edited.",
  DRAFT_BASELINE_UNAVAILABLE: "The draft baseline is unavailable; reload the stream.",
  PUBLICATION_UNRESOLVED: "An unresolved publication blocks this action.",
  PUBLICATION_CONCURRENT_CHANGE: "Publication state changed concurrently. Reload and review.",
  DOMAIN_POLICY_REJECTION: "The backend rejected this action by domain policy.",
  KEITARO_UPSTREAM_FAILURE: "The Keitaro upstream is unavailable. Read state again before retrying.",
  PUBLICATION_WRITES_DISABLED: "Live Keitaro publication writes are disabled in this environment.",
  RECOVERY_DEGRADED: "Publication recovery did not complete; unresolved work remains.",
  PUBLICATION_RECOVERY_REQUIRED: "This publication must be reconciled before it can be cancelled.",
  PUBLICATION_ABSENCE_EVIDENCE_REQUIRED:
    "Cancellation needs evidence that the remote side effect did not occur.",
  PUBLICATION_NOT_CANCELLABLE: "The backend does not allow cancelling this publication.",
  INTERNAL_ERROR: "The backend returned an internal error. Retry reading state.",
};

export type ApiErrorCode = keyof typeof ERROR_MESSAGES;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static from(status: number, body: unknown): ApiError {
    const envelope = body as ApiEnvelope | null;
    const error = envelope?.error;
    if (!error) {
      return new ApiError(status, "INTERNAL_ERROR", ERROR_MESSAGES.INTERNAL_ERROR, {});
    }
    const message =
      ERROR_MESSAGES[error.code] ??
      error.message ??
      "The backend rejected this request.";
    return new ApiError(status, error.code, message, error.details ?? {});
  }

  get isNotFound(): boolean {
    return this.status === 404 && this.code === "OPERATION_NOT_FOUND";
  }
}

export type ApiResult<T> = {
  data: T;
  status: number;
  headers: Headers;
};

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw ApiError.from(response.status, body);
  }
  return { data: body as T, status: response.status, headers: response.headers };
}

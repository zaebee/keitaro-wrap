import type {
  CancelResultResponse,
  DraftStateResponse,
  PublicationStateResponse,
  PublicationStatus,
  PublicPublicationResponse,
  RecoveryResultResponse,
} from "../../api/operations";

export type StreamIdentity = { campaignId: number; streamRef: number };

const TERMINAL_STATUSES = new Set<PublicationStatus>([
  "succeeded",
  "failed",
  "abandoned",
]);

const STATUSES = new Set<PublicationStatus>([
  "pending",
  "in_progress",
  "succeeded",
  "failed",
  "ambiguous",
  "abandoned",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isValidStatus(value: unknown): value is PublicationStatus {
  return typeof value === "string" && STATUSES.has(value as PublicationStatus);
}

export function isResolvedStatus(status: PublicationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isUnresolvedStatus(status: PublicationStatus): boolean {
  return status === "pending" || status === "in_progress" || status === "ambiguous";
}

function isValidEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isPositiveInt(entry.offer_id) &&
        isNonNegativeInt(entry.share) &&
        entry.share <= 100 &&
        (entry.state === null ||
          entry.state === undefined ||
          typeof entry.state === "string"),
    )
  );
}

function isValidRemoteOffers(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (offer) =>
        isRecord(offer) &&
        isPositiveInt(offer.offer_id) &&
        isNonNegativeInt(offer.share) &&
        isNonNegativeInt(offer.position) &&
        (offer.state === null ||
          offer.state === undefined ||
          typeof offer.state === "string"),
    )
  );
}

function isValidStagedOffers(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (offer) =>
        isRecord(offer) &&
        isPositiveInt(offer.offer_id) &&
        typeof offer.lifecycle === "string" &&
        isBoolean(offer.is_pinned) &&
        isNonNegativeInt(offer.share) &&
        (offer.state === null || typeof offer.state === "string") &&
        isNonNegativeInt(offer.position),
    )
  );
}

function isValidConflicts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (conflict) =>
        isRecord(conflict) &&
        isPositiveInt(conflict.stream_ref) &&
        isPositiveInt(conflict.offer_id) &&
        typeof conflict.field === "string" &&
        (conflict.expected === null || isNonNegativeInt(conflict.expected)) &&
        (conflict.observed === null || isNonNegativeInt(conflict.observed)) &&
        typeof conflict.reason === "string",
    )
  );
}

export function isValidStreamIdentity(value: unknown): value is StreamIdentity {
  return (
    isRecord(value) &&
    isPositiveInt(value.campaignId) &&
    isPositiveInt(value.streamRef)
  );
}

export function hasMatchingStreamIdentity(
  value: unknown,
  expected: StreamIdentity,
): boolean {
  return (
    isRecord(value) &&
    value.campaign_id === expected.campaignId &&
    value.stream_ref === expected.streamRef
  );
}

export function streamIdentityKey(identity: StreamIdentity): string {
  return `${identity.campaignId}:${identity.streamRef}`;
}

export function streamUnionFingerprint(identities: StreamIdentity[]): string {
  return identities
    .map(streamIdentityKey)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

export function mergeStreamIdentities(
  current: StreamIdentity[],
  incoming: StreamIdentity[],
): { identities: StreamIdentity[]; changed: boolean } {
  const seen = new Set(current.map(streamIdentityKey));
  const identities = [...current];
  let changed = false;
  for (const identity of incoming) {
    const key = streamIdentityKey(identity);
    if (!seen.has(key)) {
      seen.add(key);
      identities.push(identity);
      changed = true;
    }
  }
  return { identities, changed };
}

function isValidOperation(value: unknown): value is PublicPublicationResponse {
  return (
    isRecord(value) &&
    typeof value.operation_uuid === "string" &&
    value.operation_uuid.length > 0 &&
    isPositiveInt(value.campaign_id) &&
    isPositiveInt(value.stream_ref) &&
    isValidStatus(value.status) &&
    isNonNegativeInt(value.draft_version) &&
    isValidEntries(value.effective_entries) &&
    isNonNegativeInt(value.attempt_count)
  );
}

export function identitiesFromQueue(
  queue: PublicPublicationResponse[],
): StreamIdentity[] {
  return queue.map((operation) => ({
    campaignId: operation.campaign_id,
    streamRef: operation.stream_ref,
  }));
}

export function parseRecoverableQueue(
  value: unknown,
): PublicPublicationResponse[] | null {
  if (!Array.isArray(value) || !value.every(isValidOperation)) {
    return null;
  }
  return value;
}

export function isValidPublicationState(
  value: unknown,
  expected: StreamIdentity,
): value is PublicationStateResponse {
  if (!isRecord(value) || value.stream_ref !== expected.streamRef) {
    return false;
  }
  if (value.operation === null) {
    return true;
  }
  return (
    isValidOperation(value.operation) &&
    value.operation.campaign_id === expected.campaignId &&
    value.operation.stream_ref === expected.streamRef
  );
}

export function isTerminalPublicationState(
  value: unknown,
  expected: StreamIdentity,
): value is PublicationStateResponse {
  if (!isValidPublicationState(value, expected)) {
    return false;
  }
  return (
    value.operation === null || TERMINAL_STATUSES.has(value.operation.status)
  );
}

export function isValidDraftState(
  value: unknown,
  expected: StreamIdentity,
): value is DraftStateResponse {
  if (!isRecord(value) || value.stream_ref !== expected.streamRef) {
    return false;
  }
  if (value.draft === null) {
    return true;
  }
  const draft = value.draft;
  return (
    isRecord(draft) &&
    draft.stream_ref === expected.streamRef &&
    isValidStagedOffers(draft.offers) &&
    isValidRemoteOffers(draft.baseline_offers) &&
    isRecord(draft.staged_changes) &&
    isNonNegativeInt(draft.version) &&
    isBoolean(draft.is_dirty) &&
    isBoolean(draft.is_stale) &&
    isValidConflicts(draft.conflicts) &&
    Array.isArray(draft.policy_cases) &&
    draft.policy_cases.every((item) => typeof item === "string") &&
    isNonNegativeInt(draft.unallocated)
  );
}

export function parseCancelResult(
  value: unknown,
  expected: StreamIdentity,
): CancelResultResponse | null {
  if (
    !isRecord(value) ||
    value.stream_ref !== expected.streamRef ||
    !isBoolean(value.draft_discarded)
  ) {
    return null;
  }
  const status = value.status ?? null;
  const reason = value.reason ?? null;
  if (
    (status !== null && !isValidStatus(status)) ||
    (reason !== null && typeof reason !== "string")
  ) {
    return null;
  }
  return {
    stream_ref: expected.streamRef,
    status,
    reason,
    draft_discarded: value.draft_discarded,
  };
}

export type CancelErrorDetails = {
  result: CancelResultResponse;
  status: PublicationStatus | null;
  reason: string | null;
};

export function parseCancelErrorDetails(
  value: unknown,
): CancelErrorDetails | null {
  if (!isRecord(value)) {
    return null;
  }
  const result = parseCancelResult(value.result, {
    campaignId: 0,
    streamRef: isRecord(value.result) && isPositiveInt(value.result.stream_ref)
      ? value.result.stream_ref
      : -1,
  });
  if (result === null) {
    return null;
  }
  const status = value.status ?? null;
  const reason = value.reason ?? null;
  if (
    (status !== null && !isValidStatus(status)) ||
    (reason !== null && typeof reason !== "string")
  ) {
    return null;
  }
  return { result, status, reason };
}

export function parseRecoveryResult(value: unknown): RecoveryResultResponse | null {
  if (
    !isRecord(value) ||
    !isNonNegativeInt(value.processed) ||
    !isNonNegativeInt(value.confirmed) ||
    !isNonNegativeInt(value.unresolved) ||
    !isNonNegativeInt(value.degraded) ||
    !isNonNegativeInt(value.remaining) ||
    typeof value.deadline_reached !== "boolean"
  ) {
    return null;
  }
  return value as unknown as RecoveryResultResponse;
}

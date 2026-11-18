import type {
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

function isValidStatus(value: unknown): value is PublicationStatus {
  return typeof value === "string" && STATUSES.has(value as PublicationStatus);
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

export function isValidStreamIdentity(value: unknown): value is StreamIdentity {
  return (
    isRecord(value) &&
    isPositiveInt(value.campaignId) &&
    isPositiveInt(value.streamRef)
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

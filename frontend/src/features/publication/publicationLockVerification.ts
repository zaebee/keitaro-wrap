import { ApiError } from "../../api/client";
import {
  getDraftState,
  getPublicationState,
  getRecoverablePublications,
  RECOVERABLE_PUBLICATIONS_LIMIT,
  type PublicPublicationResponse,
  type PublicationStatus,
} from "../../api/operations";
import {
  hasMatchingStreamIdentity,
  identitiesFromQueue,
  isResolvedStatus,
  isUnresolvedStatus,
  isValidDraftState,
  isValidPublicationState,
  parseRecoverableQueue,
  streamUnionFingerprint,
  type StreamIdentity,
} from "./publicationValidation";
import type { LockContext } from "./usePublicationRecoveryLock";

export type CancelVerificationMode =
  | "success"
  | "noop"
  | "refusal"
  | "unknown"
  | "recovery"
  | "reconcile";

export type CancelVerificationOptions = {
  mode: CancelVerificationMode;
  target: StreamIdentity;
  code?: string;
  preDraftVersion?: number;
  onQueue?: (queue: PublicPublicationResponse[]) => void;
};

export type VerificationResult = {
  status: "released" | "handoff" | "retry" | "blocked";
  message: string;
};

type StatusRead =
  | { ok: true; status: PublicationStatus | null; streamGone: boolean }
  | { ok: false; message: string };

type DraftRead =
  | { ok: true; version: number | null }
  | { ok: false; message: string };

function blocked(message: string): VerificationResult {
  return { status: "blocked", message };
}

function identityKey(identity: StreamIdentity): string {
  return `${identity.campaignId}:${identity.streamRef}`;
}

async function readQueue(
  context: LockContext,
  options: CancelVerificationOptions,
): Promise<{ queue: PublicPublicationResponse[]; complete: boolean } | null> {
  try {
    const response = await getRecoverablePublications();
    const queue = parseRecoverableQueue(response);
    if (queue === null) {
      return null;
    }
    options.onQueue?.(queue);
    const updated = await context.updateAffected(
      identitiesFromQueue(queue),
      queue.length < RECOVERABLE_PUBLICATIONS_LIMIT,
    );
    if (!updated) {
      return null;
    }
    return {
      queue,
      complete: queue.length < RECOVERABLE_PUBLICATIONS_LIMIT,
    };
  } catch {
    return null;
  }
}

async function readStatus(identity: StreamIdentity): Promise<StatusRead> {
  try {
    const state = await getPublicationState(
      identity.campaignId,
      identity.streamRef,
    );
    if (!isValidPublicationState(state, identity)) {
      return { ok: false, message: "publication status identity mismatch" };
    }
    return {
      ok: true,
      status: state.operation?.status ?? null,
      streamGone: false,
    };
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === "STREAM_NOT_FOUND" &&
      hasMatchingStreamIdentity(error.details, identity)
    ) {
      return { ok: true, status: null, streamGone: true };
    }
    return { ok: false, message: "publication status read failed" };
  }
}

async function readDraft(
  identity: StreamIdentity,
  streamGone: boolean,
): Promise<DraftRead> {
  try {
    const state = await getDraftState(identity.campaignId, identity.streamRef);
    if (!isValidDraftState(state, identity) || streamGone) {
      return { ok: false, message: "draft state mismatch" };
    }
    return { ok: true, version: state.draft?.version ?? null };
  } catch (error) {
    if (
      streamGone &&
      error instanceof ApiError &&
      error.code === "STREAM_NOT_FOUND" &&
      hasMatchingStreamIdentity(error.details, identity)
    ) {
      return { ok: true, version: null };
    }
    return { ok: false, message: "draft read failed" };
  }
}

async function routeUnresolved(
  context: LockContext,
  identity: StreamIdentity,
  status: PublicationStatus,
): Promise<VerificationResult> {
  if (status === "in_progress" || status === "ambiguous") {
    const changed = await context.markStage("recovery_ready");
    if (!changed) {
      return blocked(
        "Could not persist the recovery handoff. The lock remains active.",
      );
    }
    return {
      status: "handoff",
      message:
        "Recovery is required before Cancel. The lock was handed to explicit recovery.",
    };
  }
  if (status === "pending") {
    const changed = await context.markRetryReady(identity);
    if (!changed) {
      return blocked(
        "Could not persist the pending retry state. The lock remains active.",
      );
    }
    return {
      status: "retry",
      message:
        "The operation is still pending. A separate confirmation is required to retry Cancel.",
    };
  }
  return blocked("An unresolved publication state kept the lock active.");
}

function refusalMatches(
  code: string | undefined,
  status: PublicationStatus | null,
): boolean {
  switch (code) {
    case "PUBLICATION_ABSENCE_EVIDENCE_REQUIRED":
      return status === "failed";
    case "PUBLICATION_NOT_CANCELLABLE":
      return status === "succeeded" || status === "abandoned";
    case "PUBLICATION_CONCURRENT_CHANGE":
      return true;
    default:
      return false;
  }
}

/**
 * Verify a cancel-origin lock with the unified authoritative GET set. All
 * identities in the persisted union are checked; the queue alone never proves
 * that an identity is resolved.
 */
export async function verifyCancelLock(
  context: LockContext,
  options: CancelVerificationOptions,
): Promise<VerificationResult> {
  const queue = await readQueue(context, options);
  if (queue === null) {
    return blocked(
      "Authoritative queue verification failed. The lock remains active.",
    );
  }
  const requireEmptyQueue =
    options.mode === "unknown" || options.mode === "recovery";
  if (requireEmptyQueue) {
    if (!queue.complete) {
      return blocked(
        "The current queue read is potentially truncated. The lock remains active.",
      );
    }
    if (queue.queue.length > 0) {
      return blocked(
        `${queue.queue.length} unresolved operation(s) remain in the complete bounded read. The lock remains active.`,
      );
    }
  }

  const initial = context.getCurrent();
  if (initial === null) {
    return blocked("The persisted lock is unavailable. No state was changed.");
  }
  if (initial.stage === "running") {
    const phaseChanged = await context.markVerification(queue.complete);
    if (!phaseChanged) {
      return blocked(
        "Could not persist the verification phase. The lock remains active.",
      );
    }
  }
  const lock = context.getCurrent();
  if (lock === null) {
    return blocked("The persisted lock changed during verification.");
  }

  const statuses = new Map<string, StatusRead>();
  for (const identity of lock.affected) {
    const result = await readStatus(identity);
    if (!result.ok) {
      return blocked(
        "One or more tracked stream states could not be validated. The lock remains active.",
      );
    }
    statuses.set(identityKey(identity), result);
  }

  const targetStatus = statuses.get(identityKey(options.target));
  if (targetStatus === undefined || !targetStatus.ok) {
    return blocked("The cancel target could not be verified.");
  }
  if (options.mode === "reconcile") {
    for (const identity of lock.affected) {
      const result = statuses.get(identityKey(identity));
      if (result === undefined || !result.ok) {
        return blocked("An affected identity was not verified.");
      }
      if (result.status !== null && isUnresolvedStatus(result.status)) {
        if (result.status === "pending") {
          const draft = await readDraft(identity, result.streamGone);
          if (!draft.ok) {
            return blocked(
              "A required draft state could not be validated. The lock remains active.",
            );
          }
        }
        return await routeUnresolved(context, identity, result.status);
      }
    }
    if (!queue.complete || queue.queue.length > 0) {
      return blocked(
        "All tracked states are resolved, but the bounded queue is not complete and empty. The lock remains active.",
      );
    }
    if (lock.stage !== "verification") {
      const phaseChanged = await context.markStage("verification");
      if (!phaseChanged) {
        return blocked(
          "Could not persist the verification phase. The lock remains active.",
        );
      }
    }
  }
  if (options.mode === "success" && targetStatus.status !== "abandoned") {
    if (targetStatus.status !== null && isUnresolvedStatus(targetStatus.status)) {
      return await routeUnresolved(context, options.target, targetStatus.status);
    }
    return blocked(
      "The target status does not confirm cancellation. The lock remains active.",
    );
  }
  if (options.mode === "noop") {
    if (
      targetStatus.status !== null &&
      !isResolvedStatus(targetStatus.status)
    ) {
      return await routeUnresolved(context, options.target, targetStatus.status);
    }
  }
  if (options.mode === "refusal") {
    if (
      options.code === "PUBLICATION_RECOVERY_REQUIRED" &&
      targetStatus.status !== "in_progress" &&
      targetStatus.status !== "ambiguous"
    ) {
      return blocked(
        "The recovery-required refusal could not be confirmed. The lock remains active.",
      );
    }
    if (
      options.code === "STREAM_NOT_FOUND" &&
      !targetStatus.streamGone
    ) {
      return blocked(
        "The stream-not-found refusal could not be confirmed. The lock remains active.",
      );
    }
    if (
      options.code !== "PUBLICATION_RECOVERY_REQUIRED" &&
      options.code !== "STREAM_NOT_FOUND" &&
      !refusalMatches(options.code, targetStatus.status)
    ) {
      return blocked(
        "The refusal status could not be confirmed. The lock remains active.",
      );
    }
  }

  for (const identity of options.mode === "reconcile" ? [] : lock.affected) {
    const result = statuses.get(identityKey(identity));
    if (result === undefined || !result.ok) {
      return blocked("An affected identity was not verified.");
    }
    if (result.status !== null && isUnresolvedStatus(result.status)) {
      if (result.status === "pending") {
        const draft = await readDraft(identity, result.streamGone);
        if (!draft.ok) {
          return blocked(
            "A required draft state could not be validated. The lock remains active.",
          );
        }
        if (
          identityKey(identity) === identityKey(options.target) &&
          options.preDraftVersion !== undefined &&
          draft.version !== options.preDraftVersion
        ) {
          return blocked(
            "The draft changed before verification. The lock remains active.",
          );
        }
      }
      return await routeUnresolved(context, identity, result.status);
    }
  }

  for (const identity of lock.draftVerification) {
    const result = statuses.get(identityKey(identity));
    const draft = await readDraft(identity, result?.ok === true && result.streamGone);
    if (!draft.ok) {
      return blocked(
        "A required draft state could not be validated. The lock remains active.",
      );
    }
    if (
      identityKey(identity) === identityKey(options.target) &&
      options.preDraftVersion !== undefined &&
      draft.version !== options.preDraftVersion
    ) {
      return blocked(
        "The draft changed before verification. The lock remains active.",
      );
    }
  }

  const released = await context.release({
    lockId: lock.lockId,
    fingerprint: streamUnionFingerprint(lock.affected),
  });
  if (!released) {
    return blocked(
      "The persisted lock changed during verification. The lock remains active.",
    );
  }
  return {
    status: "released",
    message:
      "Authoritative status and queue reads passed; the lock was released.",
  };
}

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
import {
  lockSnapshot,
  type LockContext,
  type LockSnapshot,
  type RecoveryLockV2,
} from "./usePublicationRecoveryLock";

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
  expected?: LockSnapshot;
  onQueue?: (queue: PublicPublicationResponse[]) => void;
};

export type VerificationResult = {
  status: "released" | "handoff" | "retry" | "blocked";
  message: string;
};

type StatusRead =
  | { ok: true; status: PublicationStatus | null; streamGone: boolean }
  | { ok: false; message: string };

type StatusReadOk = Extract<StatusRead, { ok: true }> & {
  status: PublicationStatus;
};

type DraftRead =
  | { ok: true; version: number | null }
  | { ok: false; message: string };

type Prepared = {
  lock: RecoveryLockV2;
  queue: PublicPublicationResponse[];
  complete: boolean;
  snapshot: LockSnapshot;
};

type Preparation = { prepared: Prepared } | { result: VerificationResult };

type UnresolvedStatus = {
  identity: StreamIdentity;
  status: PublicationStatus;
  streamGone: boolean;
};

function blocked(message: string): VerificationResult {
  return { status: "blocked", message };
}

function identityKey(identity: StreamIdentity): string {
  return `${identity.campaignId}:${identity.streamRef}`;
}

function snapshotsEqual(left: LockSnapshot, right: LockSnapshot): boolean {
  return (
    left.lockId === right.lockId &&
    left.kind === right.kind &&
    left.stage === right.stage &&
    left.unionFingerprint === right.unionFingerprint &&
    left.draftFingerprint === right.draftFingerprint &&
    left.cancelTargetFingerprint === right.cancelTargetFingerprint
  );
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
    if (options.expected !== undefined) {
      const beforeUpdate = context.getCurrent();
      if (
        beforeUpdate === null ||
        !snapshotsEqual(lockSnapshot(beforeUpdate), options.expected)
      ) {
        return null;
      }
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

async function prepareVerification(
  context: LockContext,
  options: CancelVerificationOptions,
): Promise<Preparation> {
  if (options.expected !== undefined) {
    const beforeReads = context.getCurrent();
    if (
      beforeReads === null ||
      !snapshotsEqual(lockSnapshot(beforeReads), options.expected)
    ) {
      return {
        result: blocked(
          "The lock changed before reconciliation started. No state was changed.",
        ),
      };
    }
  }
  const queue = await readQueue(context, options);
  if (queue === null) {
    return {
      result: blocked(
        "Authoritative queue verification failed. The lock remains active.",
      ),
    };
  }
  if (options.mode === "unknown" || options.mode === "recovery") {
    if (!queue.complete) {
      return {
        result: blocked(
          "The current queue read is potentially truncated. The lock remains active.",
        ),
      };
    }
    if (queue.queue.length > 0) {
      return {
        result: blocked(
          `${queue.queue.length} unresolved operation(s) remain in the complete bounded read. The lock remains active.`,
        ),
      };
    }
  }
  const initial = context.getCurrent();
  if (initial === null) {
    return {
      result: blocked("The persisted lock is unavailable. No state was changed."),
    };
  }
  if (initial.stage === "running") {
    const phaseChanged = await context.markVerification(
      queue.complete,
      lockSnapshot(initial),
    );
    if (!phaseChanged) {
      return {
        result: blocked(
          "The lock changed before verification could be persisted. No state was changed.",
        ),
      };
    }
  }
  const lock = context.getCurrent();
  if (lock === null) {
    return {
      result: blocked("The persisted lock changed during verification."),
    };
  }
  if (
    lock.kind === "cancel" &&
    (lock.cancelTarget === null ||
      identityKey(lock.cancelTarget) !== identityKey(options.target))
  ) {
    return { result: blocked("The cancel target changed during verification.") };
  }
  return {
    prepared: {
      lock,
      queue: queue.queue,
      complete: queue.complete,
      snapshot: lockSnapshot(lock),
    },
  };
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

async function readStatuses(
  lock: RecoveryLockV2,
): Promise<Map<string, StatusRead> | null> {
  const statuses = new Map<string, StatusRead>();
  for (const identity of lock.affected) {
    const result = await readStatus(identity);
    if (!result.ok) {
      return null;
    }
    statuses.set(identityKey(identity), result);
  }
  return statuses;
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
  status: UnresolvedStatus,
  target: StreamIdentity,
  expected: LockSnapshot,
): Promise<VerificationResult> {
  if (status.status !== "pending") {
    const changed = await context.markStage("recovery_ready", expected);
    if (!changed) {
      return blocked(
        "The lock changed before the recovery handoff. No state was changed.",
      );
    }
    return {
      status: "handoff",
      message:
        "Recovery is required before Cancel. The lock was handed to explicit recovery.",
    };
  }
  if (identityKey(status.identity) !== identityKey(target)) {
    return blocked(
      "An unrelated affected stream is pending. The lock remains active and the retry target is unchanged.",
    );
  }
  const changed = await context.markRetryReady(status.identity, expected);
  if (!changed) {
    return blocked(
      "The lock changed before the pending retry state could be persisted. No state was changed.",
    );
  }
  return {
    status: "retry",
    message:
      "The operation is still pending. A separate confirmation is required to retry Cancel.",
  };
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

function unresolvedStatuses(
  prepared: Prepared,
  statuses: Map<string, StatusRead>,
  target: StreamIdentity,
): UnresolvedStatus[] {
  return prepared.lock.affected
    .filter((identity) => identityKey(identity) !== identityKey(target))
    .map((identity) => ({ identity, result: statuses.get(identityKey(identity)) }))
    .filter(
      (entry): entry is { identity: StreamIdentity; result: StatusReadOk } =>
        entry.result?.ok === true &&
        entry.result.status !== null &&
        isUnresolvedStatus(entry.result.status),
    )
    .map((entry) => ({
      identity: entry.identity,
      status: entry.result.status,
      streamGone: entry.result.streamGone,
    }));
}

async function verifyReconcileMode(
  context: LockContext,
  options: CancelVerificationOptions,
  prepared: Prepared,
  statuses: Map<string, StatusRead>,
): Promise<VerificationResult | null> {
  const targetResult = statuses.get(identityKey(options.target));
  if (!targetResult?.ok) {
    return blocked("The cancel target could not be verified.");
  }
  const unrelated = unresolvedStatuses(prepared, statuses, options.target);
  const recoveryNeeded = unrelated.find(
    (entry) => entry.status === "in_progress" || entry.status === "ambiguous",
  );
  if (recoveryNeeded !== undefined) {
    return await routeUnresolved(
      context,
      recoveryNeeded,
      options.target,
      prepared.snapshot,
    );
  }
  if (targetResult.status !== null && isUnresolvedStatus(targetResult.status)) {
    if (targetResult.status === "pending" && unrelated.length > 0) {
      return blocked(
        "An unrelated affected stream is unresolved. The retry target is unchanged and the lock remains active.",
      );
    }
    if (targetResult.status === "pending") {
      const draft = await readDraft(options.target, targetResult.streamGone);
      if (!draft.ok) {
        return blocked(
          "A required draft state could not be validated. The lock remains active.",
        );
      }
    }
    return await routeUnresolved(
      context,
      {
        identity: options.target,
        status: targetResult.status,
        streamGone: targetResult.streamGone,
      },
      options.target,
      prepared.snapshot,
    );
  }
  if (unrelated.length > 0) {
    return blocked(
      "An unrelated affected stream is unresolved. The lock remains active.",
    );
  }
  if (!prepared.complete || prepared.queue.length > 0) {
    return blocked(
      "All tracked states are resolved, but the bounded queue is not complete and empty. The lock remains active.",
    );
  }
  if (prepared.lock.stage !== "verification") {
    const changed = await context.markStage(
      "verification",
      prepared.snapshot,
    );
    if (!changed) {
      return blocked(
        "The lock changed before verification could be persisted. No state was changed.",
      );
    }
  }
  return null;
}

function checkRefusal(
  options: CancelVerificationOptions,
  status: StatusRead,
): VerificationResult | null {
  if (!status.ok) {
    return blocked(
      "The refusal status could not be confirmed. The lock remains active.",
    );
  }
  if (
    options.code === "PUBLICATION_RECOVERY_REQUIRED" &&
    status.status !== "in_progress" &&
    status.status !== "ambiguous"
  ) {
    return blocked(
      "The recovery-required refusal could not be confirmed. The lock remains active.",
    );
  }
  if (options.code === "STREAM_NOT_FOUND" && !status.streamGone) {
    return blocked(
      "The stream-not-found refusal could not be confirmed. The lock remains active.",
    );
  }
  if (
    options.code !== "PUBLICATION_RECOVERY_REQUIRED" &&
    options.code !== "STREAM_NOT_FOUND" &&
    !refusalMatches(options.code, status.status)
  ) {
    return blocked(
      "The refusal status could not be confirmed. The lock remains active.",
    );
  }
  return null;
}

async function verifyOutcomeMode(
  context: LockContext,
  options: CancelVerificationOptions,
  prepared: Prepared,
  statuses: Map<string, StatusRead>,
): Promise<VerificationResult | null> {
  const targetResult = statuses.get(identityKey(options.target));
  if (!targetResult?.ok) {
    return blocked("The cancel target could not be verified.");
  }
  if (options.mode === "success" && targetResult.status !== "abandoned") {
    if (targetResult.status !== null && isUnresolvedStatus(targetResult.status)) {
      return await routeUnresolved(
        context,
        {
          identity: options.target,
          status: targetResult.status,
          streamGone: targetResult.streamGone,
        },
        options.target,
        prepared.snapshot,
      );
    }
    return blocked(
      "The target status does not confirm cancellation. The lock remains active.",
    );
  }
  const noopStatus = targetResult.status;
  if (
    options.mode === "noop" &&
    noopStatus !== null &&
    !isResolvedStatus(noopStatus)
  ) {
    return await routeUnresolved(
      context,
      {
        identity: options.target,
        status: noopStatus,
        streamGone: targetResult.streamGone,
      },
      options.target,
      prepared.snapshot,
    );
  }
  if (options.mode === "refusal") {
    const refusalResult = checkRefusal(options, targetResult);
    if (refusalResult !== null) {
      return refusalResult;
    }
  }
  for (const identity of prepared.lock.affected) {
    const result = statuses.get(identityKey(identity));
    if (!result?.ok) {
      return blocked("An affected identity was not verified.");
    }
    if (result.status === null || !isUnresolvedStatus(result.status)) {
      continue;
    }
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
    return await routeUnresolved(
      context,
      { identity, status: result.status, streamGone: result.streamGone },
      options.target,
      prepared.snapshot,
    );
  }
  return null;
}

async function verifyDraftsAndRelease(
  context: LockContext,
  options: CancelVerificationOptions,
  prepared: Prepared,
  statuses: Map<string, StatusRead>,
): Promise<VerificationResult> {
  for (const identity of prepared.lock.draftVerification) {
    const status = statuses.get(identityKey(identity));
    const draft = await readDraft(
      identity,
      status?.ok === true && status.streamGone,
    );
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
    lockId: prepared.lock.lockId,
    fingerprint: streamUnionFingerprint(prepared.lock.affected),
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

/**
 * Verify a cancel-origin lock with the unified authoritative GET set. All
 * identities in the persisted union are checked; the queue alone never proves
 * that an identity is resolved.
 */
export async function verifyCancelLock(
  context: LockContext,
  options: CancelVerificationOptions,
): Promise<VerificationResult> {
  const preparation = await prepareVerification(context, options);
  if ("result" in preparation) {
    return preparation.result;
  }
  const { prepared } = preparation;
  const statuses = await readStatuses(prepared.lock);
  if (statuses === null) {
    return blocked(
      "One or more tracked stream states could not be validated. The lock remains active.",
    );
  }
  const modeResult =
    options.mode === "reconcile"
      ? await verifyReconcileMode(context, options, prepared, statuses)
      : await verifyOutcomeMode(context, options, prepared, statuses);
  if (modeResult !== null) {
    return modeResult;
  }
  return await verifyDraftsAndRelease(context, options, prepared, statuses);
}

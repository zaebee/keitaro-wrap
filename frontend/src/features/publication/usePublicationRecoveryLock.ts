import { useCallback, useEffect, useState } from "react";

import {
  isValidStreamIdentity,
  mergeStreamIdentities,
  streamUnionFingerprint,
  type StreamIdentity,
} from "./publicationValidation";

export const RECOVERY_LOCK_KEY =
  "keitaro-wrap:s8d2:publication-recovery-lock:v1";

export type LegacyReason = "unknown" | "degraded" | "partial" | "verification";
export type RecoveryLockReason =
  | LegacyReason
  | "refusal"
  | "handoff"
  | "retry";
export type RecoveryLockKind = "recovery" | "cancel";
export type RecoveryLockStage =
  | "reserved"
  | "running"
  | "verification"
  | "recovery_ready"
  | "retry_ready";
export type CompatPhase = "running" | "verification";

export type LegacyRecoveryLock = {
  schema: 1;
  lockId: string;
  affected: StreamIdentity[];
  reason: LegacyReason;
  phase: CompatPhase;
  unionComplete: boolean;
  createdAt: string;
};

export type RecoveryLockV2 = {
  schema: 2;
  lockId: string;
  kind: RecoveryLockKind;
  stage: RecoveryLockStage;
  affected: StreamIdentity[];
  draftVerification: StreamIdentity[];
  reason: RecoveryLockReason;
  unionComplete: boolean;
  createdAt: string;
  phase: CompatPhase;
};

export type RecoveryLock = LegacyRecoveryLock | RecoveryLockV2;

type LockState =
  | { kind: "none" }
  | { kind: "active"; lock: RecoveryLockV2 }
  | { kind: "invalid" };

type GuardCallback<T> = () => T | Promise<T>;

type LockManagerLike = {
  request: (
    name: string,
    options: { mode: "exclusive" },
    callback: GuardCallback<unknown>,
  ) => Promise<unknown>;
};

export type ReleaseExpectation = {
  lockId: string;
  fingerprint: string;
};

export type LockContext = {
  updateAffected: (
    incoming: StreamIdentity[],
    complete: boolean,
  ) => boolean | Promise<boolean>;
  markVerification: (unionUpdated: boolean) => boolean | Promise<boolean>;
  markStage: (stage: RecoveryLockStage) => boolean | Promise<boolean>;
  markRetryReady: (
    identity?: StreamIdentity,
  ) => boolean | Promise<boolean>;
  abortReserved: (expected: ReleaseExpectation) => boolean | Promise<boolean>;
  release: (expected: ReleaseExpectation) => boolean | Promise<boolean>;
  getCurrent: () => RecoveryLockV2 | null;
};

export type AcquireOptions = {
  kind?: RecoveryLockKind;
  stage?: RecoveryLockStage;
  draftVerification?: StreamIdentity[];
};

let lockCounter = 0;

function newLockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  lockCounter += 1;
  return `lock-${Date.now()}-${lockCounter}`;
}

function isReason(value: unknown): value is RecoveryLockReason {
  return (
    value === "unknown" ||
    value === "degraded" ||
    value === "partial" ||
    value === "verification" ||
    value === "refusal" ||
    value === "handoff" ||
    value === "retry"
  );
}

function isLegacyReason(value: unknown): value is LegacyReason {
  return (
    value === "unknown" ||
    value === "degraded" ||
    value === "partial" ||
    value === "verification"
  );
}

function phaseForStage(stage: RecoveryLockStage): CompatPhase {
  return stage === "verification" || stage === "recovery_ready"
    ? "verification"
    : "running";
}

function isValidStage(value: unknown): value is RecoveryLockStage {
  return (
    value === "reserved" ||
    value === "running" ||
    value === "verification" ||
    value === "recovery_ready" ||
    value === "retry_ready"
  );
}

function isValidIdentities(value: unknown): value is StreamIdentity[] {
  return Array.isArray(value) && value.every(isValidStreamIdentity);
}

function identityFingerprint(identities: StreamIdentity[]): string {
  return streamUnionFingerprint(identities);
}

function normalize(value: unknown): RecoveryLockV2 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.lockId !== "string" ||
    !isValidIdentities(record.affected) ||
    !isReason(record.reason) ||
    typeof record.unionComplete !== "boolean" ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }
  if (record.schema === 1) {
    if (
      !isLegacyReason(record.reason) ||
      (record.phase !== "running" && record.phase !== "verification")
    ) {
      return null;
    }
    return {
      schema: 2,
      lockId: record.lockId,
      kind: "recovery",
      stage: record.phase,
      affected: record.affected,
      draftVerification: [],
      reason: record.reason,
      unionComplete: record.unionComplete,
      createdAt: record.createdAt,
      phase: record.phase,
    };
  }
  if (
    record.schema !== 2 ||
    (record.kind !== "recovery" && record.kind !== "cancel") ||
    !isValidStage(record.stage) ||
    !isValidIdentities(record.draftVerification) ||
    !isReason(record.reason)
  ) {
    return null;
  }
  const affectedKeys = new Set(record.affected.map(streamIdentityKeyLocal));
  if (
    !record.draftVerification.every((identity) =>
      affectedKeys.has(streamIdentityKeyLocal(identity)),
    )
  ) {
    return null;
  }
  return {
    schema: 2,
    lockId: record.lockId,
    kind: record.kind,
    stage: record.stage,
    affected: record.affected,
    draftVerification: record.draftVerification,
    reason: record.reason,
    unionComplete: record.unionComplete,
    createdAt: record.createdAt,
    phase: phaseForStage(record.stage),
  };
}

function streamIdentityKeyLocal(identity: StreamIdentity): string {
  return `${identity.campaignId}:${identity.streamRef}`;
}

function readState(): LockState {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(RECOVERY_LOCK_KEY);
  } catch {
    return { kind: "invalid" };
  }
  if (raw === null) {
    return { kind: "none" };
  }
  try {
    const lock = normalize(JSON.parse(raw));
    return lock === null ? { kind: "invalid" } : { kind: "active", lock };
  } catch {
    return { kind: "invalid" };
  }
}

function currentLock(): RecoveryLockV2 | null {
  const state = readState();
  return state.kind === "active" ? state.lock : null;
}

/**
 * Web Locks gives real same-origin/profile mutual exclusion when available.
 * Without it the read-write-reverify below is best-effort only, never an
 * atomic cross-tab guarantee. Neither path coordinates other browsers,
 * profiles, devices or direct API callers.
 */
async function withGuard<T>(fn: GuardCallback<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (locks && typeof locks.request === "function") {
    return (await locks.request(RECOVERY_LOCK_KEY, { mode: "exclusive" }, fn)) as T;
  }
  return await fn();
}

function lockMatches(
  observed: RecoveryLockV2 | null,
  expected: {
    lockId: string;
    stage?: RecoveryLockStage;
    union: string;
    drafts?: string;
  },
): boolean {
  return (
    observed !== null &&
    observed.lockId === expected.lockId &&
    (expected.stage === undefined || observed.stage === expected.stage) &&
    identityFingerprint(observed.affected) === expected.union &&
    (expected.drafts === undefined ||
      identityFingerprint(observed.draftVerification) === expected.drafts)
  );
}

export function usePublicationRecoveryLock() {
  const [state, setState] = useState<LockState>(readState);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === RECOVERY_LOCK_KEY || event.key === null) {
        setState(readState());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const write = useCallback((lock: RecoveryLockV2): boolean => {
    try {
      window.localStorage.setItem(RECOVERY_LOCK_KEY, JSON.stringify(lock));
    } catch {
      setState(readState());
      return false;
    }
    return true;
  }, []);

  const acquireUnguarded = useCallback(
    (
      affected: StreamIdentity[],
      reason: RecoveryLockReason,
      complete: boolean,
      options: AcquireOptions = {},
    ) => {
      if (readState().kind !== "none") {
        setState(readState());
        return false;
      }
      const kind = options.kind ?? "recovery";
      const stage = options.stage ?? "running";
      const draftVerification = options.draftVerification ?? [];
      const affectedKeys = new Set(affected.map(streamIdentityKeyLocal));
      if (
        !draftVerification.every((identity) =>
          affectedKeys.has(streamIdentityKeyLocal(identity)),
        )
      ) {
        return false;
      }
      const lock: RecoveryLockV2 = {
        schema: 2,
        lockId: newLockId(),
        kind,
        stage,
        affected,
        draftVerification,
        reason,
        unionComplete: complete,
        createdAt: new Date().toISOString(),
        phase: phaseForStage(stage),
      };
      if (!write(lock)) {
        return false;
      }
      const verified = readState();
      setState(verified);
      return (
        verified.kind === "active" &&
        lockMatches(verified.lock, {
          lockId: lock.lockId,
          stage,
          union: identityFingerprint(affected),
          drafts: identityFingerprint(draftVerification),
        })
      );
    },
    [write],
  );

  const updateUnguarded = useCallback(
    (incoming: StreamIdentity[], complete: boolean) => {
      const observed = readState();
      setState(observed);
      if (observed.kind !== "active") {
        return false;
      }
      const { identities, changed } = mergeStreamIdentities(
        observed.lock.affected,
        incoming,
      );
      const unionChanged = changed || observed.lock.unionComplete !== complete;
      if (!unionChanged) {
        const verified = readState();
        setState(verified);
        return (
          verified.kind === "active" &&
          lockMatches(verified.lock, {
            lockId: observed.lock.lockId,
            union: identityFingerprint(identities),
            drafts: identityFingerprint(observed.lock.draftVerification),
          })
        );
      }
      const updated: RecoveryLockV2 = {
        ...observed.lock,
        affected: identities,
        unionComplete: complete,
        phase: phaseForStage(observed.lock.stage),
      };
      if (!write(updated)) {
        return false;
      }
      const verified = readState();
      setState(verified);
      return (
        verified.kind === "active" &&
        lockMatches(verified.lock, {
          lockId: updated.lockId,
          union: identityFingerprint(identities),
          drafts: identityFingerprint(updated.draftVerification),
        })
      );
    },
    [write],
  );

  const markVerificationUnguarded = useCallback(
    (unionUpdated: boolean) => {
      const observed = readState();
      setState(observed);
      if (observed.kind !== "active" || observed.lock.stage !== "running") {
        return false;
      }
      const updated: RecoveryLockV2 = {
        ...observed.lock,
        stage: "verification",
        unionComplete: observed.lock.unionComplete && unionUpdated,
        phase: "verification",
      };
      if (!write(updated)) {
        return false;
      }
      const verified = readState();
      setState(verified);
      return (
        verified.kind === "active" &&
        lockMatches(verified.lock, {
          lockId: updated.lockId,
          stage: "verification",
          union: identityFingerprint(updated.affected),
          drafts: identityFingerprint(updated.draftVerification),
        })
      );
    },
    [write],
  );

  const markStageUnguarded = useCallback(
    (stage: RecoveryLockStage) => {
      const observed = readState();
      setState(observed);
      if (observed.kind !== "active" || observed.lock.stage === stage) {
        return false;
      }
      const updated: RecoveryLockV2 = {
        ...observed.lock,
        stage,
        phase: phaseForStage(stage),
      };
      if (!write(updated)) {
        return false;
      }
      const verified = readState();
      setState(verified);
      return (
        verified.kind === "active" &&
        lockMatches(verified.lock, {
          lockId: updated.lockId,
          stage,
          union: identityFingerprint(updated.affected),
          drafts: identityFingerprint(updated.draftVerification),
        })
      );
    },
    [write],
  );

  const markRetryReadyUnguarded = useCallback(
    (identity?: StreamIdentity) => {
      const observed = readState();
      setState(observed);
      if (observed.kind !== "active" || !observed.lock.unionComplete) {
        return false;
      }
      const drafts = identity
        ? mergeStreamIdentities(observed.lock.draftVerification, [identity]).identities
        : observed.lock.draftVerification;
      const affectedKeys = new Set(observed.lock.affected.map(streamIdentityKeyLocal));
      if (!drafts.every((item) => affectedKeys.has(streamIdentityKeyLocal(item)))) {
        return false;
      }
      const updated: RecoveryLockV2 = {
        ...observed.lock,
        stage: "retry_ready",
        draftVerification: drafts,
        phase: "running",
      };
      if (!write(updated)) {
        return false;
      }
      const verified = readState();
      setState(verified);
      return (
        verified.kind === "active" &&
        lockMatches(verified.lock, {
          lockId: updated.lockId,
          stage: "retry_ready",
          union: identityFingerprint(updated.affected),
          drafts: identityFingerprint(drafts),
        })
      );
    },
    [write],
  );

  const abortReservedUnguarded = useCallback(
    (expected: ReleaseExpectation) => {
      const observed = readState();
      setState(observed);
      if (
        observed.kind !== "active" ||
        observed.lock.stage !== "reserved" ||
        observed.lock.lockId !== expected.lockId ||
        identityFingerprint(observed.lock.affected) !== expected.fingerprint
      ) {
        return false;
      }
      try {
        window.localStorage.removeItem(RECOVERY_LOCK_KEY);
      } catch {
        setState(readState());
        return false;
      }
      const verified = readState();
      setState(verified);
      return verified.kind === "none";
    },
    [],
  );

  const releaseUnguarded = useCallback(
    (expected: ReleaseExpectation) => {
      const observed = readState();
      setState(observed);
      if (
        observed.kind !== "active" ||
        (observed.lock.stage !== "verification" &&
          observed.lock.stage !== "recovery_ready") ||
        !observed.lock.unionComplete
      ) {
        return false;
      }
      if (!lockMatches(observed.lock, { ...expected, union: expected.fingerprint })) {
        return false;
      }
      try {
        window.localStorage.removeItem(RECOVERY_LOCK_KEY);
      } catch {
        setState(readState());
        return false;
      }
      const verified = readState();
      setState(verified);
      return verified.kind === "none";
    },
    [],
  );

  const acquire = useCallback(
    async (
      affected: StreamIdentity[],
      reason: RecoveryLockReason,
      complete: boolean,
      options?: AcquireOptions,
    ) =>
      await withGuard(() =>
        acquireUnguarded(affected, reason, complete, options),
      ),
    [acquireUnguarded],
  );

  const updateAffected = useCallback(
    async (incoming: StreamIdentity[], complete: boolean) =>
      await withGuard(() => updateUnguarded(incoming, complete)),
    [updateUnguarded],
  );

  const markVerification = useCallback(
    async (unionUpdated: boolean) =>
      await withGuard(() => markVerificationUnguarded(unionUpdated)),
    [markVerificationUnguarded],
  );

  const markStage = useCallback(
    async (stage: RecoveryLockStage) =>
      await withGuard(() => markStageUnguarded(stage)),
    [markStageUnguarded],
  );

  const markRetryReady = useCallback(
    async (identity?: StreamIdentity) =>
      await withGuard(() => markRetryReadyUnguarded(identity)),
    [markRetryReadyUnguarded],
  );

  const abortReserved = useCallback(
    async (expected: ReleaseExpectation) =>
      await withGuard(() => abortReservedUnguarded(expected)),
    [abortReservedUnguarded],
  );

  const release = useCallback(
    async (expected: ReleaseExpectation) =>
      await withGuard(() => releaseUnguarded(expected)),
    [releaseUnguarded],
  );

  const runExclusive = useCallback(
    async <T,>(fn: (context: LockContext) => Promise<T>): Promise<T> => {
      const context: LockContext = {
        updateAffected: updateUnguarded,
        markVerification: markVerificationUnguarded,
        markStage: markStageUnguarded,
        markRetryReady: markRetryReadyUnguarded,
        abortReserved: abortReservedUnguarded,
        release: releaseUnguarded,
        getCurrent: currentLock,
      };
      return await withGuard(() => fn(context));
    },
    [
      abortReservedUnguarded,
      markRetryReadyUnguarded,
      markStageUnguarded,
      markVerificationUnguarded,
      releaseUnguarded,
      updateUnguarded,
    ],
  );

  return {
    lock: state.kind === "active" ? state.lock : null,
    invalid: state.kind === "invalid",
    acquire,
    updateAffected,
    release,
    markVerification,
    markStage,
    markRetryReady,
    abortReserved,
    runExclusive,
    getCurrent: currentLock,
  };
}

export type PublicationLockApi = ReturnType<typeof usePublicationRecoveryLock>;

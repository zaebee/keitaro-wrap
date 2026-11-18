import { useCallback, useEffect, useState } from "react";

import {
  isValidStreamIdentity,
  mergeStreamIdentities,
  streamUnionFingerprint,
  type StreamIdentity,
} from "./publicationValidation";

export const RECOVERY_LOCK_KEY =
  "keitaro-wrap:s8d2:publication-recovery-lock:v1";

export type RecoveryLockReason =
  | "unknown"
  | "degraded"
  | "partial"
  | "verification";

export type RecoveryLockPhase = "running" | "verification";

export type RecoveryLock = {
  schema: 1;
  lockId: string;
  affected: StreamIdentity[];
  reason: RecoveryLockReason;
  phase: RecoveryLockPhase;
  unionComplete: boolean;
  createdAt: string;
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
  release: (expected: ReleaseExpectation) => boolean | Promise<boolean>;
  getCurrent: () => RecoveryLock | null;
};

type LockState =
  | { kind: "none" }
  | { kind: "active"; lock: RecoveryLock }
  | { kind: "invalid" };

type GuardCallback<T> = () => T | Promise<T>;

type LockManagerLike = {
  request: (
    name: string,
    options: { mode: "exclusive" },
    callback: GuardCallback<unknown>,
  ) => Promise<unknown>;
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
    value === "verification"
  );
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
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as RecoveryLock).schema === 1 &&
      typeof (parsed as RecoveryLock).lockId === "string" &&
      Array.isArray((parsed as RecoveryLock).affected) &&
      (parsed as RecoveryLock).affected.every(isValidStreamIdentity) &&
      isReason((parsed as RecoveryLock).reason) &&
      ((parsed as RecoveryLock).phase === "running" ||
        (parsed as RecoveryLock).phase === "verification") &&
      typeof (parsed as RecoveryLock).unionComplete === "boolean" &&
      typeof (parsed as RecoveryLock).createdAt === "string"
    ) {
      return { kind: "active", lock: parsed as RecoveryLock };
    }
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "invalid" };
}

function currentLock(): RecoveryLock | null {
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

  const acquireUnguarded = useCallback(
    (
      affected: StreamIdentity[],
      reason: RecoveryLockReason,
      complete: boolean,
    ) => {
      if (readState().kind !== "none") {
        setState(readState());
        return false;
      }
      const lock: RecoveryLock = {
        schema: 1,
        lockId: newLockId(),
        affected,
        reason,
        phase: "running",
        unionComplete: complete,
        createdAt: new Date().toISOString(),
      };
      try {
        window.localStorage.setItem(RECOVERY_LOCK_KEY, JSON.stringify(lock));
      } catch {
        setState(readState());
        return false;
      }
      const verified = readState();
      setState(verified);
      return verified.kind === "active" && verified.lock.lockId === lock.lockId;
    },
    [],
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
        verified.lock.lockId === observed.lock.lockId &&
        streamUnionFingerprint(verified.lock.affected) ===
          streamUnionFingerprint(identities)
      );
    }
    const updated: RecoveryLock = {
      ...observed.lock,
      affected: identities,
      unionComplete: complete,
    };
    try {
      window.localStorage.setItem(RECOVERY_LOCK_KEY, JSON.stringify(updated));
    } catch {
      setState(readState());
      return false;
    }
    const verified = readState();
    setState(verified);
    return (
      verified.kind === "active" &&
      verified.lock.lockId === updated.lockId &&
      streamUnionFingerprint(verified.lock.affected) ===
        streamUnionFingerprint(identities)
    );
  }, []);

  const markVerificationUnguarded = useCallback((unionUpdated: boolean) => {
    const observed = readState();
    setState(observed);
    if (observed.kind !== "active" || observed.lock.phase !== "running") {
      return false;
    }
    const updated: RecoveryLock = {
      ...observed.lock,
      phase: "verification",
      unionComplete: observed.lock.unionComplete && unionUpdated,
    };
    try {
      window.localStorage.setItem(RECOVERY_LOCK_KEY, JSON.stringify(updated));
    } catch {
      setState(readState());
      return false;
    }
    const verified = readState();
    setState(verified);
    return (
      verified.kind === "active" &&
      verified.lock.lockId === updated.lockId &&
      verified.lock.phase === "verification"
    );
  }, []);

  const releaseUnguarded = useCallback((expected: ReleaseExpectation) => {
    const observed = readState();
    setState(observed);
    if (
      observed.kind !== "active" ||
      observed.lock.phase !== "verification" ||
      !observed.lock.unionComplete
    ) {
      return false;
    }
    if (
      observed.lock.lockId !== expected.lockId ||
      streamUnionFingerprint(observed.lock.affected) !== expected.fingerprint
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
  }, []);

  const acquire = useCallback(
    async (
      affected: StreamIdentity[],
      reason: RecoveryLockReason,
      complete: boolean,
    ) => await withGuard(() => acquireUnguarded(affected, reason, complete)),
    [acquireUnguarded],
  );

  const updateAffected = useCallback(
    async (incoming: StreamIdentity[], complete: boolean) =>
      await withGuard(() => updateUnguarded(incoming, complete)),
    [updateUnguarded],
  );

  const release = useCallback(
    async (expected: ReleaseExpectation) =>
      await withGuard(() => releaseUnguarded(expected)),
    [releaseUnguarded],
  );

  const markVerification = useCallback(
    async (unionUpdated: boolean) =>
      await withGuard(() => markVerificationUnguarded(unionUpdated)),
    [markVerificationUnguarded],
  );

  const runExclusive = useCallback(
    async <T,>(fn: (context: LockContext) => Promise<T>): Promise<T> => {
      const context: LockContext = {
        updateAffected: updateUnguarded,
        release: releaseUnguarded,
        getCurrent: currentLock,
      };
      return await withGuard(() => fn(context));
    },
    [releaseUnguarded, updateUnguarded],
  );

  return {
    lock: state.kind === "active" ? state.lock : null,
    invalid: state.kind === "invalid",
    acquire,
    updateAffected,
    release,
    markVerification,
    runExclusive,
    getCurrent: currentLock,
  };
}

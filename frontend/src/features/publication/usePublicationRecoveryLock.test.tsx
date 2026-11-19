import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECOVERY_LOCK_KEY,
  usePublicationRecoveryLock,
  type RecoveryLock,
} from "./usePublicationRecoveryLock";

function readLock(): RecoveryLock | null {
  const raw = window.localStorage.getItem(RECOVERY_LOCK_KEY);
  return raw === null ? null : (JSON.parse(raw) as RecoveryLock);
}

describe("usePublicationRecoveryLock union verification", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("rejects a same-length but different union after a concurrent write", async () => {
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      writes += 1;
      if (key === RECOVERY_LOCK_KEY && writes === 2) {
        const lock = JSON.parse(String(value)) as RecoveryLock;
        lock.affected = [{ campaignId: 42, streamRef: 102 }];
        originalSetItem.call(this, key, JSON.stringify(lock));
        return;
      }
      originalSetItem.call(this, key, String(value));
    });

    const { result } = renderHook(() => usePublicationRecoveryLock());
    await act(async () => {
      expect(
        await result.current.acquire(
          [{ campaignId: 42, streamRef: 101 }],
          "verification",
          true,
        ),
      ).toBe(true);
    });
    await act(async () => {
      expect(
        await result.current.updateAffected(
          [{ campaignId: 43, streamRef: 101 }],
          true,
        ),
      ).toBe(false);
    });

    expect(readLock()?.affected).toEqual([{ campaignId: 42, streamRef: 102 }]);
  });

  it("rejects a tampered union in the no-change re-read branch", async () => {
    const { result } = renderHook(() => usePublicationRecoveryLock());
    await act(async () => {
      expect(
        await result.current.acquire(
          [{ campaignId: 42, streamRef: 101 }],
          "verification",
          true,
        ),
      ).toBe(true);
    });

    const originalGetItem = Storage.prototype.getItem;
    let reads = 0;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      key,
    ) {
      const value = originalGetItem.call(this, key);
      if (key === RECOVERY_LOCK_KEY && value !== null && reads === 0) {
        reads += 1;
        return value;
      }
      if (key === RECOVERY_LOCK_KEY && value !== null) {
        const lock = JSON.parse(value) as RecoveryLock;
        lock.affected = [{ campaignId: 42, streamRef: 102 }];
        return JSON.stringify(lock);
      }
      return value;
    });

    await act(async () => {
      expect(
        await result.current.updateAffected(
          [{ campaignId: 42, streamRef: 101 }],
          true,
        ),
      ).toBe(false);
    });
  });
});

describe("publication lock lifecycle and migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("reads a v1 recovery lock without rewriting or clearing it", async () => {
    const legacy = {
      schema: 1,
      lockId: "legacy-1",
      affected: [{ campaignId: 42, streamRef: 101 }],
      reason: "verification",
      phase: "verification",
      unionComplete: true,
      createdAt: "2026-11-19T00:00:00.000Z",
    };
    window.localStorage.setItem(RECOVERY_LOCK_KEY, JSON.stringify(legacy));
    const { result } = renderHook(() => usePublicationRecoveryLock());

    expect(result.current.invalid).toBe(false);
    expect(result.current.lock).toMatchObject({
      lockId: "legacy-1",
      kind: "recovery",
      stage: "verification",
      draftVerification: [],
    });
    expect(JSON.parse(window.localStorage.getItem(RECOVERY_LOCK_KEY) ?? "")).toEqual(legacy);

    await act(async () => {
      expect(
        await result.current.acquire([], "verification", true),
      ).toBe(false);
    });
    await act(async () => {
      expect(
        await result.current.release({
          lockId: "legacy-1",
          fingerprint: "42:101",
        }),
      ).toBe(true);
    });
    expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull();
  });

  it("supports cancel stages and upgrades the persisted lock on first write", async () => {
    const { result } = renderHook(() => usePublicationRecoveryLock());
    const target = { campaignId: 42, streamRef: 101 };
    await act(async () => {
      expect(
        await result.current.acquire(
          [target],
          "verification",
          true,
          { kind: "cancel", stage: "reserved", draftVerification: [target] },
        ),
      ).toBe(true);
    });
    await act(async () => {
      expect(await result.current.markStage("running")).toBe(true);
    });
    await act(async () => {
      expect(await result.current.markVerification(true)).toBe(true);
    });
    await act(async () => {
      expect(await result.current.markStage("recovery_ready")).toBe(true);
    });
    expect(readLock()).toMatchObject({
      schema: 2,
      kind: "cancel",
      stage: "recovery_ready",
      phase: "verification",
      draftVerification: [target],
    });
    await act(async () => {
      expect(
        await result.current.release({
          lockId: readLock()?.lockId ?? "",
          fingerprint: "42:101",
        }),
      ).toBe(true);
    });
  });

  it("fails closed on an incomplete v1 lock", () => {
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify({ schema: 1, lockId: "broken", affected: [] }),
    );
    const { result } = renderHook(() => usePublicationRecoveryLock());
    expect(result.current.invalid).toBe(true);
    expect(result.current.lock).toBeNull();
    expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).not.toBeNull();
  });
});

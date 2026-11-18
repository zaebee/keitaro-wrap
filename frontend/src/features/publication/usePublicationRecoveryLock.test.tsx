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

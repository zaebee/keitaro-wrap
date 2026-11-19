import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  draftStateFixture,
  draftViewFixture,
  errorResponse,
  publicationOperationFixture,
} from "../../test/fixtures";
import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";
import {
  RECOVERY_LOCK_KEY,
  type RecoveryLock,
} from "./usePublicationRecoveryLock";

const QUEUE_PATH = "*/api/publications/recoverable*";
const op42 = publicationOperationFixture({
  operation_uuid: "op-42",
  campaign_id: 42,
  stream_ref: 101,
});
const op43 = publicationOperationFixture({
  operation_uuid: "op-43",
  campaign_id: 43,
  stream_ref: 101,
});

function recoveryResult(overrides: Record<string, unknown> = {}) {
  return {
    processed: 0,
    confirmed: 0,
    unresolved: 0,
    degraded: 0,
    remaining: 0,
    deadline_reached: false,
    ...overrides,
  };
}

function stateFor(campaignId: number, streamRef: number, status = "succeeded") {
  return {
    stream_ref: streamRef,
    operation: publicationOperationFixture({
      operation_uuid: `op-${campaignId}-${streamRef}`,
      campaign_id: campaignId,
      stream_ref: streamRef,
      status,
    }),
  };
}

function readLock(): RecoveryLock | null {
  const raw = window.localStorage.getItem(RECOVERY_LOCK_KEY);
  return raw === null ? null : (JSON.parse(raw) as RecoveryLock);
}

type TestUser = ReturnType<typeof userEvent.setup>;

async function startRecovery(user: TestUser) {
  await user.click(screen.getByRole("button", { name: "Run recovery" }));
  await user.click(
    screen.getByRole("button", { name: "Confirm recovery" }),
  );
}

async function clickUnlock(user: TestUser) {
  await user.click(
    screen.getByRole("button", { name: "Re-read authoritative state" }),
  );
}

function failSetItemOn(writes: number[]) {
  const original = Storage.prototype.setItem;
  let count = 0;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    count += 1;
    if (writes.includes(count)) {
      throw new Error("quota");
    }
    original.call(this, key, String(value));
  });
}

describe("S8-D2 recovery pass", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("never runs recovery on load and requires explicit confirmation", async () => {
    let postCount = 0;
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    expect(
      await screen.findByRole("button", { name: "Run recovery" }),
    ).toBeInTheDocument();
    expect(postCount).toBe(0);

    await user.click(screen.getByRole("button", { name: "Run recovery" }));
    expect(
      screen.getByRole("group", { name: "Confirm recovery pass" }),
    ).toBeInTheDocument();
    expect(postCount).toBe(0);

    await user.click(screen.getByRole("button", { name: "Keep queue unchanged" }));
    expect(postCount).toBe(0);
    expect(readLock()).toBeNull();
  });

  it("acquires lock before POST, renders counters and persists the affected union", async () => {
    let queue = [op42];
    let postCount = 0;
    let acquireSawNoLock: boolean | null = null;
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        acquireSawNoLock = readLock() !== null;
        queue = [op42, op43];
        return HttpResponse.json(
          recoveryResult({ processed: 1, confirmed: 1 }),
        );
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });

    await startRecovery(user);

    expect(await screen.findByText("Recovery pass completed")).toBeInTheDocument();
    expect(readLock()?.phase).toBe("verification");
    expect(screen.getByText("Processed").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByRole("heading", { name: "Recovery lock active" })).toBeInTheDocument();
    expect(acquireSawNoLock).toBe(true);
    expect(postCount).toBe(1);
    expect(readLock()?.unionComplete).toBe(true);
    expect(readLock()?.affected).toEqual([
      { campaignId: 42, streamRef: 101 },
      { campaignId: 43, streamRef: 101 },
    ]);
  });

  it("unlocks only after a fresh empty queue and all persisted identities validate", async () => {
    let queue = [op42];
    const requestedStatusPaths: string[] = [];
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        queue = [op42, op43];
        return HttpResponse.json(recoveryResult());
      }),
      http.get("*/api/campaigns/:campaignId/streams/:streamRef/publication", ({ params }) => {
        requestedStatusPaths.push(`${params.campaignId}/${params.streamRef}`);
        return HttpResponse.json(
          stateFor(Number(params.campaignId), Number(params.streamRef)),
        );
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);
    await screen.findByRole("heading", { name: "Recovery lock active" });

    queue = [];
    await clickUnlock(user);

    await waitFor(() => expect(readLock()).toBeNull());
    expect(
      screen.getByText(
        "No unresolved operations in the current bounded read; previously tracked stream identities re-read successfully.",
      ),
    ).toBeInTheDocument();
    expect(requestedStatusPaths).toEqual(["42/101", "43/101"]);
  });

  it.each([
    ["remaining", recoveryResult({ remaining: 2 }), 200],
    ["unresolved", recoveryResult({ unresolved: 1 }), 200],
    ["degraded", recoveryResult({ degraded: 1, deadline_reached: true }), 200],
    ["503", recoveryResult({ degraded: 1, remaining: 2, deadline_reached: true }), 503],
  ])("keeps the lock for %s results without claiming resolution", async (_name, result, status) => {
    let postCount = 0;
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return status === 503
          ? errorResponse("RECOVERY_DEGRADED", 503, { result })
          : HttpResponse.json(result);
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText("Recovery lock active", { selector: "h2" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recovery pass completed")).toBeNull();
    expect(postCount).toBe(1);
    expect(readLock()).not.toBeNull();
  });

  it("acquires lock and never retries after a network failure", async () => {
    let postCount = 0;
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.error();
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText("Recovery outcome unknown or incomplete"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recovery lock active" })).toBeInTheDocument();
    expect(readLock()?.phase).toBe("verification");
    expect(postCount).toBe(1);
  });

  it("fails closed when the lock cannot be persisted before POST", async () => {
    let postCount = 0;
    failSetItemOn([1]);
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText(
        "Could not persist the recovery lock. No recovery pass was started.",
      ),
    ).toBeInTheDocument();
    expect(postCount).toBe(0);
    expect(readLock()).toBeNull();
  });

  it("fails closed when the affected union cannot be persisted", async () => {
    failSetItemOn([2]);
    let queue = [op42];
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        queue = [op42, op43];
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText(
        "The affected identity union could not be persisted. The lock remains active and unlock is blocked.",
      ),
    ).toBeInTheDocument();
    expect(readLock()?.affected).toEqual([
      { campaignId: 42, streamRef: 101 },
    ]);
  });

  it.each([
    ["truncated", Array.from({ length: 100 }, (_, i) =>
      publicationOperationFixture({ operation_uuid: `op-${i}`, stream_ref: 200 + i }),
    )],
    ["non-empty", [op42]],
    ["malformed", [{ operation_uuid: "broken" }]],
  ])("keeps the lock when the current queue read is %s", async (_name, queueResponse) => {
    let queue = [op42];
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        queue = [];
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);
    await screen.findByRole("heading", { name: "Recovery lock active" });

    queue = queueResponse as never[];
    await clickUnlock(user);

    if (_name === "malformed") {
      expect(
        await screen.findByText(
          "The bounded queue response was malformed. The lock remains active.",
        ),
      ).toBeInTheDocument();
    } else {
      expect(
        await screen.findByText(
          _name === "truncated"
            ? "The current queue read is potentially truncated. The lock remains active."
            : "1 unresolved operation(s) remain in the complete bounded read. The lock remains active.",
        ),
      ).toBeInTheDocument();
    }
    expect(readLock()).not.toBeNull();
  });

  it("keeps the lock when a persisted identity returns wrong campaign data", async () => {
    let queue = [op42];
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        queue = [];
        return HttpResponse.json(recoveryResult());
      }),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(43, 101)),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);
    await screen.findByRole("heading", { name: "Recovery lock active" });

    queue = [];
    await clickUnlock(user);

    expect(
      await screen.findByText(
        "One or more tracked stream states could not be validated. The lock remains active.",
      ),
    ).toBeInTheDocument();
    expect(readLock()).not.toBeNull();
  });

  it("keeps GET reads available while locked and does not POST on GET retry", async () => {
    let queue: unknown[] | "error" = [op42];
    let postCount = 0;
    server.use(
      http.get(QUEUE_PATH, () =>
        queue === "error" ? errorResponse("INTERNAL_ERROR", 500, {}) : HttpResponse.json(queue),
      ),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);
    await screen.findByRole("heading", { name: "Recovery lock active" });
    expect(
      screen.queryByRole("button", { name: "Run recovery" }),
    ).toBeNull();

    queue = "error";
    await clickUnlock(user);

    expect(
      await screen.findByText(
        "Authoritative GET re-read failed. The lock remains active.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-read authoritative state" })).toBeInTheDocument();
    expect(postCount).toBe(1);
  });

  it.each(["pending", "in_progress", "ambiguous"])(
    "keeps the lock when a tracked stream is still %s",
    async (status) => {
      let queue = [op42];
      server.use(
        http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
        http.post("*/api/publications/recover", () => {
          queue = [];
          return HttpResponse.json(recoveryResult());
        }),
        http.get("*/api/campaigns/42/streams/101/publication", () =>
          HttpResponse.json(stateFor(42, 101, status)),
        ),
      );
      const user = userEvent.setup();
      renderApp("/recovery");
      await screen.findByRole("button", { name: "Run recovery" });
      await startRecovery(user);
      await screen.findByRole("heading", { name: "Recovery lock active" });

      queue = [];
      await clickUnlock(user);

      expect(
        await screen.findByText(
          "One or more tracked stream states could not be validated. The lock remains active.",
        ),
      ).toBeInTheDocument();
      expect(readLock()).not.toBeNull();
    },
  );

  it("uses a fresh queue snapshot at confirmation time", async () => {
    let queue: unknown[] = [op42];
    let postCount = 0;
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });

    queue = [op42, op43];
    await startRecovery(user);

    await screen.findByText("Recovery pass completed");
    expect(postCount).toBe(1);
    expect(readLock()?.affected).toEqual([
      { campaignId: 42, streamRef: 101 },
      { campaignId: 43, streamRef: 101 },
    ]);
  });

  it("does not start recovery when the fresh queue snapshot is malformed", async () => {
    let queue: unknown[] | { operation_uuid: string } = [op42];
    let postCount = 0;
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });

    queue = [{ operation_uuid: "broken" }];
    await startRecovery(user);

    expect(
      await screen.findByText(
        "A fresh valid queue snapshot is required before recovery can start.",
      ),
    ).toBeInTheDocument();
    expect(postCount).toBe(0);
    expect(readLock()).toBeNull();
  });

  it("treats a malformed successful recovery response as unknown", async () => {
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.post("*/api/publications/recover", () => HttpResponse.json({})),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText(
        "The recovery response was malformed. The outcome is unknown.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recovery pass completed")).toBeNull();
    expect(readLock()).not.toBeNull();
  });

  it("does not call a degraded-only 200 a completed pass", async () => {
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.post("*/api/publications/recover", () =>
        HttpResponse.json(recoveryResult({ degraded: 1 })),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText("Recovery pass did not complete cleanly"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recovery pass completed")).toBeNull();
  });

  it("refuses release when another tab expands the union during verification", async () => {
    let queue: unknown[] = [op42];
    let resolveStatus: (() => void) | null = null;
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        queue = [];
        return HttpResponse.json(recoveryResult());
      }),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        new Promise((resolve) => {
          resolveStatus = () => resolve(HttpResponse.json(stateFor(42, 101)));
        }),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);
    await screen.findByRole("heading", { name: "Recovery lock active" });

    queue = [];
    await clickUnlock(user);
    await waitFor(() => expect(resolveStatus).not.toBeNull());
    act(() => {
      const current = readLock();
      if (current) {
        current.affected.push({ campaignId: 43, streamRef: 101 });
        window.localStorage.setItem(
          RECOVERY_LOCK_KEY,
          JSON.stringify(current),
        );
      }
      resolveStatus?.();
    });

    expect(
      await screen.findByText(
        "The persisted lock changed during verification. The lock remains active.",
      ),
    ).toBeInTheDocument();
    expect(readLock()?.affected).toEqual([
      { campaignId: 42, streamRef: 101 },
      { campaignId: 43, streamRef: 101 },
    ]);
  });

  it("blocks unlock while the persisted union is incomplete", async () => {
    failSetItemOn([2, 4]);
    let queue = [op42];
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
      http.post("*/api/publications/recover", () => {
        queue = [op42, op43];
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText(
        /The affected identity union could not be persisted/,
      ),
    ).toBeInTheDocument();
    expect(readLock()?.phase).toBe("verification");
    expect(readLock()?.unionComplete).toBe(false);
    await clickUnlock(user);

    expect(
      await screen.findByText(
        /Could not persist the affected identity union. The lock remains active/,
      ),
    ).toBeInTheDocument();
    expect(readLock()).not.toBeNull();
  });

  it("keeps running until the post-run queue GET and union save finish", async () => {
    let queueGets = 0;
    let resolvePostRunQueue: (() => void) | null = null;
    server.use(
      http.get(QUEUE_PATH, () => {
        queueGets += 1;
        if (queueGets === 3) {
          return new Promise((resolve) => {
            resolvePostRunQueue = () =>
              resolve(HttpResponse.json([op42]));
          });
        }
        return HttpResponse.json([op42]);
      }),
      http.post("*/api/publications/recover", () =>
        HttpResponse.json(recoveryResult()),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    await waitFor(() => expect(resolvePostRunQueue).not.toBeNull());
    expect(readLock()?.phase).toBe("running");
    expect(
      screen.getByRole("button", { name: "Re-read authoritative state" }),
    ).toBeDisabled();

    await act(async () => {
      resolvePostRunQueue?.();
    });

    await waitFor(() => expect(readLock()?.phase).toBe("verification"));
    expect(
      screen.getByRole("button", { name: "Re-read authoritative state" }),
    ).toBeEnabled();
  });

  it("allows reconciliation after a failed post-run queue GET", async () => {
    let queueGets = 0;
    let queue: unknown[] = [];
    server.use(
      http.get(QUEUE_PATH, () => {
        queueGets += 1;
        if (queueGets === 3) {
          return errorResponse("INTERNAL_ERROR", 500, {});
        }
        return HttpResponse.json(queue);
      }),
      http.post("*/api/publications/recover", () => {
        queue = [];
        return HttpResponse.json(recoveryResult());
      }),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101)),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText(
        /The affected identity union could not be persisted/,
      ),
    ).toBeInTheDocument();
    expect(readLock()?.phase).toBe("verification");
    expect(readLock()?.unionComplete).toBe(false);
    await clickUnlock(user);

    expect(
      await screen.findByText(
        "No unresolved operations in the current bounded read; previously tracked stream identities re-read successfully.",
      ),
    ).toBeInTheDocument();
    expect(readLock()).toBeNull();
  });

  it("keeps a running lock and disables reconciliation until POST completes", async () => {
    let resolvePost: (() => void) | null = null;
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.post(
        "*/api/publications/recover",
        () =>
          new Promise((resolve) => {
            resolvePost = () => resolve(HttpResponse.json(recoveryResult()));
          }),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByRole("heading", { name: "Recovery lock active" }),
    ).toBeInTheDocument();
    expect(readLock()?.phase).toBe("running");
    expect(
      screen.getByRole("button", { name: "Re-read authoritative state" }),
    ).toBeDisabled();

    await act(async () => {
      resolvePost?.();
    });

    expect(await screen.findByText("Recovery pass completed")).toBeInTheDocument();
    expect(readLock()?.phase).toBe("verification");
  });

  it("fails closed when the running-to-verification transition cannot persist", async () => {
    failSetItemOn([2]);
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.post("*/api/publications/recover", () =>
        HttpResponse.json(recoveryResult()),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });
    await startRecovery(user);

    expect(
      await screen.findByText(
        /Could not persist the recovery phase transition/,
      ),
    ).toBeInTheDocument();
    expect(readLock()?.phase).toBe("running");
    expect(
      screen.getByRole("button", { name: "Re-read authoritative state" }),
    ).toBeDisabled();
  });

  it("observes lock changes from another tab via storage events", async () => {
    const lock: RecoveryLock = {
      schema: 1,
      lockId: "other-tab",
      affected: [{ campaignId: 42, streamRef: 101 }],
      reason: "verification",
      phase: "verification",
      unionComplete: true,
      createdAt: new Date().toISOString(),
    };
    server.use(http.get(QUEUE_PATH, () => HttpResponse.json([op42])));

    renderApp("/recovery");
    await screen.findByRole("button", { name: "Run recovery" });

    window.localStorage.setItem(RECOVERY_LOCK_KEY, JSON.stringify(lock));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: RECOVERY_LOCK_KEY }));
    });

    expect(
      await screen.findByRole("heading", { name: "Recovery lock active" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run recovery" }),
    ).toBeNull();
  });
});


const cancelLock = (
  stage: "recovery_ready" | "retry_ready" | "reserved",
) => ({
  schema: 2,
  lockId: "cancel-lock-1",
  kind: "cancel",
  stage,
  affected: [{ campaignId: 42, streamRef: 101 }],
  draftVerification: [{ campaignId: 42, streamRef: 101 }],
  cancelTarget: { campaignId: 42, streamRef: 101 },
  reason: "handoff",
  unionComplete: true,
  createdAt: new Date().toISOString(),
  phase: stage === "retry_ready" ? "running" : "verification",
});

async function unlock(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Re-read authoritative state" }),
  );
}

describe("S8-D3 Cancel-origin lock verification", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("releases a recovery_ready Cancel lock without a Recovery POST when all GET obligations pass", async () => {
    let postCount = 0;
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("recovery_ready")),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([])),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "succeeded")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(postCount).toBe(0);
    expect(
      await screen.findByText(/No unresolved operations in the current bounded read/),
    ).toBeInTheDocument();
  });

  it("keeps the lock when the complete queue still contains an operation", async () => {
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("recovery_ready")),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "succeeded")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).not.toBeNull();
    expect(
      screen.getByText(/1 unresolved operation\(s\) remain/),
    ).toBeInTheDocument();
  });

  it("keeps the lock when a required draft GET is malformed", async () => {
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("recovery_ready")),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([])),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "succeeded")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json({ stream_ref: 999, draft: null }),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).not.toBeNull();
    expect(
      screen.getByText(/required draft state could not be validated/),
    ).toBeInTheDocument();
  });

  it("keeps the lock when the queue read is potentially truncated", async () => {
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("recovery_ready")),
    );
    const truncated = Array.from({ length: 100 }, (_, index) =>
      publicationOperationFixture({
        operation_uuid: `op-${index}`,
        stream_ref: 200 + index,
      }),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json(truncated)),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "succeeded")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).not.toBeNull();
    expect(
      screen.getByText(/potentially truncated. The lock remains active/),
    ).toBeInTheDocument();
  });

  it("runs explicit Recovery under the same handoff lock and unlocks with draft verification", async () => {
    let postCount = 0;
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("recovery_ready")),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([])),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json(recoveryResult());
      }),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "succeeded")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await user.click(
      await screen.findByRole("button", { name: "Run recovery" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm recovery" }),
    );
    await waitFor(() => expect(postCount).toBe(1));
    expect(readLock()?.lockId).toBe("cancel-lock-1");

    await unlock(user);
    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(postCount).toBe(1);
  });

  it("sends one explicit retry under the same lock without automatic retries", async () => {
    let postCount = 0;
    let cancelled = false;
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("retry_ready")),
    );
    server.use(
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, cancelled ? "abandoned" : "pending")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
      http.get(QUEUE_PATH, () =>
        HttpResponse.json(
          cancelled
            ? []
            : [
                publicationOperationFixture({
                  operation_uuid: "op-pending",
                  status: "pending",
                }),
              ],
        ),
      ),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        postCount += 1;
        cancelled = true;
        return HttpResponse.json({
          stream_ref: 101,
          status: "abandoned",
          reason: null,
          draft_discarded: true,
        });
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await user.click(
      await screen.findByRole("button", { name: "Confirm cancel retry" }),
    );

    await waitFor(() => expect(postCount).toBe(1));
    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(postCount).toBe(1);
  });
});


describe("S8-D3 non-in-flight lock reconciliation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("reconciles retry_ready with a terminal status without any mutation POST", async () => {
    let cancelPosts = 0;
    let recoveryPosts = 0;
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("retry_ready")),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([])),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "succeeded")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        cancelPosts += 1;
        return HttpResponse.json({});
      }),
      http.post("*/api/publications/recover", () => {
        recoveryPosts += 1;
        return HttpResponse.json(recoveryResult());
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(cancelPosts).toBe(0);
    expect(recoveryPosts).toBe(0);
  });

  it("hands retry_ready off to recovery when status becomes in_progress", async () => {
    let cancelPosts = 0;
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("retry_ready")),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([op42])),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "in_progress")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        cancelPosts += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    await waitFor(() =>
      expect(readLock()).toMatchObject({
        kind: "cancel",
        stage: "recovery_ready",
      }),
    );
    expect(cancelPosts).toBe(0);
  });

  it("keeps retry_ready and the explicit retry when status is still pending", async () => {
    let cancelPosts = 0;
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("retry_ready")),
    );
    server.use(
      http.get(QUEUE_PATH, () =>
        HttpResponse.json([
          publicationOperationFixture({
            operation_uuid: "op-pending",
            status: "pending",
          }),
        ]),
      ),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "pending")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        cancelPosts += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    expect(readLock()).toMatchObject({
      kind: "cancel",
      stage: "retry_ready",
    });
    expect(
      screen.getByRole("button", { name: "Confirm cancel retry" }),
    ).toBeInTheDocument();
    expect(cancelPosts).toBe(0);
  });

  it("keeps retry_ready and GET retry available after a failed status read", async () => {
    let cancelPosts = 0;
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("retry_ready")),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([])),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.error(),
      ),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        cancelPosts += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    expect(readLock()).toMatchObject({
      kind: "cancel",
      stage: "retry_ready",
    });
    expect(
      screen.getByRole("button", { name: "Re-read authoritative state" }),
    ).toBeEnabled();
    expect(cancelPosts).toBe(0);
  });

  it("reconciles a persisted reserved lock after reload without sending Cancel", async () => {
    let cancelPosts = 0;
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("reserved")),
    );
    server.use(
      http.get(QUEUE_PATH, () => HttpResponse.json([])),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "abandoned")),
      ),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        cancelPosts += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(cancelPosts).toBe(0);
  });
});


describe("S8-D3 target identity and snapshot guards", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("keeps an unrelated pending queue identity from becoming the retry target", async () => {
    let cancelPosts = 0;
    const lock = {
      ...cancelLock("retry_ready"),
      affected: [
        { campaignId: 42, streamRef: 102 },
        { campaignId: 42, streamRef: 101 },
      ],
    };
    window.localStorage.setItem(RECOVERY_LOCK_KEY, JSON.stringify(lock));
    server.use(
      http.get(QUEUE_PATH, () =>
        HttpResponse.json([
          publicationOperationFixture({
            operation_uuid: "op-102",
            stream_ref: 102,
            status: "pending",
          }),
        ]),
      ),
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(stateFor(42, 101, "succeeded")),
      ),
      http.get("*/api/campaigns/42/streams/102/publication", () =>
        HttpResponse.json(stateFor(42, 102, "pending")),
      ),
      http.get("*/api/campaigns/42/streams/102/draft", () =>
        HttpResponse.json(draftStateFixture(draftViewFixture({ stream_ref: 102 }))),
      ),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        cancelPosts += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await unlock(user);

    expect(readLock()).toMatchObject({
      kind: "cancel",
      stage: "retry_ready",
      cancelTarget: { campaignId: 42, streamRef: 101 },
      draftVerification: [{ campaignId: 42, streamRef: 101 }],
    });
    expect(cancelPosts).toBe(0);
    expect(
      screen.getByText(/unrelated affected stream is pending/),
    ).toBeInTheDocument();
  });

  it("does not mutate a replacement lock or send Cancel after a stale preflight", async () => {
    let cancelPosts = 0;
    let replaced = false;
    const replacement = {
      ...cancelLock("recovery_ready"),
      lockId: "replacement-lock",
      kind: "recovery",
      affected: [{ campaignId: 42, streamRef: 999 }],
      draftVerification: [],
      cancelTarget: null,
    };
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify(cancelLock("retry_ready")),
    );
    server.use(
      http.get("*/api/campaigns/42/streams/101/publication", () => {
        if (!replaced) {
          replaced = true;
          window.localStorage.setItem(
            RECOVERY_LOCK_KEY,
            JSON.stringify(replacement),
          );
        }
        return HttpResponse.json(stateFor(42, 101, "pending"));
      }),
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
      http.get(QUEUE_PATH, () =>
        HttpResponse.json([
          publicationOperationFixture({
            operation_uuid: "op-pending",
            status: "pending",
          }),
        ]),
      ),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        cancelPosts += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    await user.click(
      await screen.findByRole("button", { name: "Confirm cancel retry" }),
    );

    await waitFor(() => expect(replaced).toBe(true));
    expect(readLock()).toMatchObject({
      lockId: "replacement-lock",
      kind: "recovery",
      stage: "recovery_ready",
    });
    expect(cancelPosts).toBe(0);
  });
});

import { cleanup, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  committedFixture,
  draftStateFixture,
  errorResponse,
  publicationOperationFixture,
} from "../../test/fixtures";
import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";
import { RECOVERY_LOCK_KEY } from "./usePublicationRecoveryLock";

const EDITOR_PATH = "/campaigns/42/streams/101";
const CANCEL_PATH = "*/api/campaigns/42/streams/101/publication/cancel";
const QUEUE_PATH = "*/api/publications/recoverable*";

function stateFor(status: string, streamRef = 101) {
  return {
    stream_ref: streamRef,
    operation: publicationOperationFixture({ status, stream_ref: streamRef }),
  };
}

function queueFor(operations: ReturnType<typeof publicationOperationFixture>[]) {
  return operations;
}


function absenceEvidenceError() {
  return errorResponse("PUBLICATION_ABSENCE_EVIDENCE_REQUIRED", 409, {
    status: "failed",
    reason: "ABSENCE_EVIDENCE_REQUIRED",
    result: {
      stream_ref: 101,
      status: "failed",
      reason: "ABSENCE_EVIDENCE_REQUIRED",
      draft_discarded: false,
    },
  });
}

function serveBase(
  getStatus: () => Record<string, unknown> = () => stateFor("pending"),
  queue = queueFor([]),
) {
  server.use(
    http.get("*/api/campaigns/42/streams/101/committed", () =>
      HttpResponse.json(committedFixture()),
    ),
    http.get("*/api/campaigns/42/streams/101/draft", () =>
      HttpResponse.json(draftStateFixture()),
    ),
    http.get("*/api/campaigns/42/streams/101/publication", () =>
      HttpResponse.json(getStatus()),
    ),
    http.get("*/api/campaigns/42/streams/102/publication", () =>
      HttpResponse.json(stateFor("in_progress", 102)),
    ),
    http.get(QUEUE_PATH, () => HttpResponse.json(queue)),
  );
}

async function confirmCancel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Cancel publication" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Confirm publication cancel" }),
  );
}

describe("S8-D3 publication Cancel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("sends one Cancel for pending and releases the lock after verification", async () => {
    let cancelled = false;
    let postCount = 0;
    serveBase(() => stateFor(cancelled ? "abandoned" : "pending"));
    server.use(
      http.post(CANCEL_PATH, () => {
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
    renderApp(EDITOR_PATH);

    await confirmCancel(user);

    await waitFor(() => expect(postCount).toBe(1));
    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(await screen.findByText(/Authoritative status and queue reads passed/)).toBeInTheDocument();
  });

  it("renders recovery-required and succeeded states without sending Cancel", async () => {
    let postCount = 0;
    serveBase(() => stateFor("in_progress"));
    server.use(http.post(CANCEL_PATH, () => {
      postCount += 1;
      return HttpResponse.json({});
    }));
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    expect(
      await screen.findByText(/Recovery is required before this publication/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel publication" })).toBeNull();
    expect(postCount).toBe(0);
    await user.click(screen.getByRole("link", { name: "Inspect recovery queue" }));
    expect(await screen.findByRole("heading", { name: "Recoverable publications" })).toBeInTheDocument();
  });

  it("treats failed without evidence as a definitive 409 and releases", async () => {
    let postCount = 0;
    serveBase(() => stateFor("failed"));
    server.use(
      http.post(CANCEL_PATH, () => {
        postCount += 1;
        return absenceEvidenceError();
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    await confirmCancel(user);

    await waitFor(() => expect(postCount).toBe(1));
    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(postCount).toBe(1);
  });

  it("keeps the lock handed off when another affected identity is unresolved", async () => {
    let postCount = 0;
    serveBase(
      () => stateFor("failed"),
      queueFor([
        publicationOperationFixture({ operation_uuid: "op-101", stream_ref: 101, status: "failed" }),
        publicationOperationFixture({ operation_uuid: "op-102", stream_ref: 102, status: "in_progress" }),
      ]),
    );
    server.use(
      http.post(CANCEL_PATH, () => {
        postCount += 1;
        return absenceEvidenceError();
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    await confirmCancel(user);

    await waitFor(() => expect(postCount).toBe(1));
    await waitFor(() => {
      const raw = window.localStorage.getItem(RECOVERY_LOCK_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw ?? "{}")).toMatchObject({
        kind: "cancel",
        stage: "recovery_ready",
      });
    });
    expect(postCount).toBe(1);
  });

  it("never retries a lost Cancel response and verifies before release", async () => {
    let postCount = 0;
    let cancelled = false;
    serveBase(() => stateFor(cancelled ? "abandoned" : "pending"));
    server.use(
      http.post(CANCEL_PATH, () => {
        postCount += 1;
        cancelled = true;
        return HttpResponse.error();
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    await confirmCancel(user);

    await waitFor(() => expect(postCount).toBe(1));
    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(postCount).toBe(1);
  });

  it("accepts a terminal operation that appeared after NO_PUBLICATION", async () => {
    let postCount = 0;
    let appeared = false;
    serveBase(() => stateFor(appeared ? "succeeded" : "pending"));
    server.use(
      http.post(CANCEL_PATH, () => {
        postCount += 1;
        appeared = true;
        return HttpResponse.json({
          stream_ref: 101,
          status: null,
          reason: "NO_PUBLICATION",
          draft_discarded: false,
        });
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    await confirmCancel(user);

    await waitFor(() => expect(postCount).toBe(1));
    await waitFor(() =>
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).toBeNull(),
    );
    expect(postCount).toBe(1);
  });

  it("does not send a Cancel when the status response is malformed", async () => {
    let postCount = 0;
    serveBase();
    server.use(
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json({ stream_ref: 999, operation: null }),
      ),
      http.post(CANCEL_PATH, () => {
        postCount += 1;
        return HttpResponse.json({});
      }),
    );
    renderApp(EDITOR_PATH);

    expect(await screen.findByText(/does not match the requested stream/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel publication" })).toBeNull();
    expect(postCount).toBe(0);
  });
});

describe("S8-D3 unified queue release predicate", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  const unresolvedQueue = queueFor([
    publicationOperationFixture({
      operation_uuid: "op-102",
      stream_ref: 102,
      status: "pending",
    }),
  ]);

  const cases = [
    {
      name: "success",
      initialStatus: "pending",
      status: "abandoned",
      respond: () =>
        HttpResponse.json({
          stream_ref: 101,
          status: "abandoned",
          reason: null,
          draft_discarded: true,
        }),
    },
    {
      name: "no-op",
      initialStatus: "pending",
      status: "succeeded",
      respond: () =>
        HttpResponse.json({
          stream_ref: 101,
          status: null,
          reason: "NO_PUBLICATION",
          draft_discarded: false,
        }),
    },
    {
      name: "definitive refusal",
      initialStatus: "failed",
      status: "failed",
      respond: () =>
        errorResponse("PUBLICATION_ABSENCE_EVIDENCE_REQUIRED", 409, {
          status: "failed",
          reason: "ABSENCE_EVIDENCE_REQUIRED",
          result: {
            stream_ref: 101,
            status: "failed",
            reason: "ABSENCE_EVIDENCE_REQUIRED",
            draft_discarded: false,
          },
        }),
    },
    {
      name: "unknown outcome",
      initialStatus: "pending",
      status: "abandoned",
      respond: () => HttpResponse.error(),
    },
  ];

  it.each(cases)(
    "keeps the lock for $name when the complete queue is not empty",
    async ({ initialStatus, status, respond }) => {
      let postCount = 0;
      let posted = false;
      serveBase(() => stateFor(posted ? status : initialStatus), unresolvedQueue);
      server.use(
        http.get("*/api/campaigns/42/streams/102/publication", () =>
          HttpResponse.json(stateFor("succeeded", 102)),
        ),
        http.post(CANCEL_PATH, () => {
          postCount += 1;
          posted = true;
          return respond();
        }),
      );
      const user = userEvent.setup();
      renderApp(EDITOR_PATH);

      await confirmCancel(user);

      await waitFor(() => expect(postCount).toBe(1));
      expect(window.localStorage.getItem(RECOVERY_LOCK_KEY)).not.toBeNull();
      expect(
        screen.queryByText(/Authoritative status and queue reads passed/),
      ).toBeNull();
      expect(
        await screen.findByText(/1 unresolved operation\(s\) remain/),
      ).toBeInTheDocument();
    },
  );
});

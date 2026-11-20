import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commandResultFixture,
  committedFixture,
  conflictFixture,
  draftStateFixture,
  draftViewFixture,
  errorResponse,
  publicationOperationFixture,
  publicationStateFixture,
  REMOTE_OFFERS,
} from "../../test/fixtures";
import { RECOVERY_LOCK_KEY } from "../publication/usePublicationRecoveryLock";
import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";

const EDITOR_PATH = "/campaigns/42/streams/101";
const DRAFT_PATH = "*/api/campaigns/42/streams/101/draft";
const COMMITTED_PATH = "*/api/campaigns/42/streams/101/committed";
const originalMatchMedia = window.matchMedia;

function serveReads(
  committed = committedFixture(),
  draft = draftStateFixture(),
) {
  server.use(
    http.get(COMMITTED_PATH, () => HttpResponse.json(committed)),
    http.get(DRAFT_PATH, () => HttpResponse.json(draft)),
    http.get("*/api/campaigns/42/streams/101/publication", () =>
      HttpResponse.json(publicationStateFixture()),
    ),
  );
}

function draftRegion(): HTMLElement {
  return screen.getByRole("heading", { name: /Staged draft/ }).closest(
    "section",
  ) as HTMLElement;
}

describe("OfferEditorPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
    window.localStorage.clear();
  });

  it("loads committed and draft GETs on direct navigation and reload without Fetch", async () => {
    let committedCount = 0;
    let draftCount = 0;
    let postCount = 0;
    let fetchCount = 0;
    serveReads();
    server.use(
      http.get(COMMITTED_PATH, () => {
        committedCount += 1;
        return HttpResponse.json(committedFixture());
      }),
      http.get(DRAFT_PATH, () => {
        draftCount += 1;
        return HttpResponse.json(draftStateFixture());
      }),
      http.post("*/api/campaigns/42/streams/101/draft/:action", () => {
        postCount += 1;
        return HttpResponse.json(commandResultFixture(draftViewFixture()));
      }),
      http.post("*/api/campaigns/42/fetch", () => {
        fetchCount += 1;
        return HttpResponse.json({});
      }),
    );

    renderApp(EDITOR_PATH);
    expect(
      await screen.findByRole("button", { name: "Add offer" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Committed baseline/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Staged draft/ }),
    ).toBeInTheDocument();

    cleanup();
    renderApp(EDITOR_PATH);
    expect(
      await screen.findByRole("button", { name: "Add offer" }),
    ).toBeInTheDocument();

    expect(committedCount).toBe(2);
    expect(draftCount).toBe(2);
    expect(postCount).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it("renders committed baseline and staged draft as distinct server views", async () => {
    serveReads(
      committedFixture({
        snapshot: { offers: REMOTE_OFFERS, captured_at: "2026-11-18T04:00:00" },
      }),
      draftStateFixture(
        draftViewFixture({
          version: 4,
          is_dirty: true,
          policy_cases: ["unallocated_remainder"],
          unallocated: 7,
        }),
      ),
    );

    renderApp(EDITOR_PATH);

    await screen.findByRole("heading", { name: /Committed baseline/ });
    const committed = screen.getByRole("heading", {
      name: /Committed baseline/,
    }).closest("section") as HTMLElement;
    const draft = draftRegion();
    expect((await within(committed).findAllByText(/share 60/)).length).toBeGreaterThan(0);
    expect(within(committed).getByText(/last remote share 60/)).toBeInTheDocument();
    expect(within(committed).getByText(/read-only/)).toBeInTheDocument();
    expect(within(draft).getByText(/local, unpublished/)).toBeInTheDocument();
    expect(within(draft).getByText("4")).toBeInTheDocument();
    expect(within(draft).getByText("dirty")).toBeInTheDocument();
    expect(within(draft).getByText("unallocated_remainder")).toBeInTheDocument();
    expect(within(draft).getByText("7")).toBeInTheDocument();
  });

  it("adds an offer by manual ID with the current expected_version", async () => {
    let body: unknown = null;
    let getCount = 0;
    serveReads();
    server.use(
      http.get(COMMITTED_PATH, () => {
        getCount += 1;
        return HttpResponse.json(committedFixture());
      }),
      http.post(`${DRAFT_PATH}/add`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          commandResultFixture(
            draftViewFixture({
              version: 2,
              is_dirty: true,
              staged_changes: { additions: [9] },
              offers: [
                ...draftViewFixture().offers,
                {
                  offer_id: 9,
                  lifecycle: "ACTIVE",
                  is_pinned: false,
                  share: 0,
                  state: null,
                  position: 2,
                },
              ],
            }),
            { created: true },
          ),
        );
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByRole("button", { name: "Add offer" });

    await user.type(screen.getByLabelText("Add offer by ID"), "9");
    await user.click(screen.getByRole("button", { name: "Add offer" }));

    expect(await screen.findByText("Offer #9")).toBeInTheDocument();
    expect(screen.getByText("Addition: Offer #9")).toBeInTheDocument();
    expect(body).toEqual({ expected_version: 1, offer_id: 9 });
    expect(getCount).toBe(1);
  });

  it.each(["", "0", "-3", "1.5", "abc", "9007199254740992"])(
    "rejects manual offer ID %s without a request",
    async (value) => {
      let postCount = 0;
      serveReads();
      server.use(
        http.post(`${DRAFT_PATH}/add`, () => {
          postCount += 1;
          return HttpResponse.json(commandResultFixture(draftViewFixture()));
        }),
      );
      const user = userEvent.setup();
      renderApp(EDITOR_PATH);
      await screen.findByRole("button", { name: "Add offer" });

      if (value) {
        await user.type(screen.getByLabelText("Add offer by ID"), value);
      }
      await user.click(screen.getByRole("button", { name: "Add offer" }));

      expect(
        await screen.findByText("Enter a positive whole offer ID."),
      ).toBeInTheDocument();
      expect(postCount).toBe(0);
    },
  );

  const offerCommands = [
    {
      action: "remove",
      button: "Remove offer 8",
      draft: draftViewFixture(),
      body: { expected_version: 1, offer_id: 8 },
      expected: { action: "remove", body: { expected_version: 1, offer_id: 8 } },
    },
    {
      action: "restore",
      button: "Restore offer 8",
      draft: draftViewFixture({
        offers: draftViewFixture().offers.map((offer) =>
          offer.offer_id === 8 ? { ...offer, lifecycle: "ARCHIVED", share: 0 } : offer,
        ),
      }),
      body: { expected_version: 1, offer_id: 8 },
      expected: { action: "restore", body: { expected_version: 1, offer_id: 8 } },
    },
    {
      action: "unpin",
      button: "Unpin offer 7",
      draft: draftViewFixture(),
      body: { expected_version: 1, offer_id: 7 },
      expected: { action: "unpin", body: { expected_version: 1, offer_id: 7 } },
    },
    {
      action: "pin",
      button: "Pin offer 8",
      draft: draftViewFixture(),
      body: { expected_version: 1, offer_id: 8 },
      expected: { action: "pin", body: { expected_version: 1, offer_id: 8 } },
    },
  ] as const;

  it.each(offerCommands)(
    "sends $action to its own endpoint with expected_version",
    async ({ button, draft, body, expected }) => {
      let actualAction: string | null = null;
      let actualBody: unknown = null;
      serveReads(committedFixture(), draftStateFixture(draft));
      server.use(
        http.post(`${DRAFT_PATH}/:action`, async ({ params, request }) => {
          actualAction = String(params.action);
          actualBody = await request.json();
          return HttpResponse.json(commandResultFixture(draftViewFixture()));
        }),
      );
      const user = userEvent.setup();
      renderApp(EDITOR_PATH);
      await screen.findByRole("button", { name: "Add offer" });

      await user.click(screen.getByRole("button", { name: button }));

      await waitFor(() => expect(actualAction).toBe(expected.action));
      expect(actualBody).toEqual(expected.body);
      expect(body).toEqual(expected.body);
    },
  );

  it("validates share input and renders the backend auto-pin result", async () => {
    let body: unknown = null;
    serveReads();
    server.use(
      http.post(`${DRAFT_PATH}/share`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          commandResultFixture(
            draftViewFixture({
              version: 2,
              staged_changes: { share_edits: { 8: 35 } },
              offers: draftViewFixture().offers.map((offer) =>
                offer.offer_id === 8
                  ? { ...offer, is_pinned: true, share: 35 }
                  : offer,
              ),
            }),
          ),
        );
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByRole("button", { name: "Add offer" });
    const input = document.getElementById("share-8") as HTMLInputElement;

    for (const invalid of ["101", "1.5", "true"]) {
      await user.clear(input);
      await user.type(input, invalid);
      await user.click(
        within(draftRegion()).getAllByRole("button", { name: "Set share" })[1],
      );
      expect(
        await screen.findByText("Enter a whole number from 0 to 100."),
      ).toBeInTheDocument();
    }
    expect(body).toBeNull();

    await user.clear(input);
    await user.type(input, "35");
    await user.click(
      within(draftRegion()).getAllByRole("button", { name: "Set share" })[1],
    );

    await waitFor(() => expect(body).toEqual({ expected_version: 1, offer_id: 8, share: 35 }));
    const offer8 = screen
      .getByRole("heading", { name: "Offer #8" })
      .closest("li") as HTMLElement;
    expect(within(offer8).getByText("pinned")).toBeInTheDocument();
    expect(within(offer8).getByText("35")).toBeInTheDocument();
    expect(screen.getByText(/Requested share: Offer #8/)).toHaveTextContent("→ 35");
  });

  it("prevents duplicate mutation submissions", async () => {
    let postCount = 0;
    serveReads();
    server.use(
      http.post(`${DRAFT_PATH}/pin`, async () => {
        postCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return HttpResponse.json(commandResultFixture(draftViewFixture()));
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByRole("button", { name: "Add offer" });
    const pinButton = screen.getByRole("button", { name: "Pin offer 8" });

    await user.click(pinButton);
    expect(
      screen.getByText("Saving local draft… Duplicate submissions are disabled."),
    ).toBeInTheDocument();
    expect(pinButton).toBeDisabled();
    await user.click(pinButton);

    expect(postCount).toBe(1);
    await waitFor(() =>
      expect(
        screen.queryByText("Saving local draft… Duplicate submissions are disabled."),
      ).toBeNull(),
    );
  });

  it("shows DRAFT_VERSION_CONFLICT and offers only a GET re-read", async () => {
    let postCount = 0;
    let draftGetCount = 0;
    serveReads();
    server.use(
      http.get(DRAFT_PATH, () => {
        draftGetCount += 1;
        return HttpResponse.json(draftStateFixture());
      }),
      http.post(`${DRAFT_PATH}/pin`, () => {
        postCount += 1;
        return errorResponse("DRAFT_VERSION_CONFLICT", 409, {
          stream_ref: 101,
          expected_version: 1,
          current_version: 3,
        });
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByRole("button", { name: "Add offer" });

    await user.click(screen.getByRole("button", { name: "Pin offer 8" }));

    expect(
      await screen.findByText("Recovery required — draft commands locked"),
    ).toBeInTheDocument();
    expect(screen.getByText("API error code: DRAFT_VERSION_CONFLICT")).toBeInTheDocument();
    expect(screen.getByText(/Your last input was not applied automatically/)).toBeInTheDocument();
    expect(postCount).toBe(1);
    const beforeRetry = draftGetCount;

    await user.click(screen.getByRole("button", { name: "Read current draft" }));

    await waitFor(() => expect(draftGetCount).toBeGreaterThan(beforeRetry));
    expect(postCount).toBe(1);
  });

  it("accepts a fresh remote observation and refreshes the clean draft", async () => {
    const conflict = conflictFixture();
    const staleView = draftViewFixture({
      version: 3,
      is_stale: true,
      conflicts: [conflict],
      conflicts_fingerprint: "sha256:stale",
    });
    let acceptBody: unknown = null;
    const resolved = draftViewFixture({
      version: 4,
      conflicts: [],
      conflicts_fingerprint: "sha256:empty",
    });
    serveReads(committedFixture(), draftStateFixture(staleView));
    server.use(
      http.post(
        "*/api/campaigns/42/streams/101/draft/accept-remote",
        async ({ request }) => {
          acceptBody = await request.json();
          return HttpResponse.json({
            stream_ref: 101,
            draft: resolved,
            noop: false,
            version: 4,
          });
        },
      ),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByText("Sticky Fetch conflicts");

    await user.click(screen.getByRole("button", { name: "Accept remote" }));
    expect(
      screen.getByRole("group", { name: "Confirm accept remote" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Confirm accept remote" }),
    );

    await waitFor(() =>
      expect(acceptBody).toEqual({
        expected_version: 3,
        expected_conflicts_fingerprint: "sha256:stale",
      }),
    );
    expect(await within(draftRegion()).findByText("4")).toBeInTheDocument();
    expect(screen.queryByText("Sticky Fetch conflicts")).not.toBeInTheDocument();
  });

  it("does not offer conflict resolution while the frontend recovery lock is active", async () => {
    const staleView = draftViewFixture({
      version: 3,
      is_stale: true,
      conflicts: [conflictFixture()],
      conflicts_fingerprint: "sha256:stale",
    });
    window.localStorage.setItem(
      RECOVERY_LOCK_KEY,
      JSON.stringify({
        schema: 2,
        lockId: "lock-1",
        kind: "recovery",
        stage: "running",
        affected: [{ campaignId: 42, streamRef: 101 }],
        draftVerification: [],
        cancelTarget: null,
        reason: "unknown",
        unionComplete: true,
        createdAt: new Date().toISOString(),
        phase: "running",
      }),
    );
    serveReads(committedFixture(), draftStateFixture(staleView));
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByText("Sticky Fetch conflicts");

    await user.click(screen.getByRole("button", { name: "Accept remote" }));
    expect(
      screen.queryByRole("group", { name: "Confirm accept remote" }),
    ).not.toBeInTheDocument();
  });

  it("blocks edits on a stale draft and preserves sticky conflicts through Cancel", async () => {
    let cancelBody: unknown = null;
    const conflict = conflictFixture();
    const staleView = draftViewFixture({
      version: 3,
      is_stale: true,
      conflicts: [conflict],
    });
    serveReads(committedFixture(), draftStateFixture(staleView));
    server.use(
      http.post(`${DRAFT_PATH}/cancel`, async ({ request }) => {
        cancelBody = await request.json();
        return HttpResponse.json(
          commandResultFixture(
            draftViewFixture({
              version: 4,
              is_stale: true,
              conflicts: [conflict],
            }),
          ),
        );
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByText("Sticky Fetch conflicts");
    expect(screen.getByText(/remote share changed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove offer 8" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add offer" })).toBeDisabled();
    const cancelButton = screen.getByRole("button", { name: "Cancel local draft" });
    expect(cancelButton).toBeEnabled();

    await user.click(cancelButton);
    expect(
      screen.getByRole("group", { name: "Confirm local cancel" }),
    ).toBeInTheDocument();
    expect(cancelBody).toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirm local cancel" }));

    await waitFor(() => expect(cancelBody).toEqual({ expected_version: 3 }));
    expect(await screen.findByText("Sticky Fetch conflicts")).toBeInTheDocument();
    expect(screen.getByText(/remote share changed/)).toBeInTheDocument();
    expect(screen.getByText(/Cancel affects only this local draft/)).toBeInTheDocument();
  });

  it("treats a network timeout as an unknown mutation outcome without retrying", async () => {
    let postCount = 0;
    let draftGetCount = 0;
    serveReads();
    server.use(
      http.get(DRAFT_PATH, () => {
        draftGetCount += 1;
        return HttpResponse.json(draftStateFixture());
      }),
      http.post(`${DRAFT_PATH}/pin`, () => {
        postCount += 1;
        return HttpResponse.error();
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByRole("button", { name: "Add offer" });

    await user.click(screen.getByRole("button", { name: "Pin offer 8" }));

    expect(
      await screen.findByText(/The draft command outcome is unknown/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Only a GET re-read is offered/)).toBeInTheDocument();
    expect(postCount).toBe(1);
    const beforeRetry = draftGetCount;

    await user.click(screen.getByRole("button", { name: "Read current draft" }));

    await waitFor(() => expect(draftGetCount).toBeGreaterThan(beforeRetry));
    expect(postCount).toBe(1);
  });

  it("retries a failed committed GET without invoking a mutation", async () => {
    let getCount = 0;
    let postCount = 0;
    serveReads();
    server.use(
      http.get(COMMITTED_PATH, () => {
        getCount += 1;
        if (getCount === 1) {
          return errorResponse("KEITARO_UPSTREAM_FAILURE", 502, {
            upstream: { status: 503, message: "down" },
          });
        }
        return HttpResponse.json(committedFixture());
      }),
      http.post(`${DRAFT_PATH}/:action`, () => {
        postCount += 1;
        return HttpResponse.json(commandResultFixture(draftViewFixture()));
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    expect(await screen.findByText("Committed state unavailable")).toBeInTheDocument();
    expect(screen.getByText("API error code: KEITARO_UPSTREAM_FAILURE")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry committed read" }));

    expect(
      await screen.findByText(/last remote share 60/),
    ).toBeInTheDocument();
    expect(getCount).toBe(2);
    expect(postCount).toBe(0);
  });

  it("retries a failed draft GET without invoking a mutation", async () => {
    let getCount = 0;
    let postCount = 0;
    serveReads();
    server.use(
      http.get(DRAFT_PATH, () => {
        getCount += 1;
        if (getCount === 1) {
          return HttpResponse.error();
        }
        return HttpResponse.json(draftStateFixture());
      }),
      http.post(`${DRAFT_PATH}/:action`, () => {
        postCount += 1;
        return HttpResponse.json(commandResultFixture(draftViewFixture()));
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    expect(await screen.findByText("Draft state unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The API could not be reached. Check the local backend and try again.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry draft read" }));

    expect(await screen.findByText("clean")).toBeInTheDocument();
    expect(getCount).toBe(2);
    expect(postCount).toBe(0);
  });

  it("shows stream-not-found without sending draft commands", async () => {
    let postCount = 0;
    serveReads();
    server.use(
      http.get(COMMITTED_PATH, () =>
        errorResponse("STREAM_NOT_FOUND", 404, {
          campaign_id: 42,
          stream_ref: 101,
        }),
      ),
      http.post(`${DRAFT_PATH}/:action`, () => {
        postCount += 1;
        return HttpResponse.json(commandResultFixture(draftViewFixture()));
      }),
    );

    renderApp(EDITOR_PATH);

    expect(
      await screen.findByRole("heading", { name: "Stream not found" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No draft command was sent/)).toBeInTheDocument();
    expect(postCount).toBe(0);
  });

  it("projects all backend-owned staged intent in the review", async () => {
    serveReads(
      committedFixture(),
      draftStateFixture(
        draftViewFixture({
          is_dirty: true,
          staged_changes: {
            additions: [9],
            archives: [8],
            restores: [6],
            pin_toggles: { 7: false },
            share_edits: { 7: 55 },
          },
        }),
      ),
    );

    renderApp(EDITOR_PATH);

    expect(await screen.findByText("Addition: Offer #9")).toBeInTheDocument();
    expect(screen.getByText("Archive: Offer #8")).toBeInTheDocument();
    expect(screen.getByText("Restore: Offer #6")).toBeInTheDocument();
    expect(screen.getByText("Unpin: Offer #7")).toBeInTheDocument();
    expect(screen.getByText(/Requested share: Offer #7/)).toHaveTextContent("→ 55");
  });

  it.each(["0", "-1", "1.5", "abc", "9007199254740992"])(
    "rejects invalid URL IDs %s without API requests",
    (streamRef) => {
      serveReads();

      renderApp(`/campaigns/42/streams/${streamRef}`);

      expect(
        screen.getByRole("heading", { name: "Invalid stream URL" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/No API request was made/)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Add offer" }),
      ).toBeNull();
    },
  );

  const recoveryCases = [
    {
      name: "DRAFT_VERSION_CONFLICT",
      failure: () =>
        errorResponse("DRAFT_VERSION_CONFLICT", 409, {
          stream_ref: 101,
          expected_version: 1,
          current_version: 2,
        }),
      finalDraft: draftStateFixture(draftViewFixture({ version: 2 })),
      finalStale: false,
    },
    {
      name: "DRAFT_STALE_CONFLICT",
      failure: () =>
        errorResponse("DRAFT_STALE_CONFLICT", 409, {
          stream_ref: 101,
          conflicts: [conflictFixture()],
        }),
      finalDraft: draftStateFixture(
        draftViewFixture({
          version: 2,
          is_stale: true,
          conflicts: [conflictFixture()],
        }),
      ),
      finalStale: true,
    },
    {
      name: "network timeout",
      failure: () => HttpResponse.error(),
      finalDraft: draftStateFixture(draftViewFixture({ version: 2 })),
      finalStale: false,
    },
  ] as const;

  it.each(recoveryCases)(
    "$name keeps the recovery lock until a successful GET re-read",
    async ({ failure, finalDraft, finalStale }) => {
      let postCount = 0;
      let draftGetCount = 0;
      let rereadShouldFail = true;
      serveReads();
      server.use(
        http.get(DRAFT_PATH, () => {
          draftGetCount += 1;
          if (rereadShouldFail && draftGetCount > 1) {
            return errorResponse("INTERNAL_ERROR", 500, {});
          }
          return HttpResponse.json(
            draftGetCount === 1 ? draftStateFixture() : finalDraft,
          );
        }),
        http.post(`${DRAFT_PATH}/pin`, () => {
          postCount += 1;
          return failure();
        }),
      );
      const user = userEvent.setup();
      renderApp(EDITOR_PATH);
      await screen.findByRole("button", { name: "Add offer" });

      await user.click(screen.getByRole("button", { name: "Pin offer 8" }));

      const root = screen.getByRole("region", { name: "Offer Editor" });
      expect(
        await screen.findByText("Recovery required — draft commands locked"),
      ).toBeInTheDocument();
      expect(root).toHaveAttribute("data-recovery-lock", "active");
      expect(screen.getByRole("button", { name: "Add offer" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Cancel local draft" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Remove offer 8" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Read current draft" }),
      ).toBeEnabled();

      await user.click(screen.getByRole("button", { name: "Read current draft" }));

      expect(
        await screen.findByText("Draft state unavailable"),
      ).toBeInTheDocument();
      expect(screen.getByText("API error code: INTERNAL_ERROR")).toBeInTheDocument();
      expect(screen.getByText("Recovery required — draft commands locked")).toBeInTheDocument();
      expect(root).toHaveAttribute("data-recovery-lock", "active");
      expect(postCount).toBe(1);

      rereadShouldFail = false;
      await user.click(screen.getByRole("button", { name: "Read current draft" }));

      await waitFor(() =>
        expect(root).toHaveAttribute("data-recovery-lock", "inactive"),
      );
      expect(
        screen.queryByText("Recovery required — draft commands locked"),
      ).toBeNull();
      expect(postCount).toBe(1);
      if (finalStale) {
        expect(await screen.findByText("Sticky Fetch conflicts")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add offer" })).toBeDisabled();
        expect(
          screen.getByRole("button", { name: "Cancel local draft" }),
        ).toBeEnabled();
      } else {
        expect(screen.getByRole("button", { name: "Add offer" })).toBeEnabled();
        expect(
          screen.getByRole("button", { name: "Cancel local draft" }),
        ).toBeEnabled();
      }
    },
  );

  const fiveHundredCases: {
    action: string;
    draft: ReturnType<typeof draftViewFixture>;
    trigger: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  }[] = [
    {
      action: "add",
      draft: draftViewFixture(),
      trigger: async (user) => {
        await user.type(screen.getByLabelText("Add offer by ID"), "9");
        await user.click(screen.getByRole("button", { name: "Add offer" }));
      },
    },
    {
      action: "remove",
      draft: draftViewFixture(),
      trigger: async (user) => {
        await user.click(screen.getByRole("button", { name: "Remove offer 8" }));
      },
    },
    {
      action: "restore",
      draft: draftViewFixture({
        offers: draftViewFixture().offers.map((offer) =>
          offer.offer_id === 8
            ? { ...offer, lifecycle: "ARCHIVED", share: 0 }
            : offer,
        ),
      }),
      trigger: async (user) => {
        await user.click(screen.getByRole("button", { name: "Restore offer 8" }));
      },
    },
    {
      action: "pin",
      draft: draftViewFixture(),
      trigger: async (user) => {
        await user.click(screen.getByRole("button", { name: "Pin offer 8" }));
      },
    },
    {
      action: "unpin",
      draft: draftViewFixture(),
      trigger: async (user) => {
        await user.click(screen.getByRole("button", { name: "Unpin offer 7" }));
      },
    },
    {
      action: "share",
      draft: draftViewFixture(),
      trigger: async (user) => {
        const input = document.getElementById("share-8") as HTMLInputElement;
        await user.type(input, "35");
        await user.click(
          within(draftRegion()).getAllByRole("button", { name: "Set share" })[1],
        );
      },
    },
    {
      action: "cancel",
      draft: draftViewFixture(),
      trigger: async (user) => {
        await user.click(
          screen.getByRole("button", { name: "Cancel local draft" }),
        );
        await user.click(
          screen.getByRole("button", { name: "Confirm local cancel" }),
        );
      },
    },
  ];

  it.each(fiveHundredCases)(
    "$action: HTTP 500 locks recovery for every draft command",
    async ({ action, draft, trigger }) => {
      let postCount = 0;
      let postedAction: string | null = null;
      let draftGetCount = 0;
      let rereadShouldFail = true;
      serveReads(committedFixture(), draftStateFixture(draft));
      server.use(
        http.get(DRAFT_PATH, () => {
          draftGetCount += 1;
          if (draftGetCount > 1 && rereadShouldFail) {
            return errorResponse("INTERNAL_ERROR", 500, {});
          }
          return HttpResponse.json(draftStateFixture(draft));
        }),
        http.post(`${DRAFT_PATH}/:action`, ({ params }) => {
          postCount += 1;
          postedAction = String(params.action);
          return errorResponse("INTERNAL_ERROR", 500, {});
        }),
      );
      const user = userEvent.setup();
      renderApp(EDITOR_PATH);
      await screen.findByRole("button", { name: "Add offer" });

      await trigger(user);

      const root = screen.getByRole("region", { name: "Offer Editor" });
      expect(
        await screen.findByText("Recovery required — draft commands locked"),
      ).toBeInTheDocument();
      expect(root).toHaveAttribute("data-recovery-lock", "active");
      expect(postedAction).toBe(action);
      expect(postCount).toBe(1);
      expect(
        screen.getByText(/The server returned 5xx after the draft command/),
      ).toBeInTheDocument();

      const enabledButtons = screen
        .getAllByRole("button")
        .filter((button) => !(button as HTMLButtonElement).disabled)
        .map((button) => button.textContent);
      expect(enabledButtons).toEqual(["Read current draft"]);
      const shareInputs = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[id^="share-"]'),
      );
      expect(shareInputs.length).toBeGreaterThan(0);
      expect(shareInputs.every((input) => input.disabled)).toBe(true);

      await user.click(screen.getByRole("button", { name: "Read current draft" }));

      expect(
        await screen.findByText("Draft state unavailable"),
      ).toBeInTheDocument();
      expect(root).toHaveAttribute("data-recovery-lock", "active");
      expect(postCount).toBe(1);

      rereadShouldFail = false;
      await user.click(screen.getByRole("button", { name: "Read current draft" }));

      await waitFor(() =>
        expect(root).toHaveAttribute("data-recovery-lock", "inactive"),
      );
      expect(screen.getByRole("button", { name: "Add offer" })).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Cancel local draft" }),
      ).toBeEnabled();
      expect(postCount).toBe(1);
    },
  );

  it.each([null, []])(
    "requires an explicit Fetch when the snapshot is missing or empty (%s)",
    async (offers) => {
      let postCount = 0;
      let fetchCount = 0;
      serveReads(
        committedFixture({
          snapshot: offers === null ? null : { offers, captured_at: "2026-11-18T04:00:00" },
        }),
        draftStateFixture(null),
      );
      server.use(
        http.post(`${DRAFT_PATH}/:action`, () => {
          postCount += 1;
          return HttpResponse.json(commandResultFixture(draftViewFixture()));
        }),
        http.post("*/api/campaigns/42/fetch", () => {
          fetchCount += 1;
          return HttpResponse.json({});
        }),
      );
      const user = userEvent.setup();
      renderApp(EDITOR_PATH);

      expect(
        await screen.findByRole("heading", { name: "Fetch required" }),
      ).toBeInTheDocument();
      const addButton = screen.getByRole("button", { name: "Add offer" });
      expect(addButton).toBeDisabled();
      expect(
        screen.getByRole("link", {
          name: "Go to Campaign Workspace for Fetch",
        }),
      ).toHaveAttribute("href", "/campaigns/42");

      await user.click(addButton);

      expect(postCount).toBe(0);
      expect(fetchCount).toBe(0);
      expect(
        screen.getByRole("link", {
          name: "Go to Campaign Workspace for Fetch",
        }),
      ).toBeInTheDocument();
    },
  );

  it("keeps local Cancel available but disables staging without a baseline", async () => {
    serveReads(
      committedFixture({ snapshot: null }),
      draftStateFixture(draftViewFixture()),
    );

    renderApp(EDITOR_PATH);

    expect(
      await screen.findByRole("heading", { name: "Fetch required" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add offer" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove offer 8" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Cancel local draft" }),
    ).toBeEnabled();
  });

  it("supports keyboard navigation to the manual offer ID field", async () => {
    serveReads();
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);
    await screen.findByRole("button", { name: "Add offer" });

    let focused = document.activeElement;
    for (let index = 0; index < 12 && focused?.id !== "add-offer-id"; index += 1) {
      await user.tab();
      focused = document.activeElement;
    }

    expect(focused).toHaveAttribute("id", "add-offer-id");
  });

  it("uses the narrow layout class on small viewports", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    serveReads();

    renderApp(EDITOR_PATH);

    expect(
      (await screen.findByRole("region", { name: "Offer Editor" })).className,
    ).toContain("narrow");
  });

  it("shows the latest publication status from its own GET and sends no publication POSTs", async () => {
    let publicationGets = 0;
    let postCount = 0;
    serveReads();
    server.use(
      http.get("*/api/campaigns/42/streams/101/publication", () => {
        publicationGets += 1;
        return HttpResponse.json(
          publicationStateFixture(
            publicationOperationFixture({
              status: "ambiguous",
              draft_version: 4,
              attempt_count: 2,
            }),
          ),
        );
      }),
      http.post("*/api/campaigns/42/push", () => {
        postCount += 1;
        return HttpResponse.json({});
      }),
      http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
        postCount += 1;
        return HttpResponse.json({});
      }),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json({});
      }),
    );

    renderApp(EDITOR_PATH);

    expect(
      await screen.findByRole("heading", { name: "Latest publication status" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Ambiguous")).toBeInTheDocument();
    expect(screen.getByText("operation-1")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Offer #7 · share 60 · state active")).toBeInTheDocument();
    expect(screen.getByText(/point-in-time view, not publication history/)).toBeInTheDocument();
    expect(publicationGets).toBe(1);
    expect(postCount).toBe(0);
  });

  it("renders no publication recorded without inventing a status", async () => {
    serveReads();
    server.use(
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(publicationStateFixture(null)),
      ),
    );

    renderApp(EDITOR_PATH);

    expect(
      await screen.findByText("No publication recorded for this stream."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Succeeded")).toBeNull();
  });

  it("retries a publication status API error with GET only", async () => {
    let publicationGets = 0;
    let postCount = 0;
    serveReads();
    server.use(
      http.get("*/api/campaigns/42/streams/101/publication", () => {
        publicationGets += 1;
        if (publicationGets === 1) {
          return errorResponse("PUBLICATION_UNRESOLVED", 409, {});
        }
        return HttpResponse.json(publicationStateFixture());
      }),
      http.post("*/api/campaigns/42/push", () => {
        postCount += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    expect(
      await screen.findByText("Latest publication status unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("API error code: PUBLICATION_UNRESOLVED")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Retry publication status read" }),
    );

    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(publicationGets).toBe(2);
    expect(postCount).toBe(0);
  });

  it.each([
    {
      name: "top-level stream_ref",
      response: { stream_ref: 999, operation: publicationOperationFixture() },
    },
    {
      name: "operation stream_ref",
      response: publicationStateFixture(
        publicationOperationFixture({ stream_ref: 999 }),
      ),
    },
  ])("rejects a publication response with mismatched $name", async ({ response }) => {
    serveReads();
    server.use(
      http.get("*/api/campaigns/42/streams/101/publication", () =>
        HttpResponse.json(response),
      ),
    );

    renderApp(EDITOR_PATH);

    expect(
      await screen.findByText("Latest publication status unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The publication status response does not match the requested stream.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry publication status read" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("operation-1")).toBeNull();
  });

  it("retries a publication status network failure with GET only", async () => {
    let publicationGets = 0;
    serveReads();
    server.use(
      http.get("*/api/campaigns/42/streams/101/publication", () => {
        publicationGets += 1;
        if (publicationGets === 1) {
          return HttpResponse.error();
        }
        return HttpResponse.json(publicationStateFixture());
      }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    expect(
      await screen.findByText(
        "The API could not be reached. Check the local backend and try again.",
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Retry publication status read" }),
    );

    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(publicationGets).toBe(2);
  });
});

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commandResultFixture,
  committedFixture,
  draftStateFixture,
  draftViewFixture,
  errorResponse,
  publicationOperationFixture,
  publicationStateFixture,
} from "../../test/fixtures";
import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";

const EDITOR_PATH = "/campaigns/42/streams/101";
const PUBLICATION_PATH = "*/api/campaigns/42/streams/101/publication";
const QUEUE_PATH = "*/api/publications/recoverable*";

type MockResponse = ReturnType<typeof HttpResponse.json>;

type Counters = {
  push: () => number;
  lastPushBody: () => unknown;
  recovery: () => number;
  cancel: () => number;
  draftAdd: () => number;
};

function serveEditor(
  state: () => MockResponse = () =>
    HttpResponse.json(publicationStateFixture()),
  draft = draftStateFixture(draftViewFixture()),
  cancelResponse: () => MockResponse = () => HttpResponse.json({}),
  pushResponse?: () => MockResponse,
): Counters {
  let push = 0;
  let lastPushBody: unknown = null;
  let recovery = 0;
  let cancel = 0;
  let draftAdd = 0;
  server.use(
    http.get("*/api/campaigns/42/streams/101/committed", () =>
      HttpResponse.json(committedFixture()),
    ),
    http.get("*/api/campaigns/42/streams/101/draft", () =>
      HttpResponse.json(draft),
    ),
    http.get(PUBLICATION_PATH, () => state()),
    http.get(QUEUE_PATH, () => HttpResponse.json([])),
    http.post("*/api/campaigns/42/push", async ({ request }) => {
      push += 1;
      lastPushBody = await request.json();
      if (pushResponse) {
        return pushResponse();
      }
      return HttpResponse.json({
        outcomes: [
          {
            stream_ref: 101,
            operation_uuid: "op-push-1",
            status: "succeeded",
            reason: null,
          },
        ],
      });
    }),
    http.post("*/api/publications/recover", () => {
      recovery += 1;
      return HttpResponse.json({});
    }),
    http.post("*/api/campaigns/42/streams/101/publication/cancel", () => {
      cancel += 1;
      return cancelResponse();
    }),
    http.post("*/api/campaigns/42/streams/101/draft/add", () => {
      draftAdd += 1;
      return HttpResponse.json(commandResultFixture(draftViewFixture()));
    }),
  );
  return {
    push: () => push,
    lastPushBody: () => lastPushBody,
    recovery: () => recovery,
    cancel: () => cancel,
    draftAdd: () => draftAdd,
  };
}

function pushPanel() {
  return screen.getByRole("region", {
    name: /Push status|Ready to push to Keitaro|Publishing to Keitaro/,
  });
}

describe("Push to Keitaro presentation and action", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("disables Push when draft has no staged changes and explains readiness", async () => {
    const counters = serveEditor(
      () => HttpResponse.json(publicationStateFixture()),
      draftStateFixture(draftViewFixture({ is_dirty: false })),
    );
    renderApp(EDITOR_PATH);

    const panel = pushPanel();
    await within(panel).findByText("Push status");
    expect(panel).toHaveAttribute("data-push-state", "blocked");
    expect(
      within(panel).getByRole("link", { name: "inspect the recoverable queue" }),
    ).toHaveAttribute("href", "/recovery");
    expect(
      screen.getByRole("button", { name: "Push to Keitaro" }),
    ).toBeDisabled();
    expect(counters.push()).toBe(0);
    expect(counters.recovery()).toBe(0);
    expect(counters.cancel()).toBe(0);
  });

  it("enables Push when dirty draft sums to 100% and dispatches POST /push", async () => {
    const dirtyDraft = draftViewFixture({
      version: 2,
      is_dirty: true,
      unallocated: 0,
      staged_changes: { share_edits: { 8: 40 } },
    });
    const counters = serveEditor(
      () => HttpResponse.json(publicationStateFixture()),
      draftStateFixture(dirtyDraft),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    const pushButton = await screen.findByRole("button", {
      name: "Push to Keitaro",
    });
    await waitFor(() => expect(pushButton).toBeEnabled());
    const panel = pushPanel();
    expect(panel).toHaveAttribute("data-push-state", "enabled");

    await user.click(pushButton);

    await waitFor(() => expect(counters.push()).toBe(1));
    expect(counters.lastPushBody()).toEqual({ stream_refs: [101] });
    expect(
      await screen.findByText(/Pushed stream #101 to Keitaro/),
    ).toBeInTheDocument();
  });

  it("surfaces a readable failure when Push fails or returns ambiguous", async () => {
    const dirtyDraft = draftViewFixture({
      version: 2,
      is_dirty: true,
      unallocated: 0,
      staged_changes: { share_edits: { 8: 40 } },
    });
    serveEditor(
      () => HttpResponse.json(publicationStateFixture()),
      draftStateFixture(dirtyDraft),
      undefined,
      () =>
        HttpResponse.json({
          outcomes: [
            {
              stream_ref: 101,
              operation_uuid: "op-ambig-1",
              status: "ambiguous",
              reason: "Keitaro read-back timed out after PUT",
            },
          ],
        }),
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    const pushButton = await screen.findByRole("button", {
      name: "Push to Keitaro",
    });
    await waitFor(() => expect(pushButton).toBeEnabled());
    await user.click(pushButton);

    expect(
      await screen.findByText("Push to Keitaro did not complete"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Keitaro read-back timed out after PUT"),
    ).toBeInTheDocument();
  });

  it("keeps the recovery link keyboard accessible without invoking Push", async () => {
    const counters = serveEditor();
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    const link = await screen.findByRole("link", {
      name: "inspect the recoverable queue",
    });
    link.focus();
    expect(link).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(
      await screen.findByRole("heading", {
        name: "Recoverable publications",
      }),
    ).toBeInTheDocument();
    expect(counters.push()).toBe(0);
  });

  it("does not suppress status refresh or local draft actions", async () => {
    let publicationGets = 0;
    const counters = serveEditor(() => {
      publicationGets += 1;
      return publicationGets === 1
        ? errorResponse("PUBLICATION_UNRESOLVED", 409, {})
        : HttpResponse.json(
            publicationStateFixture(
              publicationOperationFixture({ status: "pending" }),
            ),
          );
    });
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    await user.click(
      await screen.findByRole("button", { name: "Retry publication status read" }),
    );
    expect(await screen.findByText("Pending")).toBeInTheDocument();

    await user.type(await screen.findByLabelText("Add offer by ID"), "9");
    await user.click(screen.getByRole("button", { name: "Add offer" }));

    await waitFor(() => expect(publicationGets).toBe(2));
    await waitFor(() => expect(counters.draftAdd()).toBe(1));
    expect(counters.push()).toBe(0);
    expect(counters.recovery()).toBe(0);
    expect(counters.cancel()).toBe(0);
  });

  it("keeps publication Cancel available without any Push request", async () => {
    let cancelled = false;
    const counters = serveEditor(
      () =>
        HttpResponse.json(
          publicationStateFixture(
            publicationOperationFixture({
              status: cancelled ? "abandoned" : "pending",
            }),
          ),
        ),
      undefined,
      () => {
        cancelled = true;
        return HttpResponse.json({
          stream_ref: 101,
          status: "abandoned",
          reason: null,
          draft_discarded: true,
        });
      },
    );
    const user = userEvent.setup();
    renderApp(EDITOR_PATH);

    await user.click(
      await screen.findByRole("button", { name: "Cancel publication" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm publication cancel" }),
    );

    await waitFor(() => expect(counters.cancel()).toBe(1));
    expect(counters.push()).toBe(0);
    expect(counters.recovery()).toBe(0);
  });
});

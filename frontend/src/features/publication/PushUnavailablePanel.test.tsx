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
  recovery: () => number;
  cancel: () => number;
  draftAdd: () => number;
};

function serveEditor(
  state: () => MockResponse = () =>
    HttpResponse.json(publicationStateFixture()),
  draft = draftStateFixture(draftViewFixture()),
  cancelResponse: () => MockResponse = () => HttpResponse.json({}),
): Counters {
  let push = 0;
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
    http.post("*/api/campaigns/42/push", () => {
      push += 1;
      return HttpResponse.json({});
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
    recovery: () => recovery,
    cancel: () => cancel,
    draftAdd: () => draftAdd,
  };
}

function pushPanel() {
  return screen.getByRole("region", { name: "Push unavailable" });
}

describe("S8-D4 Push unavailable presentation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("shows a static explanation with no Push control or requests", async () => {
    const counters = serveEditor();
    renderApp(EDITOR_PATH);

    const panel = pushPanel();
    await within(panel).findByText("Push unavailable");
    expect(panel).toHaveAttribute("data-push-state", "disabled");
    expect(
      within(panel).getByText(
        "This interface does not provide a Push action. Publication writes are disabled. Refreshing, retrying, or navigating will not enable publication.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: "inspect the recoverable queue" }),
    ).toHaveAttribute("href", "/recovery");
    expect(within(panel).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("button", { name: /Push/ })).toBeNull();
    expect(counters.push()).toBe(0);
    expect(counters.recovery()).toBe(0);
    expect(counters.cancel()).toBe(0);
    expect(counters.draftAdd()).toBe(0);
  });

  it("keeps the read-only link keyboard accessible without invoking Push", async () => {
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

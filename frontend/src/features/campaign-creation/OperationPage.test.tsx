import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import {
  errorResponse,
  INTENT,
  operationFixture,
  OPERATION_UUID,
  OTHER_OPERATION_UUID,
} from "../../test/fixtures";
import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";
import { OPERATION_KEY, storeAttempt } from "./operationStorage";

describe("OperationPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    storeAttempt(OPERATION_UUID, INTENT);
  });

  it("keeps the UUID and retries POST with the same UUID on OPERATION_NOT_FOUND", async () => {
    let postCount = 0;
    let postedUuid: string | null = null;
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        errorResponse("OPERATION_NOT_FOUND", 404, {
          operation_uuid: OPERATION_UUID,
        }),
      ),
      http.post("*/api/campaign-creations", async ({ request }) => {
        postCount += 1;
        postedUuid = ((await request.json()) as { operation_uuid: string })
          .operation_uuid;
        return HttpResponse.json(operationFixture("started"), {
          status: 201,
          headers: { Location: `/campaign-creations/${OPERATION_UUID}` },
        });
      }),
    );

    const user = userEvent.setup();
    renderApp(`/campaign-creations/${OPERATION_UUID}`);

    expect(
      await screen.findByText("No durable operation exists for this UUID yet."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry POST with same UUID" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm same-UUID retry" }),
    );

    await waitFor(() => expect(postCount).toBe(1));
    expect(postedUuid).toBe(OPERATION_UUID);
    expect(window.sessionStorage.getItem(OPERATION_KEY)).toBe(OPERATION_UUID);
  });

  it("does not reuse a mismatched sessionStorage intent for a URL operation", async () => {
    let postCount = 0;
    storeAttempt(OTHER_OPERATION_UUID, INTENT);
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        errorResponse("OPERATION_NOT_FOUND", 404, {
          operation_uuid: OPERATION_UUID,
        }),
      ),
      http.post("*/api/campaign-creations", () => {
        postCount += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );

    renderApp(`/campaign-creations/${OPERATION_UUID}`);

    expect(
      await screen.findByText(
        "The stored operation UUID differs from the URL. The URL is being used.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("No durable operation exists for this UUID yet."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry POST with same UUID" }),
    ).toBeNull();
    expect(postCount).toBe(0);
  });

  it("does not reuse the previous route intent after a client-side route transition", async () => {
    let postCount = 0;
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        HttpResponse.json(operationFixture("started")),
      ),
      http.get(`*/api/campaign-creations/${OTHER_OPERATION_UUID}`, () =>
        errorResponse("OPERATION_NOT_FOUND", 404, {
          operation_uuid: OTHER_OPERATION_UUID,
        }),
      ),
      http.post("*/api/campaign-creations", () => {
        postCount += 1;
        return HttpResponse.json(operationFixture("started", OPERATION_UUID), {
          status: 201,
          headers: { Location: `/campaign-creations/${OPERATION_UUID}` },
        });
      }),
    );

    renderApp(`/campaign-creations/${OPERATION_UUID}`, {
      autoCreate: true,
      operation_uuid: OPERATION_UUID,
      intent: INTENT,
    });
    expect(
      await screen.findByText("A new durable operation was created."),
    ).toBeInTheDocument();

    act(() => {
      window.history.pushState(
        { usr: {} },
        "",
        `/campaign-creations/${OTHER_OPERATION_UUID}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(
      await screen.findByText("No durable operation exists for this UUID yet."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry POST with same UUID" }),
    ).toBeNull();
    expect(postCount).toBe(1);
  });

  it("links a confirmed campaign ID to its workspace", async () => {
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        HttpResponse.json(operationFixture("created")),
      ),
    );

    renderApp(`/campaign-creations/${OPERATION_UUID}`);

    const link = await screen.findByRole("link", {
      name: "Open Campaign Workspace",
    });
    expect(link).toHaveAttribute("href", "/campaigns/42");
  });

  it("does not fabricate a workspace link without a confirmed campaign ID", async () => {
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        HttpResponse.json(operationFixture("partial")),
      ),
    );

    renderApp(`/campaign-creations/${OPERATION_UUID}`);

    expect(
      await screen.findByText("Operation status: partial"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open Campaign Workspace" }),
    ).toBeNull();
  });

  it("renders a 200 same-UUID replay distinctly from a new operation", async () => {
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        HttpResponse.json(operationFixture("started")),
      ),
      http.post("*/api/campaign-creations", () =>
        HttpResponse.json(operationFixture("started"), { status: 200 }),
      ),
    );

    renderApp(`/campaign-creations/${OPERATION_UUID}`, {
      autoCreate: true,
      operation_uuid: OPERATION_UUID,
      intent: INTENT,
    });

    expect(
      await screen.findByText(
        "An existing durable operation was replayed for this UUID.",
      ),
    ).toBeInTheDocument();
  });

  it("shows ambiguous status without claiming success or auto-retrying", async () => {
    let postCount = 0;
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        HttpResponse.json(operationFixture("ambiguous")),
      ),
      http.post("*/api/campaign-creations", () => {
        postCount += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );

    renderApp(`/campaign-creations/${OPERATION_UUID}`);

    expect(
      await screen.findByText("Operation status: ambiguous"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resume operation" }),
    ).toBeInTheDocument();
    expect(postCount).toBe(0);
  });

  it("requires explicit confirmation before a terminal operation is replaced", async () => {
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        HttpResponse.json(operationFixture("created")),
      ),
    );

    const user = userEvent.setup();
    renderApp(`/campaign-creations/${OPERATION_UUID}`);

    expect(await screen.findByText("Operation status: created")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start new attempt" }));
    await user.click(screen.getByRole("button", { name: "Confirm new attempt" }));

    await waitFor(() =>
      expect(window.location.pathname).toBe("/campaigns/new"),
    );
    expect(window.sessionStorage.getItem(OPERATION_KEY)).toBeNull();
  });
});

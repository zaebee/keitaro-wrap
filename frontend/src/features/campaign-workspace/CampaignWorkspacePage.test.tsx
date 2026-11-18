import { cleanup, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorResponse,
  fetchOutcomeFixture,
  streamFixture,
} from "../../test/fixtures";
import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";

const originalMatchMedia = window.matchMedia;

function serveStreams(streams: unknown[]) {
  server.use(http.get("*/api/campaigns/42/streams", () => HttpResponse.json(streams)));
}

describe("CampaignWorkspacePage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
  });

  it("issues only the cached GET on entry and renders every stream field", async () => {
    let postCount = 0;
    serveStreams([
      streamFixture({
        stream_ref: 101,
        name: "Main stream",
        type: "regular",
        schema: "landings",
        comments: "  Primary stream  ",
      }),
      streamFixture({
        stream_ref: 202,
        name: "Second stream",
        type: "retargeting",
        schema: "offers",
        comments: null,
      }),
    ]);
    server.use(
      http.post("*/api/campaigns/42/fetch", () => {
        postCount += 1;
        return HttpResponse.json(fetchOutcomeFixture());
      }),
    );

    renderApp("/campaigns/42");

    expect(
      await screen.findByRole("heading", { name: "Cached stream references" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Main stream")).toBeInTheDocument();
    expect(screen.getByText("101")).toBeInTheDocument();
    expect(screen.getByText("regular")).toBeInTheDocument();
    expect(screen.getByText("landings")).toBeInTheDocument();
    expect(screen.getByText("Primary stream")).toBeInTheDocument();
    expect(screen.getByText("Second stream")).toBeInTheDocument();
    expect(screen.getByText("retargeting")).toBeInTheDocument();
    expect(screen.getByText("offers")).toBeInTheDocument();
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(screen.queryByText("Fetch summary")).toBeNull();
    expect(postCount).toBe(0);
  });

  it("shows the empty cached state before Fetch without claiming remote emptiness", async () => {
    serveStreams([]);
    renderApp("/campaigns/42");

    expect(
      await screen.findByText(/No cached stream references are available yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Fetch completed and returned zero streams.")).toBeNull();
  });

  it("distinguishes a successful zero-stream Fetch from an empty cached GET", async () => {
    serveStreams([]);
    server.use(
      http.post("*/api/campaigns/42/fetch", () =>
        HttpResponse.json(fetchOutcomeFixture({ stream_count: 0 })),
      ),
    );
    const user = userEvent.setup();
    renderApp("/campaigns/42");

    await user.click(await screen.findByRole("button", { name: "Fetch streams" }));

    expect(
      await screen.findByText("Fetch completed and returned zero streams."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Streams returned").nextElementSibling,
    ).toHaveTextContent("0");
  });

  it("prevents duplicate Fetch submissions and refetches the cached list after success", async () => {
    let getCount = 0;
    let postCount = 0;
    let streams: unknown[] = [streamFixture({ name: "Before Fetch" })];
    server.use(
      http.get("*/api/campaigns/42/streams", () => {
        getCount += 1;
        return HttpResponse.json(streams);
      }),
      http.post("*/api/campaigns/42/fetch", async () => {
        postCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        streams = [streamFixture({ name: "After Fetch" })];
        return HttpResponse.json(fetchOutcomeFixture());
      }),
    );
    const user = userEvent.setup();
    renderApp("/campaigns/42");

    await screen.findByText("Before Fetch");
    expect(getCount).toBe(1);
    const fetchButton = screen.getByRole("button", { name: "Fetch streams" });
    await user.click(fetchButton);

    expect(fetchButton).toBeDisabled();
    expect(
      screen.getByText("Fetch is running. Duplicate submissions are disabled."),
    ).toBeInTheDocument();
    await user.click(fetchButton);
    expect(postCount).toBe(1);

    expect(await screen.findByRole("heading", { name: "Fetch summary" })).toBeInTheDocument();
    expect(screen.getByText("Streams reconciled")).toBeInTheDocument();
    expect(screen.getByText("Bindings created")).toBeInTheDocument();
    expect(screen.getByText("Conflicted drafts")).toBeInTheDocument();
    await waitFor(() => expect(getCount).toBeGreaterThan(1));
    expect(await screen.findByText("After Fetch")).toBeInTheDocument();
  });

  it("retries a failed cached read without invoking Fetch", async () => {
    let getCount = 0;
    let postCount = 0;
    server.use(
      http.get("*/api/campaigns/42/streams", () => {
        getCount += 1;
        if (getCount === 1) {
          return errorResponse("DOMAIN_POLICY_REJECTION", 422, {
            reason: "rejected",
          });
        }
        return HttpResponse.json([streamFixture()]);
      }),
      http.post("*/api/campaigns/42/fetch", () => {
        postCount += 1;
        return HttpResponse.json(fetchOutcomeFixture());
      }),
    );
    const user = userEvent.setup();
    renderApp("/campaigns/42");

    expect(
      await screen.findByText("Cached stream list unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("The backend rejected this action by domain policy.")).toBeInTheDocument();
    expect(screen.getByText("API error code: DOMAIN_POLICY_REJECTION")).toBeInTheDocument();
    expect(getCount).toBe(1);

    await user.click(
      screen.getByRole("button", { name: "Retry cached list read" }),
    );

    expect(await screen.findByText("Main stream")).toBeInTheDocument();
    expect(getCount).toBe(2);
    expect(postCount).toBe(0);
  });

  it("keeps Fetch failure and retry separate from the cached read", async () => {
    let getCount = 0;
    let postCount = 0;
    server.use(
      http.get("*/api/campaigns/42/streams", () => {
        getCount += 1;
        return HttpResponse.json([streamFixture()]);
      }),
      http.post("*/api/campaigns/42/fetch", () => {
        postCount += 1;
        if (postCount === 1) {
          return errorResponse("KEITARO_UPSTREAM_FAILURE", 502, {
            upstream: { status: 503, message: "down" },
          });
        }
        return HttpResponse.json(fetchOutcomeFixture());
      }),
    );
    const user = userEvent.setup();
    renderApp("/campaigns/42");

    await screen.findByText("Main stream");
    await user.click(screen.getByRole("button", { name: "Fetch streams" }));

    expect(await screen.findByText("Fetch failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The Keitaro upstream is unavailable. Read state again before retrying.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("API error code: KEITARO_UPSTREAM_FAILURE")).toBeInTheDocument();
    expect(postCount).toBe(1);
    expect(getCount).toBe(1);

    await user.click(screen.getByRole("button", { name: "Retry Fetch streams" }));

    expect(await screen.findByRole("heading", { name: "Fetch summary" })).toBeInTheDocument();
    expect(postCount).toBe(2);
    await waitFor(() => expect(getCount).toBe(2));
  });

  it("handles an API/network outage on the cached read with an explicit retry", async () => {
    let getCount = 0;
    server.use(
      http.get("*/api/campaigns/42/streams", () => {
        getCount += 1;
        if (getCount === 1) {
          return HttpResponse.error();
        }
        return HttpResponse.json([streamFixture()]);
      }),
    );
    const user = userEvent.setup();
    renderApp("/campaigns/42");

    expect(
      await screen.findByText(
        "The API could not be reached. Check the local backend and try again.",
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Retry cached list read" }),
    );
    expect(await screen.findByText("Main stream")).toBeInTheDocument();
    expect(getCount).toBe(2);
  });

  it("keeps the URL campaign ID on direct navigation and a simulated reload", async () => {
    let getCount = 0;
    server.use(
      http.get("*/api/campaigns/42/streams", () => {
        getCount += 1;
        return HttpResponse.json([streamFixture()]);
      }),
    );

    renderApp("/campaigns/42");
    expect(await screen.findByText("Campaign ID: 42")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/campaigns/42");

    cleanup();
    renderApp("/campaigns/42");
    expect(await screen.findByText("Campaign ID: 42")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/campaigns/42");
    expect(getCount).toBe(2);
  });

  it.each(["0", "-2", "1.5", "abc", "9007199254740992"])(
    "rejects invalid URL campaign ID %s without any API request",
    (campaignId) => {
      server.use(
        http.get("*/api/campaigns/*", () => HttpResponse.json([])),
        http.post("*/api/campaigns/*/fetch", () => HttpResponse.json({})),
      );

      renderApp(`/campaigns/${campaignId}`);

      expect(
        screen.getByRole("heading", { name: "Invalid Campaign ID" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/No API request was made/)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Fetch streams" }),
      ).toBeNull();
    },
  );

  it("keeps workspace actions keyboard reachable", async () => {
    serveStreams([]);
    const user = userEvent.setup();
    renderApp("/campaigns/42");
    await screen.findByText(/No cached stream references are available yet/);

    let found = false;
    for (let index = 0; index < 12 && !found; index += 1) {
      await user.tab();
      found = document.activeElement?.textContent?.includes("Fetch streams") ?? false;
    }

    expect(found).toBe(true);
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
    serveStreams([]);

    renderApp("/campaigns/42");

    expect(
      (await screen.findByRole("region", { name: "Campaign Workspace" }))
        .className,
    ).toContain("narrow");
  });
});

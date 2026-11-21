import { cleanup, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";
import { draftStateFixture, streamFixture } from "../../test/fixtures";

afterEach(() => cleanup());

function sidebar() {
  return within(screen.getByRole("complementary", { name: "App sidebar" }));
}

function serveStreams(streams: unknown[]) {
  server.use(
    http.get("*/api/campaigns/42/streams", () => HttpResponse.json(streams)),
  );
}

describe("StreamsSidebar", () => {
  it("shows an open-campaign hint when no campaign route is active", () => {
    renderApp("/campaigns/new");
    expect(
      sidebar().getByRole("link", { name: "Open a campaign" }),
    ).toHaveAttribute("href", "/campaigns/open");
  });

  it("lists streams with the active stream highlighted and staged chip", async () => {
    serveStreams([
      streamFixture({ stream_ref: 101, name: "Main stream" }),
      streamFixture({ stream_ref: 102, name: "Backup stream" }),
    ]);
    server.use(
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json(draftStateFixture()),
      ),
    );
    renderApp("/campaigns/42/streams/101");

    const nav = sidebar().getByRole("navigation", { name: "Streams" });
    const active = await within(nav).findByRole("link", {
      name: /Main stream/,
    });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(await within(nav).findByText("staged")).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: /Backup stream/ }),
    ).not.toHaveAttribute("aria-current", "page");
  });

  it("marks a stream without a draft as synced when a snapshot exists", async () => {
    serveStreams([streamFixture({ stream_ref: 101, name: "Main stream" })]);
    server.use(
      http.get("*/api/campaigns/42/streams/101/draft", () =>
        HttpResponse.json({ stream_ref: 101, draft: null }),
      ),
      http.get("*/api/campaigns/42/streams/101/committed", () =>
        HttpResponse.json({
          stream_ref: 101,
          bindings: [],
          snapshot: { offers: [], captured_at: "2026-11-18T04:00:00" },
        }),
      ),
    );
    renderApp("/campaigns/42");

    const nav = sidebar().getByRole("navigation", { name: "Streams" });
    const state = await within(nav).findByText("synced");
    expect(state).toBeInTheDocument();
    expect(within(nav).queryByText(/staged/)).toBeNull();
  });

  it("reports the last sync time from cached stream data", async () => {
    serveStreams([streamFixture({ stream_ref: 101, name: "Main stream" })]);
    renderApp("/campaigns/42");
    expect(await sidebar().findByRole("navigation", { name: "Streams" })).toBeInTheDocument();
  });

  it("shows an unavailable hint when the streams read fails", async () => {
    server.use(
      http.get("*/api/campaigns/42/streams", () =>
        HttpResponse.json(
          { detail: "upstream unreachable", code: "UPSTREAM_UNAVAILABLE" },
          { status: 503 },
        ),
      ),
    );
    renderApp("/campaigns/42");
    expect(await sidebar().findByText("Streams unavailable")).toBeInTheDocument();
  });
});

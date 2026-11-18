import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";

const originalMatchMedia = window.matchMedia;

describe("OpenCampaignPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
  });

  it("navigates to the workspace for a manually entered positive ID", async () => {
    server.use(
      http.get("*/api/campaigns/42/streams", () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp("/campaigns/open");

    await user.type(screen.getByLabelText("Campaign ID"), "42");
    await user.click(screen.getByRole("button", { name: "Open campaign" }));

    expect(window.location.pathname).toBe("/campaigns/42");
    expect(
      await screen.findByRole("heading", { name: "Campaign Workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Campaign ID: 42")).toBeInTheDocument();
  });

  it.each(["", "0", "-4", "1.5", "abc", "9007199254740992"])(
    "rejects %s without issuing an API request",
    async (value) => {
      let requestCount = 0;
      server.use(
        http.get("*/api/campaigns/*", () => {
          requestCount += 1;
          return HttpResponse.json([]);
        }),
      );
      const user = userEvent.setup();
      renderApp("/campaigns/open");

      if (value) {
        await user.type(screen.getByLabelText("Campaign ID"), value);
      }
      await user.click(screen.getByRole("button", { name: "Open campaign" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "positive whole Campaign ID",
      );
      expect(requestCount).toBe(0);
      expect(window.location.pathname).toBe("/campaigns/open");
    },
  );

  it("supports keyboard navigation to the ID field and submission", async () => {
    server.use(
      http.get("*/api/campaigns/7/streams", () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    renderApp("/campaigns/open");

    let focused = document.activeElement;
    for (let index = 0; index < 10 && focused?.id !== "campaign-id"; index += 1) {
      await user.tab();
      focused = document.activeElement;
    }

    expect(focused).toHaveAttribute("id", "campaign-id");
    await user.type(focused as HTMLElement, "7");
    await user.keyboard("{Enter}");
    expect(window.location.pathname).toBe("/campaigns/7");
  });

  it("uses the narrow layout class on small viewports", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderApp("/campaigns/open");

    expect(
      screen.getByRole("region", { name: "Open campaign" }).className,
    ).toContain("narrow");
  });
});

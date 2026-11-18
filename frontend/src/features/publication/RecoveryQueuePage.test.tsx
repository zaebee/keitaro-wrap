import { cleanup, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponse, publicationOperationFixture } from "../../test/fixtures";
import { renderApp } from "../../test/renderApp";
import { server } from "../../test/server";

const QUEUE_PATH = "*/api/publications/recoverable*";
const originalMatchMedia = window.matchMedia;

function queueItems(count: number) {
  return Array.from({ length: count }, (_, index) =>
    publicationOperationFixture({
      operation_uuid: `operation-${index}`,
      stream_ref: 200 + index,
      status: index % 2 === 0 ? "in_progress" : "ambiguous",
    }),
  );
}

function serveQueue(
  items: unknown[],
  onRequest?: (request: Request) => void,
) {
  server.use(
    http.get(QUEUE_PATH, ({ request }) => {
      onRequest?.(request);
      return HttpResponse.json(items);
    }),
  );
}

describe("RecoveryQueuePage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
  });

  it.each([0, 1, 99, 100])(
    "renders %i recoverable records with honest bounded-queue semantics",
    async (count) => {
      let postCount = 0;
      let statusGets = 0;
      let requestedLimit: string | null = null;
      serveQueue(queueItems(count), (request) => {
        requestedLimit = new URL(request.url).searchParams.get("limit");
      });
      server.use(
        http.post("*/api/campaigns/42/push", () => {
          postCount += 1;
          return HttpResponse.json({});
        }),
        http.post("*/api/campaigns/42/streams/200/publication/cancel", () => {
          postCount += 1;
          return HttpResponse.json({});
        }),
        http.post("*/api/publications/recover", () => {
          postCount += 1;
          return HttpResponse.json({});
        }),
        http.get("*/api/campaigns/*/streams/*/publication", () => {
          statusGets += 1;
          return HttpResponse.json({});
        }),
      );

      renderApp("/recovery");

      expect(
        await screen.findByRole("heading", { name: "Recoverable publications" }),
      ).toBeInTheDocument();
      if (count === 100) {
        expect(await screen.findByText(/Potentially truncated/)).toBeInTheDocument();
        expect(screen.getByText(/not proven resolved/)).toBeInTheDocument();
      } else {
        expect(await screen.findByText(/Complete for this read/)).toBeInTheDocument();
      }
      expect(screen.getByText(/read-only screen/)).toBeInTheDocument();
      expect(screen.getByText(/separate concept/)).toBeInTheDocument();
      expect(requestedLimit).toBe("100");
      if (count === 0) {
        expect(screen.getByText(/No unresolved operations were returned/)).toBeInTheDocument();
        expect(screen.getByText(/does not prove global or permanent resolution/)).toBeInTheDocument();
      } else {
        expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(count);
      }
      expect(postCount).toBe(0);
      expect(statusGets).toBe(0);
    },
  );

  it("keeps the route on direct navigation and simulated reload", async () => {
    let getCount = 0;
    serveQueue(queueItems(1), () => {
      getCount += 1;
    });

    renderApp("/recovery");
    expect(
      await screen.findByRole("heading", { name: "Recoverable publications" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/recovery");

    cleanup();
    renderApp("/recovery");
    expect(
      await screen.findByRole("heading", { name: "Recoverable publications" }),
    ).toBeInTheDocument();
    expect(getCount).toBe(2);
  });

  it("retries a canonical queue API error with GET only", async () => {
    let getCount = 0;
    let postCount = 0;
    server.use(
      http.get(QUEUE_PATH, () => {
        getCount += 1;
        if (getCount === 1) {
          return errorResponse("INVALID_REQUEST", 422, { reason: "limit" });
        }
        return HttpResponse.json(queueItems(1));
      }),
      http.post("*/api/publications/recover", () => {
        postCount += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    expect(
      await screen.findByText("Recoverable publications unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("API error code: INVALID_REQUEST")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry queue read" }));

    expect(await screen.findByText(/Complete for this read/)).toBeInTheDocument();
    expect(getCount).toBe(2);
    expect(postCount).toBe(0);
  });

  it("retries a queue network failure with GET only", async () => {
    let getCount = 0;
    server.use(
      http.get(QUEUE_PATH, () => {
        getCount += 1;
        if (getCount === 1) {
          return HttpResponse.error();
        }
        return HttpResponse.json(queueItems(0));
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");

    expect(
      await screen.findByText(
        "The API could not be reached. Check the local backend and try again.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry queue read" }));

    expect(
      await screen.findByText(/No unresolved operations were returned/),
    ).toBeInTheDocument();
    expect(getCount).toBe(2);
  });

  it("supports keyboard navigation to the queue retry action", async () => {
    let getCount = 0;
    server.use(
      http.get(QUEUE_PATH, () => {
        getCount += 1;
        if (getCount === 1) {
          return HttpResponse.error();
        }
        return HttpResponse.json(queueItems(0));
      }),
    );
    const user = userEvent.setup();
    renderApp("/recovery");
    await screen.findByRole("button", { name: "Retry queue read" });

    let focused = document.activeElement;
    for (let index = 0; index < 12 && focused?.textContent !== "Retry queue read"; index += 1) {
      await user.tab();
      focused = document.activeElement;
    }

    expect(focused).toHaveTextContent("Retry queue read");
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
    serveQueue(queueItems(0));

    renderApp("/recovery");

    expect(
      (await screen.findByRole("region", { name: "Recoverable publications" }))
        .className,
    ).toContain("narrow");
  });
});

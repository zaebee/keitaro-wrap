import { userEvent } from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/renderApp";
import { operationFixture, OPERATION_UUID } from "../../test/fixtures";
import { server } from "../../test/server";
import { OPERATION_KEY } from "./operationStorage";

const originalMatchMedia = window.matchMedia;

describe("CreateCampaignPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
  });

  it("stores and navigates to the UUID before POST starts", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => OPERATION_UUID });
    let pathAtPost: string | null = null;
    let bodyAtPost: unknown = null;
    let postCount = 0;
    server.use(
      http.get(`*/api/campaign-creations/${OPERATION_UUID}`, () =>
        HttpResponse.json(operationFixture("started")),
      ),
      http.post("*/api/campaign-creations", async ({ request }) => {
        postCount += 1;
        pathAtPost = window.location.pathname;
        bodyAtPost = await request.json();
        return HttpResponse.json(operationFixture("started"), {
          status: 201,
          headers: { Location: `/campaign-creations/${OPERATION_UUID}` },
        });
      }),
    );

    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText("Campaign name"), "Campaign");
    await user.type(screen.getByLabelText("Country code"), "us");
    await user.type(screen.getByLabelText("Offer ID"), "7");
    await user.click(screen.getByRole("button", { name: "Create campaign" }));

    expect(
      await screen.findByText("Operation status: started"),
    ).toBeInTheDocument();
    await waitFor(() => expect(pathAtPost).toBe(`/campaign-creations/${OPERATION_UUID}`));
    expect(window.sessionStorage.getItem(OPERATION_KEY)).toBe(OPERATION_UUID);
    expect(bodyAtPost).toMatchObject({ operation_uuid: OPERATION_UUID });
    expect(postCount).toBe(1);
    expect(
      await screen.findByText("A new durable operation was created."),
    ).toBeInTheDocument();
  });

  it("does not create a UUID when shape validation fails", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Create campaign" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Use a two-letter ISO country code.",
    );
    expect(window.sessionStorage.getItem(OPERATION_KEY)).toBeNull();
  });

  it("supports keyboard navigation to labelled fields", async () => {
    const user = userEvent.setup();
    renderApp();

    let focused = document.activeElement;
    for (let index = 0; index < 10 && focused?.id !== "campaign-name"; index += 1) {
      await user.tab();
      focused = document.activeElement;
    }

    expect(focused).toHaveAttribute("id", "campaign-name");
  });

  it("applies the narrow layout class at mobile widths", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderApp();

    expect(screen.getByRole("region", { name: "Create campaign" }).className).toContain(
      "narrow",
    );
  });
});

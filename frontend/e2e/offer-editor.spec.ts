import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockStreams } from "./streams";

const committed = {
  stream_ref: 101,
  bindings: [
    {
      offer_id: 7,
      lifecycle: "ACTIVE",
      is_pinned: true,
      last_remote_share: 60,
    },
    {
      offer_id: 8,
      lifecycle: "ACTIVE",
      is_pinned: false,
      last_remote_share: 40,
    },
  ],
  snapshot: {
    offers: [
      { offer_id: 7, share: 60, state: "active", position: 0 },
      { offer_id: 8, share: 40, state: "active", position: 1 },
    ],
    captured_at: "2026-11-18T04:00:00",
  },
};

const draftView = {
  stream_ref: 101,
  offers: [
    {
      offer_id: 7,
      lifecycle: "ACTIVE",
      is_pinned: true,
      share: 60,
      state: "active",
      position: 0,
    },
    {
      offer_id: 8,
      lifecycle: "ACTIVE",
      is_pinned: false,
      share: 40,
      state: "active",
      position: 1,
    },
  ],
  baseline_offers: committed.snapshot.offers,
  staged_changes: {},
  version: 1,
  is_dirty: false,
  is_stale: false,
  conflicts: [],
  policy_cases: [],
  unallocated: 0,
};

async function mockReads(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route("**/api/campaigns/42/streams/101/committed", (route) =>
    route.fulfill({ json: committed }),
  );
  await mockStreams(page);
  await page.route("**/api/campaigns/42/streams/101/draft", (route) =>
    route.fulfill({ json: { stream_ref: 101, draft: draftView } }),
  );
  await page.route("**/api/campaigns/42/streams/101/publication", (route) =>
    route.fulfill({ json: { stream_ref: 101, operation: null } }),
  );
}

test("editor loads both server views and has no serious accessibility findings", async ({
  page,
}) => {
  await mockReads(page);
  await page.goto("/campaigns/42/streams/101");

  await expect(
    page.getByRole("heading", { name: "Offer Editor" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Committed baseline/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Staged draft/ }),
  ).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
});

test("manual add uses the draft endpoint and never calls Fetch", async ({
  page,
}) => {
  await mockReads(page);
  let addBody: unknown = null;
  let fetchCalls = 0;
  await page.route("**/api/campaigns/42/streams/101/draft/add", async (route) => {
    addBody = route.request().postDataJSON();
    await route.fulfill({
      json: {
        view: {
          ...draftView,
          version: 2,
          is_dirty: true,
          staged_changes: { additions: [9] },
          offers: [
            ...draftView.offers,
            {
              offer_id: 9,
              lifecycle: "ACTIVE",
              is_pinned: false,
              share: 0,
              state: null,
              position: 2,
            },
          ],
        },
        created: true,
        noop: false,
      },
    });
  });
  await page.route("**/api/campaigns/42/fetch", async (route) => {
    fetchCalls += 1;
    await route.fulfill({ json: {} });
  });

  await page.goto("/campaigns/42/streams/101");
  await page.getByLabel("Add offer by ID").fill("9");
  await page.getByRole("button", { name: "Add offer" }).click();

  await expect(page.getByRole("heading", { name: "Offer #9" })).toBeVisible();
  await expect(page.getByText("Addition: Offer #9")).toBeVisible();
  expect(addBody).toEqual({ expected_version: 1, offer_id: 9 });
  expect(fetchCalls).toBe(0);
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const CAMPAIGN_ID = 42;
const STREAM_REF = 101;
const UUID = "11111111-2222-4333-8444-555555555555";

const offer = (offerId: number, share: number) => ({
  offer_id: offerId,
  share,
  state: "active",
  position: offerId === 7 ? 0 : offerId === 8 ? 1 : 2,
});

const originalOffers = [offer(7, 60), offer(8, 40)];
const changedOffers = [offer(7, 90), offer(8, 40)];

const streamRef = {
  stream_ref: STREAM_REF,
  campaign_id: CAMPAIGN_ID,
  type: "regular",
  name: "Offer flow",
  schema: "landings",
  comments: "marker",
};

const publicationOperation = {
  operation_uuid: "operation-1",
  campaign_id: CAMPAIGN_ID,
  stream_ref: STREAM_REF,
  status: "in_progress",
  draft_version: 2,
  effective_entries: [],
  attempt_count: 1,
};

function draftView(overrides: Record<string, unknown> = {}) {
  return {
    stream_ref: STREAM_REF,
    offers: originalOffers.map((item) => ({
      ...item,
      lifecycle: "ACTIVE",
      is_pinned: false,
    })),
    baseline_offers: originalOffers,
    staged_changes: {},
    version: 1,
    is_dirty: false,
    is_stale: false,
    conflicts: [],
    conflicts_fingerprint: "sha256:empty",
    policy_cases: [],
    unallocated: 0,
    ...overrides,
  };
}

async function mockHealth(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
}

async function expectNoCriticalAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}

test("full mocked journey covers Fetch → conflict → Accept remote → recovery", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("http://127.0.0.1:4173") && !url.startsWith("data:")) {
      external.push(url);
    }
  });

  let operationReads = 0;
  let streams: unknown[] = [];
  let offers = originalOffers;
  let currentDraft: unknown = null;
  let stagedBody: unknown = null;
  let acceptedBody: unknown = null;
  let queue: unknown[] = [publicationOperation];

  await mockHealth(page);
  await page.route("**/api/campaign-creations", async (route) => {
    const body = (await route.request().postDataJSON()) as {
      operation_uuid: string;
    };
    expect(body.operation_uuid).toBeTruthy();
    return route.fulfill({
      status: 201,
      headers: { Location: `/campaign-creations/${body.operation_uuid}` },
      json: {
        operation_uuid: body.operation_uuid,
        alias: "slug-journey",
        status: "started",
        campaign_id: null,
      },
    });
  });
  await page.route("**/api/campaign-creations/*", (route) => {
    operationReads += 1;
    return route.fulfill({
      json: {
        operation_uuid: UUID,
        alias: "slug-journey",
        status: operationReads === 1 ? "ambiguous" : "created",
        campaign_id: CAMPAIGN_ID,
      },
    });
  });
  await page.route("**/api/campaigns/42/fetch", (route) => {
    const conflict = offers !== originalOffers ? 1 : 0;
    streams = [streamRef];
    return route.fulfill({
      json: {
        campaign_id: CAMPAIGN_ID,
        stream_count: 1,
        reconciled_stream_count: 1,
        created_bindings: 2,
        archived_bindings: 0,
        reactivated_bindings: 0,
        share_updates: conflict,
        conflicted_drafts: conflict,
      },
    });
  });
  await page.route("**/api/campaigns/42/streams", (route) =>
    route.fulfill({ json: streams }),
  );
  await page.route("**/api/campaigns/42/streams/101/committed", (route) =>
    route.fulfill({
      json: {
        stream_ref: STREAM_REF,
        bindings: offers.map((item) => ({
          offer_id: item.offer_id,
          lifecycle: "ACTIVE",
          is_pinned: false,
          last_remote_share: item.share,
        })),
        snapshot: { offers, captured_at: "2026-11-20T03:00:00" },
      },
    }),
  );
  await page.route("**/api/campaigns/42/streams/101/draft", (route) =>
    route.fulfill({ json: { stream_ref: STREAM_REF, draft: currentDraft } }),
  );
  await page.route("**/api/campaigns/42/streams/101/draft/add", async (route) => {
    stagedBody = await route.request().postDataJSON();
    currentDraft = draftView({
      offers: [
        ...originalOffers.map((item) => ({
          ...item,
          lifecycle: "ACTIVE",
          is_pinned: false,
        })),
        {
          offer_id: 9,
          lifecycle: "ACTIVE",
          is_pinned: false,
          share: 0,
          state: null,
          position: 2,
        },
      ],
      is_dirty: true,
      staged_changes: { additions: [9] },
    });
    return route.fulfill({ json: { view: currentDraft, created: true, noop: false } });
  });
  await page.route(
    "**/api/campaigns/42/streams/101/draft/accept-remote",
    async (route) => {
      acceptedBody = await route.request().postDataJSON();
      currentDraft = draftView({
        offers: changedOffers.map((item) => ({
          ...item,
          lifecycle: "ACTIVE",
          is_pinned: false,
        })),
        baseline_offers: changedOffers,
        version: 2,
      });
      return route.fulfill({
        json: { stream_ref: STREAM_REF, draft: currentDraft, noop: false, version: 2 },
      });
    },
  );
  await page.route("**/api/campaigns/42/streams/101/publication", (route) =>
    route.fulfill({
      json: {
        stream_ref: STREAM_REF,
        operation: queue.length === 0 ? null : publicationOperation,
      },
    }),
  );
  await page.route("**/api/publications/recoverable*", (route) =>
    route.fulfill({ json: queue }),
  );
  await page.route("**/api/publications/recover", (route) => {
    queue = [];
    return route.fulfill({
      json: {
        processed: 1,
        confirmed: 1,
        unresolved: 0,
        degraded: 0,
        remaining: 0,
        deadline_reached: false,
      },
    });
  });
  await page.route("**/api/campaigns/42/push", (route) => {
    throw new Error(`Unexpected Push request: ${route.request().url()}`);
  });

  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill("Journey campaign");
  await page.getByLabel("Country code").fill("US");
  await page.getByLabel("Offer ID").fill("7");
  await page.getByRole("button", { name: /Create campaign/ }).click();

  await expect(page.getByText(/Operation status:/)).toBeVisible();
  await expect(page.getByText("Operation status: created")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Operation status: created")).toBeVisible();
  await page.getByRole("link", { name: "Open Campaign Workspace" }).click();

  await expect(
    page.getByRole("heading", { name: "Campaign Workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Fetch streams" }).click();
  await expect(page.getByText("Offer flow")).toBeVisible();
  await page.getByRole("link", { name: /Open editor for stream 101/ }).click();

  await expect(page.getByRole("heading", { name: "Offer Editor" })).toBeVisible();
  await page.getByLabel("Add offer by ID").fill("9");
  await page.getByRole("button", { name: "Add offer" }).click();
  await expect(page.getByRole("heading", { name: "Offer #9" })).toBeVisible();
  expect(stagedBody).toEqual({ expected_version: 0, offer_id: 9 });

  offers = changedOffers;
  currentDraft = draftView({
    offers: [
      ...changedOffers.map((item) => ({
        ...item,
        lifecycle: "ACTIVE",
        is_pinned: false,
      })),
      {
        offer_id: 9,
        lifecycle: "ACTIVE",
        is_pinned: false,
        share: 0,
        state: null,
        position: 2,
      },
    ],
    baseline_offers: originalOffers,
    is_dirty: true,
    is_stale: true,
    staged_changes: { additions: [9] },
    conflicts: [
      {
        stream_ref: STREAM_REF,
        offer_id: 7,
        field: "share",
        expected: 60,
        observed: 90,
        reason: "remote_share_changed",
      },
    ],
    conflicts_fingerprint: "sha256:conflict",
  });

  await page.getByRole("link", { name: "Back to Campaign Workspace" }).click();
  await page.getByRole("button", { name: "Fetch streams" }).click();
  await expect(page.getByText("Conflicted drafts")).toBeVisible();
  await page.getByRole("link", { name: /Open editor for stream 101/ }).click();

  await expect(page.getByText("Sticky Fetch conflicts")).toBeVisible();
  await expect(page.getByText(/remote_share_changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add offer" })).toBeDisabled();

  await page.getByRole("button", { name: "Accept remote" }).click();
  await page.getByRole("button", { name: "Confirm accept remote" }).click();

  await expect(page.getByText("Sticky Fetch conflicts")).toHaveCount(0);
  await expect(page.getByText(/Remote state accepted/)).toBeVisible();
  expect(acceptedBody).toEqual({
    expected_version: 1,
    expected_conflicts_fingerprint: "sha256:conflict",
  });
  await expect(page.getByText("2", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add offer" })).toBeEnabled();

  await page.getByRole("link", { name: "inspect the recoverable queue" }).click();
  await expect(
    page.getByRole("heading", { name: "Recoverable publications" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run recovery" }).click();
  await page.getByRole("button", { name: "Confirm recovery" }).click();
  await expect(page.getByText("Recovery pass completed")).toBeVisible();
  await page.getByRole("button", { name: "Re-read authoritative state" }).click();
  await expect(
    page.getByText(/No unresolved operations in the current bounded read/),
  ).toBeVisible();

  expect(page.getByRole("button", { name: /Push/ })).toHaveCount(0);
  expect(external).toEqual([]);
});

test("axe-core passes on all primary routes and states", async ({ page }) => {
  let operationReads = 0;
  await mockHealth(page);
  await page.route("**/api/campaign-creations/*", (route) => {
    operationReads += 1;
    return route.fulfill({
      json: {
        operation_uuid: UUID,
        alias: "slug-axe",
        status: "created",
        campaign_id: CAMPAIGN_ID,
      },
    });
  });
  await page.route("**/api/campaigns/42/streams", (route) =>
    route.fulfill({ json: [streamRef] }),
  );
  await page.route("**/api/campaigns/42/streams/101/committed", (route) =>
    route.fulfill({
      json: {
        stream_ref: STREAM_REF,
        bindings: [],
        snapshot: { offers: originalOffers, captured_at: "2026-11-20T03:00:00" },
      },
    }),
  );
  await page.route("**/api/campaigns/42/streams/101/draft", (route) =>
    route.fulfill({ json: { stream_ref: STREAM_REF, draft: null } }),
  );
  await page.route("**/api/campaigns/42/streams/101/publication", (route) =>
    route.fulfill({ json: { stream_ref: STREAM_REF, operation: null } }),
  );
  await page.route("**/api/publications/recoverable*", (route) =>
    route.fulfill({ json: [publicationOperation] }),
  );

  const routes = [
    "/campaigns/new",
    "/campaigns/open",
    `/campaign-creations/${UUID}`,
    "/campaigns/42",
    "/campaigns/42/streams/101",
    "/recovery",
  ];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expectNoCriticalAxe(page);
  }
  expect(operationReads).toBeGreaterThan(0);
});

test("mobile and tablet viewports keep safe actions reachable", async ({
  page,
}) => {
  await mockHealth(page);
  await page.route("**/api/campaigns/42/streams", (route) =>
    route.fulfill({ json: [streamRef] }),
  );
  await page.route("**/api/campaigns/42/streams/101/committed", (route) =>
    route.fulfill({
      json: {
        stream_ref: STREAM_REF,
        bindings: [],
        snapshot: { offers: originalOffers, captured_at: "2026-11-20T03:00:00" },
      },
    }),
  );
  await page.route("**/api/campaigns/42/streams/101/draft", (route) =>
    route.fulfill({ json: { stream_ref: STREAM_REF, draft: null } }),
  );
  await page.route("**/api/campaigns/42/streams/101/publication", (route) =>
    route.fulfill({ json: { stream_ref: STREAM_REF, operation: null } }),
  );
  await page.route("**/api/publications/recoverable*", (route) =>
    route.fulfill({ json: [] }),
  );

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/campaigns/42");
    await expect(
      page.getByRole("button", { name: "Fetch streams" }),
    ).toBeVisible();
    await page.getByRole("link", { name: /Open editor for stream 101/ }).click();
    await expect(page.getByRole("heading", { name: "Offer Editor" })).toBeVisible();
    await expect(page.getByText("Push unavailable")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  }
});

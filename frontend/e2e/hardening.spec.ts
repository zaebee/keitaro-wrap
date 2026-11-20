import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const CAMPAIGN_ID = 42;
const STREAM_REF = 101;
const UUID = "11111111-2222-4333-8444-555555555555";

type RemoteOffer = { offer_id: number; share: number; state: string; position: number };
type DraftView = Record<string, unknown>;

const offer = (offerId: number, share: number): RemoteOffer => ({
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
  draft_version: 1,
  effective_entries: [],
  attempt_count: 1,
};

const stagedOffer = {
  offer_id: 9,
  lifecycle: "ACTIVE",
  is_pinned: false,
  share: 0,
  state: null,
  position: 2,
};

function stagedView(offers: RemoteOffer[] = originalOffers): DraftView {
  return draftView({
    offers: [
      ...offers.map((item) => ({
        ...item,
        lifecycle: "ACTIVE",
        is_pinned: false,
      })),
      stagedOffer,
    ],
    baseline_offers: offers,
    is_dirty: true,
    staged_changes: { additions: [9] },
  });
}

function staleView(offers: RemoteOffer[] = changedOffers): DraftView {
  return draftView({
    offers: [
      ...offers.map((item) => ({
        ...item,
        lifecycle: "ACTIVE",
        is_pinned: false,
      })),
      stagedOffer,
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
}

function draftView(overrides: Record<string, unknown> = {}): DraftView {
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

async function clearBrowserState(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
}

type ReadOnlyState = {
  streams: unknown[];
  offers: RemoteOffer[];
  draft: DraftView | null;
  publication: unknown | null;
  queue: unknown[];
};

async function mockReadOnlyApi(
  page: Page,
  initial: Partial<ReadOnlyState> = {},
) {
  const state: ReadOnlyState = {
    streams: initial.streams ?? [streamRef],
    offers: initial.offers ?? originalOffers,
    draft: initial.draft ?? null,
    publication: initial.publication ?? null,
    queue: initial.queue ?? [],
  };
  await mockHealth(page);
  await page.route("**/api/campaigns/42/streams", (route) =>
    route.fulfill({ json: state.streams }),
  );
  await page.route("**/api/campaigns/42/streams/101/committed", (route) =>
    route.fulfill({
      json: {
        stream_ref: STREAM_REF,
        bindings: state.offers.map((item) => ({
          offer_id: item.offer_id,
          lifecycle: "ACTIVE",
          is_pinned: false,
          last_remote_share: item.share,
        })),
        snapshot: { offers: state.offers, captured_at: "2026-11-20T03:00:00" },
      },
    }),
  );
  await page.route("**/api/campaigns/42/streams/101/draft", (route) =>
    route.fulfill({ json: { stream_ref: STREAM_REF, draft: state.draft } }),
  );
  await page.route("**/api/campaigns/42/streams/101/publication", (route) =>
    route.fulfill({ json: { stream_ref: STREAM_REF, operation: state.publication } }),
  );
  await page.route("**/api/publications/recoverable*", (route) =>
    route.fulfill({ json: state.queue }),
  );
  return { state };
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
  let fetchCount = 0;
  let streams: unknown[] = [];
  let offers = originalOffers;
  let currentDraft: DraftView | null = null;
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
    fetchCount += 1;
    streams = [streamRef];
    if (fetchCount >= 2) {
      currentDraft = staleView(offers);
    }
    return route.fulfill({
      json: {
        campaign_id: CAMPAIGN_ID,
        stream_count: 1,
        reconciled_stream_count: 1,
        created_bindings: 2,
        archived_bindings: 0,
        reactivated_bindings: 0,
        share_updates: fetchCount >= 2 ? 1 : 0,
        conflicted_drafts: fetchCount >= 2 ? 1 : 0,
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
    currentDraft = stagedView(offers);
    return route.fulfill({
      json: { view: currentDraft, created: true, noop: false },
    });
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
        json: {
          stream_ref: STREAM_REF,
          draft: currentDraft,
          noop: false,
          version: 2,
        },
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
  await page.locator("#main").getByRole("button", { name: "Fetch streams" }).click();
  await expect(
    page.getByRole("list", { name: "Cached stream references" }).getByText("Offer flow"),
  ).toBeVisible();
  await page.getByRole("link", { name: /Open editor for stream 101/ }).click();

  await expect(page.getByRole("heading", { name: "Offer Editor" })).toBeVisible();
  await expect(page.getByText("Sticky Fetch conflicts")).toHaveCount(0);
  await page.getByLabel("Add offer by ID").fill("9");
  await page.getByRole("button", { name: "Add offer" }).click();
  await expect(page.getByRole("row", { name: /Offer #9/ })).toBeVisible();
  expect(stagedBody).toEqual({ expected_version: 0, offer_id: 9 });
  expect((currentDraft as DraftView | null)?.is_stale).toBe(false);

  offers = changedOffers;
  await page.getByRole("link", { name: "Campaign 42 workspace" }).click();
  await page.locator("#main").getByRole("button", { name: "Fetch streams" }).click();
  await expect(page.getByText("Conflicted drafts")).toBeVisible();
  expect((currentDraft as DraftView | null)?.is_stale).toBe(true);
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
  const acceptedDraft = currentDraft as unknown as DraftView;
  expect(acceptedDraft.is_dirty).toBe(false);
  expect(acceptedDraft.is_stale).toBe(false);
  expect(acceptedDraft.staged_changes).toEqual({});
  expect(acceptedDraft.baseline_offers).toEqual(changedOffers);
  expect(
    (acceptedDraft.offers as Array<{ offer_id: number }>).some(
      (item) => item.offer_id === 9,
    ),
  ).toBe(false);
  expect(acceptedDraft.version).toBe(2);

  const draftPanel = page.getByRole("region", { name: /Staged draft/ });
  const draftMeta = draftPanel.locator("dl").first();
  const definition = (label: string) =>
    draftMeta
      .locator("dt", { hasText: new RegExp(`^${label}$`) })
      .locator("xpath=following-sibling::dd[1]");
  await expect(definition("Version")).toHaveText("2");
  await expect(definition("State")).toHaveText("clean");
  await expect(definition("Stale")).toHaveText("no");
  await expect(page.getByRole("row", { name: /Offer #9/ })).toHaveCount(0);
  const acceptedOffer7 = page.getByRole("row", { name: /Offer #7/ });
  const acceptedOffer8 = page.getByRole("row", { name: /Offer #8/ });
  await expect(acceptedOffer7).toContainText("90");
  await expect(acceptedOffer8).toContainText("40");
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

  await expect(page.getByRole("button", { name: /Push/ })).toHaveCount(0);
  expect(external).toEqual([]);
});

test("axe-core passes on routes and consequential states", async ({ page }) => {
  let operationReads = 0;
  const api = await mockReadOnlyApi(page, {
    publication: null,
    queue: [publicationOperation],
  });

  let cancelResult: unknown = null;
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
  await page.route(
    "**/api/campaigns/42/streams/101/publication/cancel",
    (route) => {
      cancelResult = {
        stream_ref: STREAM_REF,
        status: "abandoned",
        reason: "ABANDONED",
        draft_discarded: false,
      };
      api.state.publication = { ...publicationOperation, status: "abandoned" };
      return route.fulfill({ json: cancelResult });
    },
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

  api.state.draft = staleView();
  await page.goto("/campaigns/42/streams/101");
  await expect(page.getByText("Sticky Fetch conflicts")).toBeVisible();
  await expectNoCriticalAxe(page);

  await page.getByRole("button", { name: "Accept remote" }).click();
  await expect(
    page.getByRole("group", { name: "Confirm accept remote" }),
  ).toBeVisible();
  await expectNoCriticalAxe(page);

  await clearBrowserState(page);
  api.state.draft = null;
  api.state.publication = { ...publicationOperation, status: "pending" };
  api.state.queue = [];
  await page.goto("/campaigns/42/streams/101");
  await page.getByRole("button", { name: "Cancel publication" }).click();
  await expect(
    page.getByRole("group", { name: "Confirm publication cancel" }),
  ).toBeVisible();
  await expectNoCriticalAxe(page);

  api.state.draft = { ...draftView(), version: "invalid" };
  await page.getByRole("button", { name: "Confirm publication cancel" }).click();
  await expect(
    page.getByText(/A fresh valid publication status/),
  ).toBeVisible();
  await expectNoCriticalAxe(page);

  await clearBrowserState(page);
  api.state.draft = null;
  api.state.publication = { ...publicationOperation, status: "pending" };
  cancelResult = null;
  await page.goto("/campaigns/42/streams/101");
  await page.getByRole("button", { name: "Cancel publication" }).click();
  await page.getByRole("button", { name: "Confirm publication cancel" }).click();
  await expect(
    page.getByText(/Authoritative status and queue reads passed/),
  ).toBeVisible();
  await expectNoCriticalAxe(page);
});

test("mobile and tablet viewports keep safe actions reachable", async ({
  page,
}) => {
  const api = await mockReadOnlyApi(page, {
    queue: [publicationOperation],
    publication: { ...publicationOperation, status: "pending" },
  });
  await page.route("**/api/campaign-creations/*", (route) =>
    route.fulfill({
      json: {
        operation_uuid: UUID,
        alias: "slug-responsive",
        status: "created",
        campaign_id: CAMPAIGN_ID,
      },
    }),
  );

  const checks = [
    {
      route: "/campaigns/new",
      control: () => page.getByRole("button", { name: "Create campaign" }),
    },
    {
      route: `/campaign-creations/${UUID}`,
      control: () =>
        page.getByRole("link", { name: "Open Campaign Workspace" }),
    },
    {
      route: "/campaigns/open",
      control: () => page.getByRole("button", { name: "Open campaign" }),
    },
    {
      route: "/campaigns/42",
      control: () => page.locator("#main").getByRole("button", { name: "Fetch streams" }),
    },
    {
      route: "/campaigns/42/streams/101",
      control: () => page.getByRole("button", { name: "Add offer" }),
    },
    {
      route: "/recovery",
      control: () => page.getByRole("button", { name: "Run recovery" }),
    },
  ];

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    for (const check of checks) {
      await clearBrowserState(page);
      api.state.draft = null;
      await page.goto(check.route);
      const control = check.control();
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(2);
    }
  }
});

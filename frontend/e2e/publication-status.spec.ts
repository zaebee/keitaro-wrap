import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const operation = {
  operation_uuid: "operation-1",
  campaign_id: 42,
  stream_ref: 101,
  status: "in_progress",
  draft_version: 3,
  effective_entries: [
    { offer_id: 7, share: 60, state: "active" },
    { offer_id: 8, share: 40, state: "active" },
  ],
  attempt_count: 1,
};

async function mockApi(
  page: Page,
  queue: () => unknown[],
  status: "in_progress" | "succeeded" = "succeeded",
) {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route("**/api/publications/recoverable*", (route) =>
    route.fulfill({ json: queue() }),
  );
  await page.route("**/api/campaigns/42/streams/101/committed", (route) =>
    route.fulfill({ json: { stream_ref: 101, bindings: [], snapshot: null } }),
  );
  await page.route("**/api/campaigns/42/streams/101/draft", (route) =>
    route.fulfill({ json: { stream_ref: 101, draft: null } }),
  );
  await page.route("**/api/campaigns/42/streams/101/publication", (route) =>
    route.fulfill({
      json: {
        stream_ref: 101,
        operation: status === "succeeded" ? null : { ...operation, status },
      },
    }),
  );
}

test("recovery queue is explicit and honest about a bounded response", async ({
  page,
}) => {
  const queue = Array.from({ length: 100 }, (_, index) => ({
    ...operation,
    operation_uuid: `operation-${index}`,
    stream_ref: 200 + index,
  }));
  await mockApi(page, () => queue);
  await page.goto("/recovery");

  await expect(
    page.getByRole("heading", { name: "Recoverable publications" }),
  ).toBeVisible();
  await expect(page.getByText(/Potentially truncated/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run recovery" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Push/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Cancel/ })).toHaveCount(0);

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
});

test("editor shows the latest publication status as a separate read", async ({
  page,
}) => {
  await mockApi(page, () => [], "in_progress");
  await page.goto("/campaigns/42/streams/101");

  await expect(
    page.getByRole("heading", { name: "Latest publication status" }),
  ).toBeVisible();
  await expect(page.getByText("In progress")).toBeVisible();
  await expect(page.getByText("operation-1")).toBeVisible();
  await expect(
    page.getByText(/point-in-time view, not publication history/),
  ).toBeVisible();
});

test("recovery pass requires confirmation and unlocks only after bounded GET verification", async ({
  page,
}) => {
  let queue: unknown[] = [operation];
  await mockApi(page, () => queue);
  await page.route("**/api/publications/recover", (route) =>
    route.fulfill({
      json: {
        processed: 0,
        confirmed: 0,
        unresolved: 0,
        degraded: 0,
        remaining: 0,
        deadline_reached: false,
      },
    }),
  );
  await page.goto("/recovery");

  await page.getByRole("button", { name: "Run recovery" }).click();
  await page.getByRole("button", { name: "Confirm recovery" }).click();

  await expect(page.getByText("Recovery pass completed")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recovery lock active" }),
  ).toBeVisible();

  queue = [];
  await page.getByRole("button", { name: "Re-read authoritative state" }).click();

  await expect(
    page.getByText(
      "No unresolved operations in the current bounded read; previously tracked stream identities re-read successfully.",
    ),
  ).toBeVisible();
});

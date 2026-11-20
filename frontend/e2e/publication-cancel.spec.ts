import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const operation = {
  operation_uuid: "operation-1",
  campaign_id: 42,
  stream_ref: 101,
  status: "pending",
  draft_version: 1,
  effective_entries: [],
  attempt_count: 1,
};

async function mockEditor(page: Page, status = "pending") {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route("**/api/campaigns/42/streams/101/committed", (route) =>
    route.fulfill({ json: { stream_ref: 101, bindings: [], snapshot: null } }),
  );
  await page.route("**/api/campaigns/42/streams", (route) =>
    route.fulfill({
      json: [
        {
          stream_ref: 101,
          campaign_id: 42,
          type: "regular",
          name: "Main stream",
          schema: "landings",
          comments: null,
        },
      ],
    }),
  );
  await page.route("**/api/campaigns/42/streams/101/draft", (route) =>
    route.fulfill({ json: { stream_ref: 101, draft: null } }),
  );
  await page.route("**/api/campaigns/42/streams/101/publication", (route) =>
    route.fulfill({
      json: {
        stream_ref: 101,
        operation: status === "none" ? null : { ...operation, status },
      },
    }),
  );
  await page.route("**/api/publications/recoverable*", (route) =>
    route.fulfill({ json: [] }),
  );
}

test("publication cancel has a separate confirmation and no Push control", async ({
  page,
}) => {
  await mockEditor(page);
  await page.goto("/campaigns/42/streams/101");

  await expect(
    page.getByRole("heading", { name: "Publication Cancel" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel local draft" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Cancel publication" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Push/ })).toHaveCount(0);

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
});

test("recovery-required publication has no Cancel action", async ({ page }) => {
  await mockEditor(page, "in_progress");
  await page.goto("/campaigns/42/streams/101");

  await expect(page.getByText(/Recovery is required before this publication/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel publication" }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Inspect recovery queue" })).toBeVisible();
});

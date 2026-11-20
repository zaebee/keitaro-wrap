import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function mockEditor(page: Page, pushRequests: () => void) {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route("**/api/campaigns/42/push", (route) => {
    pushRequests();
    return route.fulfill({ status: 503, json: { error: { code: "PUBLICATION_WRITES_DISABLED" } } });
  });
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
    route.fulfill({ json: { stream_ref: 101, operation: null } }),
  );
  await page.route("**/api/publications/recoverable*", (route) =>
    route.fulfill({ json: [] }),
  );
}

test("editor explains disabled Push accessibly without exposing a control", async ({
  page,
}) => {
  let pushes = 0;
  await mockEditor(page, () => {
    pushes += 1;
  });
  await page.goto("/campaigns/42/streams/101");

  await expect(
    page.getByRole("heading", { name: "Push unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This interface does not provide a Push action. Publication writes are disabled. Refreshing, retrying, or navigating will not enable publication.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Push/ })).toHaveCount(0);
  expect(pushes).toBe(0);

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
});

test("read-only recovery stays reachable from the panel without Push", async ({
  page,
}) => {
  let pushes = 0;
  await mockEditor(page, () => {
    pushes += 1;
  });
  await page.goto("/campaigns/42/streams/101");

  await page.getByRole("link", { name: "inspect the recoverable queue" }).click();
  await expect(
    page.getByRole("heading", { name: "Recoverable publications" }),
  ).toBeVisible();
  expect(pushes).toBe(0);
});

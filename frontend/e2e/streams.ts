import type { Page } from "@playwright/test";

/** Mock the sidebar's cached streams read with the standard fixture stream. */
export async function mockStreams(page: Page) {
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
}

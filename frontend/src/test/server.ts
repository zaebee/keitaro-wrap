import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export const server = setupServer(
  http.get("*/api/health", () => HttpResponse.json({ status: "ok" })),
);

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export const server = setupServer(
  http.get("*/api/health", () => HttpResponse.json({ status: "ok" })),
  // Default streams reads used by the app-level sidebar. Tests override these
  // with per-campaign handlers when they need a specific stream list.
  http.get("*/api/campaigns/:campaignId/streams", () => HttpResponse.json([])),
  http.get("*/api/campaigns/:campaignId/streams/:streamRef/committed", ({
    params,
  }) =>
    HttpResponse.json({
      stream_ref: Number(params.streamRef),
      bindings: [],
      snapshot: null,
    })),
  http.get("*/api/campaigns/:campaignId/streams/:streamRef/draft", ({
    params,
  }) => HttpResponse.json({ stream_ref: Number(params.streamRef), draft: null })),
  http.get(
    "*/api/campaigns/:campaignId/streams/:streamRef/publication",
    ({ params }) =>
      HttpResponse.json({
        stream_ref: Number(params.streamRef),
        operation: null,
      }),
  ),
);

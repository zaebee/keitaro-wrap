import { describe, expect, it } from "vitest";

import { ApiError } from "./client";

const CODES = [
  "INVALID_REQUEST",
  "CAMPAIGN_INPUT_REJECTED",
  "CAMPAIGN_CONFIGURATION_INVALID",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_KEY_CONFLICT",
  "OPERATION_NOT_FOUND",
  "STREAM_NOT_FOUND",
  "DRAFT_VERSION_CONFLICT",
  "DRAFT_STALE_CONFLICT",
  "DRAFT_BASELINE_UNAVAILABLE",
  "PUBLICATION_UNRESOLVED",
  "PUBLICATION_CONCURRENT_CHANGE",
  "DOMAIN_POLICY_REJECTION",
  "KEITARO_UPSTREAM_FAILURE",
  "PUBLICATION_WRITES_DISABLED",
  "RECOVERY_DEGRADED",
  "PUBLICATION_RECOVERY_REQUIRED",
  "PUBLICATION_ABSENCE_EVIDENCE_REQUIRED",
  "PUBLICATION_NOT_CANCELLABLE",
  "INTERNAL_ERROR",
];

describe("ApiError", () => {
  it.each(CODES)("maps %s to an actionable message and keeps details", (code) => {
    const error = ApiError.from(409, {
      error: { code, message: "raw backend text", details: { marker: code } },
    });

    expect(error.code).toBe(code);
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ marker: code });
    expect(error.message).not.toBe("raw backend text");
    expect(error.message.length).toBeGreaterThan(10);
  });
});

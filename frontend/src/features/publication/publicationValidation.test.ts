import { describe, expect, it } from "vitest";

import { draftStateFixture } from "../../test/fixtures";
import {
  hasMatchingStreamIdentity,
  isValidDraftState,
  parseCancelErrorDetails,
  parseCancelResult,
} from "./publicationValidation";

const identity = { campaignId: 42, streamRef: 101 };

describe("publication Cancel validation", () => {
  it("accepts a well-formed Cancel result and rejects bad identity or flags", () => {
    expect(
      parseCancelResult(
        { stream_ref: 101, status: "abandoned", reason: null, draft_discarded: true },
        identity,
      ),
    ).toMatchObject({ stream_ref: 101, status: "abandoned", draft_discarded: true });
    expect(parseCancelResult({ stream_ref: 102, draft_discarded: true }, identity)).toBeNull();
    expect(parseCancelResult({ stream_ref: 101, draft_discarded: "yes" }, identity)).toBeNull();
    expect(
      parseCancelResult({ stream_ref: 101, draft_discarded: false, status: "unknown" }, identity),
    ).toBeNull();
  });

  it("validates 409 details without treating them as authoritative state", () => {
    const parsed = parseCancelErrorDetails({
      status: "pending",
      reason: "DRAFT_CHANGED",
      result: { stream_ref: 101, status: "pending", reason: "DRAFT_CHANGED", draft_discarded: false },
    });
    expect(parsed?.status).toBe("pending");
    expect(parsed?.reason).toBe("DRAFT_CHANGED");
    expect(parseCancelErrorDetails({ status: "ghost", result: {} })).toBeNull();
  });

  it("validates draft responses and stream-not-found details", () => {
    expect(isValidDraftState(draftStateFixture(), identity)).toBe(true);
    expect(isValidDraftState({ stream_ref: 102, draft: null }, identity)).toBe(false);
    expect(
      isValidDraftState({ ...draftStateFixture(), draft: { ...draftStateFixture().draft, version: "x" } }, identity),
    ).toBe(false);
    expect(hasMatchingStreamIdentity({ campaign_id: 42, stream_ref: 101 }, identity)).toBe(true);
    expect(hasMatchingStreamIdentity({ campaign_id: 43, stream_ref: 101 }, identity)).toBe(false);
  });
});

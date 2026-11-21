import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CommittedStateResponse,
  DraftViewResponse,
} from "../../api/generated/openapi";
import {
  buildAllocationSummary,
  evaluatePushReadiness,
  resolveEffectiveOffersSource,
  summarizeDraftChanges,
} from "./allocationSummary";

function makeDraft(overrides: Partial<DraftViewResponse> = {}): DraftViewResponse {
  return {
    stream_ref: 101,
    offers: [
      {
        offer_id: 7,
        lifecycle: "ACTIVE",
        is_pinned: true,
        share: 60,
        state: "active",
        position: 0,
      },
      {
        offer_id: 8,
        lifecycle: "ACTIVE",
        is_pinned: false,
        share: 40,
        state: "active",
        position: 1,
      },
    ],
    baseline_offers: [
      { offer_id: 7, share: 60, state: "active", position: 0 },
      { offer_id: 8, share: 40, state: "active", position: 1 },
    ],
    staged_changes: {},
    version: 1,
    is_dirty: false,
    is_stale: false,
    conflicts: [],
    policy_cases: [],
    unallocated: 0,
    conflicts_fingerprint: "fp-1",
    ...overrides,
  };
}

describe("buildAllocationSummary", () => {
  it("computes color-coded segments, totals, and baseline deltas", () => {
    const draft = makeDraft({
      is_dirty: true,
      offers: [
        {
          offer_id: 7,
          lifecycle: "ACTIVE",
          is_pinned: true,
          share: 65,
          state: "active",
          position: 0,
        },
        {
          offer_id: 8,
          lifecycle: "ACTIVE",
          is_pinned: false,
          share: 35,
          state: "active",
          position: 1,
        },
        {
          offer_id: 9,
          lifecycle: "ARCHIVED",
          is_pinned: false,
          share: 0,
          state: null,
          position: 2,
        },
      ],
    });

    const summary = buildAllocationSummary(draft);
    assert.equal(summary.allocatedPercent, 100);
    assert.equal(summary.unallocatedPercent, 0);
    assert.equal(summary.isBalanced, true);
    assert.equal(summary.segments.length, 2);
    assert.equal(summary.segments[0]?.changed, true);
    assert.equal(summary.segments[0]?.baselineShare, 60);
    assert.equal(summary.segments[0]?.share, 65);
  });

  it("tracks unallocated remainder when active shares sum under 100", () => {
    const draft = makeDraft({
      offers: [
        {
          offer_id: 7,
          lifecycle: "ACTIVE",
          is_pinned: true,
          share: 50,
          state: "active",
          position: 0,
        },
      ],
    });

    const summary = buildAllocationSummary(draft);
    assert.equal(summary.allocatedPercent, 50);
    assert.equal(summary.unallocatedPercent, 50);
    assert.equal(summary.isBalanced, false);
  });
});

describe("summarizeDraftChanges", () => {
  it("counts staged operations and archived offers accurately", () => {
    const draft = makeDraft({
      is_dirty: true,
      staged_changes: {
        additions: [9],
        archives: [10],
        pin_toggles: { "7": false },
        share_edits: { "8": 35 },
      },
      offers: [
        ...makeDraft().offers,
        {
          offer_id: 10,
          lifecycle: "ARCHIVED",
          is_pinned: false,
          share: 0,
          state: null,
          position: 2,
        },
      ],
    });

    const summary = summarizeDraftChanges(draft);
    assert.equal(summary.totalChanges, 4);
    assert.equal(summary.archivedCount, 1);
    assert.equal(summary.changesLabel, "4 staged changes");
    assert.equal(summary.archivedLabel, "1 offer archived");
  });
});

describe("evaluatePushReadiness", () => {
  it("allows push when dirty, clean of conflicts, balanced at 100%, and idle", () => {
    const draft = makeDraft({ is_dirty: true });
    const readiness = evaluatePushReadiness({
      draft,
      busy: false,
      pushing: false,
      recoveryRequired: false,
      latestPublicationStatus: "succeeded",
    });
    assert.equal(readiness.canPush, true);
    assert.equal(readiness.reason, null);
  });

  it("blocks push when draft is clean, stale, unbalanced, or recovery-locked", () => {
    assert.equal(
      evaluatePushReadiness({
        draft: makeDraft({ is_dirty: false }),
        busy: false,
        pushing: false,
        recoveryRequired: false,
        latestPublicationStatus: null,
      }).canPush,
      false,
    );

    assert.equal(
      evaluatePushReadiness({
        draft: makeDraft({ is_dirty: true, is_stale: true }),
        busy: false,
        pushing: false,
        recoveryRequired: false,
        latestPublicationStatus: null,
      }).canPush,
      false,
    );

    assert.equal(
      evaluatePushReadiness({
        draft: makeDraft({
          is_dirty: true,
          offers: [
            {
              offer_id: 7,
              lifecycle: "ACTIVE",
              is_pinned: true,
              share: 40,
              state: "active",
              position: 0,
            },
          ],
        }),
        busy: false,
        pushing: false,
        recoveryRequired: false,
        latestPublicationStatus: null,
      }).canPush,
      false,
    );

    assert.equal(
      evaluatePushReadiness({
        draft: makeDraft({ is_dirty: true }),
        busy: false,
        pushing: false,
        recoveryRequired: true,
        latestPublicationStatus: null,
      }).canPush,
      false,
    );

    assert.equal(
      evaluatePushReadiness({
        draft: makeDraft({ is_dirty: true }),
        busy: false,
        pushing: false,
        recoveryRequired: false,
        latestPublicationStatus: "pending",
      }).canPush,
      false,
    );
  });
});

describe("resolveEffectiveOffersSource", () => {
  it("builds a clean baseline preview from committed state when draft is null", () => {
    const committed: CommittedStateResponse = {
      stream_ref: 1334454,
      bindings: [
        {
          offer_id: 18813,
          lifecycle: "ACTIVE",
          is_pinned: false,
          last_remote_share: 100,
        },
      ],
      snapshot: {
        offers: [{ offer_id: 18813, share: 100, state: "active", position: 0 }],
        captured_at: "2026-11-21T01:00:00Z",
      },
    };
    const resolved = resolveEffectiveOffersSource(null, committed);
    assert.ok(resolved);
    assert.equal(resolved.version, 0);
    assert.equal(resolved.is_dirty, false);
    assert.equal(resolved.offers.length, 1);
    assert.equal(resolved.offers[0]?.offer_id, 18813);
    assert.equal(resolved.offers[0]?.share, 100);
  });
});

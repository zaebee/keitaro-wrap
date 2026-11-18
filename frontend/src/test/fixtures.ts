import { HttpResponse } from "msw";

import type { CampaignIntent } from "../api/operations";

export const OPERATION_UUID = "3f1a3a24-1c0d-4c1a-9c1b-6a1d7e6ef8aa";
export const OTHER_OPERATION_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const INTENT: CampaignIntent = {
  name: "Campaign",
  country_code: "US",
  offer_id: 7,
};

export function operationFixture(
  status: string,
  operationUuid = OPERATION_UUID,
) {
  return {
    operation_uuid: operationUuid,
    alias: "slug-abcdef12",
    status,
    campaign_id: status === "created" ? 42 : null,
    country_flow_id: null,
    offer_flow_id: null,
    error_message: null,
  };
}

export function streamFixture(
  overrides: Partial<{
    stream_ref: number;
    campaign_id: number;
    type: string;
    name: string;
    schema: string;
    comments: string | null;
  }> = {},
) {
  return {
    stream_ref: 101,
    campaign_id: 42,
    type: "regular",
    name: "Main stream",
    schema: "landings",
    comments: null,
    ...overrides,
  };
}

export function fetchOutcomeFixture(
  overrides: Partial<{
    campaign_id: number;
    stream_count: number;
    reconciled_stream_count: number;
    created_bindings: number;
    archived_bindings: number;
    reactivated_bindings: number;
    share_updates: number;
    conflicted_drafts: number;
  }> = {},
) {
  return {
    campaign_id: 42,
    stream_count: 1,
    reconciled_stream_count: 1,
    created_bindings: 2,
    archived_bindings: 0,
    reactivated_bindings: 1,
    share_updates: 3,
    conflicted_drafts: 1,
    ...overrides,
  };
}

export const REMOTE_OFFERS = [
  { offer_id: 7, share: 60, state: "active", position: 0 },
  { offer_id: 8, share: 40, state: "active", position: 1 },
];

export function committedFixture(
  overrides: Partial<{
    stream_ref: number;
    bindings: {
      offer_id: number;
      lifecycle: string;
      is_pinned: boolean;
      last_remote_share: number | null;
    }[];
    snapshot: {
      offers: typeof REMOTE_OFFERS;
      captured_at: string;
    } | null;
  }> = {},
) {
  return {
    stream_ref: 101,
    bindings: [
      {
        offer_id: 7,
        lifecycle: "ACTIVE",
        is_pinned: true,
        last_remote_share: 60,
      },
      {
        offer_id: 8,
        lifecycle: "ACTIVE",
        is_pinned: false,
        last_remote_share: 40,
      },
    ],
    snapshot: { offers: REMOTE_OFFERS, captured_at: "2026-11-18T04:00:00" },
    ...overrides,
  };
}

export function draftViewFixture(
  overrides: Partial<{
    stream_ref: number;
    offers: {
      offer_id: number;
      lifecycle: string;
      is_pinned: boolean;
      share: number;
      state: string | null;
      position: number;
    }[];
    baseline_offers: typeof REMOTE_OFFERS;
    staged_changes: Record<string, unknown>;
    version: number;
    is_dirty: boolean;
    is_stale: boolean;
    conflicts: ReturnType<typeof conflictFixture>[];
    policy_cases: string[];
    unallocated: number;
  }> = {},
) {
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
    baseline_offers: REMOTE_OFFERS,
    staged_changes: {},
    version: 1,
    is_dirty: false,
    is_stale: false,
    conflicts: [],
    policy_cases: [],
    unallocated: 0,
    ...overrides,
  };
}

export function conflictFixture(
  overrides: Partial<{
    stream_ref: number;
    offer_id: number;
    field: string;
    expected: number | null;
    observed: number | null;
    reason: string;
  }> = {},
) {
  return {
    stream_ref: 101,
    offer_id: 7,
    field: "share",
    expected: 60,
    observed: 55,
    reason: "remote share changed",
    ...overrides,
  };
}

export function draftStateFixture(draft: ReturnType<typeof draftViewFixture> | null = draftViewFixture()) {
  return { stream_ref: 101, draft };
}

export function commandResultFixture(
  view: ReturnType<typeof draftViewFixture>,
  overrides: Partial<{ created: boolean; noop: boolean }> = {},
) {
  return { view, created: false, noop: false, ...overrides };
}

export function errorResponse(code: string, status: number, details = {}) {
  return HttpResponse.json(
    { error: { code, message: code, details } },
    { status },
  );
}

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

export function errorResponse(code: string, status: number, details = {}) {
  return HttpResponse.json(
    { error: { code, message: code, details } },
    { status },
  );
}

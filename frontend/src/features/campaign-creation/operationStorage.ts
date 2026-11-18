import type { CampaignIntent } from "../../api/operations";

export const OPERATION_KEY = "s8a.creation.operationUuid";
export const INTENT_KEY = "s8a.creation.intent";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_PATH = /^\/campaign-creations\/([^/]+)\/?$/;

export function isUuidV4(value: string | null): value is string {
  return Boolean(value && UUID_V4.exec(value));
}

export function readUrlOperationId(pathname = window.location.pathname): string | null {
  const match = OPERATION_PATH.exec(pathname);
  const candidate = match?.[1] ?? null;
  return isUuidV4(candidate) ? candidate : null;
}

export function readStoredOperationId(): string | null {
  const candidate = window.sessionStorage.getItem(OPERATION_KEY);
  return isUuidV4(candidate) ? candidate : null;
}

type StoredIntent = { operationUuid: string; intent: CampaignIntent };

function isCampaignIntent(value: unknown): value is CampaignIntent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.country_code === "string" &&
    typeof candidate.offer_id === "number" &&
    Number.isInteger(candidate.offer_id)
  );
}

export function readStoredIntent(operationUuid: string | null): CampaignIntent | null {
  const raw = window.sessionStorage.getItem(INTENT_KEY);
  if (!raw || !operationUuid) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const stored = parsed as Partial<StoredIntent>;
    if (stored.operationUuid !== operationUuid || !isCampaignIntent(stored.intent)) {
      return null;
    }
    return stored.intent;
  } catch {
    return null;
  }
}

export function storeAttempt(operationUuid: string, intent?: CampaignIntent): void {
  window.sessionStorage.setItem(OPERATION_KEY, operationUuid);
  if (intent) {
    const stored: StoredIntent = { operationUuid, intent };
    window.sessionStorage.setItem(INTENT_KEY, JSON.stringify(stored));
  }
}

export function clearAttempt(): void {
  window.sessionStorage.removeItem(OPERATION_KEY);
  window.sessionStorage.removeItem(INTENT_KEY);
}

export type ResolvedAttempt = {
  operationUuid: string | null;
  source: "url" | "storage" | null;
  mismatch: boolean;
  intent: CampaignIntent | null;
};

export function resolveAttempt(pathname = window.location.pathname): ResolvedAttempt {
  const fromUrl = readUrlOperationId(pathname);
  const fromStorage = readStoredOperationId();
  const operationUuid = fromUrl ?? fromStorage;
  let source: ResolvedAttempt["source"] = null;
  if (fromUrl) {
    source = "url";
  } else if (fromStorage) {
    source = "storage";
  }
  return {
    operationUuid,
    source,
    mismatch: Boolean(fromUrl && fromStorage && fromUrl !== fromStorage),
    intent: readStoredIntent(operationUuid),
  };
}

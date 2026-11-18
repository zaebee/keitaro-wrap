import type { DraftViewResponse } from "../../api/operations";

type NumberList = number[];
type BooleanMap = [number, boolean][];
type ShareMap = [number, number][];

export type DraftChanges = {
  additions: NumberList;
  archives: NumberList;
  restores: NumberList;
  pinToggles: BooleanMap;
  shareEdits: ShareMap;
};

function numberList(value: unknown): NumberList {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is number => typeof item === "number" && Number.isSafeInteger(item),
  );
}

function booleanMap(value: unknown): BooleanMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => {
    const offerId = Number(key);
    return typeof item === "boolean" && Number.isSafeInteger(offerId)
      ? [[offerId, item] as [number, boolean]]
      : [];
  });
}

function shareMap(value: unknown): ShareMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => {
    const offerId = Number(key);
    return (
      typeof item === "number" && Number.isSafeInteger(offerId) && Number.isSafeInteger(item)
        ? [[offerId, item] as [number, number]]
        : []
    );
  });
}

/** Project the backend-owned staged intent without recalculating any domain state. */
export function draftChanges(draft: DraftViewResponse | null): DraftChanges {
  const staged = draft?.staged_changes ?? {};
  return {
    additions: numberList(staged.additions),
    archives: numberList(staged.archives),
    restores: numberList(staged.restores),
    pinToggles: booleanMap(staged.pin_toggles),
    shareEdits: shareMap(staged.share_edits),
  };
}

export function hasDraftChanges(changes: DraftChanges): boolean {
  return Boolean(
    changes.additions.length ||
      changes.archives.length ||
      changes.restores.length ||
      changes.pinToggles.length ||
      changes.shareEdits.length,
  );
}

import type {
  CommittedStateResponse,
  DraftViewResponse,
  StagedOfferResponse,
} from "../../api/generated/openapi";

export type AllocationSegment = {
  offerId: number;
  share: number;
  baselineShare: number | null;
  changed: boolean;
  pinned: boolean;
  color: string;
};

export type AllocationSummaryModel = {
  segments: AllocationSegment[];
  allocatedPercent: number;
  unallocatedPercent: number;
  isBalanced: boolean;
};

export type DraftChangeSummary = {
  totalChanges: number;
  archivedCount: number;
  changesLabel: string;
  archivedLabel: string;
};

export type PushReadiness = {
  canPush: boolean;
  reason: string | null;
};

const SEGMENT_COLORS = [
  "#2563eb", // bright blue
  "#10b981", // emerald green
  "#f59e0b", // amber orange
  "#6366f1", // indigo
  "#ec4899", // rose
  "#06b6d4", // cyan
] as const;

export function resolveEffectiveOffersSource(
  draft: DraftViewResponse | null,
  committed: CommittedStateResponse | null | undefined,
): DraftViewResponse | null {
  if (draft !== null) {
    return draft;
  }
  const snapshotOffers = committed?.snapshot?.offers ?? [];
  if (!committed || snapshotOffers.length === 0) {
    return null;
  }
  const bindingMap = new Map(
    committed.bindings.map((binding) => [binding.offer_id, binding]),
  );
  const offers: StagedOfferResponse[] = snapshotOffers.map((offer) => {
    const binding = bindingMap.get(offer.offer_id);
    return {
      offer_id: offer.offer_id,
      lifecycle: binding?.lifecycle ?? "ACTIVE",
      is_pinned: binding?.is_pinned ?? false,
      share: offer.share,
      state: offer.state ?? null,
      position: offer.position,
    };
  });
  const activeSum = offers
    .filter((offer) => offer.lifecycle === "ACTIVE")
    .reduce((acc, offer) => acc + offer.share, 0);

  return {
    stream_ref: committed.stream_ref,
    offers,
    baseline_offers: snapshotOffers,
    staged_changes: {},
    version: 0,
    is_dirty: false,
    is_stale: false,
    conflicts: [],
    policy_cases: [],
    unallocated: Math.max(0, 100 - activeSum),
    conflicts_fingerprint: "baseline",
  };
}

export function buildAllocationSummary(
  draft: DraftViewResponse | null,
): AllocationSummaryModel {
  if (!draft) {
    return {
      segments: [],
      allocatedPercent: 0,
      unallocatedPercent: 100,
      isBalanced: false,
    };
  }

  const baselineMap = new Map(
    draft.baseline_offers.map((offer) => [offer.offer_id, offer.share]),
  );
  const active = draft.offers.filter((offer) => offer.lifecycle === "ACTIVE");
  const segments: AllocationSegment[] = active.map((offer, idx) => {
    const baselineShare = baselineMap.get(offer.offer_id) ?? null;
    return {
      offerId: offer.offer_id,
      share: offer.share,
      baselineShare,
      changed: baselineShare !== null && baselineShare !== offer.share,
      pinned: offer.is_pinned,
      color: SEGMENT_COLORS[idx % SEGMENT_COLORS.length],
    };
  });

  const allocatedPercent = active.reduce((sum, offer) => sum + offer.share, 0);
  const unallocatedPercent = Math.max(0, 100 - allocatedPercent);

  return {
    segments,
    allocatedPercent,
    unallocatedPercent,
    isBalanced: allocatedPercent === 100 && active.length > 0,
  };
}

export function summarizeDraftChanges(
  draft: DraftViewResponse | null,
): DraftChangeSummary {
  const staged = (draft?.staged_changes ?? {}) as {
    additions?: number[];
    archives?: number[];
    restores?: number[];
    pin_toggles?: Record<string, boolean>;
    share_edits?: Record<string, number>;
  };
  const totalChanges =
    (Array.isArray(staged.additions) ? staged.additions.length : 0) +
    (Array.isArray(staged.archives) ? staged.archives.length : 0) +
    (Array.isArray(staged.restores) ? staged.restores.length : 0) +
    Object.keys(staged.pin_toggles ?? {}).length +
    Object.keys(staged.share_edits ?? {}).length;

  const archivedCount =
    draft?.offers.filter((offer) => offer.lifecycle === "ARCHIVED").length ?? 0;

  return {
    totalChanges,
    archivedCount,
    changesLabel: `${totalChanges} ${totalChanges === 1 ? "staged change" : "staged changes"}`,
    archivedLabel: `${archivedCount} ${archivedCount === 1 ? "offer archived" : "offers archived"}`,
  };
}

export function evaluatePushReadiness(params: {
  draft: DraftViewResponse | null;
  busy: boolean;
  pushing: boolean;
  recoveryRequired: boolean;
  latestPublicationStatus: string | null;
}): PushReadiness {
  const { draft, busy, pushing, recoveryRequired, latestPublicationStatus } = params;
  if (pushing) {
    return { canPush: false, reason: "Publishing stream changes to Keitaro…" };
  }
  if (recoveryRequired) {
    return {
      canPush: false,
      reason: "Resolve draft recovery lock before pushing.",
    };
  }
  if (busy) {
    return {
      canPush: false,
      reason: "Wait for active draft command to finish before pushing.",
    };
  }
  if (
    latestPublicationStatus === "pending" ||
    latestPublicationStatus === "in_progress" ||
    latestPublicationStatus === "ambiguous"
  ) {
    return {
      canPush: false,
      reason: "Resolve or cancel the active publication before pushing.",
    };
  }
  if (!draft || !draft.is_dirty) {
    return {
      canPush: false,
      reason: "Stage at least one draft change before pushing to Keitaro.",
    };
  }
  if (draft.is_stale || draft.conflicts.length > 0) {
    return {
      canPush: false,
      reason: "Resolve stale Fetch conflicts before pushing to Keitaro.",
    };
  }
  const active = draft.offers.filter((offer) => offer.lifecycle === "ACTIVE");
  if (active.length === 0) {
    return {
      canPush: false,
      reason: "At least one active offer is required before pushing.",
    };
  }
  const sum = active.reduce((acc, offer) => acc + offer.share, 0);
  if (sum !== 100) {
    return {
      canPush: false,
      reason: `Active offer shares must sum to 100% (currently ${sum}%).`,
    };
  }
  return { canPush: true, reason: null };
}

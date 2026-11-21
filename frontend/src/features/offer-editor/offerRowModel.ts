export type ShareEditState = Readonly<{
  currentPercentLabel: string;
  baselinePercentLabel: string | null;
  shareModified: boolean;
  hasPendingInput: boolean;
  inputDiffersFromCurrent: boolean;
  submitTitle: string;
}>;

export function describeShareEditState(params: Readonly<{
  offerShare: number;
  baselineShare?: number;
  draftInput: string;
}>): ShareEditState {
  const { offerShare, baselineShare, draftInput } = params;
  const shareModified =
    baselineShare !== undefined && baselineShare !== offerShare;
  const trimmed = draftInput.trim();
  const hasPendingInput = trimmed.length > 0;
  const parsed = hasPendingInput ? Number(trimmed) : Number.NaN;
  const inputDiffersFromCurrent =
    hasPendingInput && (!Number.isFinite(parsed) || parsed !== offerShare);

  return {
    currentPercentLabel: `${offerShare}%`,
    baselinePercentLabel: shareModified ? `${baselineShare}%` : null,
    shareModified,
    hasPendingInput,
    inputDiffersFromCurrent,
    submitTitle: inputDiffersFromCurrent
      ? `Apply ${trimmed}% share (Enter)`
      : "Enter a new share percentage, then press Enter or click Set share",
  };
}

export type OfferStatusPresentation = Readonly<{
  primaryLabel: "Active" | "Archived";
  remoteBadgeLabel: string | null;
}>;

export function describeOfferStatus(params: Readonly<{
  lifecycle: string;
  remoteState: string | null | undefined;
}>): OfferStatusPresentation {
  const primaryLabel = params.lifecycle === "ACTIVE" ? "Active" : "Archived";
  const normalizedRemote = params.remoteState?.trim();
  const remoteBadgeLabel =
    normalizedRemote && normalizedRemote.toLowerCase() !== "active"
      ? `Keitaro: ${normalizedRemote}`
      : null;

  return {
    primaryLabel,
    remoteBadgeLabel,
  };
}

export type TriggerRect = Readonly<{
  top: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}>;

export type ViewportSize = Readonly<{
  width: number;
  height: number;
}>;

export type ActionMenuPlacement =
  | Readonly<{
      mode: "absolute";
    }>
  | Readonly<{
      mode: "fixed";
      direction: "down" | "up";
      top?: number;
      bottom?: number;
      right: number;
    }>;

export function computeActionMenuPlacement(
  triggerRect: TriggerRect | null,
  viewport: ViewportSize,
  menuHeightEstimate = 104,
): ActionMenuPlacement {
  if (!triggerRect || triggerRect.width <= 0 || triggerRect.height <= 0) {
    return { mode: "absolute" };
  }

  const gap = 6;
  const minEdge = 8;
  const right = Math.max(minEdge, viewport.width - triggerRect.right);
  const spaceBelow = viewport.height - triggerRect.bottom - gap;
  const spaceAbove = triggerRect.top - gap;

  if (spaceBelow < menuHeightEstimate && spaceAbove > spaceBelow) {
    return {
      mode: "fixed",
      direction: "up",
      bottom: Math.max(minEdge, viewport.height - triggerRect.top + gap),
      right,
    };
  }

  return {
    mode: "fixed",
    direction: "down",
    top: Math.max(minEdge, triggerRect.bottom + gap),
    right,
  };
}

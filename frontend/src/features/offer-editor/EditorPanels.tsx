import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";

import type {
  CommittedStateResponse,
  ConflictDetailResponse,
  DraftViewResponse,
  StagedOfferResponse,
} from "../../api/operations";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import {
  buildAllocationSummary,
  resolveEffectiveOffersSource,
  summarizeDraftChanges,
} from "./allocationSummary";
import { draftChanges, hasDraftChanges } from "./draftChanges";
import {
  computeActionMenuPlacement,
  describeOfferStatus,
  describeShareEditState,
  type ActionMenuPlacement,
} from "./offerRowModel";
import { failureMessage, hintFor, type Failure } from "./useStreamDraft";
import styles from "./OfferEditorPage.module.css";

export type DraftActionRequest =
  | { kind: "add"; offerId: number }
  | { kind: "remove"; offerId: number }
  | { kind: "restore"; offerId: number }
  | { kind: "pin"; offerId: number }
  | { kind: "unpin"; offerId: number }
  | { kind: "share"; offerId: number; share: number }
  | { kind: "cancel" };

export function ReadErrorPanel({
  heading,
  message,
  code,
  retryLabel,
  onRetry,
  retryDisabled,
}: Readonly<{
  heading: string;
  message: string;
  code: string | null;
  retryLabel: string;
  onRetry: () => void;
  retryDisabled: boolean;
}>) {
  return (
    <ErrorSummary
      heading={heading}
      message={message}
      code={code}
      retryLabel={retryLabel}
      onRetry={onRetry}
      retryDisabled={retryDisabled}
    />
  );
}

export function StreamSyncBadge({
  draft,
  baselineReady = false,
}: Readonly<{ draft: DraftViewResponse | null; baselineReady?: boolean }>) {
  let tone = styles.syncMuted;
  let label = "No draft";
  if (draft !== null) {
    const drifted = draft.is_stale || draft.conflicts.length > 0;
    tone = drifted ? styles.syncWarn : styles.syncGood;
    label = drifted ? "Drift detected" : "✓ Synced";
  } else if (baselineReady) {
    tone = styles.syncGood;
    label = "✓ Synced";
  }
  return <span className={`${styles.syncBadge} ${tone}`}>{label}</span>;
}

export function LastFetchMeta({
  capturedAt,
}: Readonly<{ capturedAt: string | null }>) {
  return (
    <span className={styles.lastFetch}>
      <span className={styles.lastFetchLabel}>Last fetch</span>
      <span className={`${styles.lastFetchValue} tnum`}>
        {capturedAt ? new Date(capturedAt).toLocaleString() : "not available"}
      </span>
    </span>
  );
}

export function DraftCommandFeedback({
  busy,
  announcement,
  statusRef,
  isError,
  recoveryRequired,
  failure,
  staleConflicts,
  onRetry,
  retryDisabled,
}: Readonly<{
  busy: boolean;
  announcement: string | null;
  statusRef: RefObject<HTMLParagraphElement>;
  isError: boolean;
  recoveryRequired: boolean;
  failure: Failure;
  staleConflicts: ConflictDetailResponse[];
  onRetry: () => void;
  retryDisabled: boolean;
}>) {
  return (
    <>
      {busy && (
        <output className={styles.pending}>
          Saving local draft… Duplicate submissions are disabled.
        </output>
      )}
      {announcement && (
        <p
          ref={statusRef}
          className={styles.pending}
          role="status"
          aria-live="polite"
          tabIndex={-1}
        >
          {announcement}
        </p>
      )}
      {isError && (
        <ErrorSummary
          heading={
            recoveryRequired
              ? "Recovery required — draft commands locked"
              : "Draft command failed"
          }
          message={failureMessage(failure)}
          code={failure.code}
          detail={
            <>
              <p className={styles.hint}>{hintFor(failure)}</p>
              {recoveryRequired && (
                <p className={styles.hint}>
                  The lock is released only by a successful GET re-read. A failed
                  re-read keeps every draft command disabled.
                </p>
              )}
              {staleConflicts.length > 0 && (
                <ConflictPanel conflicts={staleConflicts} />
              )}
            </>
          }
          retryLabel="Read current draft"
          onRetry={onRetry}
          retryDisabled={retryDisabled}
        />
      )}
    </>
  );
}

export function CommittedPanel({
  state,
}: Readonly<{ state: CommittedStateResponse }>) {
  const snapshot = state.snapshot;
  return (
    <section
      aria-labelledby="committed-heading"
      className={`${styles.panel} ${styles.committed}`}
    >
      <h2 id="committed-heading">
        Committed baseline <span className={styles.tag}>read-only</span>
      </h2>
      <p className={styles.hint}>
        Durable wrapper bindings and the last backend-cached remote observation.
        Draft commands do not change this panel.
      </p>

      {snapshot === null ? (
        <p className={styles.empty}>
          Fetch required: no remote snapshot is cached for this stream.
        </p>
      ) : (
        <div>
          <h3>Remote snapshot</h3>
          <p className={styles.hint}>Captured at: {snapshot.captured_at}</p>
          {snapshot.offers.length === 0 ? (
            <p className={styles.empty}>
              Fetch required: the cached snapshot has no offers to baseline a
              new draft.
            </p>
          ) : (
            <ul className={styles.offerList}>
              {snapshot.offers.map((offer) => (
                <li key={offer.offer_id}>
                  Offer #{offer.offer_id} · share {offer.share} · state{" "}
                  {offer.state ?? "not provided"} · position {offer.position}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <h3>Bindings</h3>
      {state.bindings.length === 0 ? (
        <p className={styles.empty}>No committed bindings for this stream.</p>
      ) : (
        <ul className={styles.offerList}>
          {state.bindings.map((binding) => (
            <li key={binding.offer_id}>
              Offer #{binding.offer_id} · {binding.lifecycle} ·{" "}
              {binding.is_pinned ? "pinned" : "not pinned"} · last remote share{" "}
              {binding.last_remote_share ?? "not available"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function staleCheckLabel(draft: DraftViewResponse | null): string {
  if (draft === null) {
    return "No draft";
  }
  return draft.is_stale ? "Drift detected" : "Clean (No Drift)";
}

export function PolicyCard({
  draft,
}: Readonly<{ draft: DraftViewResponse | null }>) {
  const conflictCount = draft?.conflicts.length ?? 0;
  const fingerprint = draft?.conflicts_fingerprint ?? "";
  return (
    <div className={styles.policyCard}>
      <span className={styles.policyHeading}>Policy &amp; Validation</span>
      <div className={styles.policyRow}>
        <span className={styles.policyLabel}>Stale check:</span>
        <span
          className={`${styles.policyValue} ${
            draft?.is_stale ? styles.policyWarn : styles.policyGood
          }`}
        >
          {staleCheckLabel(draft)}
        </span>
      </div>
      <div className={styles.policyRow}>
        <span className={styles.policyLabel}>Conflict risk:</span>
        <span className={styles.policyValue}>
          {conflictCount > 0 ? `${conflictCount} conflict(s)` : "None detected"}
        </span>
      </div>
      <div className={styles.policyRow}>
        <span className={styles.policyLabel}>Checksum:</span>
        <span className={styles.policyChecksum}>
          {draft === null
            ? "not available"
            : `fingerprint: ${fingerprint.slice(0, 8)}…`}
        </span>
      </div>
    </div>
  );
}

export function AllocationSummary({
  draft,
  committed,
}: Readonly<{
  draft: DraftViewResponse | null;
  committed?: CommittedStateResponse | null;
}>) {
  const effectiveSource = resolveEffectiveOffersSource(draft, committed);
  const summary = buildAllocationSummary(effectiveSource);
  if (summary.segments.length === 0) {
    return null;
  }
  const changeSummary = summarizeDraftChanges(draft);

  return (
    <section
      aria-labelledby="allocation-summary-heading"
      className={styles.allocationBlock}
    >
      <div className={styles.allocationHeader}>
        <h2 id="allocation-summary-heading">
          Traffic allocation{" "}
          <span className={styles.allocationSubtitle}>
            ({draft?.is_dirty ? "Staged distribution" : "Committed distribution"})
          </span>
        </h2>
        <div className={`${styles.allocationTotal} tnum`}>
          <span className={styles.allocationTotalValue}>
            {summary.allocatedPercent}%
          </span>
          <span className={styles.allocationTotalDivider}>/ 100%</span>
          {!summary.isBalanced && (
            <span className={`${styles.balanceBadge} ${styles.balanceUnbalanced}`}>
              Unallocated: {summary.unallocatedPercent}%
            </span>
          )}
        </div>
      </div>
      <div
        className={styles.allocationBar}
        role="img"
        aria-label={`Traffic allocation across ${summary.segments.length} offers: ${summary.allocatedPercent}% allocated`}
      >
        {summary.segments.map((segment) => (
          <div
            key={segment.offerId}
            className={styles.allocationSegment}
            style={{
              width: `${segment.share}%`,
              background: segment.color,
            }}
            title={`Offer #${segment.offerId}: ${segment.share}%`}
          />
        ))}
      </div>
      <div className={styles.allocationLegend}>
        <div className={styles.legendItems}>
          {summary.segments.map((segment) => (
            <div key={segment.offerId} className={styles.legendItem}>
              <span
                className={styles.legendDot}
                style={{ background: segment.color }}
              />
              <span className={styles.legendName}>
                Offer #{segment.offerId} —
              </span>
              <span className={`${styles.legendShare} tnum`}>
                {segment.changed && segment.baselineShare !== null
                  ? `${segment.baselineShare}% → ${segment.share}%`
                  : `${segment.share}%`}
              </span>
            </div>
          ))}
        </div>
        {summary.unallocatedPercent > 0 && (
          <div className={styles.legendUnallocated}>
            Unallocated: <span>{summary.unallocatedPercent}%</span>
          </div>
        )}
      </div>
      {draft?.is_dirty && (
        <p className={styles.allocationHint}>
          {changeSummary.totalChanges} staged modification
          {changeSummary.totalChanges === 1 ? "" : "s"} awaiting commit.
        </p>
      )}
    </section>
  );
}

type DraftPanelProps = Readonly<{
  draft: DraftViewResponse | null;
  committed?: CommittedStateResponse | null;
  busy: boolean;
  recoveryRequired: boolean;
  baselineReady: boolean;
  workspacePath: string;
  newOfferId: string;
  addError: string | null;
  shareInputs: Record<number, string>;
  shareErrors: Record<number, string>;
  acceptingConflict: boolean;
  onNewOfferInput: (value: string) => void;
  onAction: (action: DraftActionRequest) => void;
  onShareInput: (offerId: number, value: string) => void;
  onShareSubmit: (offerId: number) => void;
  onAcceptRemote: () => void;
  onConfirmAcceptRemote: () => void;
  onKeepConflict: () => void;
}>;

export function DraftPanel({
  draft,
  committed,
  busy,
  recoveryRequired,
  baselineReady,
  workspacePath,
  newOfferId,
  addError,
  shareInputs,
  shareErrors,
  acceptingConflict,
  onNewOfferInput,
  onAction,
  onShareInput,
  onShareSubmit,
  onAcceptRemote,
  onConfirmAcceptRemote,
  onKeepConflict,
}: DraftPanelProps) {
  const blocked = draft?.is_stale === true || (draft?.conflicts.length ?? 0) > 0;
  const commandsDisabled = busy || recoveryRequired || blocked || !baselineReady;
  const effectiveOffersView = resolveEffectiveOffersSource(draft, committed);

  return (
    <section
      aria-labelledby="draft-heading"
      className={`${styles.panel} ${styles.draftPanel}`}
    >
      <div className={styles.draftHeadingRow}>
        <h2 id="draft-heading">
          Staged draft{" "}
          <span className={styles.tag}>
            {draft ? "local, unpublished" : "baseline preview · v0"}
          </span>
        </h2>
      </div>
      {draft === null && !effectiveOffersView && (
        <p className={styles.empty}>
          No local draft exists. The first staging command creates one from the
          committed baseline using version 0.
        </p>
      )}
      {draft !== null && (
        <dl className={styles.draftMeta}>
          <dt>Version</dt>
          <dd>{draft.version}</dd>
          <dt>State</dt>
          <dd>{draft.is_dirty ? "dirty" : "clean"}</dd>
          <dt>Stale</dt>
          <dd>{draft.is_stale ? "yes" : "no"}</dd>
          <dt>Unallocated</dt>
          <dd>{draft.unallocated}</dd>
          <dt>Policy cases</dt>
          <dd>
            {draft.policy_cases.length > 0
              ? draft.policy_cases.join(", ")
              : "none"}
          </dd>
        </dl>
      )}

      {draft && (
        <ConflictPanel
          conflicts={draft.conflicts}
          acceptingConflict={acceptingConflict}
          onAcceptRemote={onAcceptRemote}
          onConfirmAcceptRemote={onConfirmAcceptRemote}
          onKeepConflict={onKeepConflict}
        />
      )}

      {!baselineReady && (
        <div className={styles.fetchRequired}>
          <h3>Fetch required</h3>
          <p>
            A suitable remote offer snapshot is not available. Draft editing is
            disabled until a non-empty snapshot exists. Return to the Campaign
            Workspace and run <strong>Fetch streams</strong> explicitly; this
            editor never fetches automatically.
          </p>
          <Link to={workspacePath}>Go to Campaign Workspace for Fetch</Link>
        </div>
      )}

      <div className={styles.offersHeader}>
        <h3>Offers</h3>
        <form
          className={styles.addForm}
          onSubmit={(event) => {
            event.preventDefault();
            onAction({ kind: "add", offerId: Number(newOfferId) });
          }}
          noValidate
        >
          <label className={styles.srOnly} htmlFor="add-offer-id">
            Add offer by ID
          </label>
          <input
            id="add-offer-id"
            type="text"
            inputMode="numeric"
            placeholder="Offer ID"
            value={newOfferId}
            onChange={(event) => onNewOfferInput(event.target.value)}
            aria-invalid={Boolean(addError)}
            aria-describedby={addError ? "add-offer-error" : undefined}
            disabled={commandsDisabled}
          />
          <button
            type="submit"
            className={styles.addOfferButton}
            disabled={commandsDisabled}
          >
            <span aria-hidden="true">+</span> Add offer
          </button>
          {addError && (
            <p className={styles.fieldError} id="add-offer-error">
              {addError}
            </p>
          )}
        </form>
      </div>

      {effectiveOffersView && (
        <div className={styles.offerGroups}>
          {(() => {
            const activeOffers = effectiveOffersView.offers.filter(
              (offer) => offer.lifecycle === "ACTIVE",
            );
            const archivedOffers = effectiveOffersView.offers.filter(
              (offer) => offer.lifecycle === "ARCHIVED",
            );
            const renderOfferTable = (offers: typeof activeOffers) => (
              <div className={styles.tableScroll} role="region" aria-label="Offers table" tabIndex={0}>
                <table className={styles.offerTable}>
                  <thead>
                    <tr>
                      <th scope="col">Offer</th>
                      <th scope="col">Share</th>
                      <th scope="col">Allocation</th>
                      <th scope="col">Status</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {offers.map((offer, idx) => (
                      <OfferRow
                        key={offer.offer_id}
                        offer={offer}
                        colorIndex={idx}
                        disabled={commandsDisabled}
                        baselineShare={effectiveOffersView.baseline_offers.find(
                          (baseline) => baseline.offer_id === offer.offer_id,
                        )?.share}
                        shareInput={shareInputs[offer.offer_id] ?? ""}
                        shareError={shareErrors[offer.offer_id]}
                        onAction={onAction}
                        onShareInput={onShareInput}
                        onShareSubmit={onShareSubmit}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            );
            return (
              <>
                <div>
                  {activeOffers.length === 0 ? (
                    <p className={styles.empty}>No active offers.</p>
                  ) : (
                    renderOfferTable(activeOffers)
                  )}
                </div>
                <div className={styles.archivedBlock}>
                  <h3 className={styles.srOnly}>Archived offers</h3>
                  {archivedOffers.length === 0 ? (
                    <p className={styles.archivedZeroHint}>
                      Archived offers (0)
                    </p>
                  ) : (
                    <details className={styles.archivedTray}>
                      <summary className={styles.archivedSummary}>
                        <ChevronDownIcon className={styles.archivedChevron} />
                        <span>
                          Archived offers in baseline{" "}
                          <span className={styles.archivedCount}>
                            {archivedOffers.length}
                          </span>
                        </span>
                        <span className={styles.archivedHint}>Click to expand</span>
                      </summary>
                      {renderOfferTable(archivedOffers)}
                    </details>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      )}
    </section>
  );
}

const THUMB_PALETTES = [
  ["#e0f2fe", "#0284c7", "#38bdf8"],
  ["#dcfce7", "#15803d", "#4ade80"],
  ["#fef3c7", "#b45309", "#fbbf24"],
  ["#ede9fe", "#6d28d9", "#a78bfa"],
  ["#fce7f3", "#be185d", "#f472b6"],
] as const;

function OfferThumbnail({ index }: Readonly<{ index: number }>) {
  const [bg, fg, accent] = THUMB_PALETTES[index % THUMB_PALETTES.length];
  return (
    <span className={styles.offerThumb} aria-hidden="true" style={{ background: bg }}>
      <svg fill="none" height="28" viewBox="0 0 42 28" width="42">
        <rect fill={bg} height="28" rx="6" width="42" />
        <circle cx="31" cy="9" fill={accent} opacity="0.7" r="4" />
        <path
          d="M2 24l11-10 7 6 7-5 13 9H2z"
          fill={fg}
          opacity="0.22"
        />
        <path
          d="M2 26l14-9 8 5 6-4 10 8H2z"
          fill={fg}
          opacity="0.38"
        />
      </svg>
    </span>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.modeIcon}
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <rect height="11" rx="2" width="18" x="3" y="11" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function AutoIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.modeIcon}
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M16 3h5v5" />
      <path d="M8 3H3v5" />
      <path d="M21 3l-7 7" />
      <path d="M3 3l7 7" />
      <path d="M16 21h5v-5" />
      <path d="M8 21H3v-5" />
      <path d="M21 21l-7-7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="15"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 24 24"
      width="15"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="16"
      viewBox="0 0 24 24"
      width="16"
    >
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  );
}

function ChevronDownIcon({ className }: Readonly<{ className?: string }>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height="15"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="15"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

type OfferRowProps = Readonly<{
  offer: StagedOfferResponse;
  colorIndex: number;
  disabled: boolean;
  baselineShare?: number;
  shareInput: string;
  shareError?: string;
  onAction: (action: DraftActionRequest) => void;
  onShareInput: (offerId: number, value: string) => void;
  onShareSubmit: (offerId: number) => void;
}>;

function OfferRow({
  offer,
  colorIndex,
  disabled,
  baselineShare,
  shareInput,
  shareError,
  onAction,
  onShareInput,
  onShareSubmit,
}: OfferRowProps) {
  const shareState = describeShareEditState({
    offerShare: offer.share,
    baselineShare,
    draftInput: shareInput,
  });
  const statusInfo = describeOfferStatus({
    lifecycle: offer.lifecycle,
    remoteState: offer.state,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<ActionMenuPlacement>({
    mode: "absolute",
  });
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const kebabButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = (restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) {
      kebabButtonRef.current?.focus();
    }
  };

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !menuContainerRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        kebabButtonRef.current?.focus();
      }
    };

    const handleViewportChange = () => {
      setMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [menuOpen]);

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = kebabButtonRef.current?.getBoundingClientRect() ?? null;
    setMenuPlacement(
      computeActionMenuPlacement(rect, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
    setMenuOpen(true);
  };

  const runAction = (kind: "remove" | "restore" | "pin" | "unpin") => {
    closeMenu(false);
    onAction({ kind, offerId: offer.offer_id });
  };

  const focusShareInput = () => {
    const el = document.getElementById(
      `share-${offer.offer_id}`,
    ) as HTMLInputElement | null;
    if (el) {
      el.focus();
      el.select();
    }
  };

  const floatingMenuStyle =
    menuPlacement.mode === "fixed"
      ? {
          position: "fixed" as const,
          top: menuPlacement.top,
          bottom: menuPlacement.bottom,
          right: menuPlacement.right,
          zIndex: 60,
        }
      : undefined;

  return (
    <tr className={offer.lifecycle === "ARCHIVED" ? styles.offerArchived : ""}>
      <th scope="row" className={styles.offerIdCell}>
        <OfferThumbnail index={colorIndex} />
        <div className={styles.offerIdentityText}>
          <span className={styles.offerTitleRow}>
            <span className={`${styles.offerIdValue} tnum`}>
              Offer #{offer.offer_id}
            </span>
            {shareState.shareModified && (
              <span
                className={styles.modifiedPill}
                title="Share modified in local draft"
              >
                <span className={styles.modifiedDot} aria-hidden="true" />
                Modified
              </span>
            )}
          </span>
        </div>
      </th>
      <td className={styles.offerShareCell}>
        <div className={styles.shareCellRow}>
          <span
            className={`${styles.shareBadgeText} tnum`}
            title={
              shareState.shareModified
                ? `Baseline: ${shareState.baselinePercentLabel} → Draft: ${shareState.currentPercentLabel}`
                : `Current share: ${shareState.currentPercentLabel}`
            }
          >
            {shareState.shareModified ? (
              <>
                <s>{baselineShare}</s>
                <span aria-hidden="true">%</span>{" "}
                <span className={styles.shareArrow}>→</span>{" "}
                <strong className={styles.shareCurrentValue}>
                  {offer.share}
                </strong>
                <span className={styles.shareCurrentUnit}>%</span>
              </>
            ) : (
              <>
                <strong className={styles.shareCurrentValue}>
                  {offer.share}
                </strong>
                <span className={styles.shareCurrentUnit}>%</span>
              </>
            )}
          </span>
          {offer.lifecycle === "ACTIVE" && (
            <form
              className={styles.shareForm}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                onShareSubmit(offer.offer_id);
              }}
            >
              <span
                className={`${styles.shareInputWrap} ${
                  shareState.inputDiffersFromCurrent
                    ? styles.shareInputWrapDirty
                    : ""
                }`}
              >
                <input
                  id={`share-${offer.offer_id}`}
                  type="text"
                  inputMode="numeric"
                  aria-label={`Share for offer ${offer.offer_id}, 0 to 100%`}
                  placeholder={String(offer.share)}
                  value={shareInput}
                  onChange={(event) =>
                    onShareInput(offer.offer_id, event.target.value)
                  }
                  aria-invalid={Boolean(shareError)}
                  aria-describedby={
                    shareError ? `share-${offer.offer_id}-error` : undefined
                  }
                  disabled={disabled}
                />
                <span aria-hidden="true" className={styles.shareSuffix}>
                  %
                </span>
              </span>
              <button
                type="submit"
                className={`${styles.setShareBtn} ${
                  shareState.inputDiffersFromCurrent
                    ? styles.setShareBtnReady
                    : ""
                }`}
                title={shareState.submitTitle}
                disabled={disabled}
              >
                Set share
              </button>
              {shareError && (
                <p
                  className={styles.fieldError}
                  id={`share-${offer.offer_id}-error`}
                >
                  {shareError}
                </p>
              )}
            </form>
          )}
        </div>
      </td>
      <td>
        {offer.lifecycle === "ACTIVE" ? (
          <button
            type="button"
            className={`${styles.allocationModeBtn} ${
              offer.is_pinned ? styles.allocationPinned : styles.allocationAuto
            }`}
            aria-pressed={offer.is_pinned}
            disabled={disabled}
            onClick={() =>
              onAction({
                kind: offer.is_pinned ? "unpin" : "pin",
                offerId: offer.offer_id,
              })
            }
            title={
              offer.is_pinned
                ? `Pinned at ${offer.share}% — click to unlock for automatic balancing`
                : `Auto-balanced (${offer.share}%) — click to pin share`
            }
          >
            {offer.is_pinned ? <LockIcon /> : <AutoIcon />}
            <span>{offer.is_pinned ? "Pinned" : "Auto"}</span>
          </button>
        ) : (
          <span className={`${styles.allocationMode} ${styles.allocationAuto}`}>
            {offer.is_pinned ? <LockIcon /> : <AutoIcon />}
            <span>{offer.is_pinned ? "Pinned" : "Auto"}</span>
          </span>
        )}
      </td>
      <td>
        <span className={styles.offerStatusCell}>
          <span
            className={`${styles.statusDot} ${
              offer.lifecycle === "ACTIVE"
                ? styles.statusDotActive
                : styles.statusDotArchived
            }`}
            aria-hidden="true"
          />
          <span className={styles.statusPrimaryText}>
            {statusInfo.primaryLabel}
          </span>
          {statusInfo.remoteBadgeLabel && (
            <span className={styles.offerRemoteBadge}>
              {statusInfo.remoteBadgeLabel}
            </span>
          )}
        </span>
      </td>
      <td>
        <div className={styles.inlineActions} ref={menuContainerRef}>
          {offer.lifecycle === "ACTIVE" && (
            <button
              type="button"
              className={styles.iconActionBtn}
              disabled={disabled}
              aria-label={`Edit share for offer ${offer.offer_id}`}
              onClick={focusShareInput}
              title="Focus share input"
            >
              <PencilIcon />
            </button>
          )}
          <button
            ref={kebabButtonRef}
            type="button"
            className={styles.kebabButton}
            disabled={disabled}
            aria-label={`More actions for offer ${offer.offer_id}`}
            aria-expanded={menuOpen}
            aria-haspopup="true"
            onClick={toggleMenu}
            title="More actions"
          >
            <KebabIcon />
          </button>
          {menuOpen && (
            <div className={styles.actionMenu} style={floatingMenuStyle}>
              <button
                type="button"
                disabled={disabled}
                aria-label={`${offer.is_pinned ? "Unpin" : "Pin"} offer ${offer.offer_id}`}
                onClick={() => runAction(offer.is_pinned ? "unpin" : "pin")}
              >
                {offer.is_pinned ? "Unpin offer" : "Pin offer"}
              </button>
              <div className={styles.menuDivider} role="separator" />
              {offer.lifecycle === "ACTIVE" ? (
                <button
                  type="button"
                  className={styles.actionMenuDanger}
                  disabled={disabled}
                  aria-label={`Remove offer ${offer.offer_id}`}
                  title="Moves offer to Archived in local draft (does not delete in Keitaro yet)"
                  onClick={() => runAction("remove")}
                >
                  Remove offer
                </button>
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Restore offer ${offer.offer_id}`}
                  onClick={() => runAction("restore")}
                >
                  Restore offer
                </button>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

export function ConflictPanel({
  conflicts,
  acceptingConflict = false,
  onAcceptRemote,
  onConfirmAcceptRemote,
  onKeepConflict,
}: Readonly<{
  conflicts: ConflictDetailResponse[];
  acceptingConflict?: boolean;
  onAcceptRemote?: () => void;
  onConfirmAcceptRemote?: () => void;
  onKeepConflict?: () => void;
}>) {
  const acceptConfirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (acceptingConflict) {
      acceptConfirmRef.current?.focus();
    }
  }, [acceptingConflict]);

  if (conflicts.length === 0) {
    return null;
  }
  return (
    <div className={styles.conflictPanel} role="alert">
      <h3>Sticky Fetch conflicts</h3>
      <p>
        The backend blocks editing while these conflicts remain. Accept remote
        discards staged intent and adopts a fresh remote observation; local
        Cancel preserves the conflicts unchanged.
      </p>
      {onAcceptRemote !== undefined &&
        (acceptingConflict ? (
          <fieldset className={styles.confirm}>
            <legend>Confirm accept remote</legend>
            <p>
              Discard all staged changes for this stream and rebuild it from a
              fresh Keitaro read? No Keitaro mutation is sent.
            </p>
            <button
              type="button"
              ref={acceptConfirmRef}
              onClick={onConfirmAcceptRemote}
            >
              Confirm accept remote
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={onKeepConflict}
            >
              Keep conflict
            </button>
          </fieldset>
        ) : (
          <button
            type="button"
            className={styles.secondary}
            onClick={onAcceptRemote}
          >
            Accept remote
          </button>
        ))}
      <ul>
        {conflicts.map((conflict, index) => (
          <li key={`${conflict.offer_id}-${conflict.field}-${index}`}>
            Offer #{conflict.offer_id} · {conflict.field} · expected{" "}
            {conflict.expected ?? "not available"} · observed{" "}
            {conflict.observed ?? "not available"} · {conflict.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReviewPanel({
  draft,
}: Readonly<{ draft: DraftViewResponse | null }>) {
  const changes = draftChanges(draft);
  const baselineShares = new Map(
    (draft?.baseline_offers ?? []).map((offer) => [offer.offer_id, offer.share]),
  );

  return (
    <section
      id="staged-review-diff"
      aria-labelledby="review-heading"
      className={styles.panel}
    >
      <h2 id="review-heading">Review</h2>
      <dl className={styles.draftMeta}>
        <dt>Draft version</dt>
        <dd>{draft?.version ?? 0}</dd>
        <dt>Stale</dt>
        <dd>{draft?.is_stale ? "yes" : "no"}</dd>
        <dt>Conflicts</dt>
        <dd>{draft?.conflicts.length ?? 0}</dd>
      </dl>
      {draft === null || !hasDraftChanges(changes) ? (
        <p className={styles.empty}>No staged intent recorded by the backend.</p>
      ) : (
        <ul className={styles.reviewList}>
          {changes.additions.map((offerId) => (
            <li key={`add-${offerId}`}>Addition: Offer #{offerId}</li>
          ))}
          {changes.archives.map((offerId) => (
            <li key={`archive-${offerId}`}>Archive: Offer #{offerId}</li>
          ))}
          {changes.restores.map((offerId) => (
            <li key={`restore-${offerId}`}>Restore: Offer #{offerId}</li>
          ))}
          {changes.pinToggles.map(([offerId, pinned]) => (
            <li key={`pin-${offerId}`}>
              {pinned ? "Pin" : "Unpin"}: Offer #{offerId}
            </li>
          ))}
          {changes.shareEdits.map(([offerId, share]) => (
            <li key={`share-${offerId}`}>
              Requested share: Offer #{offerId} · baseline{" "}
              {baselineShares.get(offerId) ?? "not available"} → {share}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.hint}>
        This review projects backend-owned staged intent and baseline offers; it
        does not recalculate allocation or publication eligibility.
      </p>
    </section>
  );
}

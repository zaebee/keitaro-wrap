import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";

import type {
  CommittedStateResponse,
  ConflictDetailResponse,
  DraftViewResponse,
  StagedOfferResponse,
} from "../../api/operations";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import { draftChanges, hasDraftChanges } from "./draftChanges";
import { failureMessage, hintFor, type Failure } from "./useStreamDraft";

function stagedChangeCount(draft: DraftViewResponse | null): number {
  if (draft === null) {
    return 0;
  }
  const changes = draftChanges(draft);
  return (
    changes.additions.length +
    changes.archives.length +
    changes.restores.length +
    changes.pinToggles.length +
    changes.shareEdits.length
  );
}
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
}: Readonly<{ draft: DraftViewResponse | null }>) {
  const synced =
    draft !== null && !draft.is_stale && draft.conflicts.length === 0;
  const drifted =
    draft !== null && (draft.is_stale || draft.conflicts.length > 0);
  return (
    <span
      className={`${styles.syncBadge} ${
        synced
          ? styles.syncGood
          : drifted
            ? styles.syncWarn
            : styles.syncMuted
      }`}
    >
      {synced ? "✓ Synced" : drifted ? "Drift detected" : "No draft"}
    </span>
  );
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
        Committed baseline{" "}
        <span className={styles.tag}>read-only</span>
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

const SEGMENT_COLORS = ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

export function AllocationSummary({
  draft,
}: Readonly<{ draft: DraftViewResponse | null }>) {
  const baselineShares = new Map(
    (draft?.baseline_offers ?? []).map((offer) => [offer.offer_id, offer.share]),
  );
  const activeOffers =
    draft?.offers.filter((offer) => offer.lifecycle === "ACTIVE") ?? [];
  if (activeOffers.length === 0) {
    return null;
  }
  const stagedTotal = activeOffers.reduce((sum, offer) => sum + offer.share, 0);
  const modifiedCount = stagedChangeCount(draft);
  const unallocated = draft?.unallocated ?? 100 - stagedTotal;

  return (
    <section
      aria-labelledby="allocation-summary-heading"
      className={`${styles.panel} ${styles.allocationCard}`}
    >
      <div className={styles.allocationHeader}>
        <h2 id="allocation-summary-heading">
          Traffic allocation{" "}
          <span className={styles.allocationSubtitle}>
            ({draft?.is_dirty ? "Staged distribution" : "Committed distribution"})
          </span>
        </h2>
        <div className={`${styles.allocationTotal} tnum`}>
          <span className={styles.allocationTotalValue}>{stagedTotal}%</span>
          <span className={styles.allocationTotalDivider}>/ 100%</span>
          <span
            className={`${styles.balanceBadge} ${
              unallocated === 0 ? styles.balanceBalanced : styles.balanceUnbalanced
            }`}
          >
            {unallocated === 0 ? "Balanced" : `Unallocated: ${unallocated}%`}
          </span>
        </div>
      </div>
      <div
        className={styles.allocationBar}
        role="img"
        aria-label={`Traffic allocation across ${activeOffers.length} offers: ${stagedTotal}% allocated`}
      >
        {activeOffers.map((offer, index) => (
          <div
            key={offer.offer_id}
            className={styles.allocationSegment}
            style={{
              width: `${offer.share}%`,
              background: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
            }}
            title={`Offer #${offer.offer_id}: ${offer.share}%`}
          />
        ))}
      </div>
      <div className={styles.allocationLegend}>
        {activeOffers.map((offer, index) => {
          const baseline = baselineShares.get(offer.offer_id);
          return (
            <div key={offer.offer_id} className={styles.legendItem}>
              <span
                className={styles.legendDot}
                style={{
                  background: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
                }}
              />
              <span className={styles.legendName}>
                Offer #{offer.offer_id} —
              </span>
              <span className={`${styles.legendShare} tnum`}>
                {baseline !== undefined && baseline !== offer.share
                  ? `${baseline}% → ${offer.share}%`
                  : `${offer.share}%`}
              </span>
              <span
                className={`${styles.legendMode} ${
                  offer.is_pinned ? styles.legendPinned : styles.legendAuto
                }`}
              >
                {offer.is_pinned ? "Pinned" : "Auto"}
              </span>
            </div>
          );
        })}
        <div className={styles.legendUnallocated}>
          Unallocated:{" "}
          <span>{unallocated}%</span>
        </div>
      </div>
      {draft?.is_dirty && (
        <p className={styles.allocationHint}>
          {modifiedCount} staged modification
          {modifiedCount === 1 ? "" : "s"} awaiting commit.
        </p>
      )}
    </section>
  );
}

type DraftPanelProps = Readonly<{
  draft: DraftViewResponse | null;
  busy: boolean;
  recoveryRequired: boolean;
  baselineReady: boolean;
  workspacePath: string;
  newOfferId: string;
  addError: string | null;
  shareInputs: Record<number, string>;
  shareErrors: Record<number, string>;
  confirmingCancel: boolean;
  acceptingConflict: boolean;
  onNewOfferInput: (value: string) => void;
  onAction: (action: DraftActionRequest) => void;
  onShareInput: (offerId: number, value: string) => void;
  onShareSubmit: (offerId: number) => void;
  onConfirmCancel: () => void;
  onKeepDraft: () => void;
  onAcceptRemote: () => void;
  onConfirmAcceptRemote: () => void;
  onKeepConflict: () => void;
}>;

export function DraftPanel({
  draft,
  busy,
  recoveryRequired,
  baselineReady,
  workspacePath,
  newOfferId,
  addError,
  shareInputs,
  shareErrors,
  confirmingCancel,
  acceptingConflict,
  onNewOfferInput,
  onAction,
  onShareInput,
  onShareSubmit,
  onConfirmCancel,
  onKeepDraft,
  onAcceptRemote,
  onConfirmAcceptRemote,
  onKeepConflict,
}: DraftPanelProps) {
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingCancel) {
      cancelConfirmRef.current?.focus();
    }
  }, [confirmingCancel]);

  const blocked = draft?.is_stale === true || (draft?.conflicts.length ?? 0) > 0;
  const commandsDisabled = busy || recoveryRequired || blocked || !baselineReady;

  return (
    <section
      aria-labelledby="draft-heading"
      className={`${styles.panel} ${styles.draft}`}
    >
      <h2 id="draft-heading">
        Staged draft{" "}
        <span className={styles.tag}>local, unpublished</span>
      </h2>
      {draft === null ? (
        <p className={styles.empty}>
          No local draft exists. The first staging command creates one from the
          committed baseline using version 0.
        </p>
      ) : (
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
          <button type="submit" disabled={commandsDisabled}>
            <span aria-hidden="true">+</span> Add offer
          </button>
          {addError && (
            <p className={styles.fieldError} id="add-offer-error">
              {addError}
            </p>
          )}
        </form>
      </div>

      {draft && (
        <div className={styles.offerGroups}>
          {(() => {
            const activeOffers = draft.offers.filter(
              (offer) => offer.lifecycle === "ACTIVE",
            );
            const archivedOffers = draft.offers.filter(
              (offer) => offer.lifecycle === "ARCHIVED",
            );
            const renderOfferTable = (offers: typeof activeOffers) => (
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
                  {offers.map((offer) => (
                    <OfferRow
                      key={offer.offer_id}
                      offer={offer}
                      disabled={commandsDisabled}
                      baselineShare={draft.baseline_offers.find(
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
                <div>
                  <h3 className={styles.archivedHeading}>
                    Archived offers
                  </h3>
                  {archivedOffers.length === 0 ? (
                    <p className={styles.empty}>No archived offers.</p>
                  ) : (
                    <details className={styles.archivedTray}>
                      <summary className={styles.archivedSummary}>
                        <span>
                          Archived offers in baseline{" "}
                          <span className={styles.archivedCount}>
                            {archivedOffers.length}
                          </span>
                        </span>
                        <span className={styles.archivedHint}>
                          Click to expand
                        </span>
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

      <div className={styles.cancelArea}>
        {!confirmingCancel ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => onAction({ kind: "cancel" })}
            disabled={draft === null || busy || recoveryRequired}
          >
            Discard Draft
          </button>
        ) : (
          <fieldset className={styles.confirm}>
            <legend>Confirm local cancel</legend>
            <p>
              Discard local staged changes for this stream? Keitaro is not
              changed, and sticky conflict data is preserved.
            </p>
            <button
              type="button"
              ref={cancelConfirmRef}
              onClick={onConfirmCancel}
              disabled={busy || recoveryRequired}
            >
              Confirm local cancel
            </button>
            <button type="button" className={styles.secondary} onClick={onKeepDraft}>
              Keep draft
            </button>
          </fieldset>
        )}
        <p className={styles.hint}>
          Cancel affects only this local draft. It is not a publication cancel.
        </p>
      </div>
    </section>
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

type OfferRowProps = Readonly<{
  offer: StagedOfferResponse;
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
  disabled,
  baselineShare,
  shareInput,
  shareError,
  onAction,
  onShareInput,
  onShareSubmit,
}: OfferRowProps) {
  const shareModified =
    baselineShare !== undefined && baselineShare !== offer.share;
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  const runAction = (kind: "remove" | "restore" | "pin" | "unpin") => {
    closeMenu();
    onAction({ kind, offerId: offer.offer_id });
  };
  return (
    <tr className={offer.lifecycle === "ARCHIVED" ? styles.offerArchived : ""}>
      <th scope="row" className={styles.offerIdCell}>
        <span className={styles.offerIdValue}>Offer #{offer.offer_id}</span>
        {shareModified && (
          <span className={styles.modifiedDot} title="Share modified in draft" />
        )}
      </th>
      <td className={styles.offerShareCell}>
        <span className="tnum">
          {shareModified ? (
            <>
              <s>{baselineShare}</s> <span className={styles.shareArrow}>→</span>{" "}
              {offer.share}
            </>
          ) : (
            offer.share
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
            <span className={styles.shareInputWrap}>
              <input
                id={`share-${offer.offer_id}`}
                type="text"
                inputMode="numeric"
                aria-label="Share 0–100"
                value={shareInput}
                onChange={(event) => onShareInput(offer.offer_id, event.target.value)}
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
            <button type="submit" disabled={disabled}>
              Set share
            </button>
            {shareError && (
              <p className={styles.fieldError} id={`share-${offer.offer_id}-error`}>
                {shareError}
              </p>
            )}
          </form>
        )}
      </td>
      <td>
        <span
          className={`${styles.allocationMode} ${
            offer.is_pinned ? styles.allocationPinned : styles.allocationAuto
          }`}
        >
          {offer.is_pinned ? <LockIcon /> : <AutoIcon />}
          {offer.is_pinned ? "Pinned" : "Auto"}
        </span>
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
          {offer.lifecycle === "ACTIVE" ? "Active" : "Archived"}
          <span className={styles.offerLifecycle}>
            {offer.state ?? "not provided"}
          </span>
        </span>
      </td>
      <td>
        <div className={styles.inlineActions}>
          <button
            type="button"
            className={styles.kebabButton}
            disabled={disabled}
            aria-label={`More actions for offer ${offer.offer_id}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <KebabIcon />
          </button>
          {menuOpen && (
            <div className={styles.actionMenu}>
              {offer.lifecycle === "ACTIVE" ? (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove offer ${offer.offer_id}`}
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
              <button
                type="button"
                disabled={disabled}
                aria-label={`${offer.is_pinned ? "Unpin" : "Pin"} offer ${offer.offer_id}`}
                onClick={() => runAction(offer.is_pinned ? "unpin" : "pin")}
              >
                {offer.is_pinned ? "Unpin offer" : "Pin offer"}
              </button>
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
            <button type="button" className={styles.secondary} onClick={onKeepConflict}>
              Keep conflict
            </button>
          </fieldset>
        ) : (
          <button type="button" className={styles.secondary} onClick={onAcceptRemote}>
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
    <section aria-labelledby="review-heading" className={styles.panel}>
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

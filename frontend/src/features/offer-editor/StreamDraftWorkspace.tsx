import { useEffect, useRef } from "react";

import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import { PublicationCancelPanel } from "../publication/PublicationCancelPanel";
import { PublicationStatusPanel } from "../publication/PublicationStatusPanel";
import { PushStatusPanel } from "../publication/PushUnavailablePanel";
import { summarizeDraftChanges } from "./allocationSummary";
import {
  AllocationSummary,
  DraftCommandFeedback,
  DraftPanel,
  ReadErrorPanel,
  ReviewPanel,
} from "./EditorPanels";
import styles from "./OfferEditorPage.module.css";
import { describeFailure, type useStreamDraft } from "./useStreamDraft";

export type StreamDraftState = ReturnType<typeof useStreamDraft>;

function ListChangesIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.barIcon}
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M12 3v18M5 8h4M7 6v4M15 16h4" />
    </svg>
  );
}

function DraftBanner({
  draft,
}: Readonly<{ draft: NonNullable<StreamDraftState["draft"]> }>) {
  const summary = summarizeDraftChanges(draft);
  return (
    <output className={styles.dirtyBanner} data-purpose="conflict-alert">
      <p className={styles.dirtyBannerTitle}>
        Draft v{draft.version} · {summary.totalChanges} staged change
        {summary.totalChanges === 1 ? "" : "s"}
      </p>
      <span className={styles.dirtyPolicy}>Exact 100 enforced</span>
    </output>
  );
}

export function StreamDraftHeader({ state }: Readonly<{ state: StreamDraftState }>) {
  const {
    draft,
    draftQuery,
    committedQuery,
    busy,
    announcement,
    mutation,
    acceptRemoteMutation,
    pushMutation,
    pushOutcomeError,
    recoveryRequired,
    mutationFailure,
    staleConflicts,
    rereadDraft,
  } = state;
  return (
    <>
      {draft?.is_dirty && <DraftBanner draft={draft} />}
      {(draftQuery.isSuccess || committedQuery.isSuccess) && (
        <AllocationSummary
          draft={draft}
          committed={committedQuery.data ?? null}
        />
      )}
      <DraftCommandFeedback
        busy={busy && !pushMutation.isPending}
        announcement={announcement}
        isError={mutation.isError || acceptRemoteMutation.isError}
        recoveryRequired={recoveryRequired}
        failure={mutationFailure}
        staleConflicts={staleConflicts}
        onRetry={() => void rereadDraft()}
        retryDisabled={draftQuery.isFetching}
      />
      {pushMutation.isPending && (
        <output className={styles.pending}>
          Pushing offer weights to Keitaro and verifying stream state…
        </output>
      )}
      {pushOutcomeError && (
        <ErrorSummary
          heading="Push to Keitaro did not complete"
          message={pushOutcomeError}
          code={null}
        />
      )}
    </>
  );
}

export function StreamDraftSection({
  state,
  workspacePath,
  showSectionHeading = false,
  diffOpen = false,
}: Readonly<{
  state: StreamDraftState;
  workspacePath: string;
  showSectionHeading?: boolean;
  diffOpen?: boolean;
}>) {
  const { draft, draftQuery, committedQuery, busy, recoveryRequired, baselineReady } = state;
  const panel = (
    <>
      {draftQuery.isPending && <output>Loading local draft…</output>}
      {draftQuery.isError && (
        <ReadErrorPanel
          heading="Draft state unavailable"
          message={describeFailure(draftQuery.error).message}
          code={describeFailure(draftQuery.error).code}
          retryLabel="Retry draft read"
          onRetry={() => draftQuery.refetch()}
          retryDisabled={draftQuery.isFetching}
        />
      )}
      {draftQuery.isSuccess && (
        <DraftPanel
          draft={draft}
          committed={committedQuery.data ?? null}
          busy={busy}
          recoveryRequired={recoveryRequired}
          baselineReady={baselineReady}
          workspacePath={workspacePath}
          newOfferId={state.newOfferId}
          addError={state.addError}
          shareInputs={state.shareInputs}
          shareErrors={state.shareErrors}
          acceptingConflict={state.acceptingConflict}
          onNewOfferInput={state.onNewOfferInput}
          onAction={state.onAction}
          onShareInput={state.onShareInput}
          onShareSubmit={state.onShareSubmit}
          onAcceptRemote={state.onAcceptRemote}
          onConfirmAcceptRemote={state.onConfirmAcceptRemote}
          onKeepConflict={state.onKeepConflict}
        />
      )}
      {diffOpen && <ReviewPanel draft={draft} />}
    </>
  );
  if (!showSectionHeading) {
    return panel;
  }
  return (
    <section aria-labelledby="draft-section-heading" className={styles.section}>
      <h2 id="draft-section-heading">Draft state</h2>
      {panel}
    </section>
  );
}

export function StreamActionBar({ state }: Readonly<{ state: StreamDraftState }>) {
  const {
    draft,
    busy,
    recoveryRequired,
    confirmingCancel,
    onAction,
    onConfirmCancel,
    onKeepDraft,
    onPush,
    pushMutation,
    pushReadiness,
    streamRef,
  } = state;
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingCancel) {
      cancelConfirmRef.current?.focus();
    }
  }, [confirmingCancel]);

  const summary = summarizeDraftChanges(draft);
  const pushHintId = `push-reason-${streamRef}`;

  return (
    <footer className={styles.streamActionBar}>
      <div className={styles.stagedSummary}>
        <ListChangesIcon />
        <span className={styles.stagedCount}>{summary.changesLabel}</span>
        <span className={styles.summaryDivider} aria-hidden="true">
          |
        </span>
        <span className={styles.stagedMeta}>{summary.archivedLabel}</span>
        <span className={`${styles.stagedMeta} tnum`}>
          · Stream #{streamRef} (v{draft?.version ?? 0})
        </span>
      </div>
      <div className={styles.actionBarControls}>
        {confirmingCancel ? (
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
            <button
              type="button"
              className={styles.secondary}
              onClick={onKeepDraft}
              disabled={recoveryRequired}
            >
              Keep draft
            </button>
          </fieldset>
        ) : (
          <button
            type="button"
            className={styles.discardButton}
            onClick={() => onAction({ kind: "cancel" })}
            disabled={draft === null || busy || recoveryRequired}
          >
            <TrashIcon />
            <span>Discard Draft</span>
          </button>
        )}
        <button
          type="button"
          className={styles.pushButton}
          onClick={onPush}
          disabled={!pushReadiness.canPush}
          aria-describedby={pushHintId}
        >
          <SendIcon />
          <span>
            {pushMutation.isPending ? "Pushing…" : "Push to Keitaro"}
          </span>
        </button>
      </div>
      <p className={styles.actionBarHint} id={pushHintId}>
        {pushReadiness.reason ??
          "Ready to publish staged offer shares to Keitaro."}{" "}
        Cancel affects only this local draft.
      </p>
    </footer>
  );
}

export function StreamStatusSide({
  state,
  withPublicationCancel = false,
  showInspectorTitle = false,
  diffOpen,
  onToggleDiff,
}: Readonly<{
  state: StreamDraftState;
  withPublicationCancel?: boolean;
  showInspectorTitle?: boolean;
  diffOpen?: boolean;
  onToggleDiff?: () => void;
}>) {
  const {
    campaignId,
    streamRef,
    draft,
    recoveryRequired,
    publicationQuery,
    publicationFailure,
    publicationLock,
    pushReadiness,
    pushMutation,
  } = state;
  const summary = summarizeDraftChanges(draft);
  const dirty = Boolean(draft?.is_dirty);
  const stagedPlural = summary.totalChanges === 1 ? "" : "s";
  const stagedLabel = dirty
    ? `${summary.totalChanges} staged change${stagedPlural}`
    : "No staged changes";

  return (
    <aside className={styles.inspector} aria-label="Backend inspector">
      {showInspectorTitle && (
        <p className={styles.inspectorTitle}>Inspector</p>
      )}

      <section
        aria-labelledby="publication-section-heading"
        className={styles.inspectorCard}
      >
        <h2 id="publication-section-heading">Latest publication status</h2>
        <PublicationStatusPanel
          state={publicationQuery.data ?? null}
          expectedCampaignId={campaignId}
          expectedStreamRef={streamRef}
          isPending={publicationQuery.isPending}
          error={publicationQuery.isError ? publicationFailure : null}
          onRetry={() => publicationQuery.refetch()}
          retryDisabled={publicationQuery.isFetching || recoveryRequired}
        />
        {withPublicationCancel && (
          <PublicationCancelPanel
            campaignId={campaignId}
            streamRef={streamRef}
            lock={publicationLock}
            state={publicationQuery.data ?? null}
            stateError={publicationQuery.isError ? publicationFailure : null}
            statePending={publicationQuery.isPending}
          />
        )}
      </section>

      <section aria-label="Draft and checks" className={styles.inspectorCard}>
        <h2 className={styles.inspectorCardHeading}>Draft & Checks</h2>
        <div className={styles.draftStatusRow}>
          <span
            className={`${styles.draftStatusDot} ${
              dirty ? styles.draftStatusDotDirty : styles.draftStatusDotClean
            }`}
            aria-hidden="true"
          />
          <div>
            <p className={styles.draftStatusValue}>{stagedLabel}</p>
            <p className={`${styles.draftStatusVersion} tnum`}>
              v{draft?.version ?? 0}
            </p>
          </div>
        </div>
        <dl className={styles.checksList}>
          <div className={styles.checkRow}>
            <dt>Stale check</dt>
            <dd className={draft?.is_stale ? styles.checkWarn : styles.checkGood}>
              {draft?.is_stale ? "Drift detected" : "Up to date"}
            </dd>
          </div>
          <div className={styles.checkRow}>
            <dt>Conflicts</dt>
            <dd>{draft?.conflicts.length ? `${draft.conflicts.length} conflict(s)` : "None"}</dd>
          </div>
        </dl>
        {onToggleDiff && (
          <button
            type="button"
            className={styles.viewDiffButton}
            onClick={onToggleDiff}
            disabled={recoveryRequired || !dirty}
            aria-expanded={diffOpen}
            title={dirty ? undefined : "No staged changes to review"}
          >
            <DiffIcon />
            <span>{diffOpen ? "Hide Diff" : "View Diff"}</span>
          </button>
        )}
        <details className={styles.techDetails}>
          <summary>Technical details</summary>
          <p className={styles.techDetailLine}>
            fingerprint: {draft?.conflicts_fingerprint ?? "not available"}
          </p>
        </details>
      </section>

      <PushStatusPanel
        readiness={pushReadiness}
        pushing={pushMutation.isPending}
      />
    </aside>
  );
}

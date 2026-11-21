import { useEffect, useRef } from "react";

import { PublicationCancelPanel } from "../publication/PublicationCancelPanel";
import { PublicationStatusPanel } from "../publication/PublicationStatusPanel";
import { PushUnavailablePanel } from "../publication/PushUnavailablePanel";
import {
  AllocationSummary,
  DraftCommandFeedback,
  DraftPanel,
  PolicyCard,
  ReadErrorPanel,
} from "./EditorPanels";
import styles from "./OfferEditorPage.module.css";
import { draftChanges } from "./draftChanges";
import { describeFailure, type useStreamDraft } from "./useStreamDraft";

export type StreamDraftState = ReturnType<typeof useStreamDraft>;

function draftChangesCount(draft: NonNullable<StreamDraftState["draft"]>): number {
  const changes = draftChanges(draft);
  return (
    changes.additions.length +
    changes.archives.length +
    changes.restores.length +
    changes.pinToggles.length +
    changes.shareEdits.length
  );
}

function DraftBanner({
  draft,
}: Readonly<{ draft: NonNullable<StreamDraftState["draft"]> }>) {
  return (
    <div className={styles.dirtyBanner} data-purpose="conflict-alert">
      <div>
        <p className={styles.dirtyBannerTitle}>
          Draft active on version {draft.version}. {draftChangesCount(draft)}{" "}
          local staged mutation
          {draftChangesCount(draft) === 1 ? "" : "s"} awaiting commit.
        </p>
        <p className={styles.dirtyBannerHint}>
          Remote baseline remains pinned. Manual edits automatically toggle offer
          mode to Pinned.
        </p>
      </div>
      <span className={styles.dirtyPolicy}>Policy: EXACT_100_ENFORCED</span>
    </div>
  );
}

export function StreamDraftHeader({ state }: Readonly<{ state: StreamDraftState }>) {
  const {
    draft,
    draftQuery,
    busy,
    announcement,
    statusRef,
    mutation,
    acceptRemoteMutation,
    recoveryRequired,
    mutationFailure,
    staleConflicts,
    rereadDraft,
  } = state;
  return (
    <>
      {draft?.is_dirty && <DraftBanner draft={draft} />}
      {draftQuery.isSuccess && <AllocationSummary draft={draft} />}
      <DraftCommandFeedback
        busy={busy}
        announcement={announcement}
        statusRef={statusRef}
        isError={mutation.isError || acceptRemoteMutation.isError}
        recoveryRequired={recoveryRequired}
        failure={mutationFailure}
        staleConflicts={staleConflicts}
        onRetry={() => void rereadDraft()}
        retryDisabled={draftQuery.isFetching}
      />
    </>
  );
}

export function StreamDraftSection({
  state,
  workspacePath,
  showSectionHeading = false,
}: Readonly<{
  state: StreamDraftState;
  workspacePath: string;
  showSectionHeading?: boolean;
}>) {
  const { draft, draftQuery, busy, recoveryRequired, baselineReady } = state;
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
    streamRef,
  } = state;
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingCancel) {
      cancelConfirmRef.current?.focus();
    }
  }, [confirmingCancel]);
  const changes = draft ? draftChangesCount(draft) : 0;
  const archived = draft
    ? draft.offers.filter((offer) => offer.lifecycle === "ARCHIVED").length
    : 0;
  return (
    <footer className={styles.streamActionBar}>
      <div className={styles.stagedSummary}>
        <span
          className={`${styles.stagedDot} ${
            (draft?.is_dirty && styles.stagedDotActive) || ""
          }`}
          aria-hidden="true"
        />
        <span className={styles.stagedCount}>{changes} staged changes</span>
        <span className={styles.stagedMeta}>· {archived} archived</span>
        <span className={`${styles.stagedMeta} tnum`}>
          · Stream {streamRef} (v{draft?.version ?? 0} draft)
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
            >
              Keep draft
            </button>
          </fieldset>
        ) : (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => onAction({ kind: "cancel" })}
            disabled={draft === null || busy || recoveryRequired}
          >
            Discard Draft
          </button>
        )}
        <button
          type="button"
          className={styles.pushButton}
          disabled
          aria-describedby="push-disabled-reason"
        >
          Push to Keitaro
        </button>
      </div>
      <p className={styles.actionBarHint} id="push-disabled-reason">
        Push is disabled: live Keitaro writes are off in this environment
        (KEITARO_ALLOW_PUBLICATION_WRITES=false), and this interface never calls
        the publish endpoint. Cancel affects only this local draft. It is not a
        publication cancel.
      </p>
    </footer>
  );
}

export function StreamStatusSide({
  state,
  withPublicationCancel = false,
  showInspectorTitle = false,
}: Readonly<{
  state: StreamDraftState;
  withPublicationCancel?: boolean;
  showInspectorTitle?: boolean;
}>) {
  const {
    campaignId,
    streamRef,
    draft,
    publicationQuery,
    publicationFailure,
    publicationLock,
  } = state;
  return (
    <aside className={styles.inspector} aria-label="Backend inspector">
      {showInspectorTitle && (
        <p className={styles.inspectorTitle}>Backend Inspector</p>
      )}
      <PolicyCard draft={draft} />
      <section
        aria-labelledby="publication-section-heading"
        className={styles.section}
      >
        <h2 id="publication-section-heading">Latest publication status</h2>
        <PublicationStatusPanel
          state={publicationQuery.data ?? null}
          expectedCampaignId={campaignId}
          expectedStreamRef={streamRef}
          isPending={publicationQuery.isPending}
          error={publicationQuery.isError ? publicationFailure : null}
          onRetry={() => publicationQuery.refetch()}
          retryDisabled={publicationQuery.isFetching}
        />
        <PushUnavailablePanel />
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
    </aside>
  );
}

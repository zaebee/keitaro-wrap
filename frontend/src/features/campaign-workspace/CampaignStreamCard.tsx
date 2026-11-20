import { Link } from "react-router-dom";

import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import { PublicationStatusPanel } from "../publication/PublicationStatusPanel";
import { PushUnavailablePanel } from "../publication/PushUnavailablePanel";
import {
  AllocationSummary,
  ConflictPanel,
  DraftPanel,
  PolicyCard,
} from "../offer-editor/EditorPanels";
import {
  describeFailure,
  failureMessage,
  hintFor,
  useStreamDraft,
} from "../offer-editor/useStreamDraft";
import styles from "./CampaignWorkspacePage.module.css";

function syncLabel(draft: { is_stale: boolean; conflicts: unknown[] } | null) {
  if (draft === null) {
    return { label: "No draft", tone: styles.syncMuted };
  }
  if (draft.is_stale || draft.conflicts.length > 0) {
    return { label: "Drift detected", tone: styles.syncWarn };
  }
  return { label: "✓ Synced", tone: styles.syncGood };
}

export function CampaignStreamCard({
  campaignId,
  streamRef,
}: Readonly<{ campaignId: number; streamRef: number }>) {
  const {
    draft,
    busy,
    recoveryRequired,
    baselineReady,
    confirmingCancel,
    acceptingConflict,
    announcement,
    statusRef,
    newOfferId,
    addError,
    shareInputs,
    shareErrors,
    snapshot,
    committedQuery,
    draftQuery,
    publicationQuery,
    mutation,
    acceptRemoteMutation,
    mutationFailure,
    publicationFailure,
    staleConflicts,
    streamMissing,
    onNewOfferInput,
    onAction,
    onShareInput,
    onShareSubmit,
    onConfirmCancel,
    onKeepDraft,
    onAcceptRemote,
    onConfirmAcceptRemote,
    onKeepConflict,
    rereadDraft,
  } = useStreamDraft(campaignId, streamRef);

  if (streamMissing) {
    return (
      <p className={styles.empty}>
        Campaign {campaignId} does not have stream {streamRef}. No draft command
        was sent.
      </p>
    );
  }

  const sync = syncLabel(draft);

  return (
    <div className={styles.streamCardBody}>
      <div className={styles.streamCardMetaRow}>
        <span className={`${styles.syncBadge} ${sync.tone}`}>{sync.label}</span>
        <span className={styles.lastFetch}>
          <span className={styles.lastFetchLabel}>Last fetch</span>
          <span className={`${styles.lastFetchValue} tnum`}>
            {snapshot
              ? new Date(snapshot.captured_at).toLocaleString()
              : "not available"}
          </span>
        </span>
        <Link
          className={styles.streamEditorLink}
          to={`/campaigns/${campaignId}/streams/${streamRef}`}
          aria-label={`Open editor for stream ${streamRef}`}
        >
          Open editor
        </Link>
      </div>

      <div className={styles.streamColumns}>
        <div className={styles.streamMain}>
          {draft?.is_dirty && (
            <div className={styles.dirtyBanner} data-purpose="conflict-alert">
              <p className={styles.dirtyBannerTitle}>
                Draft active on version {draft.version}.
              </p>
              <p className={styles.dirtyBannerHint}>
                Manual edits automatically toggle offer mode to Pinned.
              </p>
            </div>
          )}

          {draftQuery.isSuccess && <AllocationSummary draft={draft} />}

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

          {(mutation.isError || acceptRemoteMutation.isError) && (
            <ErrorSummary
              heading={
                recoveryRequired
                  ? "Recovery required — draft commands locked"
                  : "Draft command failed"
              }
              message={failureMessage(mutationFailure)}
              code={mutationFailure.code}
              detail={
                <>
                  <p className={styles.hint}>{hintFor(mutationFailure)}</p>
                  {staleConflicts.length > 0 && (
                    <ConflictPanel conflicts={staleConflicts} />
                  )}
                </>
              }
              retryLabel="Read current draft"
              onRetry={() => void rereadDraft()}
              retryDisabled={draftQuery.isFetching}
            />
          )}

          {draftQuery.isPending && <output>Loading local draft…</output>}
          {draftQuery.isError && (
            <p className={styles.empty}>
              Draft state unavailable: {describeFailure(draftQuery.error).message}
            </p>
          )}
          {draftQuery.isSuccess && (
            <DraftPanel
              draft={draft}
              busy={busy}
              recoveryRequired={recoveryRequired}
              baselineReady={baselineReady}
              workspacePath={`/campaigns/${campaignId}`}
              newOfferId={newOfferId}
              addError={addError}
              shareInputs={shareInputs}
              shareErrors={shareErrors}
              confirmingCancel={confirmingCancel}
              acceptingConflict={acceptingConflict}
              onNewOfferInput={onNewOfferInput}
              onAction={onAction}
              onShareInput={onShareInput}
              onShareSubmit={onShareSubmit}
              onConfirmCancel={onConfirmCancel}
              onKeepDraft={onKeepDraft}
              onAcceptRemote={onAcceptRemote}
              onConfirmAcceptRemote={onConfirmAcceptRemote}
              onKeepConflict={onKeepConflict}
            />
          )}
        </div>

        <aside className={styles.streamSide}>
          <PolicyCard draft={draft} />
          <section
            aria-labelledby={`publication-heading-${streamRef}`}
            className={styles.streamSideSection}
          >
            <h3 id={`publication-heading-${streamRef}`}>
              Latest publication status
            </h3>
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
          </section>
        </aside>
      </div>

      {committedQuery.isError && (
        <p className={styles.hint}>
          Committed baseline unavailable:{" "}
          {describeFailure(committedQuery.error).message}
        </p>
      )}
    </div>
  );
}

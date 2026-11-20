import { Link, useParams } from "react-router-dom";

import type { DraftViewResponse } from "../../api/operations";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import { PublicationCancelPanel } from "../publication/PublicationCancelPanel";
import { PublicationStatusPanel } from "../publication/PublicationStatusPanel";
import { PushUnavailablePanel } from "../publication/PushUnavailablePanel";
import { parsePositiveId } from "../campaign-workspace/campaignId";
import {
  AllocationSummary,
  CommittedPanel,
  ConflictPanel,
  DraftPanel,
  PolicyCard,
  ReadErrorPanel,
  ReviewPanel,
} from "./EditorPanels";
import styles from "./OfferEditorPage.module.css";
import { draftChanges } from "./draftChanges";
import {
  describeFailure,
  failureMessage,
  hintFor,
  useStreamDraft,
} from "./useStreamDraft";

function draftChangesCount(draft: DraftViewResponse): number {
  const changes = draftChanges(draft);
  return (
    changes.additions.length +
    changes.archives.length +
    changes.restores.length +
    changes.pinToggles.length +
    changes.shareEdits.length
  );
}

function Editor({
  campaignId,
  streamRef,
}: Readonly<{ campaignId: number; streamRef: number }>) {
  const narrow = useNarrowViewport();
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
    publicationLock,
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
      <section aria-labelledby="stream-missing-heading" className={styles.card}>
        <h1 id="stream-missing-heading">Stream not found</h1>
        <p>
          Campaign {campaignId} does not have stream {streamRef}. No draft
          command was sent.
        </p>
        <Link to={`/campaigns/${campaignId}`}>Back to Campaign Workspace</Link>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="editor-heading"
      aria-busy={
        busy ||
        committedQuery.isFetching ||
        draftQuery.isFetching ||
        publicationQuery.isFetching
      }
      className={`${styles.card} ${narrow ? styles.narrow : ""}`}
      data-recovery-lock={recoveryRequired ? "active" : "inactive"}
    >
      <header className={styles.topBar}>
        <nav aria-label="Breadcrumb" className={styles.breadcrumbs}>
          <Link className={styles.crumbLink} to="/campaigns/open">
            Campaigns
          </Link>
          <span className={styles.crumbSep} aria-hidden="true">
            ›
          </span>
          <Link
            className={styles.crumbLink}
            to={`/campaigns/${campaignId}`}
            aria-label={`Campaign ${campaignId} workspace`}
          >
            <span className="tnum">Campaign #{campaignId}</span>
          </Link>
          <span className={styles.crumbSep} aria-hidden="true">
            ›
          </span>
          <span className={`${styles.crumbCurrent} tnum`} aria-current="page">
            Stream #{streamRef}
          </span>
        </nav>
        <div className={styles.titleRow}>
          <h1 id="editor-heading">Offer Editor</h1>
          <span className={`${styles.titleStream} tnum`}>
            Stream #{streamRef}
          </span>
          {(() => {
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
          })()}
            {draft?.is_dirty && (
              <span className={styles.dirtyBadge}>
                Draft v{draft.version} (Dirty)
              </span>
            )}
          <span className={styles.lastFetch}>
            <span className={styles.lastFetchLabel}>Last fetch</span>
            <span className={`${styles.lastFetchValue} tnum`}>
              {snapshot ? new Date(snapshot.captured_at).toLocaleString() : "not available"}
            </span>
          </span>
          </div>
          <p className={styles.hint}>
            This screen edits only the selected stream; streams remain
            independent. Committed baseline and staged draft are separate server
            views. The publication section shows read-only status, explains why
            Push is unavailable, and offers only a local publication Cancel.
          </p>
        </header>

        <div className={styles.columns}>
          <div className={styles.mainColumn}>
        {draft?.is_dirty && (
          <div className={styles.dirtyBanner} data-purpose="conflict-alert">
            <div>
              <p className={styles.dirtyBannerTitle}>
                Draft active on version {draft.version}.{" "}
                {draftChangesCount(draft)} local staged mutation
                {draftChangesCount(draft) === 1 ? "" : "s"} awaiting commit.
              </p>
              <p className={styles.dirtyBannerHint}>
                Remote baseline remains pinned. Manual edits automatically toggle
                offer mode to Pinned.
              </p>
            </div>
            <span className={styles.dirtyPolicy}>Policy: EXACT_100_ENFORCED</span>
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
            onRetry={() => void rereadDraft()}
            retryDisabled={draftQuery.isFetching}
          />
        )}

        <section aria-labelledby="committed-section-heading" className={styles.section}>
          <h2 id="committed-section-heading">Committed state</h2>
          {committedQuery.isPending && (
            <output>Loading committed stream state…</output>
          )}
          {committedQuery.isError && (
            <ReadErrorPanel
              heading="Committed state unavailable"
              message={describeFailure(committedQuery.error).message}
              code={describeFailure(committedQuery.error).code}
              retryLabel="Retry committed read"
              onRetry={() => committedQuery.refetch()}
              retryDisabled={committedQuery.isFetching}
            />
          )}
          {committedQuery.isSuccess && <CommittedPanel state={committedQuery.data} />}
        </section>

        <section aria-labelledby="draft-section-heading" className={styles.section}>
          <h2 id="draft-section-heading">Draft state</h2>
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
        </section>
        </div>

        <aside className={styles.inspector} aria-label="Backend inspector">
          <p className={styles.inspectorTitle}>Backend Inspector</p>
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
          error={
            publicationQuery.isError ? publicationFailure : null
          }
          onRetry={() => publicationQuery.refetch()}
          retryDisabled={publicationQuery.isFetching}
        />
        <PushUnavailablePanel />
        <PublicationCancelPanel
          campaignId={campaignId}
          streamRef={streamRef}
          lock={publicationLock}
          state={publicationQuery.data ?? null}
          stateError={publicationQuery.isError ? publicationFailure : null}
          statePending={publicationQuery.isPending}
        />
      </section>
        </aside>
      </div>

      <ReviewPanel draft={draft} />
      <footer className={styles.actionBar}>
        <div className={styles.stagedSummary}>
          <span
            className={`${styles.stagedDot} ${
              (draft?.is_dirty && styles.stagedDotActive) || ""
            }`}
            aria-hidden="true"
          />
          <span className={styles.stagedCount}>
            {draft ? draftChangesCount(draft) : 0} staged changes
          </span>
          <span className={styles.stagedMeta}>
            · Stream {streamRef} (v{draft?.version ?? 0} draft)
          </span>
        </div>
        <p className={styles.actionBarHint}>
          Local / trusted environment only. No Keitaro request is made by
          opening this editor.
        </p>
      </footer>
    </section>
  );
}

export function OfferEditorPage() {
  const { campaignId: rawCampaignId, streamRef: rawStreamRef } = useParams();
  const campaignId = parsePositiveId(rawCampaignId);
  const streamRef = parsePositiveId(rawStreamRef);

  if (campaignId === null || streamRef === null) {
    return (
      <section aria-labelledby="invalid-editor-heading" className={styles.card}>
        <h1 id="invalid-editor-heading">Invalid stream URL</h1>
        <p>
          Campaign ID and stream ref must be positive whole numbers within the
          safe integer range. No API request was made.
        </p>
        <Link to="/campaigns/open">Enter a Campaign ID</Link>
      </section>
    );
  }

  return <Editor key={`${campaignId}-${streamRef}`} campaignId={campaignId} streamRef={streamRef} />;
}

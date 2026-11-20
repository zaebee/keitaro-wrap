import { Link, useParams } from "react-router-dom";

import type { DraftViewResponse } from "../../api/operations";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { parsePositiveId } from "../campaign-workspace/campaignId";
import {
  CommittedPanel,
  LastFetchMeta,
  ReadErrorPanel,
  ReviewPanel,
  StreamSyncBadge,
} from "./EditorPanels";
import {
  StreamDraftHeader,
  StreamDraftSection,
  StreamStatusSide,
} from "./StreamDraftWorkspace";
import styles from "./OfferEditorPage.module.css";
import { draftChanges } from "./draftChanges";
import { describeFailure, useStreamDraft } from "./useStreamDraft";

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
  const streamDraft = useStreamDraft(campaignId, streamRef);
  const {
    draft,
    busy,
    recoveryRequired,
    snapshot,
    committedQuery,
    draftQuery,
    publicationQuery,
    streamMissing,
  } = streamDraft;

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
          <StreamSyncBadge draft={draft} />
            {draft?.is_dirty && (
              <span className={styles.dirtyBadge}>
                Draft v{draft.version} (Dirty)
              </span>
            )}
          <LastFetchMeta capturedAt={snapshot?.captured_at ?? null} />
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
        <StreamDraftHeader state={streamDraft} />

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

        <StreamDraftSection
          state={streamDraft}
          workspacePath={`/campaigns/${campaignId}`}
          showSectionHeading
        />
        </div>

        <StreamStatusSide
          state={streamDraft}
          withPublicationCancel
          showInspectorTitle
        />
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

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { getCampaignInfo } from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { parsePositiveId } from "../campaign-workspace/campaignId";
import {
  CommittedPanel,
  LastFetchMeta,
  ReadErrorPanel,
  StreamSyncBadge,
} from "./EditorPanels";
import {
  StreamActionBar,
  StreamDraftHeader,
  StreamDraftSection,
  StreamStatusSide,
} from "./StreamDraftWorkspace";
import styles from "./OfferEditorPage.module.css";
import { describeFailure, useStreamDraft } from "./useStreamDraft";

function Editor({
  campaignId,
  streamRef,
}: Readonly<{ campaignId: number; streamRef: number }>) {
  const narrow = useNarrowViewport();
  const [diffOpen, setDiffOpen] = useState(true);
  const streamDraft = useStreamDraft(campaignId, streamRef);
  const campaignQuery = useQuery({
    queryKey: queryKeys.campaign(campaignId),
    queryFn: () => getCampaignInfo(campaignId),
    retry: false,
    refetchOnWindowFocus: false,
  });

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

  const campaignTitle = campaignQuery.data?.name?.trim() || `Campaign #${campaignId}`;

  return (
    <section
      aria-labelledby="editor-heading"
      aria-busy={
        busy ||
        committedQuery.isFetching ||
        draftQuery.isFetching ||
        publicationQuery.isFetching
      }
      className={`${styles.pageShell} ${narrow ? styles.narrow : ""}`}
      data-recovery-lock={recoveryRequired ? "active" : "inactive"}
    >
      <div className={styles.topUtilityBar}>
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
            <span className="tnum">{campaignTitle}</span>
          </Link>
          <span className={styles.crumbSep} aria-hidden="true">
            ›
          </span>
          <span className={`${styles.crumbCurrent} tnum`} aria-current="page">
            Stream #{streamRef}
          </span>
        </nav>
        <span className={styles.userAvatar} aria-hidden="true" title="Keitaro Wrap operator">
          KW
        </span>
      </div>

      <header className={styles.editorHero}>
        <div className={styles.titleRow}>
          <h1 id="editor-heading">Offer Editor</h1>
          <span className={`${styles.titleStream} tnum`}>
            #{streamRef}
          </span>
          <StreamSyncBadge draft={draft} baselineReady={streamDraft.baselineReady} />
          {draft?.is_dirty && (
            <span className={styles.dirtyBadge}>
              Draft changes · v{draft.version}
            </span>
          )}
          <LastFetchMeta capturedAt={snapshot?.captured_at ?? null} />
        </div>
        <p className={styles.hint}>
          Stage offer weights, pins, additions, and removals for this stream.
          Committed baseline remains untouched until you push changes to Keitaro.
        </p>
      </header>

      <div className={styles.columns}>
        <div className={styles.mainColumn}>
          <StreamDraftHeader state={streamDraft} />

          <StreamDraftSection
            state={streamDraft}
            workspacePath={`/campaigns/${campaignId}`}
            showSectionHeading
            diffOpen={diffOpen}
          />

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
                retryDisabled={committedQuery.isFetching || recoveryRequired}
              />
            )}
            {committedQuery.isSuccess && <CommittedPanel state={committedQuery.data} />}
          </section>
        </div>

        <StreamStatusSide
          state={streamDraft}
          withPublicationCancel
          showInspectorTitle={false}
          diffOpen={diffOpen}
          onToggleDiff={() => setDiffOpen((open) => !open)}
        />
      </div>

      <StreamActionBar state={streamDraft} />
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

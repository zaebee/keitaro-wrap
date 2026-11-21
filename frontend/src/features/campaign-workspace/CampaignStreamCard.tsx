import { Link } from "react-router-dom";

import { LastFetchMeta, StreamSyncBadge } from "../offer-editor/EditorPanels";
import { useStreamDraft } from "../offer-editor/useStreamDraft";
import styles from "./CampaignWorkspacePage.module.css";

export function CampaignStreamCard({
  campaignId,
  streamRef,
}: Readonly<{ campaignId: number; streamRef: number }>) {
  const streamDraft = useStreamDraft(campaignId, streamRef);
  const { draft, snapshot, streamMissing } = streamDraft;

  if (streamMissing) {
    return (
      <p className={styles.empty}>
        Campaign {campaignId} does not have stream {streamRef}. No draft
        command was sent.
      </p>
    );
  }

  return (
    <div className={styles.streamCardBody}>
      <div className={styles.streamCardMetaRow}>
        <div className={styles.streamCardBadges}>
          <StreamSyncBadge draft={draft} baselineReady={streamDraft.baselineReady} />
          {draft?.is_dirty && (
            <span className={styles.dirtyPill}>
              ✎ Draft changes · v{draft.version}
            </span>
          )}
        </div>
        <div className={styles.streamCardMetaRight}>
          <LastFetchMeta capturedAt={snapshot?.captured_at ?? null} />
          <Link
            className={styles.streamEditorLink}
            to={`/campaigns/${campaignId}/streams/${streamRef}`}
            aria-label={`Open editor for stream ${streamRef}`}
          >
            Open editor
          </Link>
        </div>
      </div>
      <p className={styles.streamCardHint}>
        Open the full editor to stage offer weights, pins, additions and
        removals for this stream.
      </p>
    </div>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";

import {
  LastFetchMeta,
  StreamSyncBadge,
} from "../offer-editor/EditorPanels";
import {
  StreamActionBar,
  StreamDraftHeader,
  StreamDraftSection,
  StreamStatusSide,
} from "../offer-editor/StreamDraftWorkspace";
import { useStreamDraft } from "../offer-editor/useStreamDraft";
import styles from "./CampaignWorkspacePage.module.css";

export function CampaignStreamCard({
  campaignId,
  streamRef,
}: Readonly<{ campaignId: number; streamRef: number }>) {
  const [diffOpen, setDiffOpen] = useState(false);
  const streamDraft = useStreamDraft(campaignId, streamRef);
  const { draft, snapshot, streamMissing } = streamDraft;

  if (streamMissing) {
    return (
      <p className={styles.empty}>
        Campaign {campaignId} does not have stream {streamRef}. No draft command
        was sent.
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

      <div className={styles.streamColumns}>
        <div className={styles.streamMain}>
          <StreamDraftHeader state={streamDraft} />
          <StreamDraftSection
            state={streamDraft}
            workspacePath={`/campaigns/${campaignId}`}
            diffOpen={diffOpen}
          />
        </div>
        <StreamStatusSide
          state={streamDraft}
          diffOpen={diffOpen}
          onToggleDiff={() => setDiffOpen((open) => !open)}
        />
      </div>
      <StreamActionBar state={streamDraft} />
    </div>
  );
}

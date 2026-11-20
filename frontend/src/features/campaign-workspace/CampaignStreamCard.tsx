import { Link } from "react-router-dom";

import {
  LastFetchMeta,
  StreamSyncBadge,
} from "../offer-editor/EditorPanels";
import {
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
        <StreamSyncBadge draft={draft} />
        <LastFetchMeta capturedAt={snapshot?.captured_at ?? null} />
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
          <StreamDraftHeader state={streamDraft} />
          <StreamDraftSection
            state={streamDraft}
            workspacePath={`/campaigns/${campaignId}`}
          />
        </div>
        <StreamStatusSide state={streamDraft} />
      </div>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, useParams } from "react-router-dom";

import {
  fetchCampaignStreams,
  getCampaignStreams,
  getCommittedState,
  getDraftState,
  getHealth,
} from "../../api/operations";
import { parsePositiveId } from "../campaign-workspace/campaignId";
import { queryKeys } from "../../queries/queryClient";
import styles from "./StreamsSidebar.module.css";

type StreamState = "staged" | "synced" | "idle";

function streamState(
  staged: boolean,
  synced: boolean,
): StreamState {
  if (staged) {
    return "staged";
  }
  if (synced) {
    return "synced";
  }
  return "idle";
}

function streamStateLabel(state: StreamState): string {
  if (state === "staged") {
    return "has staged changes";
  }
  if (state === "synced") {
    return "synced";
  }
  return "no staged changes";
}

function dotClassName(state: StreamState): string {
  if (state === "staged") {
    return `${styles.dot} ${styles.dotStaged}`;
  }
  if (state === "synced") {
    return `${styles.dot} ${styles.dotSynced}`;
  }
  return styles.dot;
}

function formatSyncTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function StreamNavItem({
  campaignId,
  streamRef,
  name,
}: Readonly<{ campaignId: number; streamRef: number; name: string }>) {
  const draft = useQuery({
    queryKey: queryKeys.draft(campaignId, streamRef),
    queryFn: () => getDraftState(campaignId, streamRef),
    retry: false,
  });
  const committed = useQuery({
    queryKey: queryKeys.committed(campaignId, streamRef),
    queryFn: () => getCommittedState(campaignId, streamRef),
    retry: false,
  });

  const staged = draft.data?.draft ?? null;
  const synced = committed.data?.snapshot != null;
  const state = streamState(staged !== null, synced);

  return (
    <li className={styles.streamItem}>
      <NavLink
        to={`/campaigns/${campaignId}/streams/${streamRef}`}
        className={({ isActive }) =>
          `${styles.streamLink} ${isActive ? styles.streamLinkActive : ""}`
        }
      >
        <span className={dotClassName(state)} aria-hidden="true" />
        <span className={styles.streamName}>{name}</span>
        <span className={styles.streamMeta}>
          {staged && (
            <span className={styles.chip}>v{staged.version} staged</span>
          )}
          <span className={styles.visuallyHidden} data-stream-state={state}>
            {streamStateLabel(state)}
          </span>
        </span>
      </NavLink>
    </li>
  );
}

function CampaignSidebar({
  campaignId,
}: Readonly<{ campaignId: number }>) {
  const queryClient = useQueryClient();
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const streams = useQuery({
    queryKey: queryKeys.campaignStreams(campaignId),
    queryFn: () => getCampaignStreams(campaignId),
    retry: false,
  });

  const refresh = useMutation({
    mutationFn: () => fetchCampaignStreams(campaignId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.campaignStreams(campaignId),
      });
      queryClient.invalidateQueries({ queryKey: ["committed", campaignId] });
      queryClient.invalidateQueries({ queryKey: ["draft", campaignId] });
      queryClient.invalidateQueries({ queryKey: ["publication", campaignId] });
      setLastSyncedAt(Date.now());
    },
  });

  let syncLine = "Not synced in this session";
  if (lastSyncedAt !== null) {
    syncLine = `Last sync: ${formatSyncTime(lastSyncedAt)}`;
  } else if (streams.dataUpdatedAt > 0) {
    syncLine = `Last sync: ${formatSyncTime(streams.dataUpdatedAt)}`;
  }

  let streamsContent: JSX.Element;
  if (streams.isError) {
    streamsContent = <p className={styles.streamsHint}>Streams unavailable</p>;
  } else if (streams.data && streams.data.length > 0) {
    streamsContent = (
      <ul className={styles.streamList}>
        {streams.data.map((stream) => (
          <StreamNavItem
            key={stream.stream_ref}
            campaignId={campaignId}
            streamRef={stream.stream_ref}
            name={stream.name}
          />
        ))}
      </ul>
    );
  } else if (streams.isSuccess) {
    streamsContent = (
      <p className={styles.streamsHint}>No streams yet. Run Fetch.</p>
    );
  } else {
    streamsContent = <p className={styles.streamsHint}>Loading streams…</p>;
  }

  return (
    <section className={styles.campaignBlock} aria-label="Campaign">
      <div className={styles.campaignHeader}>
        <h2 className={styles.campaignTitle}>Campaign {campaignId}</h2>
        <span className={styles.activeBadge}>Active</span>
      </div>
      <div className={styles.campaignActions}>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Fetching…" : "Fetch streams"}
        </button>
        <p className={styles.syncLine}>
          {refresh.isError ? "Fetch failed; streams unchanged" : syncLine}
        </p>
      </div>
      <nav aria-label="Streams" className={styles.streamsNav}>
        {streamsContent}
      </nav>
    </section>
  );
}

function SidebarFooter() {
  const { data, isError } = useQuery({
    queryKey: queryKeys.health,
    queryFn: getHealth,
  });
  const environment = import.meta.env.MODE === "production"
    ? "production"
    : "development";

  return (
    <footer className={styles.statusFooter} aria-label="Environment status">
      <p className={styles.statusLine}>
        <span
          className={`${styles.statusDot} ${isError ? styles.statusDotError : styles.statusDotOk}`}
          aria-hidden="true"
        />
        {isError ? "API unavailable" : `API ${data?.status ?? "checking"}`}
      </p>
      <p className={styles.statusLine}>
        <span className={styles.envChip}>{environment}</span>
        {" "}
        Keitaro core: unknown
      </p>
    </footer>
  );
}

export function StreamsSidebar() {
  const { campaignId: rawCampaignId } = useParams();
  const campaignId = parsePositiveId(rawCampaignId);

  return (
    <aside className={styles.sidebar} aria-label="App sidebar">
      <div className={styles.brandBlock}>
        <Link className={styles.brand} to="/campaigns/new">
          Keitaro Wrap
        </Link>
        <p className={styles.wordmark}>OFFER DISPATCH</p>
        <nav aria-label="Primary" className={styles.primaryNav}>
          <Link to="/campaigns/new">Create campaign</Link>
          <Link to="/campaigns/open">Open campaign</Link>
          <Link to="/recovery">Recovery queue</Link>
        </nav>
      </div>
      {campaignId !== null ? (
        <CampaignSidebar campaignId={campaignId} />
      ) : (
        <section className={styles.campaignBlock} aria-label="Campaign">
          <p className={styles.streamsHint}>
            No campaign open.{" "}
            <Link to="/campaigns/open">Open a campaign</Link> to see its
            streams.
          </p>
        </section>
      )}
      <SidebarFooter />
    </aside>
  );
}

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
  const state = staged ? "staged" : synced ? "synced" : "idle";

  return (
    <li className={styles.streamItem}>
      <NavLink
        to={`/campaigns/${campaignId}/streams/${streamRef}`}
        className={({ isActive }) =>
          `${styles.streamLink} ${isActive ? styles.streamLinkActive : ""}`
        }
      >
        <span
          className={`${styles.dot} ${state === "staged" ? styles.dotStaged : ""} ${state === "synced" ? styles.dotSynced : ""}`}
          aria-hidden="true"
        />
        <span className={styles.streamName}>{name}</span>
        <span className={styles.streamMeta}>
          {staged && (
            <span className={styles.chip}>v{staged.version} staged</span>
          )}
          <span className={styles.visuallyHidden} data-stream-state={state}>
            {state === "staged"
              ? "has staged changes"
              : state === "synced"
                ? "synced"
                : "no staged changes"}
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

  const syncLine = lastSyncedAt !== null
    ? `Last sync: ${formatSyncTime(lastSyncedAt)}`
    : streams.dataUpdatedAt > 0
      ? `Last sync: ${formatSyncTime(streams.dataUpdatedAt)}`
      : "Not synced in this session";

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
        {streams.isError ? (
          <p className={styles.streamsHint}>Streams unavailable</p>
        ) : streams.data && streams.data.length > 0 ? (
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
        ) : streams.isSuccess ? (
          <p className={styles.streamsHint}>No streams yet. Run Fetch.</p>
        ) : (
          <p className={styles.streamsHint}>Loading streams…</p>
        )}
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

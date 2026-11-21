import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, useLocation, useParams } from "react-router-dom";

import {
  getCampaignStreams,
  getCommittedState,
  getDraftState,
  getHealth,
} from "../../api/operations";
import { parsePositiveId } from "../campaign-workspace/campaignId";
import { queryKeys } from "../../queries/queryClient";
import styles from "./StreamsSidebar.module.css";

type StreamState = "staged" | "synced" | "idle";

function streamState(staged: boolean, synced: boolean): StreamState {
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

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <svg fill="none" height="22" viewBox="0 0 24 24" width="22">
        <rect fill="#2563EB" height="24" rx="6" width="24" />
        <path
          d="M7 6.5v11M16.5 6.5L10.5 12l6 5.5"
          stroke="#FFFFFF"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.4"
        />
      </svg>
    </span>
  );
}

function CampaignsIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.navIcon}
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 24 24"
      width="16"
    >
      <rect height="7" rx="1.5" width="7" x="3" y="3" />
      <rect height="7" rx="1.5" width="7" x="14" y="3" />
      <rect height="7" rx="1.5" width="7" x="3" y="14" />
      <rect height="7" rx="1.5" width="7" x="14" y="14" />
    </svg>
  );
}

function PlusSquareIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.navIcon}
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 24 24"
      width="16"
    >
      <rect height="18" rx="3" width="18" x="3" y="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function RecoveryIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.navIcon}
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 24 24"
      width="16"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.82 1 1.51 1H21a2 2 0 0 1 0 4h-.09c-.69 0-1.25.4-1.51 1z" />
    </svg>
  );
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
  const hasStaged = staged !== null && (staged.is_dirty || staged.version > 0);
  const synced = committed.data?.snapshot != null;
  const state = streamState(hasStaged, synced);

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
          {hasStaged && (
            <span className={styles.chip} title={staged ? `Draft version ${staged.version}` : undefined}>
              staged
            </span>
          )}
          <span className={styles.visuallyHidden} data-stream-state={state}>
            {streamStateLabel(state)}
          </span>
        </span>
      </NavLink>
    </li>
  );
}

function CampaignSidebar({ campaignId }: Readonly<{ campaignId: number }>) {

  const streams = useQuery({
    queryKey: queryKeys.campaignStreams(campaignId),
    queryFn: () => getCampaignStreams(campaignId),
    retry: false,
  });

  let syncLine = "Not synced in this session";
  if (streams.dataUpdatedAt > 0) {
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
      </div>
      <div className={styles.campaignActions}>
        <p className={styles.syncLine}>{syncLine}</p>
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

  return (
    <footer className={styles.statusFooter} aria-label="Environment status">
      <div className={styles.statusRow}>
        <p className={styles.statusLine}>
          <span
            className={`${styles.statusDot} ${isError ? styles.statusDotError : styles.statusDotOk}`}
            aria-hidden="true"
          />
          {isError ? "API unavailable" : "API Connected"}
        </p>
        <Link
          to="/recovery"
          className={styles.helpIconLink}
          aria-label="Recovery queue help"
          title="Inspect recovery queue"
        >
          ?
        </Link>
      </div>
      {data?.mode && (
        <p className={styles.statusSubline}>
          <span className={styles.envChip}>
            {data.mode === "live" ? "Live Keitaro" : "Sandbox"}
          </span>
        </p>
      )}
    </footer>
  );
}

export function StreamsSidebar() {
  const { campaignId: rawCampaignId } = useParams();
  const location = useLocation();
  const campaignId = parsePositiveId(rawCampaignId);
  const campaignsActive =
    location.pathname.startsWith("/campaigns") &&
    location.pathname !== "/campaigns/new";

  return (
    <aside className={styles.sidebar} aria-label="App sidebar">
      <div className={styles.brandBlock}>
        <Link className={styles.brand} to="/campaigns/open">
          <BrandMark />
          <span>Keitaro Wrap</span>
        </Link>
        <nav aria-label="Primary" className={styles.primaryNav}>
          <Link
            to="/campaigns/open"
            className={`${styles.navLink} ${campaignsActive ? styles.navLinkActive : ""}`}
          >
            <CampaignsIcon />
            <span>Open campaign</span>
          </Link>
          <NavLink
            to="/campaigns/new"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
          >
            <PlusSquareIcon />
            <span>Create campaign</span>
          </NavLink>
          <NavLink
            to="/recovery"
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
            }
          >
            <RecoveryIcon />
            <span>Recovery queue</span>
          </NavLink>
        </nav>
      </div>
      {campaignId !== null ? (
        <CampaignSidebar campaignId={campaignId} />
      ) : (
        <section className={styles.campaignBlock} aria-label="Campaign">
          <p className={styles.streamsHint}>
            No campaign open.{" "}
            <Link className={styles.inlineLink} to="/campaigns/open">
              Open a campaign
            </Link>{" "}
            to see its streams.
          </p>
        </section>
      )}
      <SidebarFooter />
    </aside>
  );
}

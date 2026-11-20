import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { ApiError } from "../../api/client";
import {
  fetchCampaignStreams,
  getCampaignStreams,
  type FetchOutcomeResponse,
  type StreamRefResponse,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useFocusOnChange } from "../../shared/hooks/useFocusOnChange";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { CampaignStreamCard } from "./CampaignStreamCard";
import { parseCampaignId } from "./campaignId";
import styles from "./CampaignWorkspacePage.module.css";
import { ErrorPanel, FetchSummary } from "./WorkspacePanels";

const API_UNAVAILABLE =
  "The API could not be reached. Check the local backend and try again.";

type Failure = { message: string; code: string | null };

function describeFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  return { message: API_UNAVAILABLE, code: null };
}

function CampaignIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.campaignIcon}
      fill="none"
      height="26"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width="26"
    >
      <path d="M3 11v2a1 1 0 0 0 1 1h2l14 6V4L6 10H4a1 1 0 0 0-1 1z" />
      <path d="M7 14v4a2 2 0 0 0 4 0v-3" />
    </svg>
  );
}

function StreamToggle({
  stream,
  open,
  onToggle,
}: Readonly<{
  stream: StreamRefResponse;
  open: boolean;
  onToggle: () => void;
}>) {
  const comments = stream.comments?.trim();
  return (
    <button
      type="button"
      className={styles.streamCardToggle}
      aria-expanded={open}
      aria-controls={`stream-card-${stream.stream_ref}`}
      onClick={onToggle}
    >
      <span className={styles.streamCardTitle}>
        <span className={`tnum ${styles.streamCardName}`}>
          {stream.name} · {stream.type} #{stream.stream_ref}
        </span>
        <span className={styles.streamCardMeta}>
          {stream.schema}
          {comments ? ` · ${comments}` : ""}
        </span>
      </span>
      <span
        className={`${styles.streamChevron} ${open ? styles.streamChevronOpen : ""}`}
        aria-hidden="true"
      >
        ▾
      </span>
    </button>
  );
}

function Workspace({ campaignId }: Readonly<{ campaignId: number }>) {
  const narrow = useNarrowViewport();
  const queryClient = useQueryClient();
  const [fetchOutcome, setFetchOutcome] = useState<FetchOutcomeResponse | null>(
    null,
  );
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [openStream, setOpenStream] = useState<number | "none" | null>(null);
  const statusRef = useFocusOnChange<HTMLParagraphElement>(announcement);

  const streamsQuery = useQuery({
    queryKey: queryKeys.campaignStreams(campaignId),
    queryFn: () => getCampaignStreams(campaignId),
    enabled: true,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const fetchMutation = useMutation({
    mutationFn: () => fetchCampaignStreams(campaignId),
    onSuccess: (outcome) => {
      setFetchOutcome(outcome);
      setAnnouncement(
        `Fetch complete: ${outcome.stream_count} stream(s) returned, ${outcome.conflicted_drafts} conflicted draft(s).`,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.campaignStreams(campaignId),
      });
    },
  });

  const streams = streamsQuery.data ?? [];
  const fetchFailure = describeFailure(fetchMutation.error);
  const listFailure = describeFailure(streamsQuery.error);
  const finishedWithZeroStreams = fetchOutcome?.stream_count === 0;

  const defaultStreamRef = streams[0]?.stream_ref ?? null;
  const expandedRef =
    openStream === "none" ? null : (openStream ?? defaultStreamRef);

  return (
    <section
      aria-labelledby="workspace-heading"
      aria-busy={fetchMutation.isPending || streamsQuery.isFetching}
      className={`${styles.card} ${narrow ? styles.narrow : ""}`}
    >
      <header className={styles.campaignHeader}>
        <span className={styles.campaignIconTile}>
          <CampaignIcon />
        </span>
        <div className={styles.campaignIdentity}>
          <h1 id="workspace-heading">
            Campaign <span className="tnum">#{campaignId}</span>
          </h1>
          <p className={styles.campaignSubtitle}>
            Streams are read from the local cache. Fetch is an explicit remote
            read followed by local reconciliation; it is not a publication.
          </p>
        </div>
        <div className={styles.campaignActions}>
          <button
            type="button"
            onClick={() => streamsQuery.refetch()}
            disabled={streamsQuery.isFetching}
          >
            {streamsQuery.isFetching
              ? "Reading cached streams…"
              : "Refresh cached streams"}
          </button>
          <button
            className={styles.primary}
            type="button"
            onClick={() => {
              setAnnouncement(null);
              fetchMutation.mutate();
            }}
            disabled={fetchMutation.isPending}
          >
            {fetchMutation.isPending ? "Fetching streams…" : "Fetch streams"}
          </button>
        </div>
      </header>

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

      {fetchMutation.isPending && (
        <output className={styles.pending}>
          Fetch is running. Duplicate submissions are disabled.
        </output>
      )}

      {streamsQuery.isError && (
        <ErrorPanel
          heading="Cached stream list unavailable"
          message={listFailure.message}
          code={listFailure.code}
          retryLabel="Retry cached list read"
          onRetry={() => streamsQuery.refetch()}
          retryDisabled={streamsQuery.isFetching}
        />
      )}

      {fetchMutation.isError && (
        <ErrorPanel
          heading="Fetch failed"
          message={fetchFailure.message}
          code={fetchFailure.code}
          retryLabel="Retry Fetch streams"
          onRetry={() => fetchMutation.mutate()}
          retryDisabled={fetchMutation.isPending}
        />
      )}

      {fetchOutcome && <FetchSummary outcome={fetchOutcome} />}

      <section aria-labelledby="streams-heading" className={styles.streams}>
        <h2 id="streams-heading">Streams</h2>
        {streamsQuery.isPending && (
          <output>Loading cached stream references…</output>
        )}
        {finishedWithZeroStreams && (
          <p className={styles.empty}>
            Fetch completed and returned zero streams.
          </p>
        )}
        {!finishedWithZeroStreams &&
          streamsQuery.isSuccess &&
          streams.length === 0 && (
            <p className={styles.empty}>
              No cached stream references are available yet. Fetch streams to
              read this campaign from Keitaro and update the local cache.
            </p>
          )}
        {streams.length > 0 && (
          <ul aria-label="Cached stream references" className={styles.streamList}>
            {streams.map((stream) => {
              const open = expandedRef === stream.stream_ref;
              return (
                <li className={styles.streamCard} key={stream.stream_ref}>
                  <StreamToggle
                    stream={stream}
                    open={open}
                    onToggle={() =>
                      setOpenStream(open ? "none" : stream.stream_ref)
                    }
                  />
                  {open && (
                    <div id={`stream-card-${stream.stream_ref}`}>
                      <CampaignStreamCard
                        campaignId={campaignId}
                        streamRef={stream.stream_ref}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className={styles.hint}>
        Local / trusted environment only. No campaign list or remote cache
        timestamp is exposed by the current API.
      </p>
    </section>
  );
}

export function CampaignWorkspacePage() {
  const { campaignId: rawCampaignId } = useParams();
  const campaignId = parseCampaignId(rawCampaignId);

  if (campaignId === null) {
    return (
      <section aria-labelledby="invalid-campaign-heading" className={styles.card}>
        <h1 id="invalid-campaign-heading">Invalid Campaign ID</h1>
        <p>
          The campaign ID in the URL must be a positive whole number within the
          safe integer range. No API request was made.
        </p>
        <Link to="/campaigns/open">Enter a Campaign ID</Link>
      </section>
    );
  }

  return <Workspace key={campaignId} campaignId={campaignId} />;
}

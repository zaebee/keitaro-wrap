import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { ApiError } from "../../api/client";
import {
  fetchCampaignStreams,
  getCampaignStreams,
  type FetchOutcomeResponse,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { parseCampaignId } from "./campaignId";
import styles from "./CampaignWorkspacePage.module.css";
import {
  ErrorPanel,
  FetchSummary,
  StreamList,
} from "./WorkspacePanels";

const API_UNAVAILABLE =
  "The API could not be reached. Check the local backend and try again.";

type Failure = { message: string; code: string | null };

function describeFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  return { message: API_UNAVAILABLE, code: null };
}

function Workspace({ campaignId }: Readonly<{ campaignId: number }>) {
  const narrow = useNarrowViewport();
  const queryClient = useQueryClient();
  const [fetchOutcome, setFetchOutcome] = useState<FetchOutcomeResponse | null>(
    null,
  );

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
      void queryClient.invalidateQueries({
        queryKey: queryKeys.campaignStreams(campaignId),
      });
    },
  });

  const streams = streamsQuery.data ?? [];
  const fetchFailure = describeFailure(fetchMutation.error);
  const listFailure = describeFailure(streamsQuery.error);
  const finishedWithZeroStreams = fetchOutcome?.stream_count === 0;

  return (
    <section
      aria-labelledby="workspace-heading"
      aria-busy={fetchMutation.isPending || streamsQuery.isFetching}
      className={`${styles.card} ${narrow ? styles.narrow : ""}`}
    >
      <h1 id="workspace-heading">Campaign Workspace</h1>
      <p className={styles.campaignId}>Campaign ID: {campaignId}</p>
      <p className={styles.hint}>
        Stream references are read from the local cache. Fetch is an explicit
        remote read followed by local reconciliation; it is not a publication.
      </p>

      <div className={styles.actions}>
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
          onClick={() => fetchMutation.mutate()}
          disabled={fetchMutation.isPending}
        >
          {fetchMutation.isPending ? "Fetching streams…" : "Fetch streams"}
        </button>
      </div>

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
        <h2 id="streams-heading">Cached stream references</h2>
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
        {streams.length > 0 && <StreamList streams={streams} />}
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

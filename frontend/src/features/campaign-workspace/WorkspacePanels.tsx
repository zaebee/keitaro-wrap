import type { FetchOutcomeResponse, StreamRefResponse } from "../../api/operations";
import styles from "./CampaignWorkspacePage.module.css";

export function FetchSummary({
  outcome,
}: Readonly<{ outcome: FetchOutcomeResponse }>) {
  return (
    <section
      aria-labelledby="fetch-summary-heading"
      className={styles.summary}
    >
      <h2 id="fetch-summary-heading">Fetch summary</h2>
      <dl className={styles.summaryGrid}>
        <dt>Campaign ID</dt>
        <dd>{outcome.campaign_id}</dd>
        <dt>Streams returned</dt>
        <dd>{outcome.stream_count}</dd>
        <dt>Streams reconciled</dt>
        <dd>{outcome.reconciled_stream_count}</dd>
        <dt>Bindings created</dt>
        <dd>{outcome.created_bindings}</dd>
        <dt>Bindings archived</dt>
        <dd>{outcome.archived_bindings}</dd>
        <dt>Bindings reactivated</dt>
        <dd>{outcome.reactivated_bindings}</dd>
        <dt>Share updates</dt>
        <dd>{outcome.share_updates}</dd>
        <dt>Conflicted drafts</dt>
        <dd>{outcome.conflicted_drafts}</dd>
      </dl>
      <p className={styles.hint}>
        Counts are returned by the backend Fetch operation. Conflicts are
        display-only in this slice; Fetch does not publish changes.
      </p>
    </section>
  );
}

export function StreamList({
  streams,
}: Readonly<{ streams: StreamRefResponse[] }>) {
  return (
    <ul aria-label="Cached stream references" className={styles.streamList}>
      {streams.map((stream) => {
        const comments = stream.comments?.trim();
        return (
          <li className={styles.streamItem} key={stream.stream_ref}>
            <h3>Stream {stream.stream_ref}</h3>
            <dl className={styles.streamFields}>
              <dt>Name</dt>
              <dd>{stream.name}</dd>
              <dt>Stream ref</dt>
              <dd>{stream.stream_ref}</dd>
              <dt>Type</dt>
              <dd>{stream.type}</dd>
              <dt>Schema</dt>
              <dd>{stream.schema}</dd>
              {comments && (
                <>
                  <dt>Comments</dt>
                  <dd>{comments}</dd>
                </>
              )}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

type ErrorPanelProps = Readonly<{
  heading: string;
  message: string;
  code: string | null;
  retryLabel: string;
  onRetry: () => void;
  retryDisabled: boolean;
}>;

export function ErrorPanel({
  heading,
  message,
  code,
  retryLabel,
  onRetry,
  retryDisabled,
}: ErrorPanelProps) {
  return (
    <div className={styles.errorPanel} role="alert">
      <h2>{heading}</h2>
      <p>{message}</p>
      {code && <p className={styles.hint}>API error code: {code}</p>}
      <button type="button" onClick={onRetry} disabled={retryDisabled}>
        {retryLabel}
      </button>
    </div>
  );
}

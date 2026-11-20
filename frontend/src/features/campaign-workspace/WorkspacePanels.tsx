import type { FetchOutcomeResponse } from "../../api/operations";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
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
    <ErrorSummary
      heading={heading}
      message={message}
      code={code}
      retryLabel={retryLabel}
      onRetry={onRetry}
      retryDisabled={retryDisabled}
    />
  );
}

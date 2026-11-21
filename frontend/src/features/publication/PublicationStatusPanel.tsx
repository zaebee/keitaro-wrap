import type { PublicationStateResponse } from "../../api/operations";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import { PublicationOperationCard } from "./PublicationOperationCard";
import { isValidPublicationState } from "./publicationValidation";
import styles from "./Publication.module.css";

type ReadFailure = { message: string; code: string | null };

const STREAM_REF_MISMATCH =
  "The publication status response does not match the requested stream.";

export function PublicationReadError({
  heading,
  message,
  code,
  retryLabel,
  onRetry,
  retryDisabled,
}: ReadFailure & {
  heading: string;
  retryLabel: string;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
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

function StatusSummaryBanner({
  status,
}: Readonly<{ status: NonNullable<PublicationStateResponse["operation"]>["status"] }>) {
  const labelMap: Record<string, string> = {
    succeeded: "Succeeded",
    pending: "Pending",
    in_progress: "In progress",
    failed: "Failed",
    ambiguous: "Ambiguous",
    abandoned: "Abandoned",
  };
  const label = labelMap[status] ?? status;
  const isOk = status === "succeeded";
  const isErr = status === "failed" || status === "ambiguous";

  let circleClass = styles.pubCirclePending;
  if (isOk) {
    circleClass = styles.pubCircleOk;
  } else if (isErr) {
    circleClass = styles.pubCircleErr;
  }
  let textClass = styles.pubTextPending;
  if (isOk) {
    textClass = styles.pubTextOk;
  } else if (isErr) {
    textClass = styles.pubTextErr;
  }
  let circleContent = "…";
  if (isOk) {
    circleContent = "✓";
  } else if (isErr) {
    circleContent = "!";
  }

  return (
    <div className={styles.pubSummaryRow}>
      <span
        className={`${styles.pubStatusCircle} ${circleClass}`}
        aria-hidden="true"
      >
        {circleContent}
      </span>
      <div className={styles.pubSummaryText}>
        <span className={styles.pubSummaryLabel}>Latest publication:</span>
        <span
          className={`${styles.pubSummaryState} ${textClass}`}
          data-status={status}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

export function PublicationStatusPanel({
  state,
  expectedCampaignId,
  expectedStreamRef,
  isPending,
  error,
  onRetry,
  retryDisabled,
}: Readonly<{
  state: PublicationStateResponse | null;
  expectedCampaignId: number;
  expectedStreamRef: number;
  isPending: boolean;
  error: ReadFailure | null;
  onRetry: () => void;
  retryDisabled: boolean;
}>) {
  if (isPending) {
    return <output>Loading latest publication status…</output>;
  }
  if (error) {
    return (
      <PublicationReadError
        heading="Latest publication status unavailable"
        message={error.message}
        code={error.code}
        retryLabel="Retry publication status read"
        onRetry={onRetry}
        retryDisabled={retryDisabled}
      />
    );
  }
  if (state === null) {
    return <p className={styles.empty}>Publication status is unavailable.</p>;
  }
  if (
    !isValidPublicationState(state, {
      campaignId: expectedCampaignId,
      streamRef: expectedStreamRef,
    })
  ) {
    return (
      <PublicationReadError
        heading="Latest publication status unavailable"
        message={STREAM_REF_MISMATCH}
        code={null}
        retryLabel="Retry publication status read"
        onRetry={onRetry}
        retryDisabled={retryDisabled}
      />
    );
  }
  if (state.operation === null) {
    return (
      <p className={styles.empty}>
        No publication recorded for this stream.
      </p>
    );
  }

  return (
    <div>
      <StatusSummaryBanner status={state.operation.status} />
      <ul className={styles.operationList}>
        <PublicationOperationCard operation={state.operation} hideStatusBadge />
      </ul>
      <p className={styles.hint}>
        This is the latest backend status for this stream at read time. It is a
        point-in-time view, not publication history or proof of a global state.
      </p>
    </div>
  );
}

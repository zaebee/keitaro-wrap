import type { PublicationStateResponse } from "../../api/operations";
import { PublicationOperationCard } from "./PublicationOperationCard";
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
    <div className={styles.errorPanel} role="alert">
      <h3>{heading}</h3>
      <p>{message}</p>
      {code && <p className={styles.hint}>API error code: {code}</p>}
      <button type="button" onClick={onRetry} disabled={retryDisabled}>
        {retryLabel}
      </button>
    </div>
  );
}

export function PublicationStatusPanel({
  state,
  expectedStreamRef,
  isPending,
  error,
  onRetry,
  retryDisabled,
}: Readonly<{
  state: PublicationStateResponse | null;
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
    state.stream_ref !== expectedStreamRef ||
    (state.operation !== null &&
      state.operation.stream_ref !== expectedStreamRef)
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
      <ul className={styles.operationList}>
        <PublicationOperationCard operation={state.operation} />
      </ul>
      <p className={styles.hint}>
        This is the latest backend status for this stream at read time. It is a
        point-in-time view, not publication history or proof of a global state.
      </p>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { ApiError } from "../../api/client";
import {
  getRecoverablePublications,
  RECOVERABLE_PUBLICATIONS_LIMIT,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { PublicationOperationCard } from "./PublicationOperationCard";
import { PublicationReadError } from "./PublicationStatusPanel";
import styles from "./Publication.module.css";

function describeFailure(error: unknown): { message: string; code: string | null } {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  return {
    message: "The API could not be reached. Check the local backend and try again.",
    code: null,
  };
}

export function RecoveryQueuePage() {
  const narrow = useNarrowViewport();
  const queueQuery = useQuery({
    queryKey: queryKeys.recoverablePublications,
    queryFn: getRecoverablePublications,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const operations = queueQuery.data ?? [];
  const potentiallyTruncated = operations.length >= RECOVERABLE_PUBLICATIONS_LIMIT;

  return (
    <section
      aria-labelledby="recovery-heading"
      className={`${styles.panel} ${narrow ? styles.narrow : ""}`}
      aria-busy={queueQuery.isFetching}
    >
      <h1 id="recovery-heading">Recoverable publications</h1>
      <p>
        Bounded, point-in-time queue of unresolved publication operations. This
        is a read-only screen: no recovery, Push or Cancel action is available.
      </p>
      <p className={styles.hint}>
        The recoverable queue is a separate concept from the latest publication
        status shown in an individual stream editor.
      </p>

      {queueQuery.isPending && <output>Loading recoverable publications…</output>}
      {queueQuery.isError &&
        (() => {
          const failure = describeFailure(queueQuery.error);
          return (
            <PublicationReadError
              heading="Recoverable publications unavailable"
              message={failure.message}
              code={failure.code}
              retryLabel="Retry queue read"
              onRetry={() => queueQuery.refetch()}
              retryDisabled={queueQuery.isFetching}
            />
          );
        })()}

      {queueQuery.isSuccess && (
        <>
          <div
            className={`${styles.completeness} ${potentiallyTruncated ? styles.truncated : ""}`}
          >
            {potentiallyTruncated ? (
              <p>
                Potentially truncated: the API returns at most{" "}
                {RECOVERABLE_PUBLICATIONS_LIMIT} records. An operation absent
                from this response is not proven resolved.
              </p>
            ) : (
              <p>
                Complete for this read: fewer than{" "}
                {RECOVERABLE_PUBLICATIONS_LIMIT} unresolved records were
                returned. This is still a point-in-time snapshot; state may
                change concurrently.
              </p>
            )}
          </div>

          {operations.length === 0 ? (
            <p className={styles.empty}>
              {"No unresolved operations were returned in this bounded view. This does not prove global or permanent resolution."}
            </p>
          ) : (
            <ul aria-label="Recoverable publication operations" className={styles.operationList}>
              {operations.map((operation) => (
                <PublicationOperationCard
                  key={operation.operation_uuid}
                  operation={operation}
                />
              ))}
            </ul>
          )}
          <p className={styles.hint}>
            This screen never claims global recovery completion. Current state
            must be re-read before any later operator action.
          </p>
        </>
      )}

      <p>
        <Link to="/campaigns/open">Open a campaign</Link>
      </p>
    </section>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../../api/client";
import {
  cancelPublication,
  getDraftState,
  getPublicationState,
  getRecoverablePublications,
  RECOVERABLE_PUBLICATIONS_LIMIT,
  runRecoveryPass,
  type RecoveryResultResponse,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { PublicationOperationCard } from "./PublicationOperationCard";
import { PublicationReadError } from "./PublicationStatusPanel";
import {
  hasMatchingStreamIdentity,
  identitiesFromQueue,
  isTerminalPublicationState,
  isValidDraftState,
  isValidPublicationState,
  parseCancelErrorDetails,
  parseCancelResult,
  parseRecoverableQueue,
  parseRecoveryResult,
  streamUnionFingerprint,
  type StreamIdentity,
} from "./publicationValidation";
import {
  verifyCancelLock,
  type CancelVerificationMode,
} from "./publicationLockVerification";
import styles from "./Publication.module.css";
import { usePublicationRecoveryLock } from "./usePublicationRecoveryLock";

type Failure = {
  message: string;
  code: string | null;
  result: RecoveryResultResponse | null;
};

type RecoveryRunOutcome = {
  result: RecoveryResultResponse | null;
  failure: Failure | null;
  unionUpdated: boolean;
  phaseUpdated: boolean;
};

function describeFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      code: error.code,
      result: parseRecoveryResult(error.details.result),
    };
  }
  return {
    message: "The API could not be reached. Check the local backend and try again.",
    code: null,
    result: null,
  };
}

function resultHeading(result: RecoveryResultResponse, degraded: boolean): string {
  if (degraded) {
    return "Recovery pass did not complete cleanly";
  }
  if (
    result.remaining > 0 ||
    result.unresolved > 0 ||
    result.degraded > 0 ||
    result.deadline_reached
  ) {
    return "Bounded pass finished with unresolved work";
  }
  return "Recovery pass completed";
}

function RecoveryResultSummary({
  result,
  degraded,
}: Readonly<{ result: RecoveryResultResponse; degraded: boolean }>) {
  return (
    <div className={styles.recoveryPanel}>
      <h2>{resultHeading(result, degraded || result.degraded > 0)}</h2>
      <dl className={styles.counters}>
        <dt>Processed</dt>
        <dd>{result.processed}</dd>
        <dt>Confirmed</dt>
        <dd>{result.confirmed}</dd>
        <dt>Unresolved</dt>
        <dd>{result.unresolved}</dd>
        <dt>Degraded</dt>
        <dd>{result.degraded}</dd>
        <dt>Remaining</dt>
        <dd>{result.remaining}</dd>
        <dt>Deadline reached</dt>
        <dd>{String(result.deadline_reached)}</dd>
      </dl>
      <p className={styles.hint}>
        These counters describe the request and the bounded pass only. They do
        not prove that all operations are resolved; current state must be
        re-read.
      </p>
    </div>
  );
}

export function RecoveryQueuePage() {
  const narrow = useNarrowViewport();
  const queryClient = useQueryClient();
  const queueQuery = useQuery({
    queryKey: queryKeys.recoverablePublications,
    queryFn: getRecoverablePublications,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const lock = usePublicationRecoveryLock();
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [verificationMessage, setVerificationMessage] = useState<string | null>(
    null,
  );
  const [unlockInFlight, setUnlockInFlight] = useState(false);
  const unlockRef = useRef(false);
  const [retryInFlight, setRetryInFlight] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const recoveryMutation = useMutation<RecoveryRunOutcome>({
    mutationFn: async () => {
      let result: RecoveryResultResponse | null = null;
      let failure: Failure | null = null;
      try {
        const raw = await runRecoveryPass();
        const parsed = parseRecoveryResult(raw);
        if (parsed === null) {
          failure = {
            message:
              "The recovery response was malformed. The outcome is unknown.",
            code: null,
            result: null,
          };
        } else {
          result = parsed;
        }
      } catch (error) {
        failure = describeFailure(error);
      }

      let unionUpdated = false;
      try {
        const queue = await getRecoverablePublications();
        const parsed = parseRecoverableQueue(queue);
        if (parsed !== null) {
          queryClient.setQueryData(queryKeys.recoverablePublications, parsed);
          unionUpdated = await lock.updateAffected(
            identitiesFromQueue(parsed),
            parsed.length < RECOVERABLE_PUBLICATIONS_LIMIT,
          );
        }
      } catch {
        unionUpdated = false;
      }

      const phaseUpdated = await lock.markVerification(unionUpdated);
      if (!phaseUpdated) {
        return {
          result: null,
          failure: {
            message:
              "Could not persist the recovery phase transition. The lock remains in running phase.",
            code: null,
            result: null,
          },
          unionUpdated,
          phaseUpdated: false,
        };
      }
      return { result, failure, unionUpdated, phaseUpdated };
    },
  });

  const parsedQueue = queueQuery.isSuccess
    ? parseRecoverableQueue(queueQuery.data)
    : null;
  const queueInvalid = queueQuery.isSuccess && parsedQueue === null;
  const operations = parsedQueue ?? [];
  const potentiallyTruncated =
    operations.length >= RECOVERABLE_PUBLICATIONS_LIMIT;
  const locked = lock.lock !== null || lock.invalid;
  const recoveryReady =
    lock.lock?.kind === "cancel" && lock.lock.stage === "recovery_ready";
  const retryReady =
    lock.lock?.kind === "cancel" && lock.lock.stage === "retry_ready";
  const mutationDisabled =
    (!recoveryReady && locked) ||
    recoveryMutation.isPending ||
    queueQuery.isFetching ||
    parsedQueue === null;

  const confirmRecovery = async () => {
    setConfirming(false);
    setActionError(null);
    setVerificationError(null);
    setVerificationMessage(null);
    let freshQueue;
    try {
      const response = await getRecoverablePublications();
      freshQueue = parseRecoverableQueue(response);
      if (freshQueue === null) {
        throw new Error("malformed queue");
      }
      queryClient.setQueryData(queryKeys.recoverablePublications, freshQueue);
    } catch {
      setActionError(
        "A fresh valid queue snapshot is required before recovery can start.",
      );
      return;
    }
    if (lock.lock !== null && recoveryReady) {
      const unionUpdated = await lock.updateAffected(
        identitiesFromQueue(freshQueue),
        freshQueue.length < RECOVERABLE_PUBLICATIONS_LIMIT,
      );
      if (!unionUpdated) {
        setActionError(
          "Could not update the handed-off lock. No recovery pass was started.",
        );
        return;
      }
      const running = await lock.markStage("running");
      if (!running) {
        setActionError(
          "Could not persist the recovery phase. No recovery pass was started.",
        );
        return;
      }
      recoveryMutation.mutate();
      return;
    }
    const acquired = await lock.acquire(
      identitiesFromQueue(freshQueue),
      "verification",
      freshQueue.length < RECOVERABLE_PUBLICATIONS_LIMIT,
    );
    if (!acquired) {
      setActionError(
        "Could not persist the recovery lock. No recovery pass was started.",
      );
      return;
    }
    recoveryMutation.mutate();
  };

  const verifyUnlock = async () => {
    if (unlockRef.current) {
      return;
    }
    unlockRef.current = true;
    setUnlockInFlight(true);
    setVerificationError(null);
    setVerificationMessage(null);
    try {
      await lock.runExclusive(async (context) => {
        const initial = context.getCurrent();
        if (initial === null) {
          setVerificationError(
            "The persisted lock state is unavailable. The lock remains active.",
          );
          return;
        }
        if (initial.kind === "cancel") {
          const target = initial.affected[0];
          if (target === undefined) {
            setVerificationError(
              "No tracked stream identities are available. The lock remains active.",
            );
            return;
          }
          const result = await verifyCancelLock(context, {
            mode: "recovery",
            target,
            onQueue: (queue) => {
              queryClient.setQueryData(queryKeys.recoverablePublications, queue);
            },
          });
          if (result.status === "released") {
            setVerificationMessage(
              "No unresolved operations in the current bounded read; previously tracked stream identities re-read successfully.",
            );
          } else {
            setVerificationError(result.message);
          }
          return;
        }
        if (initial.phase !== "verification") {
          setVerificationError(
            "Recovery POST is still running; GET reconciliation is disabled.",
          );
          return;
        }
        const queue = await getRecoverablePublications();
        const parsed = parseRecoverableQueue(queue);
        if (parsed === null) {
          setVerificationError(
            "The bounded queue response was malformed. The lock remains active.",
          );
          return;
        }
        queryClient.setQueryData(queryKeys.recoverablePublications, parsed);
        const merged = await context.updateAffected(
          identitiesFromQueue(parsed),
          parsed.length < RECOVERABLE_PUBLICATIONS_LIMIT,
        );
        if (!merged) {
          setVerificationError(
            "Could not persist the affected identity union. The lock remains active.",
          );
          return;
        }
        if (parsed.length >= RECOVERABLE_PUBLICATIONS_LIMIT) {
          setVerificationError(
            "The current queue read is potentially truncated. The lock remains active.",
          );
          return;
        }
        if (parsed.length > 0) {
          setVerificationError(
            `${parsed.length} unresolved operation(s) remain in the complete bounded read. The lock remains active.`,
          );
          return;
        }

        const current = context.getCurrent();
        if (current === null) {
          setVerificationError(
            "The persisted lock state is unavailable. The lock remains active.",
          );
          return;
        }
        if (!current.unionComplete) {
          setVerificationError(
            "The affected identity union is incomplete. The lock remains active.",
          );
          return;
        }
        const expected = {
          lockId: current.lockId,
          fingerprint: streamUnionFingerprint(current.affected),
        };
        const statusChecks = await Promise.all(
          current.affected.map(async (identity: StreamIdentity) => {
            try {
              const state = await getPublicationState(
                identity.campaignId,
                identity.streamRef,
              );
              return isTerminalPublicationState(state, identity);
            } catch {
              return false;
            }
          }),
        );
        if (!statusChecks.every(Boolean)) {
          setVerificationError(
            "One or more tracked stream states could not be validated. The lock remains active.",
          );
          return;
        }
        const released = await context.release(expected);
        if (!released) {
          setVerificationError(
            "The persisted lock changed during verification. The lock remains active.",
          );
          return;
        }
        setVerificationMessage(
          "No unresolved operations in the current bounded read; previously tracked stream identities re-read successfully.",
        );
      });
    } catch {
      setVerificationError(
        "Authoritative GET re-read failed. The lock remains active.",
      );
    } finally {
      unlockRef.current = false;
      setUnlockInFlight(false);
    }
  };

  const retryCancel = async () => {
    if (retryInFlight || !retryReady || lock.lock === null) {
      return;
    }
    setRetryInFlight(true);
    setRetryError(null);
    setRetryMessage(null);
    const current = lock.getCurrent();
    const target = current?.draftVerification[0] ?? current?.affected[0];
    if (current === null || target === undefined) {
      setRetryError("No tracked stream identity is available for retry.");
      setRetryInFlight(false);
      return;
    }
    try {
      let freshState;
      let freshDraft;
      try {
        const rawState = await getPublicationState(
          target.campaignId,
          target.streamRef,
        );
        if (!isValidPublicationState(rawState, target)) {
          throw new Error("status mismatch");
        }
        const rawDraft = await getDraftState(
          target.campaignId,
          target.streamRef,
        );
        if (!isValidDraftState(rawDraft, target)) {
          throw new Error("draft mismatch");
        }
        const rawQueue = await getRecoverablePublications();
        const parsedQueue = parseRecoverableQueue(rawQueue);
        if (parsedQueue === null) {
          throw new Error("queue mismatch");
        }
        freshState = rawState;
        freshDraft = rawDraft;
        queryClient.setQueryData(queryKeys.recoverablePublications, parsedQueue);
      } catch {
        setRetryError(
          "Fresh authoritative status, draft and queue reads are required before retry.",
        );
        return;
      }
      if (freshState.operation === null || freshState.operation.status !== "pending") {
        setRetryMessage(
          "The operation is no longer pending. No retry Cancel was sent.",
        );
        return;
      }
      const running = await lock.markStage("running");
      if (!running) {
        setRetryError(
          "The running phase could not be persisted. No retry Cancel was sent.",
        );
        return;
      }
      let mode: CancelVerificationMode = "unknown";
      let code: string | undefined;
      try {
        const result = parseCancelResult(
          await cancelPublication(target.campaignId, target.streamRef),
          target,
        );
        if (result !== null && result.status === "abandoned") {
          mode = "success";
        } else if (result?.reason === "NO_PUBLICATION") {
          mode = "noop";
        }
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === "STREAM_NOT_FOUND" &&
          hasMatchingStreamIdentity(error.details, target)
        ) {
          mode = "refusal";
          code = "STREAM_NOT_FOUND";
        } else if (error instanceof ApiError && error.status === 409) {
          if (parseCancelErrorDetails(error.details) !== null) {
            mode = "refusal";
            code = error.code;
          }
        }
      }
      const verification = await lock.runExclusive((context) =>
        verifyCancelLock(context, {
          mode,
          code,
          target,
          preDraftVersion: freshDraft.draft?.version,
          onQueue: (queue) => {
            queryClient.setQueryData(queryKeys.recoverablePublications, queue);
          },
        }),
      );
      setRetryMessage(verification.message);
    } catch {
      setRetryError("The retry Cancel outcome is unknown. No automatic retry was made.");
    } finally {
      setRetryInFlight(false);
    }
  };

  const run = recoveryMutation.data;

  return (
    <section
      aria-labelledby="recovery-heading"
      className={`${styles.panel} ${narrow ? styles.narrow : ""}`}
      aria-busy={
        queueQuery.isFetching ||
        recoveryMutation.isPending ||
        lock.lock !== null
      }
      data-recovery-lock={locked ? "active" : "inactive"}
    >
      <h1 id="recovery-heading">Recoverable publications</h1>
      <p>
        Bounded, point-in-time queue of unresolved publication operations.
        Reads are always available; recovery runs only after explicit
        confirmation and may change local publication state. Push stays
        disabled. Publication Cancel is offered in the stream editor; pending
        cancel retries and lock verification are available here.
      </p>
      <p className={styles.hint}>
        The recoverable queue is a separate concept from the latest publication
        status shown in an individual stream editor.
      </p>

      {lock.lock && (
        <output className={styles.lockBanner}>
          <h2>Recovery lock active</h2>
          <p>
            {lock.lock.affected.length} tracked stream identity/identities.
            {lock.lock.kind === "cancel" && lock.lock.stage === "recovery_ready"
              ? " Recovery is required; the cancel lock was handed to explicit recovery."
              : lock.lock.kind === "cancel" && lock.lock.stage === "retry_ready"
                ? " The publication is still pending; an explicit cancel retry is required."
                : lock.lock.phase === "running"
                  ? " Recovery POST is still running; GET reconciliation is disabled."
                  : " Read-only actions remain available; further recovery passes are blocked until authoritative GET re-read succeeds."}
          </p>
          <button
            type="button"
            onClick={() => void verifyUnlock()}
            disabled={
              queueQuery.isFetching ||
              unlockInFlight ||
              recoveryMutation.isPending ||
              lock.lock?.phase !== "verification"
            }
          >
            Re-read authoritative state
          </button>
        </output>
      )}
      {verificationError && (
        <p className={styles.fieldError} role="alert">
          {verificationError}
        </p>
      )}
      {verificationMessage && <output>{verificationMessage}</output>}
      {retryMessage && <output>{retryMessage}</output>}
      {retryError && (
        <p className={styles.fieldError} role="alert">
          {retryError}
        </p>
      )}
      {lock.invalid && (
        <div className={styles.lockBanner} role="alert">
          <h2>Recovery lock state unavailable</h2>
          <p>
            The persisted lock is malformed. Consequential actions are blocked;
            no force-clear is offered.
          </p>
        </div>
      )}

      {actionError && <p className={styles.fieldError} role="alert">{actionError}</p>}

      {(!locked || recoveryReady) && !confirming && (
        <div className={styles.inlineActions}>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={mutationDisabled}
          >
            Run recovery
          </button>
          {parsedQueue === null && queueQuery.isSuccess && (
            <p className={styles.fieldError}>
              A valid queue snapshot is required before recovery can start.
            </p>
          )}
        </div>
      )}
      {(!locked || recoveryReady) && confirming && (
        <fieldset className={styles.confirm}>
          <legend>Confirm recovery pass</legend>
          <p>
            Run one bounded recovery pass? It reads Keitaro but may durably
            change local publication state. No automatic retry or live write is
            performed.
          </p>
          <button type="button" onClick={() => void confirmRecovery()}>
            Confirm recovery
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Keep queue unchanged
          </button>
        </fieldset>
      )}

      {retryReady && (
        <fieldset className={styles.confirm}>
          <legend>Confirm cancel retry</legend>
          <p>
            Fresh authoritative reads show the publication is still pending.
            Send one more local Cancel under the existing lock? No automatic
            retry and no Keitaro request are performed.
          </p>
          <button
            type="button"
            onClick={() => void retryCancel()}
            disabled={retryInFlight || queueQuery.isFetching}
          >
            Confirm cancel retry
          </button>
        </fieldset>
      )}

      {recoveryMutation.isPending && (
        <output>Recovery pass is running. Duplicate submissions are disabled.</output>
      )}
      {run?.phaseUpdated === false && (
        <p className={styles.fieldError} role="alert">
          The recovery phase transition could not be persisted. The lock
          remains active in running phase and unlock is blocked.
        </p>
      )}
      {run?.unionUpdated === false && (
        <p className={styles.fieldError} role="alert">
          The affected identity union could not be persisted. The lock remains
          active and unlock is blocked.
        </p>
      )}
      {run?.failure && (
        <div className={styles.errorPanel} role="alert">
          <h2>Recovery outcome unknown or incomplete</h2>
          <p>{run.failure.message}</p>
          {run.failure.code && (
            <p className={styles.hint}>API error code: {run.failure.code}</p>
          )}
          {run.failure.result && (
            <RecoveryResultSummary result={run.failure.result} degraded />
          )}
        </div>
      )}
      {run?.result && <RecoveryResultSummary result={run.result} degraded={false} />}

      {queueQuery.isPending && <output>Loading recoverable publications…</output>}
      {queueQuery.isError && (() => {
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
      {queueInvalid && (
        <PublicationReadError
          heading="Recoverable publications unavailable"
          message="The bounded queue response was malformed."
          code={null}
          retryLabel="Retry queue read"
          onRetry={() => queueQuery.refetch()}
          retryDisabled={queueQuery.isFetching}
        />
      )}

      {parsedQueue !== null && (
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

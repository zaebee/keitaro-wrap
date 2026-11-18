import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import {
  ApiError,
  type CampaignCreationResponse,
} from "../../api/client";
import {
  createCampaign,
  getCampaignOperation,
  resumeCampaignOperation,
  type CampaignIntent,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { clearAttempt, resolveAttempt } from "./operationStorage";
import {
  NewAttemptConfirmation,
  NewAttemptPanel,
  OperationDetails,
  OperationErrorPanel,
  ResumePanel,
  type PendingAction,
} from "./OperationPanels";
import styles from "./OperationPage.module.css";

type LocationState = {
  autoCreate?: boolean;
  operation_uuid?: string;
  intent?: CampaignIntent;
} | null;

const NON_TERMINAL = new Set(["started", "partial", "ambiguous"]);

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return "The request outcome is unknown. Check operation status before acting.";
}

function retryablePostError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status >= 500;
  }
  return true;
}

function resolveStateIntent(
  state: LocationState,
  operationUuid: string | null,
): CampaignIntent | null {
  if (state?.operation_uuid !== operationUuid || !state.intent) {
    return null;
  }
  return state.intent;
}

function shouldAutoCreate(
  state: LocationState,
  routeUuid: string | undefined,
  stateIntent: CampaignIntent | null,
): boolean {
  return Boolean(state?.autoCreate && routeUuid && stateIntent);
}

function canRetrySameUuid(
  intent: CampaignIntent | null,
  postFailure: unknown,
  missingOperation: boolean,
): boolean {
  if (!intent) {
    return false;
  }
  if (postFailure) {
    return retryablePostError(postFailure);
  }
  return missingOperation;
}

function canStartNewAttempt(
  missingOperation: boolean,
  postFailure: unknown,
  status: string | null,
): boolean {
  if (missingOperation) {
    return true;
  }
  if (
    postFailure instanceof ApiError &&
    postFailure.code === "IDEMPOTENCY_KEY_REUSED"
  ) {
    return true;
  }
  return Boolean(status && !NON_TERMINAL.has(status));
}

function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return error instanceof ApiError && error.status >= 500 && failureCount < 1;
}

function pollingInterval(query: {
  state: { data?: CampaignCreationResponse | null };
}): number | false {
  const status = query.state.data?.status ?? null;
  return status && NON_TERMINAL.has(status) ? 2000 : false;
}

function statusMessage(status: string | null): string {
  return status ? `Operation status: ${status}` : "Status unavailable";
}

export function OperationPage() {
  const { operationUuid: routeUuid } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrowViewport();
  const state = location.state as LocationState;
  const attempt = resolveAttempt();
  const operationUuid = routeUuid ?? attempt.operationUuid;
  const mismatch = attempt.mismatch;
  const stateIntent = resolveStateIntent(state, operationUuid);
  const autoCreate = shouldAutoCreate(state, routeUuid, stateIntent);
  const intent = stateIntent ?? attempt.intent;

  const [postPhase, setPostPhase] = useState<"idle" | "posting" | "posted" | "error">(
    autoCreate ? "posting" : "idle",
  );
  const [postResult, setPostResult] = useState<CampaignCreationResponse | null>(null);
  const [created, setCreated] = useState<boolean | null>(null);
  const [postError, setPostError] = useState<unknown>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const startedRef = useRef<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!routeUuid && attempt.operationUuid) {
      navigate(`/campaign-creations/${attempt.operationUuid}`, { replace: true });
    }
  }, [attempt.operationUuid, navigate, routeUuid]);

  const createMutation = useMutation({
    mutationFn: createCampaign,
    onSuccess: (outcome) => {
      setPostResult(outcome.operation);
      setCreated(outcome.created);
      setPostError(null);
      setPostPhase("posted");
      setPendingAction(null);
    },
    onError: (error: unknown) => {
      setPostError(error);
      setPostPhase("error");
    },
  });

  useEffect(() => {
    if (!autoCreate || !operationUuid || !stateIntent) {
      return;
    }
    if (startedRef.current === operationUuid) {
      return;
    }
    startedRef.current = operationUuid;
    setPostPhase("posting");
    createMutation.mutate({
      ...stateIntent,
      operation_uuid: operationUuid,
    });
    // The mutation is intentionally started once per operation URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCreate, operationUuid, stateIntent]);

  const operationQuery = useQuery({
    queryKey: queryKeys.operation(operationUuid ?? "missing"),
    queryFn: () => getCampaignOperation(operationUuid as string),
    enabled: Boolean(operationUuid) && postPhase !== "posting",
    retry: shouldRetryQuery,
    refetchInterval: pollingInterval,
  });

  const resumeMutation = useMutation({
    mutationFn: () => resumeCampaignOperation(operationUuid as string),
    onSuccess: (operation) => {
      setPostResult(operation);
      operationQuery.refetch();
    },
  });

  const operation = operationQuery.data ?? postResult ?? null;
  const status = operation?.status ?? null;
  const statusText = statusMessage(status);
  const missingOperation =
    operationQuery.error instanceof ApiError && operationQuery.error.isNotFound;
  const postFailure = postPhase === "error" ? postError : null;
  const blockingError = postFailure ?? operationQuery.error ?? null;
  const sameUuidRetryAllowed = canRetrySameUuid(
    intent,
    postFailure,
    missingOperation,
  );
  const errorMessage = missingOperation
    ? "No durable operation exists for this UUID yet."
    : messageFor(blockingError);
  const canStartNew = canStartNewAttempt(missingOperation, postFailure, status);

  useEffect(() => {
    if (blockingError && statusRef.current) {
      statusRef.current.focus();
    }
  }, [blockingError]);

  const retryPost = () => {
    if (!operationUuid || !intent) {
      return;
    }
    startedRef.current = null;
    setPostPhase("posting");
    setPostError(null);
    setPendingAction(null);
    createMutation.mutate({ ...intent, operation_uuid: operationUuid });
  };

  const startNewAttempt = () => {
    clearAttempt();
    navigate("/campaigns/new", { replace: true });
  };

  if (!operationUuid) {
    return (
      <section aria-labelledby="operation-missing-heading">
        <h1 id="operation-missing-heading">No operation selected</h1>
        <Link to="/campaigns/new">Create a campaign</Link>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="operation-heading"
      className={`${styles.card} ${narrow ? styles.narrow : ""}`}
    >
      <h1 id="operation-heading">Campaign creation operation</h1>
      <p className={styles.uuid}>UUID: {operationUuid}</p>
      {mismatch && (
        <output className={styles.notice}>
          The stored operation UUID differs from the URL. The URL is being used.
        </output>
      )}

      <p
        className={styles.status}
        data-status={status ?? "unknown"}
        ref={statusRef}
        tabIndex={-1}
        aria-live="polite"
      >
        {statusText}
      </p>

      {created !== null && (
        <p className={styles.hint}>
          {created
            ? "A new durable operation was created."
            : "An existing durable operation was replayed for this UUID."}
        </p>
      )}

      {postPhase === "posting" && (
        <output>Creating the durable operation…</output>
      )}

      {blockingError && (
        <OperationErrorPanel
          message={errorMessage}
          canRetrySameUuid={sameUuidRetryAllowed}
          canStartNew={canStartNew}
          pendingAction={pendingAction}
          onRetry={() => setPendingAction("retry")}
          onStartNew={() => setPendingAction("new")}
          onCheckStatus={() => operationQuery.refetch()}
          onConfirmRetry={retryPost}
          onConfirmNew={startNewAttempt}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {operation && <OperationDetails operation={operation} />}

      {status && NON_TERMINAL.has(status) && (
        <ResumePanel
          pending={resumeMutation.isPending}
          error={
            resumeMutation.error ? messageFor(resumeMutation.error) : null
          }
          onResume={() => resumeMutation.mutate()}
        />
      )}

      {status && !NON_TERMINAL.has(status) && (
        <NewAttemptPanel onStart={() => setPendingAction("new")} />
      )}

      {pendingAction === "new" &&
        status &&
        !NON_TERMINAL.has(status) &&
        !blockingError && (
          <NewAttemptConfirmation
            onConfirm={startNewAttempt}
            onCancel={() => setPendingAction(null)}
          />
        )}
    </section>
  );
}

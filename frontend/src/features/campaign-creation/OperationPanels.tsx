import { Link } from "react-router-dom";

import type { CampaignCreationResponse } from "../../api/client";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import styles from "./OperationPage.module.css";

export type PendingAction = "retry" | "new" | null;

type ErrorPanelProps = Readonly<{
  message: string;
  canRetrySameUuid: boolean;
  canStartNew: boolean;
  pendingAction: PendingAction;
  onRetry: () => void;
  onStartNew: () => void;
  onCheckStatus: () => void;
  onConfirmRetry: () => void;
  onConfirmNew: () => void;
  onCancel: () => void;
}>;

export function OperationErrorPanel({
  message,
  canRetrySameUuid,
  canStartNew,
  pendingAction,
  onRetry,
  onStartNew,
  onCheckStatus,
  onConfirmRetry,
  onConfirmNew,
  onCancel,
}: ErrorPanelProps) {
  return (
    <ErrorSummary
      heading="Action needed"
      message={message}
      detail={
        <>
          <p className={styles.hint}>
            The UUID above is unchanged. No replacement UUID was generated.
          </p>
      {pendingAction === null && (
        <div className={styles.actions}>
          {canRetrySameUuid && (
            <button type="button" onClick={onRetry}>
              Retry POST with same UUID
            </button>
          )}
          {canStartNew && (
            <button type="button" className={styles.secondary} onClick={onStartNew}>
              Start new attempt
            </button>
          )}
          <button type="button" className={styles.secondary} onClick={onCheckStatus}>
            Check operation status
          </button>
        </div>
      )}
      {pendingAction === "retry" && (
        <div className={styles.confirm}>
          <p>Retry creation with this exact UUID and the original intent?</p>
          <button type="button" autoFocus onClick={onConfirmRetry}>
            Confirm same-UUID retry
          </button>
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
      {pendingAction === "new" && (
        <div className={styles.confirm}>
          <p>
            Clear the stored attempt and generate a new UUID only for a new
            logical creation attempt?
          </p>
          <button type="button" autoFocus onClick={onConfirmNew}>
            Confirm new attempt
          </button>
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
        </>
      }
    />
  );
}

export function OperationDetails({
  operation,
}: Readonly<{
  operation: CampaignCreationResponse;
}>) {
  return (
    <dl className={styles.details}>
      <dt>Alias</dt>
      <dd>{operation.alias}</dd>
      <dt>Campaign ID</dt>
      <dd>
        {operation.campaign_id ?? "not available"}
        {typeof operation.campaign_id === "number" &&
          Number.isSafeInteger(operation.campaign_id) &&
          operation.campaign_id > 0 && (
            <>
              {" "}
              <Link to={`/campaigns/${operation.campaign_id}`}>
                Open Campaign Workspace
              </Link>
            </>
          )}
      </dd>
      <dt>Country flow ID</dt>
      <dd>{operation.country_flow_id ?? "not available"}</dd>
      <dt>Offer flow ID</dt>
      <dd>{operation.offer_flow_id ?? "not available"}</dd>
      {operation.error_message && (
        <>
          <dt>Backend error</dt>
          <dd>{operation.error_message}</dd>
        </>
      )}
    </dl>
  );
}

export function ResumePanel({
  pending,
  error,
  onResume,
}: Readonly<{
  pending: boolean;
  error: string | null;
  onResume: () => void;
}>) {
  return (
    <div className={styles.actions}>
      <button type="button" onClick={onResume} disabled={pending}>
        {pending ? "Resuming…" : "Resume operation"}
      </button>
      <p className={styles.hint}>
        Resume is explicit. The backend reconciles without blind retries.
      </p>
      {error && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function NewAttemptPanel({
  onStart,
}: Readonly<{ onStart: () => void }>) {
  return (
    <div className={styles.actions}>
      <button type="button" onClick={onStart}>
        Start new attempt
      </button>
    </div>
  );
}

export function NewAttemptConfirmation({
  onConfirm,
  onCancel,
}: Readonly<{
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  return (
    <div className={styles.confirm}>
      <p>Generate a new UUID for a new logical creation attempt?</p>
      <button type="button" onClick={onConfirm}>
        Confirm new attempt
      </button>
      <button type="button" className={styles.secondary} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

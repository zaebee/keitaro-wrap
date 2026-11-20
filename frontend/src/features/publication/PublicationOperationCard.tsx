import type { PublicPublicationResponse, PublicationStatus } from "../../api/operations";
import styles from "./Publication.module.css";

const STATUS_LABELS: Record<PublicationStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  succeeded: "Succeeded",
  failed: "Failed",
  ambiguous: "Ambiguous",
  abandoned: "Abandoned",
};

export function PublicationStatusBadge({
  status,
}: Readonly<{ status: PublicationStatus }>) {
  return (
    <span className={styles.status} data-status={status}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function PublicationOperationCard({
  operation,
}: Readonly<{ operation: PublicPublicationResponse }>) {
  return (
    <li className={styles.operationCard}>
      <h3>
        Stream {operation.stream_ref} ·{" "}
        <PublicationStatusBadge status={operation.status} />
      </h3>
      <dl className={styles.meta}>
        <dt>Operation UUID</dt>
        <dd className={styles.mono}>{operation.operation_uuid}</dd>
        <dt>Campaign</dt>
        <dd className="tnum">{operation.campaign_id}</dd>
        <dt>Target version</dt>
        <dd className="tnum">{operation.draft_version}</dd>
        <dt>Attempt (zero-retry)</dt>
        <dd className="tnum">{operation.attempt_count}</dd>
      </dl>
      <p className={styles.syncLockNote}>
        <strong>Keitaro Sync Lock.</strong> Publication commands are
        zero-retry; this card shows the single recorded attempt, never a
        retried outcome.
      </p>
      <p className={styles.hint}>Effective published entries (backend allowlisted):</p>
      {operation.effective_entries.length === 0 ? (
        <p className={styles.empty}>No effective entries were reported.</p>
      ) : (
        <ul className={styles.entries}>
          {operation.effective_entries.map((entry) => (
            <li key={entry.offer_id}>
              Offer #{entry.offer_id} · share {entry.share} · state{" "}
              {entry.state ?? "not provided"}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

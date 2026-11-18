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
        <dt>Campaign</dt>
        <dd>{operation.campaign_id}</dd>
        <dt>Draft version</dt>
        <dd>{operation.draft_version}</dd>
        <dt>Attempt count</dt>
        <dd>{operation.attempt_count}</dd>
        <dt>Operation UUID</dt>
        <dd>{operation.operation_uuid}</dd>
      </dl>
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

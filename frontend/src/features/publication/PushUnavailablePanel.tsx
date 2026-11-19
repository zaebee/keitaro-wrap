import { Link } from "react-router-dom";

import styles from "./Publication.module.css";

/**
 * Static presentation for the deliberately unavailable Push action. It has no
 * API imports, request handlers, or mutation behavior.
 */
export function PushUnavailablePanel() {
  return (
    <section
      aria-labelledby="push-unavailable-heading"
      className={styles.disabledPanel}
      data-push-state="disabled"
    >
      <h3 id="push-unavailable-heading">Push unavailable</h3>
      <p id="push-unavailable-copy">
        This interface does not provide a Push action. Publication writes are
        disabled. Refreshing, retrying, or navigating will not enable
        publication.
      </p>
      <p className={styles.hint}>
        Read-only alternatives: refresh the publication status shown above, or{" "}
        <Link to="/recovery" aria-describedby="push-unavailable-copy">
          inspect the recoverable queue
        </Link>
        . These actions do not publish anything or enable Push.
      </p>
    </section>
  );
}

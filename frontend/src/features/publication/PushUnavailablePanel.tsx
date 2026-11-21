import { Link } from "react-router-dom";

import type { PushReadiness } from "../offer-editor/allocationSummary";
import styles from "./Publication.module.css";

export function PushStatusPanel({
  readiness,
  pushing,
}: Readonly<{
  readiness?: PushReadiness;
  pushing?: boolean;
}>) {
  const canPush = readiness?.canPush ?? false;
  const reason = readiness?.reason ?? null;

  return (
    <section
      aria-labelledby="push-status-heading"
      className={`${styles.pushCard} ${canPush ? styles.pushCardReady : styles.pushCardIdle}`}
      data-push-state={canPush ? "enabled" : "blocked"}
    >
      <div className={styles.pushCardHeader}>
        <span className={styles.pushCardIcon} aria-hidden="true">
          {canPush ? "✓" : "i"}
        </span>
        <h3 id="push-status-heading">
          {pushing
            ? "Publishing to Keitaro…"
            : canPush
              ? "Ready to push to Keitaro"
              : "Push status"}
        </h3>
      </div>
      <p className={styles.pushCardCopy} id="push-status-copy">
        {pushing
          ? "Sending offer weights to Keitaro and verifying read-back state."
          : canPush
            ? "Staged offer shares total 100% with no conflicts. Click Push to Keitaro below to publish."
            : (reason ??
              "Stage local offer changes summing to 100% to enable Push to Keitaro.")}
      </p>
      <p className={styles.hint}>
        Need recovery inspection?{" "}
        <Link to="/recovery" aria-describedby="push-status-copy">
          inspect the recoverable queue
        </Link>
        .
      </p>
    </section>
  );
}

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

  const cardClass = canPush ? styles.pushCardReady : styles.pushCardIdle;
  const pushState = canPush ? "enabled" : "blocked";
  const iconContent = canPush ? "✓" : "i";

  let headingText = "Push status";
  if (pushing) {
    headingText = "Publishing to Keitaro…";
  } else if (canPush) {
    headingText = "Ready to push to Keitaro";
  }

  let copyText =
    "Stage local offer changes summing to 100% to enable Push to Keitaro.";
  if (pushing) {
    copyText = "Sending offer weights to Keitaro and verifying read-back state.";
  } else if (canPush) {
    copyText =
      "Staged offer shares total 100% with no conflicts. Click Push to Keitaro below to publish.";
  } else if (reason) {
    copyText = reason;
  }

  return (
    <section
      aria-labelledby="push-status-heading"
      className={`${styles.pushCard} ${cardClass}`}
      data-push-state={pushState}
    >
      <div className={styles.pushCardHeader}>
        <span className={styles.pushCardIcon} aria-hidden="true">
          {iconContent}
        </span>
        <h3 id="push-status-heading">{headingText}</h3>
      </div>
      <p className={styles.pushCardCopy} id="push-status-copy">
        {copyText}
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

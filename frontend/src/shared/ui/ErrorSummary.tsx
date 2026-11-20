import { useEffect, useRef, type ReactNode } from "react";

import styles from "./ErrorSummary.module.css";

type ErrorSummaryProps = Readonly<{
  heading: string;
  message: string;
  code?: string | null;
  detail?: ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  focusKey?: string;
}>;

export function ErrorSummary({
  heading,
  message,
  code,
  detail,
  retryLabel,
  onRetry,
  retryDisabled,
  focusKey,
}: ErrorSummaryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const key = focusKey ?? `${heading}|${message}|${code ?? ""}`;

  useEffect(() => {
    ref.current?.focus();
  }, [key]);

  return (
    <div ref={ref} className={styles.summary} role="alert" tabIndex={-1}>
      <h2>{heading}</h2>
      <p>{message}</p>
      {code && <p className={styles.hint}>API error code: {code}</p>}
      {detail}
      {retryLabel && onRetry && (
        <button type="button" onClick={onRetry} disabled={retryDisabled}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

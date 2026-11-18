import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { parseCampaignId } from "./campaignId";
import styles from "./OpenCampaignPage.module.css";

const INVALID_MESSAGE =
  "Enter a positive whole Campaign ID (maximum 9007199254740991).";

export function OpenCampaignPage() {
  const navigate = useNavigate();
  const narrow = useNarrowViewport();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const campaignId = parseCampaignId(value);
    if (campaignId === null) {
      setError(INVALID_MESSAGE);
      return;
    }
    setError(null);
    navigate(`/campaigns/${campaignId}`);
  };

  return (
    <section
      aria-labelledby="open-campaign-heading"
      className={`${styles.card} ${narrow ? styles.narrow : ""}`}
    >
      <h1 id="open-campaign-heading">Open campaign</h1>
      <p className={styles.lead}>
        Enter a known Keitaro Campaign ID to inspect its cached stream
        references.
      </p>

      {error && (
        <div className={styles.errorSummary} role="alert">
          {error}
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor="campaign-id">Campaign ID</label>
          <input
            id="campaign-id"
            name="campaignId"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "campaign-id-error" : "campaign-id-hint"}
          />
          <p className={styles.hint} id="campaign-id-hint">
            Whole positive numbers only. Campaigns are not listed by this
            local/trusted-environment app.
          </p>
          {error && (
            <p className={styles.fieldError} id="campaign-id-error">
              {error}
            </p>
          )}
        </div>

        <div className={styles.actions}>
          <button className={styles.primary} type="submit">
            Open campaign
          </button>
          <Link to="/campaigns/new">Create campaign instead</Link>
        </div>
      </form>
    </section>
  );
}

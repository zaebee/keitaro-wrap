import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { listCampaigns } from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import { parseCampaignId } from "./campaignId";
import styles from "./OpenCampaignPage.module.css";

const INVALID_MESSAGE =
  "Enter a positive whole Campaign ID (maximum 9007199254740991).";

export function OpenCampaignPage() {
  const navigate = useNavigate();
  const narrow = useNarrowViewport();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);

  const campaignsQuery = useQuery({
    queryKey: queryKeys.campaigns,
    queryFn: () => listCampaigns(50),
    enabled: showList,
    retry: false,
  });

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
    <div className={styles.pageWrap}>
      <div className={styles.topBar}>
        <span className={styles.crumbCurrent}>Campaigns</span>
        <span className={styles.avatar} aria-hidden="true">
          KW
        </span>
      </div>

      <section
        aria-labelledby="open-campaign-heading"
        className={`${styles.card} ${narrow ? styles.narrow : ""}`}
      >
        <h1 id="open-campaign-heading">Open campaign</h1>
        <p className={styles.lead}>
          Enter a known Keitaro Campaign ID to inspect its cached stream
          references, edit offer weights, and push updates to Keitaro.
        </p>

        {error && <ErrorSummary heading="Invalid campaign ID" message={error} />}

        <form onSubmit={submit} noValidate>
          <div className={styles.field}>
            <label htmlFor="campaign-id">Campaign ID</label>
            <input
              id="campaign-id"
              name="campaignId"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 42"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "campaign-id-error" : "campaign-id-hint"}
            />
            <p className={styles.hint} id="campaign-id-hint">
              Whole positive numbers only.
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
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setShowList((prev) => !prev)}
            >
              {showList ? "Hide campaigns list" : "Browse Keitaro campaigns"}
            </button>
            <Link to="/campaigns/new">Create campaign instead</Link>
          </div>
        </form>

        {showList && (
          <div className={styles.campaignListBox}>
            <div className={styles.campaignListHeader}>
              <h2>Available campaigns</h2>
              <button
                type="button"
                className={styles.refreshListBtn}
                onClick={() => void campaignsQuery.refetch()}
                disabled={campaignsQuery.isFetching}
              >
                {campaignsQuery.isFetching ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {campaignsQuery.isPending && <output>Loading campaigns…</output>}
            {campaignsQuery.isError && (
              <p className={styles.fieldError}>
                Could not load campaigns from Keitaro. Enter a Campaign ID
                manually above.
              </p>
            )}
            {campaignsQuery.isSuccess && campaignsQuery.data.length === 0 && (
              <p className={styles.hint}>No campaigns found in Keitaro.</p>
            )}
            {campaignsQuery.isSuccess && campaignsQuery.data.length > 0 && (
              <ul className={styles.campaignList}>
                {campaignsQuery.data.map((campaign) => (
                  <li key={campaign.id} className={styles.campaignListItem}>
                    <div>
                      <span className={styles.campaignName}>{campaign.name}</span>
                      <span className={`${styles.campaignMeta} tnum`}>
                        #{campaign.id}
                        {campaign.alias ? ` · ${campaign.alias}` : ""}
                        {campaign.state ? ` · ${campaign.state}` : ""}
                      </span>
                    </div>
                    <Link
                      className={styles.openLink}
                      to={`/campaigns/${campaign.id}`}
                    >
                      Open
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

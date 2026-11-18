import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";

import { getHealth } from "./api/operations";
import { CreateCampaignPage } from "./features/campaign-creation/CreateCampaignPage";
import { OperationPage } from "./features/campaign-creation/OperationPage";
import { queryKeys } from "./queries/queryClient";
import styles from "./App.module.css";

function HealthIndicator() {
  const { data, isError } = useQuery({
    queryKey: queryKeys.health,
    queryFn: getHealth,
  });
  const label = isError ? "API unavailable" : `API: ${data?.status ?? "checking"}`;
  return (
    <span className={`${styles.health} ${isError ? styles.healthError : ""}`}>
      {label}
    </span>
  );
}

function OperationRoute() {
  const { operationUuid } = useParams();
  return <OperationPage key={operationUuid} />;
}

export function App() {
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main">
        Skip to main content
      </a>
      <header className={styles.header}>
        <Link className={styles.brand} to="/campaigns/new">
          Keitaro Wrap
        </Link>
        <nav aria-label="Primary">
          <Link to="/campaigns/new">Create campaign</Link>
        </nav>
        <HealthIndicator />
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Navigate to="/campaigns/new" replace />} />
          <Route path="/campaigns/new" element={<CreateCampaignPage />} />
          <Route
            path="/campaign-creations/:operationUuid"
            element={<OperationRoute />}
          />
          <Route
            path="*"
            element={
              <section aria-labelledby="not-found-heading">
                <h1 id="not-found-heading">Page not found</h1>
                <Link to="/campaigns/new">Return to campaign creation</Link>
              </section>
            }
          />
        </Routes>
      </main>
      <footer className={styles.footer}>Local / trusted environment only</footer>
    </div>
  );
}

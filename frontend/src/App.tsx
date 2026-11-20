import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useParams,
} from "react-router-dom";

import { CreateCampaignPage } from "./features/campaign-creation/CreateCampaignPage";
import { OperationPage } from "./features/campaign-creation/OperationPage";
import { CampaignWorkspacePage } from "./features/campaign-workspace/CampaignWorkspacePage";
import { OpenCampaignPage } from "./features/campaign-workspace/OpenCampaignPage";
import { OfferEditorPage } from "./features/offer-editor/OfferEditorPage";
import { RecoveryQueuePage } from "./features/publication/RecoveryQueuePage";
import { StreamsSidebar } from "./features/streams-sidebar/StreamsSidebar";
import styles from "./App.module.css";

function OperationRoute() {
  const { operationUuid } = useParams();
  return <OperationPage key={operationUuid} />;
}

function AppLayout() {
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main">
        Skip to main content
      </a>
      <StreamsSidebar />
      <main id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/campaigns/new" replace />} />
        <Route path="/campaigns/new" element={<CreateCampaignPage />} />
        <Route path="/campaigns/open" element={<OpenCampaignPage />} />
        <Route
          path="/campaigns/:campaignId"
          element={<CampaignWorkspacePage />}
        />
        <Route
          path="/campaigns/:campaignId/streams/:streamRef"
          element={<OfferEditorPage />}
        />
        <Route
          path="/campaign-creations/:operationUuid"
          element={<OperationRoute />}
        />
        <Route path="/recovery" element={<RecoveryQueuePage />} />
        <Route
          path="*"
          element={
            <section aria-labelledby="not-found-heading">
              <h1 id="not-found-heading">Page not found</h1>
              <Link to="/campaigns/new">Return to campaign creation</Link>
            </section>
          }
        />
      </Route>
    </Routes>
  );
}

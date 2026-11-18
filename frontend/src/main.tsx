import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { createQueryClient } from "./queries/queryClient";
import "./shared/styles/tokens.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element is missing");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

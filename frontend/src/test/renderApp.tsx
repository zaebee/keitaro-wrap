import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";

import { App } from "../App";
import { createQueryClient } from "../queries/queryClient";

export function renderApp(path = "/campaigns/new", state: unknown = {}) {
  window.history.replaceState({ usr: state }, "", path);
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

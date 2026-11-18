import { QueryClient } from "@tanstack/react-query";

export const queryKeys = {
  health: ["health"] as const,
  operation: (operationUuid: string) =>
    ["campaign-creation-operation", operationUuid] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

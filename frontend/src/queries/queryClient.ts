import { QueryClient } from "@tanstack/react-query";

export const queryKeys = {
  health: ["health"] as const,
  operation: (operationUuid: string) =>
    ["campaign-creation-operation", operationUuid] as const,
  campaignStreams: (campaignId: number) =>
    ["campaign-streams", campaignId] as const,
  committed: (campaignId: number, streamRef: number) =>
    ["committed", campaignId, streamRef] as const,
  draft: (campaignId: number, streamRef: number) =>
    ["draft", campaignId, streamRef] as const,
  publication: (campaignId: number, streamRef: number) =>
    ["publication", campaignId, streamRef] as const,
  recoverablePublications: ["recoverable-publications"] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

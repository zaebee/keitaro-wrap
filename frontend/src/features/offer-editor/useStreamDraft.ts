import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../../api/client";
import {
  acceptRemoteConflict,
  addDraftOffer,
  cancelLocalDraft,
  getCommittedState,
  getDraftState,
  getPublicationState,
  pinDraftOffer,
  pushCampaignStreams,
  removeDraftOffer,
  restoreDraftOffer,
  setDraftShare,
  unpinDraftOffer,
  type ConflictDetailResponse,
  type PushResultResponse,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useFocusOnChange } from "../../shared/hooks/useFocusOnChange";
import { usePublicationRecoveryLock } from "../publication/usePublicationRecoveryLock";
import { parsePositiveId } from "../campaign-workspace/campaignId";
import { evaluatePushReadiness } from "./allocationSummary";
import type { DraftActionRequest } from "./EditorPanels";

export type Failure = { message: string; code: string | null; status: number | null };

export function describeFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code, status: error.status };
  }
  return {
    message: "The API could not be reached. Check the local backend and try again.",
    code: null,
    status: null,
  };
}

export function requiresRecovery(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }
  return (
    error.status >= 500 ||
    error.code === "DRAFT_VERSION_CONFLICT" ||
    error.code === "DRAFT_STALE_CONFLICT"
  );
}

export function isStreamNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "STREAM_NOT_FOUND";
}

export function conflictDetails(error: unknown): ConflictDetailResponse[] {
  if (
    !(error instanceof ApiError) ||
    error.code !== "DRAFT_STALE_CONFLICT" ||
    !Array.isArray(error.details.conflicts)
  ) {
    return [];
  }
  return error.details.conflicts as ConflictDetailResponse[];
}

export function failureMessage(failure: Failure): string {
  if (failure.code === null) {
    return "The draft command outcome is unknown. Read the current draft before acting again; no automatic retry was made.";
  }
  if (failure.status !== null && failure.status >= 500) {
    return "The server returned 5xx after the draft command. It may have been applied; read the current draft before acting again.";
  }
  return failure.message;
}

export function hintFor(failure: Failure): string {
  if (failure.code === "DRAFT_VERSION_CONFLICT") {
    return "The draft changed on the server. Your last input was not applied automatically; read the current draft before retrying.";
  }
  if (failure.code === "DRAFT_STALE_CONFLICT") {
    return "Sticky conflicts still block editing. Cancel preserves them; no conflict was resolved.";
  }
  if (failure.code === "DRAFT_CONFLICT_CHANGED") {
    return "Conflict details changed before resolution. Read the current draft again; nothing was changed.";
  }
  if (failure.code === null || (failure.status !== null && failure.status >= 500)) {
    return "Only a GET re-read is offered. The previous command is not retried.";
  }
  return "No mutation retry is performed automatically.";
}

function parseShare(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : null;
}

export function useStreamDraft(campaignId: number, streamRef: number) {
  const queryClient = useQueryClient();
  const [newOfferId, setNewOfferId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [shareInputs, setShareInputs] = useState<Record<number, string>>({});
  const [shareErrors, setShareErrors] = useState<Record<number, string>>({});
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [acceptingConflict, setAcceptingConflict] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [pushOutcomeError, setPushOutcomeError] = useState<string | null>(null);
  const statusRef = useFocusOnChange<HTMLParagraphElement>(announcement);
  const publicationLock = usePublicationRecoveryLock();

  const committedQuery = useQuery({
    queryKey: queryKeys.committed(campaignId, streamRef),
    queryFn: () => getCommittedState(campaignId, streamRef),
    retry: false,
  });
  const draftQuery = useQuery({
    queryKey: queryKeys.draft(campaignId, streamRef),
    queryFn: () => getDraftState(campaignId, streamRef),
    retry: false,
  });
  const publicationQuery = useQuery({
    queryKey: queryKeys.publication(campaignId, streamRef),
    queryFn: () => getPublicationState(campaignId, streamRef),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const mutation = useMutation({
    mutationFn: (action: DraftActionRequest) => {
      const expected_version = draftQuery.data?.draft?.version ?? 0;
      switch (action.kind) {
        case "add":
          return addDraftOffer(campaignId, streamRef, {
            expected_version,
            offer_id: action.offerId,
          });
        case "remove":
          return removeDraftOffer(campaignId, streamRef, {
            expected_version,
            offer_id: action.offerId,
          });
        case "restore":
          return restoreDraftOffer(campaignId, streamRef, {
            expected_version,
            offer_id: action.offerId,
          });
        case "pin":
          return pinDraftOffer(campaignId, streamRef, {
            expected_version,
            offer_id: action.offerId,
          });
        case "unpin":
          return unpinDraftOffer(campaignId, streamRef, {
            expected_version,
            offer_id: action.offerId,
          });
        case "share":
          return setDraftShare(campaignId, streamRef, {
            expected_version,
            offer_id: action.offerId,
            share: action.share,
          });
        case "cancel":
          return cancelLocalDraft(campaignId, streamRef, { expected_version });
      }
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.draft(campaignId, streamRef), {
        stream_ref: streamRef,
        draft: result.view,
      });
      setNewOfferId("");
      setAddError(null);
      setShareInputs({});
      setShareErrors({});
      setConfirmingCancel(false);
      setPushOutcomeError(null);
      setAnnouncement("Draft command verified. The server view has been refreshed.");
    },
    onError: (error: unknown) => {
      setAnnouncement(null);
      if (requiresRecovery(error)) {
        setRecoveryRequired(true);
      }
      setConfirmingCancel(false);
    },
  });

  const acceptRemoteMutation = useMutation({
    mutationFn: async () => {
      const current = draftQuery.data?.draft;
      if (current === null || current === undefined) {
        throw new ApiError(422, "DOMAIN_POLICY_REJECTION", "no draft to resolve", {});
      }
      return await publicationLock.runExclusive(async (context) => {
        if (context.getState().kind !== "none") {
          throw new ApiError(
            409,
            "PUBLICATION_UNRESOLVED",
            "An active or unreadable publication recovery lock blocks conflict resolution.",
            {},
          );
        }
        return await acceptRemoteConflict(campaignId, streamRef, {
          expected_version: current.version,
          expected_conflicts_fingerprint: current.conflicts_fingerprint,
        });
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.draft(campaignId, streamRef), {
        stream_ref: streamRef,
        draft: result.draft,
      });
      void committedQuery.refetch();
      void publicationQuery.refetch();
      setAcceptingConflict(false);
      setPushOutcomeError(null);
      setAnnouncement("Remote state accepted. The draft is clean on the new baseline.");
      acceptRemoteMutation.reset();
    },
    onError: (error: unknown) => {
      setAnnouncement(null);
      const failure = describeFailure(error);
      if (failure.code === null || (failure.status !== null && failure.status >= 500)) {
        setRecoveryRequired(true);
      }
      setAcceptingConflict(false);
    },
  });

  const pushMutation = useMutation({
    mutationFn: () => pushCampaignStreams(campaignId, [streamRef]),
    onSuccess: async (result: PushResultResponse) => {
      const outcome =
        result.outcomes.find((item) => item.stream_ref === streamRef) ??
        result.outcomes[0] ??
        null;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.committed(campaignId, streamRef),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.draft(campaignId, streamRef),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.publication(campaignId, streamRef),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.campaignStreams(campaignId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.recoverablePublications,
        }),
      ]);
      if (outcome?.status === "succeeded") {
        setPushOutcomeError(null);
        setAnnouncement(
          `Pushed stream #${streamRef} to Keitaro. Committed state is now synced.`,
        );
      } else {
        setAnnouncement(null);
        setPushOutcomeError(
          outcome?.reason ??
            "Push completed without confirmation. Check publication status before retrying.",
        );
      }
    },
    onError: (error: unknown) => {
      setAnnouncement(null);
      setPushOutcomeError(describeFailure(error).message);
      void publicationQuery.refetch();
      void draftQuery.refetch();
    },
  });

  const draft = draftQuery.data?.draft ?? null;
  const mutationFailure = describeFailure(mutation.error ?? acceptRemoteMutation.error);
  const publicationFailure = describeFailure(publicationQuery.error);
  const staleConflicts = conflictDetails(mutation.error);
  const busy =
    mutation.isPending ||
    acceptRemoteMutation.isPending ||
    pushMutation.isPending;
  const blocked = draft?.is_stale === true || (draft?.conflicts.length ?? 0) > 0;
  const snapshot = committedQuery.data?.snapshot;
  const baselineReady = Boolean(snapshot && snapshot.offers.length > 0);
  const latestPublicationStatus = publicationQuery.data?.operation?.status ?? null;
  const pushReadiness = evaluatePushReadiness({
    draft,
    busy: mutation.isPending || acceptRemoteMutation.isPending,
    pushing: pushMutation.isPending,
    recoveryRequired,
    latestPublicationStatus,
  });

  const rereadDraft = async () => {
    const result = await draftQuery.refetch();
    if (result.status === "success") {
      setRecoveryRequired(false);
      mutation.reset();
      acceptRemoteMutation.reset();
    }
  };

  const requestAcceptRemote = async () => {
    if (recoveryRequired || busy || draft === null) {
      return;
    }
    const unlocked = await publicationLock.runExclusive(
      (context) => context.getState().kind === "none",
    );
    if (!unlocked) {
      return;
    }
    setAcceptingConflict(true);
  };

  const handleAction = (action: DraftActionRequest) => {
    if (recoveryRequired || busy) {
      return;
    }
    if (action.kind === "cancel") {
      if (draft === null) {
        return;
      }
      setConfirmingCancel(true);
      return;
    }
    if (blocked || !baselineReady) {
      return;
    }
    if (action.kind === "add") {
      const offerId = parsePositiveId(newOfferId);
      if (offerId === null) {
        setAddError("Enter a positive whole offer ID.");
        return;
      }
      setAddError(null);
      mutation.mutate({ kind: "add", offerId });
      return;
    }
    mutation.mutate(action);
  };

  const submitShare = (offerId: number) => {
    if (recoveryRequired || busy || blocked || !baselineReady) {
      return;
    }
    const share = parseShare(shareInputs[offerId] ?? "");
    if (share === null) {
      setShareErrors((previous) => ({
        ...previous,
        [offerId]: "Enter a whole number from 0 to 100.",
      }));
      return;
    }
    setShareErrors((previous) => ({ ...previous, [offerId]: "" }));
    mutation.mutate({ kind: "share", offerId, share });
  };

  const handlePush = () => {
    if (!pushReadiness.canPush) {
      return;
    }
    setAnnouncement(null);
    setPushOutcomeError(null);
    pushMutation.mutate();
  };

  const streamMissing =
    isStreamNotFound(committedQuery.error) || isStreamNotFound(draftQuery.error);

  return {
    campaignId,
    streamRef,
    draft,
    busy,
    blocked,
    baselineReady,
    recoveryRequired,
    confirmingCancel,
    acceptingConflict,
    announcement,
    statusRef,
    newOfferId,
    addError,
    shareInputs,
    shareErrors,
    snapshot,
    committedQuery,
    draftQuery,
    publicationQuery,
    publicationLock,
    mutation,
    acceptRemoteMutation,
    pushMutation,
    pushReadiness,
    pushOutcomeError,
    mutationFailure,
    publicationFailure,
    staleConflicts,
    streamMissing,
    onNewOfferInput: (value: string) => {
      setNewOfferId(value);
      setAddError(null);
    },
    onAction: handleAction,
    onShareInput: (offerId: number, value: string) =>
      setShareInputs((previous) => ({ ...previous, [offerId]: value })),
    onShareSubmit: submitShare,
    onConfirmCancel: () => {
      if (!recoveryRequired && draft !== null) {
        mutation.mutate({ kind: "cancel" });
      }
    },
    onKeepDraft: () => setConfirmingCancel(false),
    onAcceptRemote: () => void requestAcceptRemote(),
    onConfirmAcceptRemote: () => acceptRemoteMutation.mutate(),
    onKeepConflict: () => setAcceptingConflict(false),
    onPush: handlePush,
    rereadDraft,
  };
}

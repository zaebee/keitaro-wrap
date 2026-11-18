import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { ApiError } from "../../api/client";
import {
  addDraftOffer,
  cancelLocalDraft,
  getCommittedState,
  getDraftState,
  getPublicationState,
  pinDraftOffer,
  removeDraftOffer,
  restoreDraftOffer,
  setDraftShare,
  unpinDraftOffer,
  type ConflictDetailResponse,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { PublicationStatusPanel } from "../publication/PublicationStatusPanel";
import { parsePositiveId } from "../campaign-workspace/campaignId";
import {
  CommittedPanel,
  ConflictPanel,
  DraftPanel,
  ReadErrorPanel,
  ReviewPanel,
  type DraftActionRequest,
} from "./EditorPanels";
import styles from "./OfferEditorPage.module.css";

type Failure = { message: string; code: string | null; status: number | null };

function describeFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code, status: error.status };
  }
  return {
    message: "The API could not be reached. Check the local backend and try again.",
    code: null,
    status: null,
  };
}

function requiresRecovery(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }
  return (
    error.status >= 500 ||
    error.code === "DRAFT_VERSION_CONFLICT" ||
    error.code === "DRAFT_STALE_CONFLICT"
  );
}

function isStreamNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "STREAM_NOT_FOUND";
}

function conflictDetails(error: unknown): ConflictDetailResponse[] {
  if (
    !(error instanceof ApiError) ||
    error.code !== "DRAFT_STALE_CONFLICT" ||
    !Array.isArray(error.details.conflicts)
  ) {
    return [];
  }
  return error.details.conflicts as ConflictDetailResponse[];
}

function failureMessage(failure: Failure): string {
  if (failure.code === null) {
    return "The draft command outcome is unknown. Read the current draft before acting again; no automatic retry was made.";
  }
  if (failure.status !== null && failure.status >= 500) {
    return "The server returned 5xx after the draft command. It may have been applied; read the current draft before acting again.";
  }
  return failure.message;
}

function hintFor(failure: Failure): string {
  if (failure.code === "DRAFT_VERSION_CONFLICT") {
    return "The draft changed on the server. Your last input was not applied automatically; read the current draft before retrying.";
  }
  if (failure.code === "DRAFT_STALE_CONFLICT") {
    return "Sticky conflicts still block editing. Cancel preserves them; no conflict was resolved.";
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

function Editor({
  campaignId,
  streamRef,
}: Readonly<{ campaignId: number; streamRef: number }>) {
  const narrow = useNarrowViewport();
  const queryClient = useQueryClient();
  const [newOfferId, setNewOfferId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [shareInputs, setShareInputs] = useState<Record<number, string>>({});
  const [shareErrors, setShareErrors] = useState<Record<number, string>>({});
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);

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
    },
    onError: (error: unknown) => {
      if (requiresRecovery(error)) {
        setRecoveryRequired(true);
      }
      setConfirmingCancel(false);
    },
  });

  const draft = draftQuery.data?.draft ?? null;
  const mutationFailure = describeFailure(mutation.error);
  const publicationFailure = describeFailure(publicationQuery.error);
  const staleConflicts = conflictDetails(mutation.error);
  const busy = mutation.isPending;
  const blocked = draft?.is_stale === true || (draft?.conflicts.length ?? 0) > 0;
  const snapshot = committedQuery.data?.snapshot;
  const baselineReady = Boolean(snapshot && snapshot.offers.length > 0);

  const rereadDraft = async () => {
    const result = await draftQuery.refetch();
    if (result.status === "success") {
      setRecoveryRequired(false);
      mutation.reset();
    }
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

  const streamMissing =
    isStreamNotFound(committedQuery.error) || isStreamNotFound(draftQuery.error);

  if (streamMissing) {
    return (
      <section aria-labelledby="stream-missing-heading" className={styles.card}>
        <h1 id="stream-missing-heading">Stream not found</h1>
        <p>
          Campaign {campaignId} does not have stream {streamRef}. No draft
          command was sent.
        </p>
        <Link to={`/campaigns/${campaignId}`}>Back to Campaign Workspace</Link>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="editor-heading"
      aria-busy={
        busy ||
        committedQuery.isFetching ||
        draftQuery.isFetching ||
        publicationQuery.isFetching
      }
      className={`${styles.card} ${narrow ? styles.narrow : ""}`}
      data-recovery-lock={recoveryRequired ? "active" : "inactive"}
    >
      <h1 id="editor-heading">Offer Editor</h1>
      <p className={styles.identity}>
        Campaign {campaignId} · Stream {streamRef}
      </p>
      <p className={styles.hint}>
        This screen edits only the selected stream; streams remain independent.
        Committed baseline and staged draft are separate server views. No
        publication control is available here.
      </p>
      <Link to={`/campaigns/${campaignId}`}>Back to Campaign Workspace</Link>

      {busy && (
        <output className={styles.pending}>
          Saving local draft… Duplicate submissions are disabled.
        </output>
      )}

      {mutation.isError && (
        <div
          className={`${styles.errorPanel} ${recoveryRequired ? styles.recoveryPanel : ""}`}
          role="alert"
        >
          <h2>
            {recoveryRequired
              ? "Recovery required — draft commands locked"
              : "Draft command failed"}
          </h2>
          <p>{failureMessage(mutationFailure)}</p>
          {mutationFailure.code && (
            <p className={styles.hint}>API error code: {mutationFailure.code}</p>
          )}
          <p className={styles.hint}>{hintFor(mutationFailure)}</p>
          {recoveryRequired && (
            <p className={styles.hint}>
              The lock is released only by a successful GET re-read. A failed
              re-read keeps every draft command disabled.
            </p>
          )}
          {staleConflicts.length > 0 && (
            <ConflictPanel conflicts={staleConflicts} />
          )}
          <button
            type="button"
            onClick={() => void rereadDraft()}
            disabled={draftQuery.isFetching}
          >
            Read current draft
          </button>
        </div>
      )}

      <section aria-labelledby="committed-section-heading" className={styles.section}>
        <h2 id="committed-section-heading">Committed state</h2>
        {committedQuery.isPending && (
          <output>Loading committed stream state…</output>
        )}
        {committedQuery.isError && (
          <ReadErrorPanel
            heading="Committed state unavailable"
            message={describeFailure(committedQuery.error).message}
            code={describeFailure(committedQuery.error).code}
            retryLabel="Retry committed read"
            onRetry={() => committedQuery.refetch()}
            retryDisabled={committedQuery.isFetching}
          />
        )}
        {committedQuery.isSuccess && <CommittedPanel state={committedQuery.data} />}
      </section>

      <section aria-labelledby="draft-section-heading" className={styles.section}>
        <h2 id="draft-section-heading">Draft state</h2>
        {draftQuery.isPending && <output>Loading local draft…</output>}
        {draftQuery.isError && (
          <ReadErrorPanel
            heading="Draft state unavailable"
            message={describeFailure(draftQuery.error).message}
            code={describeFailure(draftQuery.error).code}
            retryLabel="Retry draft read"
            onRetry={() => draftQuery.refetch()}
            retryDisabled={draftQuery.isFetching}
          />
        )}
        {draftQuery.isSuccess && (
          <DraftPanel
            draft={draft}
            busy={busy}
            recoveryRequired={recoveryRequired}
            baselineReady={baselineReady}
            workspacePath={`/campaigns/${campaignId}`}
            newOfferId={newOfferId}
            addError={addError}
            shareInputs={shareInputs}
            shareErrors={shareErrors}
            confirmingCancel={confirmingCancel}
            onNewOfferInput={(value) => {
              setNewOfferId(value);
              setAddError(null);
            }}
            onAction={handleAction}
            onShareInput={(offerId, value) =>
              setShareInputs((previous) => ({ ...previous, [offerId]: value }))
            }
            onShareSubmit={submitShare}
            onConfirmCancel={() => {
              if (!recoveryRequired && draft !== null) {
                mutation.mutate({ kind: "cancel" });
              }
            }}
            onKeepDraft={() => setConfirmingCancel(false)}
          />
        )}
      </section>

      <section
        aria-labelledby="publication-section-heading"
        className={styles.section}
      >
        <h2 id="publication-section-heading">Latest publication status</h2>
        <PublicationStatusPanel
          state={publicationQuery.data ?? null}
          expectedCampaignId={campaignId}
          expectedStreamRef={streamRef}
          isPending={publicationQuery.isPending}
          error={
            publicationQuery.isError ? publicationFailure : null
          }
          onRetry={() => publicationQuery.refetch()}
          retryDisabled={publicationQuery.isFetching}
        />
      </section>

      <ReviewPanel draft={draft} />
      <p className={styles.hint}>
        Local / trusted environment only. No Keitaro request is made by opening
        this editor.
      </p>
    </section>
  );
}

export function OfferEditorPage() {
  const { campaignId: rawCampaignId, streamRef: rawStreamRef } = useParams();
  const campaignId = parsePositiveId(rawCampaignId);
  const streamRef = parsePositiveId(rawStreamRef);

  if (campaignId === null || streamRef === null) {
    return (
      <section aria-labelledby="invalid-editor-heading" className={styles.card}>
        <h1 id="invalid-editor-heading">Invalid stream URL</h1>
        <p>
          Campaign ID and stream ref must be positive whole numbers within the
          safe integer range. No API request was made.
        </p>
        <Link to="/campaigns/open">Enter a Campaign ID</Link>
      </section>
    );
  }

  return <Editor key={`${campaignId}-${streamRef}`} campaignId={campaignId} streamRef={streamRef} />;
}

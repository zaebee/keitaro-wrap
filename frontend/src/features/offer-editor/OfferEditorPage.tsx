import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { ApiError } from "../../api/client";
import {
  acceptRemoteConflict,
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
  type DraftViewResponse,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import { useFocusOnChange } from "../../shared/hooks/useFocusOnChange";
import { useNarrowViewport } from "../../shared/hooks/useNarrowViewport";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import { PublicationCancelPanel } from "../publication/PublicationCancelPanel";
import { PublicationStatusPanel } from "../publication/PublicationStatusPanel";
import { PushUnavailablePanel } from "../publication/PushUnavailablePanel";
import { usePublicationRecoveryLock } from "../publication/usePublicationRecoveryLock";
import { parsePositiveId } from "../campaign-workspace/campaignId";
import {
  AllocationSummary,
  CommittedPanel,
  ConflictPanel,
  DraftPanel,
  PolicyCard,
  ReadErrorPanel,
  ReviewPanel,
  type DraftActionRequest,
} from "./EditorPanels";
import styles from "./OfferEditorPage.module.css";
import { draftChanges } from "./draftChanges";

function draftChangesCount(draft: DraftViewResponse): number {
  const changes = draftChanges(draft);
  return (
    changes.additions.length +
    changes.archives.length +
    changes.restores.length +
    changes.pinToggles.length +
    changes.shareEdits.length
  );
}

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
  const [acceptingConflict, setAcceptingConflict] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
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
        throw new ApiError(
          422,
          "DOMAIN_POLICY_REJECTION",
          "no draft to resolve",
          {},
        );
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

  const draft = draftQuery.data?.draft ?? null;
  const mutationFailure = describeFailure(mutation.error ?? acceptRemoteMutation.error);
  const publicationFailure = describeFailure(publicationQuery.error);
  const staleConflicts = conflictDetails(mutation.error);
  const busy = mutation.isPending || acceptRemoteMutation.isPending;
  const blocked = draft?.is_stale === true || (draft?.conflicts.length ?? 0) > 0;
  const snapshot = committedQuery.data?.snapshot;
  const baselineReady = Boolean(snapshot && snapshot.offers.length > 0);

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
      <header className={styles.topBar}>
        <nav aria-label="Breadcrumb" className={styles.breadcrumbs}>
          <Link className={styles.crumbLink} to="/campaigns/open">
            Campaigns
          </Link>
          <span className={styles.crumbSep} aria-hidden="true">
            ›
          </span>
          <Link
            className={styles.crumbLink}
            to={`/campaigns/${campaignId}`}
            aria-label={`Campaign ${campaignId} workspace`}
          >
            <span className="tnum">Campaign #{campaignId}</span>
          </Link>
          <span className={styles.crumbSep} aria-hidden="true">
            ›
          </span>
          <span className={`${styles.crumbCurrent} tnum`} aria-current="page">
            Stream #{streamRef}
          </span>
        </nav>
        <div className={styles.titleRow}>
          <h1 id="editor-heading">Offer Editor</h1>
          <span className={`${styles.titleStream} tnum`}>
            Stream #{streamRef}
          </span>
            {draft?.is_dirty && (
              <span className={styles.dirtyBadge}>
                Draft v{draft.version} (Dirty)
              </span>
            )}
          </div>
          <p className={styles.hint}>
            This screen edits only the selected stream; streams remain
            independent. Committed baseline and staged draft are separate server
            views. The publication section shows read-only status, explains why
            Push is unavailable, and offers only a local publication Cancel.
          </p>
        </header>

        <div className={styles.columns}>
          <div className={styles.mainColumn}>
        {draft?.is_dirty && (
          <div className={styles.dirtyBanner} data-purpose="conflict-alert">
            <div>
              <p className={styles.dirtyBannerTitle}>
                Draft active on version {draft.version}.{" "}
                {draftChangesCount(draft)} local staged mutation
                {draftChangesCount(draft) === 1 ? "" : "s"} awaiting commit.
              </p>
              <p className={styles.dirtyBannerHint}>
                Remote baseline remains pinned. Manual edits automatically toggle
                offer mode to Pinned.
              </p>
            </div>
            <span className={styles.dirtyPolicy}>Policy: EXACT_100_ENFORCED</span>
          </div>
        )}

        {draftQuery.isSuccess && <AllocationSummary draft={draft} />}

        {busy && (
          <output className={styles.pending}>
            Saving local draft… Duplicate submissions are disabled.
          </output>
        )}

        {announcement && (
          <p
            ref={statusRef}
            className={styles.pending}
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            {announcement}
          </p>
        )}

        {(mutation.isError || acceptRemoteMutation.isError) && (
          <ErrorSummary
            heading={
              recoveryRequired
                ? "Recovery required — draft commands locked"
                : "Draft command failed"
            }
            message={failureMessage(mutationFailure)}
            code={mutationFailure.code}
            detail={
              <>
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
              </>
            }
            retryLabel="Read current draft"
            onRetry={() => void rereadDraft()}
            retryDisabled={draftQuery.isFetching}
          />
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
              acceptingConflict={acceptingConflict}
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
              onAcceptRemote={() => void requestAcceptRemote()}
              onConfirmAcceptRemote={() => acceptRemoteMutation.mutate()}
              onKeepConflict={() => setAcceptingConflict(false)}
            />
          )}
        </section>
        </div>

        <aside className={styles.inspector} aria-label="Backend inspector">
          <p className={styles.inspectorTitle}>Backend Inspector</p>
          <PolicyCard draft={draft} />

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
        <PushUnavailablePanel />
        <PublicationCancelPanel
          campaignId={campaignId}
          streamRef={streamRef}
          lock={publicationLock}
          state={publicationQuery.data ?? null}
          stateError={publicationQuery.isError ? publicationFailure : null}
          statePending={publicationQuery.isPending}
        />
      </section>
        </aside>
      </div>

      <ReviewPanel draft={draft} />
      <footer className={styles.actionBar}>
        <div className={styles.stagedSummary}>
          <span
            className={`${styles.stagedDot} ${
              (draft?.is_dirty && styles.stagedDotActive) || ""
            }`}
            aria-hidden="true"
          />
          <span className={styles.stagedCount}>
            {draft ? draftChangesCount(draft) : 0} staged changes
          </span>
          <span className={styles.stagedMeta}>
            · Stream {streamRef} (v{draft?.version ?? 0} draft)
          </span>
        </div>
        <p className={styles.actionBarHint}>
          Local / trusted environment only. No Keitaro request is made by
          opening this editor.
        </p>
      </footer>
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

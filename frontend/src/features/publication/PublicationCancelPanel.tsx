import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../../api/client";
import {
  cancelPublication,
  getDraftState,
  getPublicationState,
  getRecoverablePublications,
  type CancelResultResponse,
  type DraftStateResponse,
  type PublicationStateResponse,
} from "../../api/operations";
import { queryKeys } from "../../queries/queryClient";
import {
  hasMatchingStreamIdentity,
  identitiesFromQueue,
  isValidDraftState,
  isValidPublicationState,
  mergeStreamIdentities,
  parseCancelErrorDetails,
  parseCancelResult,
  parseRecoverableQueue,
  type StreamIdentity,
} from "./publicationValidation";
import {
  verifyCancelLock,
  type CancelVerificationMode,
} from "./publicationLockVerification";
import styles from "./Publication.module.css";
import {
  lockSnapshot,
  type PublicationLockApi,
} from "./usePublicationRecoveryLock";

type Availability =
  | { kind: "cancellable" }
  | { kind: "unavailable"; message: string }
  | { kind: "noop"; message: string }
  | { kind: "blocked"; message: string };

function availabilityFor(state: PublicationStateResponse | null): Availability {
  if (state === null) {
    return { kind: "unavailable", message: "Publication status is unavailable." };
  }
  const operation = state.operation;
  if (operation === null) {
    return {
      kind: "noop",
      message: "No publication operation recorded; nothing to cancel.",
    };
  }
  if (operation.status === "in_progress" || operation.status === "ambiguous") {
    return {
      kind: "blocked",
      message:
        "Recovery is required before this publication can be cancelled.",
    };
  }
  if (operation.status === "succeeded") {
    return {
      kind: "blocked",
      message: "A successful publication cannot be cancelled locally.",
    };
  }
  if (operation.status === "abandoned") {
    return { kind: "noop", message: "This publication is already abandoned." };
  }
  return { kind: "cancellable" };
}

function lockMessage(
  lock: PublicationLockApi["lock"],
  invalid: boolean,
): string | null {
  if (invalid) {
    return "The persisted publication lock is unavailable. Consequential actions are blocked; no force-clear is offered.";
  }
  if (lock === null) {
    return null;
  }
  if (lock.kind === "cancel" && lock.stage === "recovery_ready") {
    return "Recovery is required. The cancel lock was handed to explicit recovery; GET reads remain available.";
  }
  if (lock.kind === "cancel" && lock.stage === "retry_ready") {
    return "The operation is still pending. An explicit cancel retry is required in the recovery queue.";
  }
  if (lock.stage === "running") {
    return "A publication mutation is running. Publication Cancel is blocked until authoritative GET verification succeeds.";
  }
  if (lock.stage === "reserved") {
    return "A Cancel was reserved but no POST was sent. GET reconciliation is available in the recovery queue.";
  }
  return "Publication mutations are locked until authoritative GET verification succeeds.";
}

export function PublicationCancelPanel({
  campaignId,
  streamRef,
  lock,
  state,
  stateError,
  statePending,
}: Readonly<{
  campaignId: number;
  streamRef: number;
  lock: PublicationLockApi;
  state: PublicationStateResponse | null;
  stateError: { message: string; code: string | null } | null;
  statePending: boolean;
}>) {
  const queryClient = useQueryClient();
  const identity: StreamIdentity = { campaignId, streamRef };
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const locked = lock.lock !== null || lock.invalid;
  const availability =
    stateError !== null
      ? ({ kind: "unavailable", message: stateError.message } as Availability)
      : availabilityFor(state);
  const banner = lockMessage(lock.lock, lock.invalid);

  const refreshQueries = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.publication(campaignId, streamRef) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.draft(campaignId, streamRef) });
  };

  const submit = async () => {
    if (locked || busy || statePending) {
      return;
    }
    setConfirming(false);
    setBusy(true);
    setOutcome(null);
    setError(null);
    try {
      let freshState;
      let freshDraft: DraftStateResponse;
      let freshQueue;
      try {
        const rawState = await getPublicationState(campaignId, streamRef);
        if (!isValidPublicationState(rawState, identity)) {
          throw new Error("publication status mismatch");
        }
        const rawDraft = await getDraftState(campaignId, streamRef);
        if (!isValidDraftState(rawDraft, identity)) {
          throw new Error("draft mismatch");
        }
        const rawQueue = await getRecoverablePublications();
        const parsedQueue = parseRecoverableQueue(rawQueue);
        if (parsedQueue === null) {
          throw new Error("queue mismatch");
        }
        freshState = rawState;
        freshDraft = rawDraft;
        freshQueue = parsedQueue;
        queryClient.setQueryData(queryKeys.recoverablePublications, parsedQueue);
        queryClient.setQueryData(queryKeys.draft(campaignId, streamRef), rawDraft);
      } catch {
        setError(
          "A fresh valid publication status, draft and queue snapshot is required before Cancel.",
        );
        return;
      }

      const freshAvailability = availabilityFor(freshState);
      if (freshAvailability.kind !== "cancellable") {
        setOutcome(freshAvailability.message);
        return;
      }
      const preDraftVersion = freshDraft.draft?.version;
      const { identities, changed } = mergeStreamIdentities(
        identitiesFromQueue(freshQueue),
        [identity],
      );
      if (!changed && !identities.some((item) => item.streamRef === streamRef && item.campaignId === campaignId)) {
        setError("The cancel target could not be added to the lock union.");
        return;
      }
      const acquired = await lock.acquire(
        identities,
        "verification",
        freshQueue.length < 100,
        {
          kind: "cancel",
          stage: "reserved",
          draftVerification: [identity],
          cancelTarget: identity,
        },
      );
      if (!acquired) {
        setError(
          "The publication lock could not be persisted. No Cancel was sent.",
        );
        return;
      }
      const reserved = lock.getCurrent();
      const running =
        reserved !== null &&
        (await lock.markStage("running", lockSnapshot(reserved)));
      if (!running) {
        const current = lock.getCurrent();
        const aborted =
          current !== null &&
          (await lock.abortReserved({
            lockId: current.lockId,
            fingerprint: identities
              .map((item) => `${item.campaignId}:${item.streamRef}`)
              .sort()
              .join("|"),
          }));
        setError(
          aborted
            ? "The running phase could not be persisted. No Cancel was sent."
            : "The running phase could not be persisted. The lock remains active; no Cancel was sent.",
        );
        return;
      }

      let mode: CancelVerificationMode = "unknown";
      let code: string | undefined;
      let result: CancelResultResponse | null = null;
      try {
        result = parseCancelResult(await cancelPublication(campaignId, streamRef), identity);
        if (result === null) {
          mode = "unknown";
        } else if (result.reason === "NO_PUBLICATION") {
          mode = "noop";
        } else if (result.status === "abandoned") {
          mode = "success";
        }
      } catch (cancelError) {
        if (
          cancelError instanceof ApiError &&
          cancelError.status === 404 &&
          cancelError.code === "STREAM_NOT_FOUND" &&
          hasMatchingStreamIdentity(cancelError.details, identity)
        ) {
          mode = "refusal";
          code = "STREAM_NOT_FOUND";
        } else if (
          cancelError instanceof ApiError &&
          cancelError.status === 409
        ) {
          const details = parseCancelErrorDetails(cancelError.details);
          if (details !== null) {
            mode = "refusal";
            code = cancelError.code;
          }
        }
      }

      const verification = await lock.runExclusive((context) =>
        verifyCancelLock(context, {
          mode,
          code,
          target: identity,
          preDraftVersion,
          onQueue: (queue) => {
            queryClient.setQueryData(queryKeys.recoverablePublications, queue);
          },
        }),
      );
      setOutcome(verification.message);
      refreshQueries();
    } catch {
      setError("The publication Cancel outcome is unknown. No retry was made.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="publication-cancel-heading"
      className={styles.section}
      data-publication-cancel-lock={locked ? "active" : "inactive"}
    >
      <h3 id="publication-cancel-heading">Publication Cancel</h3>
      <p className={styles.hint}>
        This is separate from local draft Cancel. It never rolls back a
        successful remote publication and sends no Keitaro request.
      </p>
      {banner !== null && (
        <div className={styles.lockBanner} role="status">
          <p>{banner}</p>
          <Link to="/recovery">Open recovery queue</Link>
        </div>
      )}
      {busy && <output>Publication Cancel is running. No retry is made.</output>}
      {outcome !== null && <output>{outcome}</output>}
      {error !== null && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
      {stateError !== null && (
        <p className={styles.hint}>
          Publication Cancel is unavailable until the status read above succeeds.
        </p>
      )}
      {stateError === null && statePending && <output>Loading publication status…</output>}
      {!busy && !locked && !stateError && !statePending && availability.kind === "noop" && (
        <p className={styles.empty}>{availability.message}</p>
      )}
      {!busy && !locked && !stateError && !statePending && availability.kind === "blocked" && (
        <div className={styles.recoveryPanel} role="status">
          <p>{availability.message}</p>
          <Link to="/recovery">Inspect recovery queue</Link>
        </div>
      )}
      {!busy && !locked && !stateError && !statePending && availability.kind === "cancellable" && !confirming && (
        <div className={styles.inlineActions}>
          <button type="button" onClick={() => setConfirming(true)}>
            Cancel publication
          </button>
        </div>
      )}
      {!busy && !locked && !stateError && !statePending && availability.kind === "cancellable" && confirming && (
        <fieldset className={styles.confirm}>
          <legend>Confirm publication cancel</legend>
          <p>
            Mark this local publication operation abandoned and discard matching
            staged intent if present. This does not cancel or roll back anything
            in Keitaro and does not touch the local draft separately.
          </p>
          <button type="button" onClick={() => void submit()}>
            Confirm publication cancel
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Keep publication
          </button>
        </fieldset>
      )}
    </section>
  );
}

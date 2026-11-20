import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../../api/client";
import { ErrorSummary } from "../../shared/ui/ErrorSummary";
import {
  cancelPublication,
  getDraftState,
  getPublicationState,
  getRecoverablePublications,
  type CancelResultResponse,
  type DraftStateResponse,
  type PublicPublicationResponse,
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

type FreshCancelReads = {
  state: PublicationStateResponse;
  draft: DraftStateResponse;
  queue: PublicPublicationResponse[];
};

async function readFreshCancelState(
  campaignId: number,
  streamRef: number,
  identity: StreamIdentity,
): Promise<FreshCancelReads | null> {
  try {
    const state = await getPublicationState(campaignId, streamRef);
    if (!isValidPublicationState(state, identity)) {
      return null;
    }
    const draft = await getDraftState(campaignId, streamRef);
    if (!isValidDraftState(draft, identity)) {
      return null;
    }
    const queue = parseRecoverableQueue(await getRecoverablePublications());
    return queue === null ? null : { state, draft, queue };
  } catch {
    return null;
  }
}

function cancelMode(result: CancelResultResponse | null): CancelVerificationMode {
  if (result === null) {
    return "unknown";
  }
  if (result.reason === "NO_PUBLICATION") {
    return "noop";
  }
  return result.status === "abandoned" ? "success" : "unknown";
}

function cancelErrorMode(
  error: unknown,
  identity: StreamIdentity,
): { mode: CancelVerificationMode; code?: string } {
  if (error instanceof ApiError && error.status === 404) {
    if (
      error.code === "STREAM_NOT_FOUND" &&
      hasMatchingStreamIdentity(error.details, identity)
    ) {
      return { mode: "refusal", code: "STREAM_NOT_FOUND" };
    }
    return { mode: "unknown" };
  }
  if (error instanceof ApiError && error.status === 409) {
    if (parseCancelErrorDetails(error.details) !== null) {
      return { mode: "refusal", code: error.code };
    }
  }
  return { mode: "unknown" };
}

function identityKey(identity: StreamIdentity): string {
  return `${identity.campaignId}:${identity.streamRef}`;
}

function fingerprint(identities: StreamIdentity[]): string {
  return identities
    .map((item) => `${item.campaignId}:${item.streamRef}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
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
      const fresh = await readFreshCancelState(campaignId, streamRef, identity);
      if (fresh === null) {
        setError(
          "A fresh valid publication status, draft and queue snapshot is required before Cancel.",
        );
        return;
      }
      queryClient.setQueryData(queryKeys.recoverablePublications, fresh.queue);
      queryClient.setQueryData(queryKeys.draft(campaignId, streamRef), fresh.draft);
      const freshAvailability = availabilityFor(fresh.state);
      if (freshAvailability.kind !== "cancellable") {
        setOutcome(freshAvailability.message);
        return;
      }
      const preDraftVersion = fresh.draft.draft?.version;
      const { identities } = mergeStreamIdentities(
        identitiesFromQueue(fresh.queue),
        [identity],
      );
      if (!identities.some((item) => identityKey(item) === identityKey(identity))) {
        setError("The cancel target could not be added to the lock union.");
        return;
      }
      const acquired = await lock.acquire(
        identities,
        "verification",
        fresh.queue.length < 100,
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
          current?.stage === "reserved" &&
          (await lock.abortReserved({
            lockId: current.lockId,
            fingerprint: fingerprint(identities),
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
      try {
        mode = cancelMode(
          parseCancelResult(
            await cancelPublication(campaignId, streamRef),
            identity,
          ),
        );
      } catch (cancelError) {
        const classified = cancelErrorMode(cancelError, identity);
        mode = classified.mode;
        code = classified.code;
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
        <output className={styles.lockBanner}>
          <p>{banner}</p>
          <Link to="/recovery">Open recovery queue</Link>
        </output>
      )}
      {busy && <output>Publication Cancel is running. No retry is made.</output>}
      {outcome !== null && <output>{outcome}</output>}
      {error !== null && (
        <ErrorSummary heading="Publication Cancel blocked" message={error} />
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
        <output className={styles.recoveryPanel}>
          <p>{availability.message}</p>
          <Link to="/recovery">Inspect recovery queue</Link>
        </output>
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

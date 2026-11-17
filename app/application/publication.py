"""Slice 6 publication orchestration with durable claims and bounded recovery."""

import asyncio
import time
import uuid
from collections.abc import Mapping
from dataclasses import replace

from app.application.dto import (
    CancelDraftCommand,
    CancelPublicationCommand,
    CancelResult,
    DirtyDraftView,
    OfferEntry,
    PublicationOperationView,
    PublicationPlan,
    PushResult,
    PushStreamOutcome,
    PushStreamsCommand,
    RecoveryResult,
    StreamUpdateDTO,
)
from app.application.ports import (
    KeitaroClientPort,
    StreamDraftRepository,
    StreamPublicationRepository,
    StreamReconciliationRepository,
)
from app.domain.draft import DraftCommand, DraftCommandKind
from app.domain.publication import (
    PublicationStatus,
    build_offer_entries,
    entries_match,
    evaluate_eligibility,
)
from app.domain.reconciliation import RemoteOffer, validate_remote_offers


class PublicationGateError(RuntimeError):
    """Durable state or configuration blocks a new Push."""


class PublicationConflictError(RuntimeError):
    """A concurrent worker changed the captured publication state."""


class PublicationInputError(ValueError):
    """Remote or staged input cannot be published safely."""


_LIVE_WRITES_DISABLED = (
    "LIVE_WRITES_DISABLED: offers-only PUT preservation is not verified"
)


class PublicationService:
    """Application-owned Push, recovery and publication-aware Cancel."""

    def __init__(
        self,
        client: KeitaroClientPort,
        drafts: StreamDraftRepository,
        publications: StreamPublicationRepository,
        snapshots: StreamReconciliationRepository,
        *,
        allow_live_writes: bool = False,
        reconcile_attempts: int = 3,
        reconcile_delay: float = 0.1,
        max_recovery_operations: int = 50,
        recovery_deadline_seconds: float = 10.0,
    ):
        """Wire application ports, live-write gate and bounded read limits."""
        if reconcile_attempts < 1 or max_recovery_operations < 1:
            raise ValueError("bounded read limits must be positive")
        self._client = client
        self._drafts = drafts
        self._publications = publications
        self._snapshots = snapshots
        self._allow_live_writes = allow_live_writes
        self._reconcile_attempts = reconcile_attempts
        self._reconcile_delay = reconcile_delay
        self._max_recovery_operations = max_recovery_operations
        self._recovery_deadline_seconds = recovery_deadline_seconds

    async def push(self, command: PushStreamsCommand) -> PushResult:
        """Plan dirty streams, persist operations, then PUT them independently."""
        self._validate_command(command)
        targets, outcomes = await self._select_targets(command)
        if not targets:
            return PushResult(command.campaign_id, tuple(outcomes))

        planning: list[DirtyDraftView] = []
        resumable: list[PublicationOperationView] = []
        for target in targets:
            operation = await asyncio.to_thread(
                self._publications.get_unresolved,
                command.campaign_id,
                target.stream_ref,
            )
            if operation is None:
                planning.append(target)
            elif (
                operation.status is PublicationStatus.PENDING
                and operation.draft_version == target.version
                and dict(operation.intent) == dict(target.intent)
            ):
                resumable.append(operation)
            else:
                outcomes.append(
                    PushStreamOutcome(
                        target.stream_ref, reason="UNRESOLVED_PUBLICATION"
                    )
                )
        active_refs = tuple(target.stream_ref for target in planning) + tuple(
            operation.stream_ref for operation in resumable
        )
        if not active_refs:
            return PushResult(command.campaign_id, tuple(outcomes))
        if not self._allow_live_writes:
            outcomes.extend(
                PushStreamOutcome(ref, reason=_LIVE_WRITES_DISABLED)
                for ref in active_refs
            )
            return PushResult(command.campaign_id, tuple(outcomes))

        plans: list[PublicationPlan] = []
        for target in planning:
            plan, reason = await self._build_plan(command.campaign_id, target)
            if plan is not None:
                plans.append(plan)
            else:
                outcomes.append(PushStreamOutcome(target.stream_ref, reason=reason))

        operations: list[PublicationOperationView] = []
        if plans:
            try:
                operations.extend(
                    await asyncio.to_thread(
                        self._publications.create_pending, tuple(plans)
                    )
                )
            except (PublicationConflictError, PublicationGateError):
                outcomes.extend(
                    PushStreamOutcome(
                        target.stream_ref, reason="CONCURRENT_PUBLICATION"
                    )
                    for target in planning
                    if target.stream_ref in {plan.stream_ref for plan in plans}
                )
        for operation in resumable:
            reason = await self._validate_resume(operation)
            if reason is None:
                operations.append(operation)
            else:
                outcomes.append(PushStreamOutcome(operation.stream_ref, reason=reason))
        if not operations:
            return PushResult(command.campaign_id, tuple(outcomes))

        worker_token = str(uuid.uuid4())
        for operation in operations:
            outcomes.append(await self._push_one(operation, worker_token))
        return PushResult(command.campaign_id, tuple(outcomes))

    async def _validate_resume(self, operation: PublicationOperationView) -> str | None:
        """Revalidate a captured pending operation before reusing it."""
        try:
            document = await self._client.get_stream_document(operation.stream_ref)
        except Exception as exc:
            return f"PREIMAGE_READ_FAILED: {exc}"
        try:
            observed = self._document_offers(document, operation.stream_ref)
            baseline = self._document_offers(
                operation.remote_baseline_before, operation.stream_ref
            )
        except PublicationInputError as exc:
            return str(exc)
        if (
            document.get("id") != operation.stream_ref
            or document.get("campaign_id") != operation.campaign_id
            or observed != baseline
        ):
            return "STALE_REMOTE_STATE"
        return None

    async def recover(self) -> RecoveryResult:
        """Reconcile unresolved operations with bounded read-only calls."""
        deadline = time.monotonic() + self._recovery_deadline_seconds
        operations = await asyncio.to_thread(
            self._publications.list_recoverable, self._max_recovery_operations
        )
        remaining = len(operations)
        result = RecoveryResult(remaining=remaining)
        for operation in operations:
            if time.monotonic() >= deadline:
                return replace(result, deadline_reached=True)
            if operation.status is PublicationStatus.PENDING:
                continue
            confirmed, degraded = await self._reconcile_operation(operation)
            remaining -= 1
            result = RecoveryResult(
                processed=result.processed + 1,
                confirmed=result.confirmed + int(confirmed),
                unresolved=result.unresolved + int(not confirmed),
                degraded=result.degraded + int(degraded),
                remaining=remaining,
            )
        return result

    async def cancel(self, command: CancelPublicationCommand) -> CancelResult:
        """Cancel publication state without ever rolling back a remote success."""
        if type(command.campaign_id) is not int or command.campaign_id <= 0:
            raise PublicationInputError("campaign_id must be a positive int")
        if type(command.stream_ref) is not int or command.stream_ref <= 0:
            raise PublicationInputError("stream_ref must be a positive int")
        operation = await asyncio.to_thread(
            self._publications.get_latest, command.campaign_id, command.stream_ref
        )
        if operation is None:
            return CancelResult(command.stream_ref, reason="NO_PUBLICATION")
        status = operation.status
        if status is PublicationStatus.IN_PROGRESS:
            return CancelResult(command.stream_ref, status, "RECOVERY_REQUIRED")
        if status is PublicationStatus.AMBIGUOUS:
            return CancelResult(command.stream_ref, status, "RECOVERY_REQUIRED")
        if status is PublicationStatus.FAILED and not operation.evidence:
            return CancelResult(command.stream_ref, status, "ABSENCE_EVIDENCE_REQUIRED")
        if status not in (PublicationStatus.PENDING, PublicationStatus.FAILED):
            return CancelResult(command.stream_ref, status, "NOT_CANCELLABLE")
        abandoned = await asyncio.to_thread(
            self._publications.abandon, operation.id, "operator cancel"
        )
        if abandoned is None:
            return CancelResult(command.stream_ref, status, "CONCURRENT_PUBLICATION")
        discarded = False
        view = await asyncio.to_thread(self._drafts.get_view, command.stream_ref)
        if view is not None:
            intent = DraftCommand(DraftCommandKind.CANCEL)
            await asyncio.to_thread(
                self._drafts.apply,
                CancelDraftCommand(
                    command.campaign_id, command.stream_ref, view.version
                ),
                intent,
            )
            discarded = view.is_dirty
        return CancelResult(
            command.stream_ref,
            PublicationStatus.ABANDONED,
            draft_discarded=discarded,
        )

    @staticmethod
    def _validate_command(command: PushStreamsCommand) -> None:
        """Validate campaign identity and explicit stream selection."""
        if type(command.campaign_id) is not int or command.campaign_id <= 0:
            raise PublicationInputError("campaign_id must be a positive int")
        if any(type(ref) is not int or ref <= 0 for ref in command.stream_refs):
            raise PublicationInputError("stream_ref must be a positive int")
        if len(set(command.stream_refs)) != len(command.stream_refs):
            raise PublicationInputError("stream_refs must be unique")

    async def _select_targets(
        self, command: PushStreamsCommand
    ) -> tuple[list[DirtyDraftView], list[PushStreamOutcome]]:
        """Select dirty, non-stale drafts for the requested scope."""
        dirty = await asyncio.to_thread(self._drafts.list_dirty, command.campaign_id)
        by_ref = {item.stream_ref: item for item in dirty}
        outcomes: list[PushStreamOutcome] = []
        targets: list[DirtyDraftView] = []
        if command.stream_refs:
            for ref in command.stream_refs:
                item = by_ref.get(ref)
                if item is None:
                    outcomes.append(PushStreamOutcome(ref, reason="NO_DIRTY_DRAFT"))
                elif item.is_stale:
                    outcomes.append(PushStreamOutcome(ref, reason="STALE_CONFLICT"))
                else:
                    targets.append(item)
            return targets, outcomes
        for item in dirty:
            if item.is_stale:
                outcomes.append(
                    PushStreamOutcome(item.stream_ref, reason="STALE_CONFLICT_SKIPPED")
                )
            else:
                targets.append(item)
        return targets, outcomes

    async def _build_plan(
        self, campaign_id: int, target: DirtyDraftView
    ) -> tuple[PublicationPlan | None, str | None]:
        """Validate eligibility and capture the exact immutable request body."""
        view = await asyncio.to_thread(self._drafts.get_view, target.stream_ref)
        if (
            view is None
            or view.version != target.version
            or dict(view.staged_changes) != dict(target.intent)
        ):
            return None, "DRAFT_CHANGED"
        verdict = evaluate_eligibility(
            view.offers,
            policy_cases=view.policy_cases,
            unallocated=view.unallocated,
        )
        if not verdict.eligible:
            return None, str(verdict.reason)
        try:
            entries = build_offer_entries(view.offers)
        except ValueError as exc:
            return None, str(exc)
        try:
            document = await self._client.get_stream_document(target.stream_ref)
        except Exception as exc:
            return None, f"PREIMAGE_READ_FAILED: {exc}"
        try:
            remote = self._document_offers(document, target.stream_ref)
        except PublicationInputError as exc:
            return None, str(exc)
        if (
            document.get("campaign_id") != campaign_id
            or document.get("id") != target.stream_ref
        ):
            return None, "REMOTE_IDENTITY_MISMATCH"
        cached = await asyncio.to_thread(
            self._snapshots.get_remote_snapshot, target.stream_ref
        )
        if cached is None or cached.offers != remote:
            return None, "STALE_REMOTE_STATE"
        payload: dict[str, object] = {"offers": [entry.to_json() for entry in entries]}
        return (
            PublicationPlan(
                campaign_id=campaign_id,
                stream_ref=target.stream_ref,
                draft_version=target.version,
                intent=dict(target.intent),
                staged_offers=view.offers,
                payload=payload,
                expected_entries=entries,
                preimage=dict(document),
                correlation_marker=str(uuid.uuid4()),
            ),
            None,
        )

    @staticmethod
    def _document_offers(
        document: Mapping[str, object], stream_ref: int
    ) -> tuple[RemoteOffer, ...]:
        """Parse and validate the offers array of a raw stream document."""
        raw = document.get("offers")
        if raw is None:
            raw = []
        if not isinstance(raw, list):
            raise PublicationInputError(f"stream {stream_ref}: offers is not a list")
        offers: list[RemoteOffer] = []
        for position, item in enumerate(raw):
            if not isinstance(item, dict):
                raise PublicationInputError(
                    f"stream {stream_ref}: offer entry is not an object"
                )
            if "offer_id" not in item or "share" not in item:
                raise PublicationInputError(
                    f"stream {stream_ref}: offer is missing offer_id or share"
                )
            offers.append(
                RemoteOffer(
                    offer_id=item["offer_id"],
                    share=item["share"],
                    state=item.get("state"),
                    position=position,
                )
            )
        try:
            return validate_remote_offers(offers)
        except ValueError as exc:
            raise PublicationInputError(f"stream {stream_ref}: {exc}") from exc

    async def _push_one(self, operation, worker_token: str) -> PushStreamOutcome:
        """Claim, PUT once and verify one durable operation."""
        claimed = await asyncio.to_thread(
            self._publications.claim, operation.id, worker_token
        )
        if claimed is None:
            return PushStreamOutcome(
                operation.stream_ref, reason="CONCURRENT_PUBLICATION"
            )
        try:
            await self._client.update_stream(
                operation.stream_ref,
                StreamUpdateDTO(fields=dict(operation.request_payload)),
            )
        except Exception as exc:
            error = f"PUT failed with uncertain outcome: {exc}"
            await asyncio.to_thread(
                self._publications.mark_ambiguous, operation.id, error
            )
            return PushStreamOutcome(
                operation.stream_ref, PublicationStatus.AMBIGUOUS, operation.id, error
            )
        return await self._confirm(operation)

    async def _confirm(self, operation) -> PushStreamOutcome:
        """Read back a PUT result with bounded attempts before committing."""
        error = "read-back did not establish a verified match"
        for attempt in range(self._reconcile_attempts):
            try:
                document = await self._client.get_stream_document(operation.stream_ref)
                observed = self._document_offers(document, operation.stream_ref)
                entries = tuple(
                    OfferEntry(
                        offer_id=offer.offer_id,
                        share=offer.share,
                        state=offer.state,
                    )
                    for offer in observed
                )
                if (
                    document.get("id") == operation.stream_ref
                    and document.get("campaign_id") == operation.campaign_id
                    and entries_match(entries, operation.effective_entries)
                ):
                    verified = await asyncio.to_thread(
                        self._publications.finalize_success,
                        operation.id,
                        observed,
                    )
                    if verified is not None:
                        return PushStreamOutcome(
                            operation.stream_ref,
                            PublicationStatus.SUCCEEDED,
                            operation.id,
                        )
                    error = "draft changed before confirmation"
                    break
            except Exception as exc:
                error = f"read-back failed: {exc}"
            if attempt + 1 < self._reconcile_attempts:
                await asyncio.sleep(self._reconcile_delay)
        await asyncio.to_thread(self._publications.mark_ambiguous, operation.id, error)
        return PushStreamOutcome(
            operation.stream_ref, PublicationStatus.AMBIGUOUS, operation.id, error
        )

    async def _reconcile_operation(self, operation) -> tuple[bool, bool]:
        """Reconcile one operation with reads only; never repeat a PUT."""
        degraded = False
        for _ in range(self._reconcile_attempts):
            try:
                document = await self._client.get_stream_document(operation.stream_ref)
                observed = self._document_offers(document, operation.stream_ref)
                entries = tuple(
                    OfferEntry(
                        offer_id=offer.offer_id,
                        share=offer.share,
                        state=offer.state,
                    )
                    for offer in observed
                )
                if (
                    document.get("id") == operation.stream_ref
                    and document.get("campaign_id") == operation.campaign_id
                    and entries_match(entries, operation.effective_entries)
                ):
                    verified = await asyncio.to_thread(
                        self._publications.finalize_success,
                        operation.id,
                        observed,
                    )
                    if verified is not None:
                        return True, False
                    await asyncio.to_thread(
                        self._publications.mark_ambiguous,
                        operation.id,
                        "draft changed before confirmation",
                    )
                    return False, False
            except Exception as exc:
                degraded = True
                error = f"reconciliation read failed: {exc}"
            else:
                error = "read-back did not match the published intent"
            if operation.status is PublicationStatus.IN_PROGRESS:
                await asyncio.to_thread(
                    self._publications.mark_ambiguous, operation.id, error
                )
        return False, degraded

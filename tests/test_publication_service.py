"""Application-level Slice 6 tests with fakes and an explicit D14 assertion."""

import asyncio
import threading
import time
from dataclasses import replace
from datetime import UTC, datetime
from typing import cast

import pytest

from app.application.dto import (
    CancelDraftCommand,
    CancelPublicationCommand,
    DirtyDraftView,
    DraftCommandResult,
    DraftView,
    PublicationOperationView,
    PublicationPlan,
    PushStreamsCommand,
    RemoteSnapshotView,
    StreamDTO,
    StreamUpdateDTO,
)
from app.application.ports import (
    KeitaroClientPort,
    StreamDraftRepository,
    StreamPublicationRepository,
    StreamReconciliationRepository,
)
from app.application.publication import (
    PublicationConflictError,
    PublicationGateError,
    PublicationService,
)
from app.domain.allocation import PolicyCase
from app.domain.draft import DraftCommand, StagedOffer
from app.domain.publication import OfferEntry, PublicationStatus
from app.domain.reconciliation import BindingLifecycle, RemoteOffer


def staged(
    ref: int, share8: int = 60, share5: int | None = None
) -> tuple[StagedOffer, ...]:
    """Return a staged view; by default it totals exactly 100."""
    first = 100 - share8 if share5 is None else share5
    return (
        StagedOffer(5, BindingLifecycle.ACTIVE, False, first, "active", 0),
        StagedOffer(8, BindingLifecycle.ACTIVE, True, share8, "active", 1),
    )


def document(stream_ref: int, share8: int = 60) -> dict[str, object]:
    """Return a realistic raw stream document with a non-offer field."""
    return {
        "id": stream_ref,
        "campaign_id": 5,
        "type": "regular",
        "name": "offers",
        "schema": "landings",
        "action_payload": "keep-me",
        "offers": [
            {"offer_id": 5, "share": 100 - share8, "state": "active"},
            {"offer_id": 8, "share": share8, "state": "active"},
        ],
    }


class FakeDrafts:
    """Minimal draft port double recording thread ids."""

    def __init__(self):
        """Start with no drafts or views."""
        self.views: dict[int, DraftView] = {}
        self.dirty: dict[int, DirtyDraftView] = {}
        self.threads: list[int] = []
        self.applied: list[CancelDraftCommand] = []

    def add(
        self,
        stream_ref: int,
        *,
        share8: int = 60,
        share5: int | None = None,
        stale: bool = False,
    ):
        """Register one dirty draft and its derived view."""
        offers = staged(stream_ref, share8, share5)
        intent = {"share_edits": {"8": share8}}
        self.views[stream_ref] = DraftView(
            stream_ref=stream_ref,
            offers=offers,
            baseline_offers=(
                RemoteOffer(5, 40, "active", 0),
                RemoteOffer(8, 60, "active", 1),
            ),
            staged_changes=intent,
            version=1,
            is_dirty=True,
            is_stale=stale,
            conflicts=(),
            policy_cases=(PolicyCase.SINGLE_ACTIVE_OFFER,) if share8 == 100 else (),
            unallocated=0,
        )
        self.dirty[stream_ref] = DirtyDraftView(stream_ref, 1, intent, True, stale)

    def list_dirty(self, campaign_id: int) -> tuple[DirtyDraftView, ...]:
        """Return registered dirty drafts."""
        self.threads.append(threading.get_ident())
        return tuple(self.dirty.values())

    def get_view(self, stream_ref: int) -> DraftView | None:
        """Return the derived view off the event loop."""
        self.threads.append(threading.get_ident())
        return self.views.get(stream_ref)

    def apply(
        self, command: CancelDraftCommand, intent: DraftCommand
    ) -> DraftCommandResult:
        """Record a local cancel used after publication cancellation."""
        self.threads.append(threading.get_ident())
        self.applied.append(command)
        result = self.views.get(command.stream_ref)
        assert result is not None
        return DraftCommandResult(replace(result, version=0, is_dirty=False))


class FakeSnapshots:
    """Cached remote snapshots used for stale detection."""

    def __init__(self):
        """Start with no snapshots."""
        self.values: dict[int, RemoteSnapshotView] = {}

    def add(self, stream_ref: int, share8: int = 60) -> None:
        """Register the last observed remote offers."""
        self.values[stream_ref] = RemoteSnapshotView(
            (
                RemoteOffer(5, 100 - share8, "active", 0),
                RemoteOffer(8, share8, "active", 1),
            ),
            datetime.now(UTC).replace(tzinfo=None),
        )

    def get_remote_snapshot(self, stream_ref: int) -> RemoteSnapshotView | None:
        """Return a cached snapshot."""
        return self.values.get(stream_ref)


class FakeClient:
    """Keitaro double recording exact request order and bodies."""

    def __init__(self):
        """Start with default documents and no failures."""
        self.readbacks: dict[int, list[dict[str, object]]] = {}
        self.put_error: Exception | None = None
        self.get_error: Exception | None = None
        self.calls: list[str] = []
        self.puts: list[dict[str, object]] = []
        self.get_counts: dict[int, int] = {}
        self.get_delay = 0.0

    def add_stream(self, stream_ref: int, share8: int = 60) -> None:
        """Register a document used by every GET for one stream."""
        doc = document(stream_ref, share8)
        self.readbacks[stream_ref] = [doc]

    async def get_stream_document(self, stream_ref: int) -> dict[str, object]:
        """Return the pre-image first, then the read-back document."""
        self.calls.append(f"GET {stream_ref}")
        if self.get_error is not None:
            raise self.get_error
        if self.get_delay:
            await asyncio.sleep(self.get_delay)
        count = self.get_counts.get(stream_ref, 0) + 1
        self.get_counts[stream_ref] = count
        docs = self.readbacks[stream_ref]
        return docs[0] if count == 1 or len(docs) == 1 else docs[-1]

    async def update_stream(
        self, stream_ref: int, payload: StreamUpdateDTO
    ) -> StreamDTO:
        """Record the exact PUT body; never retry it."""
        self.calls.append(f"PUT {stream_ref}")
        self.puts.append(dict(payload.fields))
        if self.put_error is not None:
            raise self.put_error
        return StreamDTO(stream_ref, 5, "regular", "offers", "landings")


class FakePublications:
    """In-memory durable publication repository double."""

    def __init__(self):
        """Start with no operations."""
        self.operations: dict[int, PublicationOperationView] = {}
        self.next_id = 1
        self.plans: list[PublicationPlan] = []
        self.create_error: Exception | None = None
        self.claim_fails = False
        self.finalize_fails = False
        self.recoverable: tuple[PublicationOperationView, ...] = ()
        self.discardable: set[int] = set()
        self.cancel_conflict = False
        self.list_delay = 0.0
        self.list_completed = False

    def _store(self, plan: PublicationPlan, status: PublicationStatus):
        """Create one operation view from a plan."""
        view = PublicationOperationView(
            id=self.next_id,
            operation_uuid=plan.correlation_marker,
            campaign_id=plan.campaign_id,
            stream_ref=plan.stream_ref,
            status=status,
            draft_version=plan.draft_version,
            intent=plan.intent,
            request_payload=plan.payload,
            remote_baseline_before=plan.preimage,
            remote_baseline_after=None,
            effective_entries=plan.expected_entries,
            staged_offers=plan.staged_offers,
            attempt_count=0,
            error=None,
            evidence=None,
        )
        self.operations[self.next_id] = view
        self.next_id += 1
        return view

    def create_pending(
        self, plans: tuple[PublicationPlan, ...]
    ) -> tuple[PublicationOperationView, ...]:
        """Create pending operations unless a gate was configured."""
        if self.create_error is not None:
            raise self.create_error
        self.plans.extend(plans)
        return tuple(self._store(plan, PublicationStatus.PENDING) for plan in plans)

    def claim(self, operation_id: int, worker_token: str):
        """Atomically claim one pending operation."""
        if self.claim_fails:
            return None
        current = self.operations[operation_id]
        if current.status is not PublicationStatus.PENDING:
            return None
        updated = replace(
            current, status=PublicationStatus.IN_PROGRESS, attempt_count=1
        )
        self.operations[operation_id] = updated
        return updated

    def mark_ambiguous(self, operation_id: int, error: str):
        """Record an ambiguous outcome."""
        current = self.operations[operation_id]
        updated = replace(current, status=PublicationStatus.AMBIGUOUS, error=error)
        self.operations[operation_id] = updated
        return updated

    def mark_failed(self, operation_id: int, error: str, evidence):
        """Record an evidenced failure."""
        current = self.operations[operation_id]
        updated = replace(
            current, status=PublicationStatus.FAILED, error=error, evidence=evidence
        )
        self.operations[operation_id] = updated
        return updated

    def finalize_success(self, operation_id: int, remote_baseline_after):
        """Mark a verified success unless a changed draft was configured."""
        if self.finalize_fails:
            return None
        current = self.operations[operation_id]
        updated = replace(
            current,
            status=PublicationStatus.SUCCEEDED,
            remote_baseline_after=remote_baseline_after,
        )
        self.operations[operation_id] = updated
        return updated

    def has_unresolved(self, campaign_id: int, stream_refs: tuple[int, ...]) -> bool:
        """Derive the distributed gate from durable operation state."""
        return any(
            op.campaign_id == campaign_id
            and op.stream_ref in stream_refs
            and op.status
            in (
                PublicationStatus.PENDING,
                PublicationStatus.IN_PROGRESS,
                PublicationStatus.AMBIGUOUS,
            )
            for op in self.operations.values()
        )

    def get_unresolved(self, campaign_id: int, stream_ref: int):
        """Return one unresolved operation for safe pending resume."""
        matches = [
            op
            for op in self.operations.values()
            if op.campaign_id == campaign_id
            and op.stream_ref == stream_ref
            and op.status
            in (
                PublicationStatus.PENDING,
                PublicationStatus.IN_PROGRESS,
                PublicationStatus.AMBIGUOUS,
            )
        ]
        return matches[-1] if matches else None

    def get_latest(self, campaign_id: int, stream_ref: int):
        """Return the newest operation for one stream."""
        matches = [
            op
            for op in self.operations.values()
            if op.campaign_id == campaign_id and op.stream_ref == stream_ref
        ]
        return matches[-1] if matches else None

    def list_recoverable(self, limit: int):
        """Return configured unresolved operations after a simulated DB wait."""
        if self.list_delay:
            time.sleep(self.list_delay)
        self.list_completed = True
        return self.recoverable[:limit]

    def cancel(self, campaign_id: int, stream_ref: int, reason: str):
        """Atomically abandon and report the discarded draft in memory."""
        if self.cancel_conflict:
            raise PublicationConflictError("draft changed")
        operation = self.get_unresolved(campaign_id, stream_ref)
        if operation is None:
            return None
        updated = replace(operation, status=PublicationStatus.ABANDONED, error=reason)
        self.operations[operation.id] = updated
        return updated, stream_ref in self.discardable


def make_service(allow_live_writes: bool = True, **overrides):
    """Build a service with fresh fakes for one test."""
    drafts = FakeDrafts()
    snapshots = FakeSnapshots()
    client = FakeClient()
    publications = FakePublications()
    service = PublicationService(
        cast(KeitaroClientPort, client),
        cast(StreamDraftRepository, drafts),
        cast(StreamPublicationRepository, publications),
        cast(StreamReconciliationRepository, snapshots),
        allow_live_writes=allow_live_writes,
        reconcile_delay=0,
        **overrides,
    )
    return service, drafts, snapshots, client, publications


@pytest.mark.asyncio
async def test_live_writes_are_disabled_by_default():
    """No GET, operation or PUT happens while live writes are gated off."""
    service, drafts, _, client, publications = make_service(False)
    drafts.add(12)
    result = await service.push(PushStreamsCommand(5))
    assert result.outcomes[0].reason is not None
    assert "LIVE_WRITES_DISABLED" in result.outcomes[0].reason
    assert client.calls == []
    assert publications.operations == {}


@pytest.mark.asyncio
async def test_successful_push_uses_exact_request_order_and_body():
    """A verified PUT is GET → offers-only PUT → GET and respects D14."""
    service, drafts, snapshots, client, publications = make_service()
    drafts.add(12)
    snapshots.add(12)
    client.add_stream(12)
    result = await service.push(PushStreamsCommand(5))
    assert client.calls == ["GET 12", "PUT 12", "GET 12"]
    assert client.puts == [
        {
            "offers": [
                {"offer_id": 5, "share": 40, "state": "active"},
                {"offer_id": 8, "share": 60, "state": "active"},
            ]
        }
    ]
    assert result.outcomes[0].status is PublicationStatus.SUCCEEDED
    assert all(thread_id != threading.get_ident() for thread_id in drafts.threads)
    assert len(publications.plans) == 1


@pytest.mark.asyncio
async def test_definitive_four_xx_is_ambiguous_and_never_retried():
    """No PUT status range is treated as proof of absence."""
    service, drafts, snapshots, client, publications = make_service()
    drafts.add(12)
    snapshots.add(12)
    client.add_stream(12)
    client.put_error = RuntimeError("HTTP 422")  # status absorption is adapter-specific
    result = await service.push(PushStreamsCommand(5))
    assert result.outcomes[0].status is PublicationStatus.AMBIGUOUS
    assert client.calls.count("PUT 12") == 1
    operation = next(iter(publications.operations.values()))
    assert operation.status is PublicationStatus.AMBIGUOUS


@pytest.mark.asyncio
async def test_mismatched_readback_stays_ambiguous():
    """A successful PUT without a verified read-back never commits locally."""
    service, drafts, snapshots, client, publications = make_service()
    drafts.add(12)
    snapshots.add(12)
    client.readbacks[12] = [document(12), document(12, share8=45)]
    result = await service.push(PushStreamsCommand(5))
    assert result.outcomes[0].status is PublicationStatus.AMBIGUOUS
    operation = next(iter(publications.operations.values()))
    assert operation.status is PublicationStatus.AMBIGUOUS
    assert operation.remote_baseline_after is None


@pytest.mark.asyncio
async def test_partial_success_is_reported_per_stream():
    """One stream may confirm while another stays ambiguous."""
    service, drafts, snapshots, client, _ = make_service()
    drafts.add(12)
    drafts.add(13, share8=70)
    snapshots.add(12)
    snapshots.add(13, share8=70)
    client.add_stream(12)
    client.readbacks[13] = [document(13, share8=70), document(13, share8=50)]
    result = await service.push(PushStreamsCommand(5, (12, 13)))
    statuses = {item.stream_ref: item.status for item in result.outcomes}
    assert statuses[12] is PublicationStatus.SUCCEEDED
    assert statuses[13] is PublicationStatus.AMBIGUOUS


@pytest.mark.asyncio
async def test_matching_pending_operation_is_resumed_without_a_new_capture():
    """A crash before claim resumes its operation after pre-image revalidation."""
    service, drafts, _, client, publications = make_service()
    drafts.add(12)
    client.add_stream(12)
    plan = PublicationPlan(
        5,
        12,
        1,
        {"share_edits": {"8": 60}},
        staged(12),
        {"offers": []},
        (
            OfferEntry(5, 40, "active"),
            OfferEntry(8, 60, "active"),
        ),
        document(12),
        "resume-marker",
    )
    publications._store(plan, PublicationStatus.PENDING)
    result = await service.push(PushStreamsCommand(5))
    assert result.outcomes[0].status is PublicationStatus.SUCCEEDED
    assert client.puts
    assert client.calls.count("PUT 12") == 1
    assert publications.plans == []


@pytest.mark.asyncio
async def test_durable_gate_blocks_a_second_push():
    """A pending operation blocks another worker's Push in durable state."""
    service, drafts, snapshots, client, publications = make_service()
    drafts.add(12)
    snapshots.add(12)
    client.readbacks[12] = [document(12), document(12, share8=45)]
    await service.push(PushStreamsCommand(5))
    client.calls.clear()
    second = await service.push(PushStreamsCommand(5))
    assert second.outcomes[0].reason == "UNRESOLVED_PUBLICATION"
    assert client.calls == []


@pytest.mark.asyncio
async def test_create_conflict_maps_to_concurrent_publication():
    """A losing claim/capture worker never issues a PUT."""
    service, drafts, snapshots, client, publications = make_service()
    drafts.add(12)
    snapshots.add(12)
    client.add_stream(12)
    publications.create_error = PublicationGateError("gate lost")
    result = await service.push(PushStreamsCommand(5))
    assert result.outcomes[0].reason == "CONCURRENT_PUBLICATION"
    assert not any(call.startswith("PUT") for call in client.calls)


@pytest.mark.asyncio
async def test_recovery_confirms_only_matching_reads_and_never_puts():
    """Startup recovery is read-only and marks unmatched operations ambiguous."""
    service, _, _, client, publications = make_service()
    for stream_ref, share8 in ((12, 60), (13, 70)):
        plan = PublicationPlan(
            5, stream_ref, 1, {}, (), {"offers": []}, (), {}, "marker"
        )
        operation = publications._store(plan, PublicationStatus.IN_PROGRESS)
        operation = replace(
            operation,
            effective_entries=(
                OfferEntry(5, 100 - share8, "active"),
                OfferEntry(8, share8, "active"),
            ),
        )
        publications.operations[operation.id] = operation
        publications.recoverable = (*publications.recoverable, operation)
        client.add_stream(stream_ref, 50 if stream_ref == 13 else share8)
    result = await service.recover()
    assert result.processed == 2
    assert result.confirmed == 1
    assert result.unresolved == 1
    assert all(not call.startswith("PUT") for call in client.calls)


@pytest.mark.asyncio
async def test_recovery_deadline_cancels_a_hanging_get():
    """One hanging GET cannot hold startup past the configured deadline."""
    service, _, _, client, publications = make_service(
        recovery_deadline_seconds=0.05, reconcile_attempts=3
    )
    for stream_ref in (12, 13):
        plan = PublicationPlan(5, stream_ref, 1, {}, (), {"offers": []}, (), {}, "m")
        operation = publications._store(plan, PublicationStatus.IN_PROGRESS)
        publications.operations[operation.id] = replace(
            operation,
            effective_entries=(
                OfferEntry(5, 40, "active"),
                OfferEntry(8, 60, "active"),
            ),
        )
        publications.recoverable = (*publications.recoverable, operation)
        client.add_stream(stream_ref)
    client.get_delay = 1.0
    started = time.monotonic()
    result = await service.recover()
    elapsed = time.monotonic() - started
    assert elapsed < 0.5
    assert result.deadline_reached is True
    assert len(client.calls) == 1
    for operation in publications.operations.values():
        assert operation.status is PublicationStatus.IN_PROGRESS


@pytest.mark.asyncio
async def test_slow_recovery_db_call_finishes_before_startup_continues():
    """DB work is awaited to completion; no remote phase starts after expiry."""
    service, _, _, client, publications = make_service(recovery_deadline_seconds=0.05)
    plan = PublicationPlan(5, 12, 1, {}, (), {"offers": []}, (), {}, "m")
    operation = publications._store(plan, PublicationStatus.IN_PROGRESS)
    publications.recoverable = (operation,)
    publications.list_delay = 0.1
    result = await service.recover()
    assert publications.list_completed is True
    assert result.deadline_reached is True
    assert result.processed == 0
    assert client.calls == []


@pytest.mark.asyncio
async def test_cancel_is_reconcile_first():
    """D25 blocks Cancel for unresolved state and requires evidence for failed."""
    service, drafts, _, _, publications = make_service()
    drafts.add(12)
    plan = PublicationPlan(5, 12, 1, {}, (), {"offers": []}, (), {}, "m")
    ambiguous = publications._store(plan, PublicationStatus.AMBIGUOUS)
    result = await service.cancel(CancelPublicationCommand(5, 12))
    assert result.reason == "RECOVERY_REQUIRED"
    assert publications.operations[ambiguous.id].status is PublicationStatus.AMBIGUOUS

    publications.operations[ambiguous.id] = replace(
        ambiguous, status=PublicationStatus.FAILED
    )
    result = await service.cancel(CancelPublicationCommand(5, 12))
    assert result.reason == "ABSENCE_EVIDENCE_REQUIRED"

    pending = publications._store(plan, PublicationStatus.PENDING)
    publications.operations = {pending.id: pending}
    publications.discardable = {12}
    result = await service.cancel(CancelPublicationCommand(5, 12))
    assert result.status is PublicationStatus.ABANDONED
    assert result.draft_discarded is True


@pytest.mark.asyncio
async def test_cancel_conflict_keeps_operation_and_draft_unchanged():
    """A changed draft rejects Cancel without abandoning the operation."""
    service, drafts, _, _, publications = make_service()
    drafts.add(12)
    plan = PublicationPlan(5, 12, 1, {}, (), {"offers": []}, (), {}, "m")
    pending = publications._store(plan, PublicationStatus.PENDING)
    publications.cancel_conflict = True
    result = await service.cancel(CancelPublicationCommand(5, 12))
    assert result.reason == "DRAFT_CHANGED"
    assert publications.operations[pending.id].status is PublicationStatus.PENDING


@pytest.mark.asyncio
async def test_stale_draft_is_not_selected_for_push():
    """D17 conflicts are never silently cleared by a publication attempt."""
    service, drafts, _, client, _ = make_service()
    drafts.add(12, stale=True)
    result = await service.push(PushStreamsCommand(5))
    assert result.outcomes[0].reason == "STALE_CONFLICT_SKIPPED"
    assert client.calls == []


@pytest.mark.asyncio
async def test_ineligible_staged_view_is_rejected_before_any_remote_read():
    """D23 rejects a non-100 total without any GET or PUT."""
    service, drafts, _, client, _ = make_service()
    drafts.add(12, share8=55, share5=40)
    result = await service.push(PushStreamsCommand(5))
    assert result.outcomes[0].reason is not None
    assert client.calls == []

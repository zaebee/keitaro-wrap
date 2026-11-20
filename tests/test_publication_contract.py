"""Mocked-HTTP contract tests for the exact Slice 6 remote sequence."""

import json
from dataclasses import replace
from datetime import UTC, datetime
from typing import cast

import httpx
import pytest

from app.application.dto import (
    DirtyDraftView,
    DraftCommandResult,
    DraftView,
    PublicationOperationView,
    PushStreamsCommand,
    RemoteSnapshotView,
)
from app.application.ports import (
    KeitaroClientPort,
    StreamDraftRepository,
    StreamPublicationRepository,
    StreamReconciliationRepository,
)
from app.application.publication import PublicationService
from app.domain.draft import StagedOffer
from app.domain.publication import PublicationStatus
from app.domain.reconciliation import BindingLifecycle, RemoteOffer
from app.keitaro_client.client import KeitaroClient

DOCUMENT = {
    "id": 12,
    "campaign_id": 5,
    "type": "regular",
    "name": "offers",
    "schema": "landings",
    "action_payload": "must-not-be-sent",
    "offers": [
        {"offer_id": 5, "share": 40, "state": "active"},
        {"offer_id": 8, "share": 60, "state": "active"},
    ],
}


class Drafts:
    """Minimal draft port exposing one dirty draft."""

    def list_dirty(self, campaign_id: int) -> tuple[DirtyDraftView, ...]:
        """Return one dirty draft."""
        return (DirtyDraftView(12, 1, {"share_edits": {"8": 60}}, True, False),)

    def get_view(self, stream_ref: int) -> DraftView | None:
        """Return the staged view used to build the payload."""
        return DraftView(
            stream_ref,
            (
                StagedOffer(5, BindingLifecycle.ACTIVE, False, 40, "active", 0),
                StagedOffer(8, BindingLifecycle.ACTIVE, True, 60, "active", 1),
            ),
            (),
            {"share_edits": {"8": 60}},
            1,
            True,
            False,
            (),
            "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            (),
            0,
        )

    def apply(self, command, intent) -> DraftCommandResult:
        """Local cancel is not exercised in this contract test."""
        raise AssertionError("unexpected draft command")


class Snapshots:
    """Minimal snapshot port with one matching cached observation."""

    def get_remote_snapshot(self, stream_ref: int) -> RemoteSnapshotView | None:
        """Return the pre-publication cache."""
        return RemoteSnapshotView(
            (
                RemoteOffer(5, 40, "active", 0),
                RemoteOffer(8, 60, "active", 1),
            ),
            datetime.now(UTC).replace(tzinfo=None),
        )


class Publications:
    """Minimal in-memory operation store."""

    def __init__(self):
        """Start without operations."""
        self.operations: dict[int, PublicationOperationView] = {}
        self.next_id = 1

    def has_unresolved(self, campaign_id: int, stream_refs: tuple[int, ...]) -> bool:
        """No operation exists before the first Push."""
        return False

    def create_pending(self, plans):
        """Create one pending operation."""
        plan = plans[0]
        view = PublicationOperationView(
            self.next_id,
            plan.correlation_marker,
            plan.campaign_id,
            plan.stream_ref,
            PublicationStatus.PENDING,
            plan.draft_version,
            plan.intent,
            plan.payload,
            plan.preimage,
            None,
            plan.expected_entries,
            plan.staged_offers,
            0,
            None,
            None,
        )
        self.operations[self.next_id] = view
        self.next_id += 1
        return (view,)

    def claim(self, operation_id: int, worker_token: str):
        """Claim the operation once."""
        current = self.operations[operation_id]
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

    def finalize_success(self, operation_id: int, remote_baseline_after):
        """Record a verified success."""
        current = self.operations[operation_id]
        updated = replace(
            current,
            status=PublicationStatus.SUCCEEDED,
            remote_baseline_after=remote_baseline_after,
        )
        self.operations[operation_id] = updated
        return updated

    def get_unresolved(self, campaign_id: int, stream_ref: int):
        """No unresolved operation exists before the first Push."""
        return None

    def get_latest(self, campaign_id: int, stream_ref: int):
        """Return the newest operation."""
        return next(iter(self.operations.values()), None)

    def list_recoverable(self, limit: int):
        """No recovery operations in this test."""
        return ()

    def cancel(self, campaign_id: int, stream_ref: int, reason: str):
        """Not used here."""
        return None

    def mark_failed(self, operation_id: int, error: str, evidence):
        """Not used here."""
        return None


@pytest.mark.asyncio
async def test_exact_offers_only_body_and_readback_sequence():
    """The real client sends the exact documented body with no stream fields."""
    requests: list[tuple[str, str, bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content
        requests.append((request.method, request.url.path, body))
        if request.method == "GET":
            return httpx.Response(200, json=DOCUMENT)
        assert json.loads(body) == {
            "offers": [
                {"offer_id": 5, "share": 40, "state": "active"},
                {"offer_id": 8, "share": 60, "state": "active"},
            ]
        }
        return httpx.Response(200, json=DOCUMENT)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://example.com"
    ) as http:
        service = PublicationService(
            cast(KeitaroClientPort, KeitaroClient(http, api_key="secret")),
            cast(StreamDraftRepository, Drafts()),
            cast(StreamPublicationRepository, Publications()),
            cast(StreamReconciliationRepository, Snapshots()),
            allow_live_writes=True,
            reconcile_delay=0,
        )
        result = await service.push(PushStreamsCommand(5))

    assert [item[:2] for item in requests] == [
        ("GET", "/admin_api/v1/streams/12"),
        ("PUT", "/admin_api/v1/streams/12"),
        ("GET", "/admin_api/v1/streams/12"),
    ]
    assert "must-not-be-sent" not in requests[1][2].decode()
    assert result.outcomes[0].status is PublicationStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_put_rejection_is_ambiguous_without_a_second_put():
    """A 400 from Keitaro is ambiguous evidence, never a blind retry."""
    count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal count
        if request.method == "GET":
            return httpx.Response(200, json=DOCUMENT)
        count += 1
        return httpx.Response(400, json={"message": "bad request"})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://example.com"
    ) as http:
        service = PublicationService(
            cast(KeitaroClientPort, KeitaroClient(http, api_key="secret")),
            cast(StreamDraftRepository, Drafts()),
            cast(StreamPublicationRepository, Publications()),
            cast(StreamReconciliationRepository, Snapshots()),
            allow_live_writes=True,
            reconcile_delay=0,
        )
        result = await service.push(PushStreamsCommand(5))

    assert count == 1
    assert result.outcomes[0].status is PublicationStatus.AMBIGUOUS

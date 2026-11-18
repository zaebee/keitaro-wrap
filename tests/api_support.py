"""Deterministic fakes and helpers for route-level S7 tests."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import FastAPI

from app.api.deps import (
    get_campaign_creation_service,
    get_draft_service,
    get_fetch_service,
    get_publication_service,
)
from app.api.errors import register_error_handlers
from app.api.routes import router
from app.application.dto import (
    CampaignCreationResult,
    CommittedStateView,
    CreateCampaignOutcome,
    DraftCommandResult,
    DraftView,
    FetchOutcome,
    PublicPublicationView,
    PushResult,
    RecoveryResult,
    RemoteSnapshotView,
    StreamBindingView,
    StreamRefView,
)
from app.application.publication import CancelResult
from app.domain.allocation import PolicyCase
from app.domain.campaign_creation import OperationStatus
from app.domain.draft import StagedOffer
from app.domain.publication import OfferEntry, PublicationStatus
from app.domain.reconciliation import BindingLifecycle, RemoteOffer


def sample_draft_view(stream_ref: int = 12, version: int = 1) -> DraftView:
    """Build a small valid effective draft view."""
    offer = StagedOffer(
        offer_id=7,
        lifecycle=BindingLifecycle.ACTIVE,
        is_pinned=False,
        share=100,
        state="active",
        position=0,
    )
    baseline = RemoteOffer(7, 100, "active", 0)
    return DraftView(
        stream_ref=stream_ref,
        offers=(offer,),
        baseline_offers=(baseline,),
        staged_changes={},
        version=version,
        is_dirty=False,
        is_stale=False,
        conflicts=(),
        policy_cases=(PolicyCase.SINGLE_ACTIVE_OFFER,),
        unallocated=0,
    )


def sample_publication(stream_ref: int = 12) -> PublicPublicationView:
    """Build a safe publication projection."""
    return PublicPublicationView(
        operation_uuid="operation-1",
        campaign_id=5,
        stream_ref=stream_ref,
        status=PublicationStatus.SUCCEEDED,
        draft_version=3,
        effective_entries=(OfferEntry(7, 100, "active"),),
        attempt_count=1,
    )


@dataclass
class CampaignServiceFake:
    """Async campaign-service double."""

    result: CampaignCreationResult | None = None
    created: bool = True
    error: Exception | None = None
    calls: list[tuple[Any, ...]] = field(default_factory=list)

    async def create_idempotent(self, command: Any, operation_uuid: str):
        """Record a creation call and return a configured outcome."""
        self.calls.append(("create", command, operation_uuid))
        if self.error is not None:
            raise self.error
        result = self.result or CampaignCreationResult(
            operation_uuid=operation_uuid,
            alias="slug-abcdef12",
            status=OperationStatus.STARTED,
        )
        return CreateCampaignOutcome(result, self.created)

    async def get(self, operation_uuid: str):
        """Record a read call."""
        self.calls.append(("get", operation_uuid))
        if self.error is not None:
            raise self.error
        return self.result

    async def resume(self, operation_uuid: str):
        """Record a resume call."""
        self.calls.append(("resume", operation_uuid))
        if self.error is not None:
            raise self.error
        return self.result


@dataclass
class FetchServiceFake:
    """Async Fetch-service double."""

    outcome: FetchOutcome | None = None
    streams: tuple[StreamRefView, ...] = ()
    committed: CommittedStateView | None = None
    error: Exception | None = None
    calls: list[tuple[Any, ...]] = field(default_factory=list)

    async def fetch(self, command: Any):
        """Record a Fetch call."""
        self.calls.append(("fetch", command))
        if self.error is not None:
            raise self.error
        return self.outcome

    async def list_streams(self, campaign_id: int):
        """Record a cached stream listing."""
        self.calls.append(("list_streams", campaign_id))
        return self.streams

    async def get_committed(self, campaign_id: int, stream_ref: int):
        """Record a committed-state read."""
        self.calls.append(("committed", campaign_id, stream_ref))
        if self.error is not None:
            raise self.error
        return self.committed


@dataclass
class DraftServiceFake:
    """Async draft-service double."""

    view: DraftView | None = None
    error: Exception | None = None
    calls: list[tuple[Any, ...]] = field(default_factory=list)

    async def _apply(self, name: str, command: Any):
        """Record one draft command."""
        self.calls.append((name, command))
        if self.error is not None:
            raise self.error
        return DraftCommandResult(view=self.view or sample_draft_view(), created=True)

    async def add(self, command: Any):
        """Stage an addition."""
        return await self._apply("add", command)

    async def remove(self, command: Any):
        """Stage an archive."""
        return await self._apply("remove", command)

    async def restore(self, command: Any):
        """Stage a restore."""
        return await self._apply("restore", command)

    async def set_pin(self, command: Any):
        """Stage a pin or unpin."""
        return await self._apply("set_pin", command)

    async def set_share(self, command: Any):
        """Stage a share edit."""
        return await self._apply("set_share", command)

    async def cancel(self, command: Any):
        """Cancel local staged intent."""
        return await self._apply("cancel", command)

    async def get_view_for_campaign(self, campaign_id: int, stream_ref: int):
        """Read a campaign-scoped draft view."""
        self.calls.append(("get_view", campaign_id, stream_ref))
        if self.error is not None:
            raise self.error
        return self.view


@dataclass
class PublicationServiceFake:
    """Async publication-service double."""

    push_result: PushResult | None = None
    cancel_result: CancelResult | None = None
    publication: PublicPublicationView | None = None
    recoverable: tuple[PublicPublicationView, ...] = ()
    recovery: RecoveryResult | None = None
    error: Exception | None = None
    calls: list[tuple[Any, ...]] = field(default_factory=list)

    async def push(self, command: Any):
        """Record a Push call."""
        self.calls.append(("push", command))
        if self.error is not None:
            raise self.error
        return self.push_result or PushResult(
            campaign_id=command.campaign_id, outcomes=()
        )

    async def cancel(self, command: Any):
        """Record a publication Cancel call."""
        self.calls.append(("cancel", command))
        if self.error is not None:
            raise self.error
        return self.cancel_result or CancelResult(command.stream_ref)

    async def get_latest(self, campaign_id: int, stream_ref: int):
        """Record a publication read."""
        self.calls.append(("get_latest", campaign_id, stream_ref))
        if self.error is not None:
            raise self.error
        return self.publication

    async def list_recoverable(self, limit: int):
        """Record a bounded unresolved-operation read."""
        self.calls.append(("list_recoverable", limit))
        return self.recoverable

    async def recover(self):
        """Record a bounded recovery pass."""
        self.calls.append(("recover",))
        return self.recovery or RecoveryResult()


def build_client(
    *,
    campaign: CampaignServiceFake | None = None,
    fetch: FetchServiceFake | None = None,
    draft: DraftServiceFake | None = None,
    publication: PublicationServiceFake | None = None,
    overrides: dict[Any, Any] | None = None,
):
    """Build an ASGI client with service fakes installed via dependency overrides."""
    app = FastAPI()
    app.include_router(router)
    register_error_handlers(app)
    if campaign is not None:
        app.dependency_overrides[get_campaign_creation_service] = lambda: campaign
    if fetch is not None:
        app.dependency_overrides[get_fetch_service] = lambda: fetch
    if draft is not None:
        app.dependency_overrides[get_draft_service] = lambda: draft
    if publication is not None:
        app.dependency_overrides[get_publication_service] = lambda: publication
    for dependency, provider in (overrides or {}).items():
        app.dependency_overrides[dependency] = provider
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    )


def committed_view(stream_ref: int = 12) -> CommittedStateView:
    """Build a committed-state view with one binding and a cached snapshot."""
    binding = StreamBindingView(7, "ACTIVE", False, 100)
    snapshot = RemoteSnapshotView(
        (RemoteOffer(7, 100, "active", 0),),
        datetime.now(UTC).replace(tzinfo=None),
    )
    return CommittedStateView(stream_ref, (binding,), snapshot)

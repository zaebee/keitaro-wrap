"""Transport safety tests: generic errors and the D14 event-loop boundary."""

import threading
from typing import cast
from uuid import uuid4

import pytest

from app.api.deps import get_fetch_service
from app.application.dto import FetchOutcome, FetchSnapshot
from app.application.fetch import FetchService
from app.application.ports import KeitaroClientPort, StreamReconciliationRepository
from tests.api_support import CampaignServiceFake, build_client


class _ReadClient:
    """Async Keitaro double returning an empty stream list."""

    async def list_campaign_streams(self, campaign_id: int):
        """Return no streams for the test campaign."""
        return []


class _ThreadRecordingRepository:
    """Synchronous repository double recording its execution thread."""

    def __init__(self):
        """Start with no recorded calls."""
        self.threads: list[int] = []

    def reconcile(self, snapshot: FetchSnapshot) -> FetchOutcome:
        """Record the calling thread and return a deterministic outcome."""
        self.threads.append(threading.get_ident())
        return FetchOutcome(snapshot.campaign_id, 0, 0)


@pytest.mark.asyncio
async def test_sync_repository_work_is_off_the_event_loop():
    """A route using the real Fetch service never runs sync DB work on the loop."""
    repository = _ThreadRecordingRepository()
    service = FetchService(
        cast(KeitaroClientPort, _ReadClient()),
        cast(StreamReconciliationRepository, repository),
    )
    async with build_client(overrides={get_fetch_service: lambda: service}) as client:
        response = await client.post("/campaigns/5/fetch")
    assert response.status_code == 200
    assert repository.threads
    assert repository.threads[0] != threading.get_ident()


@pytest.mark.asyncio
async def test_unhandled_error_is_safe_500():
    """Internal exception text is not leaked to API clients."""
    fake = CampaignServiceFake(error=RuntimeError("secret internal detail"))
    async with build_client(campaign=fake) as client:
        response = await client.get(f"/campaign-creations/{uuid4()}")
    assert response.status_code == 500
    body = response.json()["error"]
    assert body["code"] == "INTERNAL_ERROR"
    assert "secret internal detail" not in response.text

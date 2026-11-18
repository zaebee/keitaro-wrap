"""Route-level tests for Fetch and cached read endpoints."""

import pytest

from app.application.dto import FetchOutcome, StreamRefView
from app.application.errors import StreamNotFoundError, UpstreamError
from app.domain.reconciliation import RemoteOfferValidationError
from tests.api_support import FetchServiceFake, build_client, committed_view


@pytest.mark.asyncio
async def test_fetch_returns_reconciliation_counts():
    """Fetch exposes only the application outcome, not persistence rows."""
    outcome = FetchOutcome(
        campaign_id=5,
        stream_count=2,
        reconciled_stream_count=1,
        created_bindings=3,
        conflicted_drafts=1,
    )
    fake = FetchServiceFake(outcome=outcome)
    async with build_client(fetch=fake) as client:
        response = await client.post("/campaigns/5/fetch")
    assert response.status_code == 200
    assert response.json()["conflicted_drafts"] == 1
    assert fake.calls[0][1].campaign_id == 5


@pytest.mark.asyncio
async def test_stream_list_and_committed_state_are_readable():
    """Cached stream refs and committed bindings are exposed as typed DTOs."""
    ref = StreamRefView(12, 5, "default", "offer flow", "landings", "marker")
    fake = FetchServiceFake(streams=(ref,), committed=committed_view())
    async with build_client(fetch=fake) as client:
        streams = await client.get("/campaigns/5/streams")
        committed = await client.get("/campaigns/5/streams/12/committed")
    assert streams.status_code == 200
    assert streams.json()[0]["schema"] == "landings"
    assert committed.status_code == 200
    assert committed.json()["bindings"][0]["offer_id"] == 7
    assert committed.json()["snapshot"]["offers"][0]["share"] == 100


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (UpstreamError(404, "campaign missing"), 502, "KEITARO_UPSTREAM_FAILURE"),
        (RemoteOfferValidationError("duplicate offer"), 422, "DOMAIN_POLICY_REJECTION"),
        (StreamNotFoundError(5, 12), 404, "STREAM_NOT_FOUND"),
    ],
)
async def test_fetch_read_errors_are_mapped(error, status, code):
    """Upstream, domain and not-found failures keep stable codes."""
    fake = FetchServiceFake(error=error)
    async with build_client(fetch=fake) as client:
        response = await client.get("/campaigns/5/streams/12/committed")
    assert response.status_code == status
    assert response.json()["error"]["code"] == code


@pytest.mark.asyncio
async def test_invalid_campaign_id_never_reaches_service():
    """Path shape validation stays in the transport layer."""
    fake = FetchServiceFake()
    async with build_client(fetch=fake) as client:
        response = await client.post("/campaigns/0/fetch")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert fake.calls == []

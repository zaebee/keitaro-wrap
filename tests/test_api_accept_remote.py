"""Route-level contract tests for explicit Accept-remote conflict resolution."""

import pytest

from app.api.deps import get_conflict_resolution_service
from app.application.draft import DraftVersionConflict
from app.application.dto import AcceptRemoteResult
from app.application.errors import (
    ConflictChangedError,
    ConflictResolutionInputError,
)
from app.application.publication import PublicationGateError
from app.keitaro_client.client import KeitaroError
from tests.api_support import build_client, sample_draft_view

PATH = "/campaigns/5/streams/12/draft/accept-remote"
BODY = {"expected_version": 1, "expected_conflicts_fingerprint": "sha256:test"}


class ResolutionServiceFake:
    """Record one route call and return a configured application outcome."""

    def __init__(self, result=None, error: Exception | None = None):
        """Seed the result or the exception to raise."""
        self.result = result
        self.error = error
        self.commands = []

    async def accept_remote(self, command):
        """Record the typed command built by the transport."""
        self.commands.append(command)
        if self.error is not None:
            raise self.error
        return self.result


def client_for(service: ResolutionServiceFake):
    """Build an ASGI client with the resolution service overridden."""
    return build_client(overrides={get_conflict_resolution_service: lambda: service})


@pytest.mark.asyncio
async def test_accept_remote_returns_observable_clean_draft():
    """A successful resolution returns the full allowlisted draft view."""
    view = sample_draft_view(12, version=2)
    service = ResolutionServiceFake(AcceptRemoteResult(12, view, False, 2))
    async with client_for(service) as client:
        response = await client.post(PATH, json=BODY)

    assert response.status_code == 200
    body = response.json()
    assert body["stream_ref"] == 12
    assert body["noop"] is False
    assert body["version"] == 2
    assert body["draft"]["version"] == 2
    assert body["draft"]["conflicts"] == []
    assert isinstance(body["draft"]["conflicts_fingerprint"], str)
    assert service.commands[0].expected_version == 1
    assert service.commands[0].expected_conflicts_fingerprint == "sha256:test"


@pytest.mark.asyncio
async def test_accept_remote_noop_for_clean_draft():
    """An already-resolved clean draft returns its current view with noop=true."""
    view = sample_draft_view(12)
    service = ResolutionServiceFake(AcceptRemoteResult(12, view, True, 1))
    async with client_for(service) as client:
        response = await client.post(PATH, json=BODY)

    assert response.status_code == 200
    assert response.json()["noop"] is True
    assert response.json()["version"] == 1


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (
            ConflictResolutionInputError("no draft exists for this stream"),
            422,
            "DOMAIN_POLICY_REJECTION",
        ),
        (
            DraftVersionConflict(
                "draft version changed",
                stream_ref=12,
                expected_version=1,
                current_version=2,
            ),
            409,
            "DRAFT_VERSION_CONFLICT",
        ),
        (
            ConflictChangedError(12, "sha256:old", "sha256:new"),
            409,
            "DRAFT_CONFLICT_CHANGED",
        ),
        (
            PublicationGateError("unresolved publication"),
            409,
            "PUBLICATION_UNRESOLVED",
        ),
        (KeitaroError(0, "timeout"), 502, "KEITARO_UPSTREAM_FAILURE"),
    ],
)
@pytest.mark.asyncio
async def test_accept_remote_error_mapping(error, status, code):
    """Every typed failure keeps its established stable error code."""
    async with client_for(ResolutionServiceFake(error=error)) as client:
        response = await client.post(PATH, json=BODY)

    assert response.status_code == status
    assert response.json()["error"]["code"] == code


@pytest.mark.asyncio
async def test_conflict_changed_details_are_structured():
    """The new 409 carries both fingerprints without exposing internal state."""
    error = ConflictChangedError(12, "sha256:old", "sha256:new")
    async with client_for(ResolutionServiceFake(error=error)) as client:
        response = await client.post(PATH, json=BODY)

    details = response.json()["error"]["details"]
    assert details == {
        "stream_ref": 12,
        "expected": "sha256:old",
        "observed": "sha256:new",
    }


@pytest.mark.asyncio
async def test_speculative_fields_are_rejected():
    """The contract exposes only the two agreed concurrency tokens."""
    async with client_for(ResolutionServiceFake()) as client:
        response = await client.post(PATH, json={**BODY, "strategy": "accept_remote"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"

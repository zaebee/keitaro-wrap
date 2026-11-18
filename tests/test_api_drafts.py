"""Route-level tests for local draft commands and effective draft reads."""

import pytest

from app.application.draft import DraftStaleError, DraftVersionConflict
from app.application.errors import StreamNotFoundError
from app.application.publication import PublicationGateError
from app.domain.draft import DraftBaselineUnavailable, DraftInputError
from app.domain.reconciliation import ConflictDetail
from tests.api_support import DraftServiceFake, build_client, sample_draft_view


@pytest.mark.asyncio
async def test_draft_view_returns_effective_view_or_null():
    """An existing stream without a draft returns a typed null draft."""
    fake = DraftServiceFake(view=sample_draft_view())
    async with build_client(draft=fake) as client:
        response = await client.get("/campaigns/5/streams/12/draft")
    assert response.status_code == 200
    body = response.json()
    assert body["stream_ref"] == 12
    assert body["draft"]["version"] == 1
    assert body["draft"]["policy_cases"] == ["single_active_offer"]
    assert fake.calls == [("get_view", 5, 12)]


@pytest.mark.asyncio
async def test_missing_draft_is_not_a_not_found_error():
    """Existing streams simply report an absent draft."""
    fake = DraftServiceFake(view=None)
    async with build_client(draft=fake) as client:
        response = await client.get("/campaigns/5/streams/12/draft")
    assert response.status_code == 200
    assert response.json()["draft"] is None


@pytest.mark.parametrize(
    ("path", "payload", "expected_name"),
    [
        ("add", {"offer_id": 7}, "add"),
        ("remove", {"offer_id": 7}, "remove"),
        ("restore", {"offer_id": 7}, "restore"),
        ("pin", {"offer_id": 7}, "set_pin"),
        ("unpin", {"offer_id": 7}, "set_pin"),
        ("share", {"offer_id": 7, "share": 35}, "set_share"),
        ("cancel", {}, "cancel"),
    ],
)
@pytest.mark.asyncio
async def test_each_draft_command_forwards_version_and_intent(
    path, payload, expected_name
):
    """All commands delegate to the service with an unchanged expected version."""
    fake = DraftServiceFake(view=sample_draft_view(version=4))
    body = {"expected_version": 3, **payload}
    async with build_client(draft=fake) as client:
        response = await client.post(f"/campaigns/5/streams/12/draft/{path}", json=body)
    assert response.status_code == 200
    assert response.json()["view"]["version"] == 4
    name, command = fake.calls[0]
    assert name == expected_name
    assert command.expected_version == 3
    assert command.campaign_id == 5
    assert command.stream_ref == 12


@pytest.mark.asyncio
async def test_pin_and_unpin_are_explicit_booleans():
    """Dedicated routes map to set_pin with true and false."""
    fake = DraftServiceFake(view=sample_draft_view())
    async with build_client(draft=fake) as client:
        await client.post(
            "/campaigns/5/streams/12/draft/pin",
            json={"expected_version": 1, "offer_id": 7},
        )
        await client.post(
            "/campaigns/5/streams/12/draft/unpin",
            json={"expected_version": 2, "offer_id": 7},
        )
    assert [call[1].is_pinned for call in fake.calls] == [True, False]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (
            DraftVersionConflict(
                "changed", stream_ref=12, expected_version=3, current_version=4
            ),
            409,
            "DRAFT_VERSION_CONFLICT",
        ),
        (
            DraftStaleError(
                12,
                (ConflictDetail(12, 7, "share", 20, 25, "remote share changed"),),
            ),
            409,
            "DRAFT_STALE_CONFLICT",
        ),
        (
            DraftBaselineUnavailable("missing baseline"),
            409,
            "DRAFT_BASELINE_UNAVAILABLE",
        ),
        (DraftInputError("offer 7 is archived"), 422, "DOMAIN_POLICY_REJECTION"),
        (PublicationGateError("unresolved publication"), 409, "PUBLICATION_UNRESOLVED"),
        (StreamNotFoundError(5, 12), 404, "STREAM_NOT_FOUND"),
    ],
)
async def test_draft_errors_mapping(error, status, code):
    """Draft failures preserve stable codes and structured details."""
    fake = DraftServiceFake(error=error)
    async with build_client(draft=fake) as client:
        response = await client.post(
            "/campaigns/5/streams/12/draft/add",
            json={"expected_version": 3, "offer_id": 7},
        )
    assert response.status_code == status
    body = response.json()["error"]
    assert body["code"] == code
    assert isinstance(body["details"], dict)


@pytest.mark.asyncio
async def test_stale_conflict_details_are_preserved():
    """Structured conflict data is not flattened into a message."""
    error = DraftStaleError(
        12, (ConflictDetail(12, 7, "share", 20, 25, "remote share changed"),)
    )
    fake = DraftServiceFake(error=error)
    async with build_client(draft=fake) as client:
        response = await client.post(
            "/campaigns/5/streams/12/draft/add",
            json={"expected_version": 3, "offer_id": 7},
        )
    details = response.json()["error"]["details"]
    assert details["conflicts"][0]["offer_id"] == 7
    assert details["conflicts"][0]["expected"] == 20
    assert details["conflicts"][0]["observed"] == 25


@pytest.mark.asyncio
async def test_bool_share_is_rejected_by_transport():
    """StrictInt rejects bool before any application command is built."""
    fake = DraftServiceFake(view=sample_draft_view())
    async with build_client(draft=fake) as client:
        response = await client.post(
            "/campaigns/5/streams/12/draft/share",
            json={"expected_version": 3, "offer_id": 7, "share": True},
        )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert fake.calls == []

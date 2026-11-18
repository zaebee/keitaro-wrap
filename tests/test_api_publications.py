"""Route-level tests for Push, publication reads, Cancel and recovery."""

import pytest

from app.application.dto import PublicationOutcomeReason, PushResult, PushStreamOutcome
from app.application.errors import StreamNotFoundError, UpstreamError
from app.application.publication import CancelResult
from app.domain.publication import PublicationStatus
from tests.api_support import PublicationServiceFake, build_client, sample_publication


@pytest.mark.asyncio
async def test_push_reports_independent_stream_outcomes():
    """Partial success is represented per stream with no aggregate success flag."""
    result = PushResult(
        campaign_id=5,
        outcomes=(
            PushStreamOutcome(12, PublicationStatus.SUCCEEDED, 1),
            PushStreamOutcome(13, PublicationStatus.AMBIGUOUS, 2, "read-back failed"),
            PushStreamOutcome(
                14,
                reason="STALE_CONFLICT",
                reason_code=PublicationOutcomeReason.STALE_CONFLICT,
            ),
        ),
    )
    fake = PublicationServiceFake(push_result=result)
    async with build_client(publication=fake) as client:
        response = await client.post(
            "/campaigns/5/push", json={"stream_refs": [12, 13, 14]}
        )
    assert response.status_code == 200
    body = response.json()
    assert "success" not in body
    assert [item["status"] for item in body["outcomes"]] == [
        "succeeded",
        "ambiguous",
        None,
    ]
    assert body["outcomes"][1]["reason"] == "read-back failed"
    assert fake.calls[0][1].stream_refs == (12, 13, 14)


@pytest.mark.asyncio
async def test_disabled_live_writes_return_503_with_full_result():
    """A typed LIVE_WRITES_DISABLED outcome is fail-closed and keeps all outcomes."""
    result = PushResult(
        campaign_id=5,
        outcomes=(
            PushStreamOutcome(
                12,
                reason=(
                    "LIVE_WRITES_DISABLED: offers-only PUT preservation is not verified"
                ),
                reason_code=PublicationOutcomeReason.LIVE_WRITES_DISABLED,
            ),
            PushStreamOutcome(
                13,
                reason="NO_DIRTY_DRAFT",
                reason_code=PublicationOutcomeReason.NO_DIRTY_DRAFT,
            ),
        ),
    )
    fake = PublicationServiceFake(push_result=result)
    async with build_client(publication=fake) as client:
        response = await client.post("/campaigns/5/push", json={"stream_refs": []})
    assert response.status_code == 503
    body = response.json()["error"]
    assert body["code"] == "PUBLICATION_WRITES_DISABLED"
    assert len(body["details"]["result"]["outcomes"]) == 2
    assert body["details"]["result"]["outcomes"][0]["reason_code"] == (
        "live_writes_disabled"
    )


@pytest.mark.asyncio
async def test_publication_view_is_allowlisted():
    """No internal recovery evidence appears in a public publication response."""
    fake = PublicationServiceFake(publication=sample_publication())
    async with build_client(publication=fake) as client:
        response = await client.get("/campaigns/5/streams/12/publication")
    assert response.status_code == 200
    body = response.json()["operation"]
    assert body["operation_uuid"] == "operation-1"
    assert body["effective_entries"][0]["share"] == 100
    assert set(body) == {
        "operation_uuid",
        "campaign_id",
        "stream_ref",
        "status",
        "draft_version",
        "effective_entries",
        "attempt_count",
    }


@pytest.mark.asyncio
async def test_recoverable_list_and_recovery_result():
    """Unresolved list and recovery result use the same typed projection."""
    fake = PublicationServiceFake(
        recoverable=(sample_publication(),),
        recovery=None,
    )
    async with build_client(publication=fake) as client:
        listed = await client.get("/publications/recoverable?limit=10")
        recovered = await client.post("/publications/recover")
    assert listed.status_code == 200
    assert listed.json()[0]["status"] == "succeeded"
    assert recovered.status_code == 200
    assert recovered.json()["deadline_reached"] is False


@pytest.mark.asyncio
async def test_degraded_recovery_is_503_with_counts():
    """A degraded bounded pass returns 503 without hiding its structured counts."""
    from app.application.dto import RecoveryResult

    fake = PublicationServiceFake(
        recovery=RecoveryResult(degraded=1, remaining=2, deadline_reached=True)
    )
    async with build_client(publication=fake) as client:
        response = await client.post("/publications/recover")
    assert response.status_code == 503
    body = response.json()["error"]
    assert body["code"] == "RECOVERY_DEGRADED"
    assert body["details"]["result"]["degraded"] == 1
    assert body["details"]["result"]["remaining"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("result", "status", "code"),
    [
        (CancelResult(12, reason="NO_PUBLICATION"), 200, None),
        (
            CancelResult(12, PublicationStatus.ABANDONED, draft_discarded=True),
            200,
            None,
        ),
        (
            CancelResult(12, PublicationStatus.IN_PROGRESS, "RECOVERY_REQUIRED"),
            409,
            "PUBLICATION_RECOVERY_REQUIRED",
        ),
        (
            CancelResult(12, PublicationStatus.FAILED, "ABSENCE_EVIDENCE_REQUIRED"),
            409,
            "PUBLICATION_ABSENCE_EVIDENCE_REQUIRED",
        ),
        (
            CancelResult(12, PublicationStatus.SUCCEEDED, "NOT_CANCELLABLE"),
            409,
            "PUBLICATION_NOT_CANCELLABLE",
        ),
    ],
)
async def test_publication_cancel_contract(result, status, code):
    """D25 refusals are errors but preserve the full CancelResult."""
    fake = PublicationServiceFake(cancel_result=result)
    async with build_client(publication=fake) as client:
        response = await client.post("/campaigns/5/streams/12/publication/cancel")
    assert response.status_code == status
    if code is None:
        assert response.json()["reason"] == result.reason
        return
    body = response.json()["error"]
    assert body["code"] == code
    assert body["details"]["result"]["stream_ref"] == 12
    assert body["details"]["status"] == result.status.value
    assert body["details"]["reason"] == result.reason


@pytest.mark.asyncio
async def test_publication_read_errors_are_mapped():
    """Unknown streams and upstream failures have distinct stable errors."""
    fake = PublicationServiceFake(error=StreamNotFoundError(5, 12))
    async with build_client(publication=fake) as client:
        missing = await client.get("/campaigns/5/streams/12/publication")
    fake = PublicationServiceFake(error=UpstreamError(503, "busy"))
    async with build_client(publication=fake) as client:
        upstream = await client.post("/campaigns/5/push", json={})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "STREAM_NOT_FOUND"
    assert upstream.status_code == 502
    assert upstream.json()["error"]["code"] == "KEITARO_UPSTREAM_FAILURE"

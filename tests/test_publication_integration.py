"""End-to-end backend publication tests over a local fake Keitaro server.

These tests exercise the real HTTP API, composition root, Keitaro HTTP adapter
and SQLite repositories. They never contact production Keitaro and use only
synthetic identifiers and a dummy API key.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.db.models import (
    RemoteOfferSnapshotModel,
    StreamOfferBindingModel,
    StreamPublicationModel,
    StreamRefModel,
)
from app.db.repositories import SqlAlchemyStreamPublicationRepository
from app.domain.publication import PublicationStatus
from tests.publication_integration_support import (
    EXPECTED_OFFER_ENTRIES,
    KEITARO_PATH,
    TEST_API_KEY,
    TEST_CAMPAIGN_ID,
    TEST_OFFER_ID,
    TEST_OFFER_ID_B,
    TEST_STREAM_ID,
    FakeKeitaroState,
    IntegrationDatabase,
    assert_no_unresolved,
    bind_app_to_test_runtime,
    draft_rows,
    publication_rows,
    seed_eligible_draft,
    start_fake_keitaro,
    stream_document,
    writable_view,
)
from tests.publication_integration_support import (  # noqa: E402
    integration_db as publication_integration_db,
)

integration_db = publication_integration_db


def remote_get(server_url: str) -> dict[str, Any]:
    """Perform an independent fresh GET from the local fake Keitaro."""
    url = f"{server_url}{KEITARO_PATH}/streams/{TEST_STREAM_ID}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=3.0) as response:
        return json.load(response)


def offer_map(offers: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Index offer documents by offer_id for order-insensitive comparison."""
    return {item["offer_id"]: item for item in offers}


def post_push(
    monkeypatch: pytest.MonkeyPatch,
    db: IntegrationDatabase,
    server_url: str,
    *,
    allow_live_writes: bool = True,
    timeout: float = 30.0,
) -> Any:
    """Bind the real app once and POST one Push through the HTTP API."""
    app = bind_app_to_test_runtime(
        monkeypatch,
        db,
        server_url,
        allow_live_writes=allow_live_writes,
        timeout=timeout,
    )
    with TestClient(app) as client:
        return client.post(
            f"/campaigns/{TEST_CAMPAIGN_ID}/push",
            json={"stream_refs": [TEST_STREAM_ID]},
        )


def assert_outcome(response: Any, status: str | None) -> dict[str, Any]:
    """Extract the single stream outcome from a successful HTTP response."""
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["campaign_id"] == TEST_CAMPAIGN_ID
    outcomes = payload["outcomes"]
    assert len(outcomes) == 1
    outcome = outcomes[0]
    assert outcome["stream_ref"] == TEST_STREAM_ID
    assert outcome["status"] == status
    return outcome


def test_push_full_stack_succeeds_and_updates_durable_state(
    monkeypatch: pytest.MonkeyPatch, integration_db: IntegrationDatabase
) -> None:
    """One Push goes API -> service -> real client -> fake Keitaro -> SQLite."""
    seed_eligible_draft(integration_db)
    state = FakeKeitaroState(stream_document())
    server = start_fake_keitaro(state)
    try:
        assert_no_unresolved(integration_db)
        response = post_push(monkeypatch, integration_db, server.url)

        outcome = assert_outcome(response, "succeeded")
        operation_id = outcome["operation_id"]
        assert operation_id is not None
        puts = state.puts()
        assert len(puts) == 1
        assert puts[0].path == f"{KEITARO_PATH}/streams/{TEST_STREAM_ID}"
        assert puts[0].api_key == TEST_API_KEY
        sent_body = json.loads(puts[0].body)
        assert set(sent_body) == {"offers"}
        sent = sorted(sent_body["offers"], key=lambda x: x["offer_id"])
        expected = sorted(EXPECTED_OFFER_ENTRIES, key=lambda x: x["offer_id"])
        assert sent == expected

        remote = remote_get(server.url)
        actual = offer_map(remote["offers"])
        for entry in expected:
            assert actual[entry["offer_id"]]["share"] == entry["share"]
            assert actual[entry["offer_id"]]["state"] == entry["state"]

        rows = publication_rows(integration_db)
        assert len(rows) == 1
        row = rows[0]
        assert row.id == operation_id
        assert row.status == PublicationStatus.SUCCEEDED.value
        assert row.attempt_count == 1
        assert row.error is None
        assert draft_rows(integration_db) == []
        assert_no_unresolved(integration_db)

        with integration_db.factory() as session:
            ref = session.get(StreamRefModel, 1)
            assert ref is not None
            assert ref.draft_version_counter == 1
            cache = session.query(RemoteOfferSnapshotModel).one()
            cached = offer_map(json.loads(cache.offers_json))
            assert cached[TEST_OFFER_ID]["share"] == 30
            assert cached[TEST_OFFER_ID_B]["share"] == 70
            bindings = {
                item.offer_id: item
                for item in session.query(StreamOfferBindingModel).all()
            }
            assert set(bindings) == {TEST_OFFER_ID, TEST_OFFER_ID_B}
            assert bindings[TEST_OFFER_ID].lifecycle == "ACTIVE"
            assert bindings[TEST_OFFER_ID].is_pinned is True
            assert bindings[TEST_OFFER_ID].last_remote_share == 30
            assert bindings[TEST_OFFER_ID_B].lifecycle == "ACTIVE"
            assert bindings[TEST_OFFER_ID_B].is_pinned is True
            assert bindings[TEST_OFFER_ID_B].last_remote_share == 70
    finally:
        server.close()


def test_gate_disabled_rejects_push_without_remote_write(
    monkeypatch: pytest.MonkeyPatch, integration_db: IntegrationDatabase
) -> None:
    """A disabled gate rejects Push before any operation or remote PUT."""
    seed_eligible_draft(integration_db)
    state = FakeKeitaroState(stream_document())
    server = start_fake_keitaro(state)
    try:
        assert_no_unresolved(integration_db)
        response = post_push(
            monkeypatch, integration_db, server.url, allow_live_writes=False
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "PUBLICATION_WRITES_DISABLED"
        assert state.puts() == []
        assert publication_rows(integration_db) == []
        assert len(draft_rows(integration_db)) == 1
    finally:
        server.close()


def test_readback_mismatch_keeps_operation_ambiguous(
    monkeypatch: pytest.MonkeyPatch, integration_db: IntegrationDatabase
) -> None:
    """Keitaro accepting the PUT is not an application success without read-back."""
    seed_eligible_draft(integration_db)
    state = FakeKeitaroState(stream_document())
    state.readback_share = 29
    server = start_fake_keitaro(state)
    try:
        assert_no_unresolved(integration_db)
        response = post_push(monkeypatch, integration_db, server.url)
        assert_outcome(response, "ambiguous")
        assert len(state.puts()) == 1
        rows = publication_rows(integration_db)
        assert len(rows) == 1
        assert rows[0].status == PublicationStatus.AMBIGUOUS.value
        assert rows[0].remote_baseline_after_json is None
        assert len(draft_rows(integration_db)) == 1
    finally:
        server.close()


def test_put_timeout_after_delivery_is_ambiguous_without_retry(
    monkeypatch: pytest.MonkeyPatch, integration_db: IntegrationDatabase
) -> None:
    """A late response cannot trigger a second PUT after a client timeout."""
    seed_eligible_draft(integration_db)
    state = FakeKeitaroState(stream_document())
    state.put_delay = 0.6
    server = start_fake_keitaro(state)
    try:
        assert_no_unresolved(integration_db)
        response = post_push(monkeypatch, integration_db, server.url, timeout=0.2)
        assert_outcome(response, "ambiguous")
        assert state.put_handled.wait(3.0)
        assert len(state.puts()) == 1
        remote = remote_get(server.url)
        assert offer_map(remote["offers"])[TEST_OFFER_ID]["share"] == 30
        rows = publication_rows(integration_db)
        assert len(rows) == 1
        assert rows[0].status == PublicationStatus.AMBIGUOUS.value
    finally:
        server.close()


def test_second_push_after_ambiguous_is_blocked_without_mutation(
    monkeypatch: pytest.MonkeyPatch, integration_db: IntegrationDatabase
) -> None:
    """An AMBIGUOUS operation blocks another Push and never blindly retries."""
    seed_eligible_draft(integration_db)
    state = FakeKeitaroState(stream_document())
    state.readback_share = 29
    server = start_fake_keitaro(state)
    try:
        assert_no_unresolved(integration_db)
        app = bind_app_to_test_runtime(
            monkeypatch, integration_db, server.url, allow_live_writes=True
        )
        with TestClient(app) as client:
            first = client.post(
                f"/campaigns/{TEST_CAMPAIGN_ID}/push",
                json={"stream_refs": [TEST_STREAM_ID]},
            )
            assert_outcome(first, "ambiguous")
            second = client.post(
                f"/campaigns/{TEST_CAMPAIGN_ID}/push",
                json={"stream_refs": [TEST_STREAM_ID]},
            )
        assert second.status_code == 200
        outcome = second.json()["outcomes"][0]
        assert outcome["reason"] == "UNRESOLVED_PUBLICATION"
        assert outcome["status"] is None
        assert len(state.puts()) == 1
        assert len(publication_rows(integration_db)) == 1
    finally:
        server.close()


def test_finalize_failure_after_remote_change_is_not_success(
    monkeypatch: pytest.MonkeyPatch, integration_db: IntegrationDatabase
) -> None:
    """A local persistence failure cannot report SUCCEEDED or repeat the PUT."""
    seed_eligible_draft(integration_db)
    state = FakeKeitaroState(stream_document())
    server = start_fake_keitaro(state)

    def fail_finalize(self: Any, operation_id: int, remote_baseline_after: Any) -> None:
        """Simulate a local finalize failure after the remote mutation landed."""
        raise RuntimeError("local finalize unavailable")

    monkeypatch.setattr(
        SqlAlchemyStreamPublicationRepository, "finalize_success", fail_finalize
    )
    try:
        assert_no_unresolved(integration_db)
        response = post_push(monkeypatch, integration_db, server.url)
        assert_outcome(response, "ambiguous")
        assert len(state.puts()) == 1
        assert offer_map(remote_get(server.url)["offers"])[TEST_OFFER_ID]["share"] == 30
        rows = publication_rows(integration_db)
        assert len(rows) == 1
        assert rows[0].status == PublicationStatus.AMBIGUOUS.value
        assert len(draft_rows(integration_db)) == 1
    finally:
        server.close()


def test_preflight_guard_refuses_run_with_unresolved_pending(
    monkeypatch: pytest.MonkeyPatch, integration_db: IntegrationDatabase
) -> None:
    """Procedure-level guard: do not start a test run with PENDING present.

    This checks the acceptance-test preflight helper, not an application-level
    Push guard; the application has its own resume behavior for matching
    PENDING operations and is intentionally not exercised here.
    """
    seed_eligible_draft(integration_db)
    state = FakeKeitaroState(stream_document())
    server = start_fake_keitaro(state)
    try:
        with integration_db.factory() as session:
            ref = session.get(StreamRefModel, 1)
            assert ref is not None
            session.add(
                StreamPublicationModel(
                    operation_uuid="pending-integration-marker",
                    campaign_id=TEST_CAMPAIGN_ID,
                    stream_ref=TEST_STREAM_ID,
                    stream_ref_id=ref.id,
                    status=PublicationStatus.PENDING.value,
                    draft_version=1,
                    attempt_count=0,
                    request_payload_json="{}",
                    remote_baseline_before_json="{}",
                    expected_intent_json="{}",
                    effective_offers_json="[]",
                    staged_offers_json="[]",
                )
            )
            session.commit()
        with pytest.raises(AssertionError, match="unresolved publication"):
            assert_no_unresolved(integration_db)
        assert state.puts() == []
    finally:
        server.close()


def test_offers_only_put_preserves_every_other_writable_field(
    monkeypatch: pytest.MonkeyPatch, integration_db: IntegrationDatabase
) -> None:
    """All documented writable fields except offers survive the remote PUT."""
    seed_eligible_draft(integration_db)
    state = FakeKeitaroState(stream_document())
    server = start_fake_keitaro(state)
    try:
        before = writable_view(state.snapshot())
        assert_no_unresolved(integration_db)
        assert_outcome(post_push(monkeypatch, integration_db, server.url), "succeeded")
        after = writable_view(remote_get(server.url))
        assert before.keys() == after.keys()
        for field in before:
            if field == "offers":
                continue
            assert after[field] == before[field], field
    finally:
        server.close()

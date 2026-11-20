"""Local, deterministic support for publication integration tests.

Nothing in this module contacts a real Keitaro instance. The fake server binds
only to 127.0.0.1 on an ephemeral port and uses synthetic identifiers.
"""

from __future__ import annotations

import copy
import json
import threading
import time
from collections.abc import Generator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from sqlalchemy import Engine, create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app import main as main_module
from app.core.config import settings
from app.db.base import Base
from app.db.models import (
    RemoteOfferSnapshotModel,
    StreamDraftModel,
    StreamOfferBindingModel,
    StreamPublicationModel,
    StreamRefModel,
)
from app.db.repositories import (
    SqlAlchemyCampaignCreationOperations,
    SqlAlchemySettingsRepository,
    SqlAlchemyStreamDraftRepository,
    SqlAlchemyStreamPublicationRepository,
    SqlAlchemyStreamReconciliationRepository,
)
from app.domain.publication import UNRESOLVED_STATUSES

TEST_CAMPAIGN_ID = 90001
TEST_STREAM_ID = 90002
TEST_OFFER_ID = 90003
TEST_OFFER_ID_B = 90006
TEST_OFFER_ROW_ID = 90004
TEST_OFFER_ROW_ID_B = 90007
TEST_FILTER_ROW_ID = 90005
TEST_API_KEY = "integration-test-key"
KEITARO_PATH = "/admin_api/v1"
FIXED_TIMESTAMP = "2026-01-01 00:00:00"
EXPECTED_OFFER_ENTRIES: tuple[dict[str, Any], ...] = (
    {"offer_id": TEST_OFFER_ID, "share": 30, "state": "active"},
    {"offer_id": TEST_OFFER_ID_B, "share": 70, "state": "active"},
)

WRITABLE_FIELDS: tuple[str, ...] = (
    "campaign_id",
    "type",
    "name",
    "position",
    "weight",
    "action_options",
    "comments",
    "state",
    "action_type",
    "schema",
    "collect_clicks",
    "filter_or",
    "filters",
    "triggers",
    "landings",
    "offers",
)


@dataclass(frozen=True)
class IntegrationDatabase:
    """A temporary SQLite database and its session factory."""

    engine: Engine
    factory: sessionmaker[Session]


@dataclass(frozen=True)
class CapturedRequest:
    """One scrubbed view of an outbound request seen by the fake server."""

    method: str
    path: str
    body: bytes
    api_key: str | None


@dataclass
class FakeKeitaroState:
    """Mutable state and captured requests of the local fake Keitaro."""

    document: dict[str, Any]
    requests: list[CapturedRequest] = field(default_factory=list)
    readback_share: int | None = None
    put_delay: float = 0.0
    put_apply: bool = True
    put_handled: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, Any]:
        """Return a detached copy of the current stream document."""
        with self.lock:
            return copy.deepcopy(self.document)

    def puts(self) -> list[CapturedRequest]:
        """Return all captured PUT requests in arrival order."""
        with self.lock:
            return [item for item in self.requests if item.method == "PUT"]

    def offers(self) -> list[dict[str, Any]]:
        """Return the current remote offers array."""
        return self.snapshot()["offers"]


@dataclass(frozen=True)
class FakeKeitaroServer:
    """A running loopback-only HTTP server plus its observed state."""

    url: str
    state: FakeKeitaroState
    _server: ThreadingHTTPServer
    _thread: threading.Thread

    def close(self) -> None:
        """Stop the server and release the loopback port."""
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)


def stream_document() -> dict[str, Any]:
    """Build a full stream document with synthetic sentinel values."""
    return {
        "id": TEST_STREAM_ID,
        "type": "regular",
        "name": "integration-stream",
        "campaign_id": TEST_CAMPAIGN_ID,
        "position": 7,
        "weight": 13,
        "action_options": {"redirect": "sentinel"},
        "comments": "sentinel-comments",
        "state": "active",
        "created_at": FIXED_TIMESTAMP,
        "action_type": "http",
        "action_payload": "runtime-only-sentinel",
        "schema": "landings",
        "collect_clicks": True,
        "filter_or": True,
        "offer_selection": "after_click",
        "filters": [
            {
                "id": TEST_FILTER_ROW_ID,
                "stream_id": TEST_STREAM_ID,
                "name": "geo",
                "mode": "accept",
                "payload": ["XX"],
                "oid": TEST_FILTER_ROW_ID,
            }
        ],
        "triggers": [],
        "landings": [],
        "offers": [
            {
                "id": TEST_OFFER_ROW_ID,
                "stream_id": TEST_STREAM_ID,
                "offer_id": TEST_OFFER_ID,
                "state": "active",
                "share": 40,
                "created_at": FIXED_TIMESTAMP,
                "updated_at": FIXED_TIMESTAMP,
            },
            {
                "id": TEST_OFFER_ROW_ID_B,
                "stream_id": TEST_STREAM_ID,
                "offer_id": TEST_OFFER_ID_B,
                "state": "active",
                "share": 60,
                "created_at": FIXED_TIMESTAMP,
                "updated_at": FIXED_TIMESTAMP,
            },
        ],
    }


def writable_view(document: dict[str, Any]) -> dict[str, Any]:
    """Extract only the documented writable fields of a stream document."""
    return {name: copy.deepcopy(document.get(name)) for name in WRITABLE_FIELDS}


def make_handler(state: FakeKeitaroState) -> type[BaseHTTPRequestHandler]:
    """Build a deterministic request handler bound to one fake state."""

    class Handler(BaseHTTPRequestHandler):
        """Serve one synthetic stream resource over loopback HTTP."""

        def log_message(self, format: str, *args: Any) -> None:
            """Suppress test noise from the stdlib HTTP server."""

        def _send(self, status: int, payload: Any) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802 - stdlib hook name
            """Return the current document, optionally with a mismatched share."""
            if self.path != f"{KEITARO_PATH}/streams/{TEST_STREAM_ID}":
                self._send(404, {"error": "not found"})
                return
            document = state.snapshot()
            if state.readback_share is not None and state.puts() and document["offers"]:
                document["offers"][0]["share"] = state.readback_share
            self._send(200, document)

        def do_PUT(self) -> None:  # noqa: N802 - stdlib hook name
            """Reject non-offers-only bodies; apply a valid change once."""
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            with state.lock:
                state.requests.append(
                    CapturedRequest("PUT", self.path, body, self.headers.get("Api-Key"))
                )
            try:
                if state.put_delay:
                    time.sleep(state.put_delay)
                payload = json.loads(body)
                unexpected = set(payload) - {"offers"}
                if unexpected or "offers" not in payload:
                    self._send(
                        400,
                        {
                            "error": "only the offers field is writable here",
                            "fields": sorted(unexpected),
                        },
                    )
                    return
                if state.put_apply:
                    row_ids = {
                        offer["offer_id"]: offer["id"]
                        for offer in state.snapshot()["offers"]
                    }
                    updated = [
                        {
                            "id": row_ids.get(item["offer_id"], 0),
                            "stream_id": TEST_STREAM_ID,
                            "offer_id": item["offer_id"],
                            "state": item.get("state", "active"),
                            "share": item["share"],
                            "created_at": FIXED_TIMESTAMP,
                            "updated_at": FIXED_TIMESTAMP,
                        }
                        for item in payload["offers"]
                    ]
                    with state.lock:
                        state.document["offers"] = updated
                self._send(200, state.snapshot())
            except Exception as exc:  # pragma: no cover - defensive test server
                self._send(500, {"error": str(exc)})
            finally:
                state.put_handled.set()

    return Handler


def start_fake_keitaro(state: FakeKeitaroState) -> FakeKeitaroServer:
    """Start a loopback-only fake Keitaro with an ephemeral port."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    return FakeKeitaroServer(
        url=f"http://127.0.0.1:{port}",
        state=state,
        _server=server,
        _thread=thread,
    )


@pytest.fixture
def integration_db(tmp_path: Any) -> Generator[IntegrationDatabase, None, None]:
    """Create an isolated in-file SQLite schema for one integration test."""
    engine = create_engine(f"sqlite:///{tmp_path / 'publication-integration.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    database = IntegrationDatabase(engine, factory)
    yield database
    engine.dispose()


def seed_eligible_draft(db: IntegrationDatabase) -> None:
    """Seed one cached stream, snapshot, binding and eligible dirty draft."""
    now = datetime.now(UTC).replace(tzinfo=None)
    snapshot = [
        {
            "offer_id": TEST_OFFER_ID,
            "share": 40,
            "state": "active",
            "position": 0,
        },
        {
            "offer_id": TEST_OFFER_ID_B,
            "share": 60,
            "state": "active",
            "position": 1,
        },
    ]
    base_bindings = [
        {"offer_id": TEST_OFFER_ID, "lifecycle": "ACTIVE", "is_pinned": True},
        {"offer_id": TEST_OFFER_ID_B, "lifecycle": "ACTIVE", "is_pinned": True},
    ]
    with db.factory() as session:
        ref = StreamRefModel(
            campaign_id=TEST_CAMPAIGN_ID,
            keitaro_stream_id=TEST_STREAM_ID,
            type="regular",
            name="integration-stream",
            schema="landings",
            draft_version_counter=1,
        )
        session.add(ref)
        session.flush()
        session.add(
            RemoteOfferSnapshotModel(
                stream_ref_id=ref.id,
                offers_json=json.dumps(snapshot, separators=(",", ":")),
                captured_at=now,
            )
        )
        for offer_id, share in ((TEST_OFFER_ID, 40), (TEST_OFFER_ID_B, 60)):
            session.add(
                StreamOfferBindingModel(
                    stream_ref_id=ref.id,
                    offer_id=offer_id,
                    lifecycle="ACTIVE",
                    is_pinned=True,
                    last_remote_share=share,
                )
            )
        session.add(
            StreamDraftModel(
                stream_ref_id=ref.id,
                baseline_snapshot_json=json.dumps(snapshot, separators=(",", ":")),
                baseline_bindings_json=json.dumps(base_bindings, separators=(",", ":")),
                baseline_captured_at=now,
                staged_changes_json=json.dumps(
                    {
                        "share_edits": {
                            str(TEST_OFFER_ID): 30,
                            str(TEST_OFFER_ID_B): 70,
                        }
                    },
                    separators=(",", ":"),
                ),
                version=1,
                is_dirty=True,
            )
        )
        session.commit()


def assert_no_unresolved(db: IntegrationDatabase) -> None:
    """Guard the test procedure against an accidental PENDING resume."""
    with db.factory() as session:
        rows = (
            session.execute(
                select(StreamPublicationModel).where(
                    StreamPublicationModel.status.in_(
                        [item.value for item in UNRESOLVED_STATUSES]
                    )
                )
            )
            .scalars()
            .all()
        )
        assert not rows, f"unexpected unresolved publication rows: {len(rows)}"


def publication_rows(db: IntegrationDatabase) -> list[StreamPublicationModel]:
    """Return all durable publication rows from the isolated database."""
    with db.factory() as session:
        return list(session.query(StreamPublicationModel).all())


def draft_rows(db: IntegrationDatabase) -> list[StreamDraftModel]:
    """Return all draft rows from the isolated database."""
    with db.factory() as session:
        return list(session.query(StreamDraftModel).all())


def bind_app_to_test_runtime(
    monkeypatch: pytest.MonkeyPatch,
    db: IntegrationDatabase,
    base_url: str,
    *,
    allow_live_writes: bool,
    timeout: float = 30.0,
) -> Any:
    """Bind the real composition root to temporary SQLite and fake Keitaro."""
    test_settings = settings.model_copy(
        update={
            "KEITARO_BASE_URL": base_url,
            "KEITARO_API_KEY": TEST_API_KEY,
            "KEITARO_TIMEOUT": timeout,
            "KEITARO_ALLOW_PUBLICATION_WRITES": allow_live_writes,
        }
    )
    monkeypatch.setattr(main_module, "settings", test_settings)
    monkeypatch.setattr(main_module, "engine", db.engine)
    repository_pairs = (
        ("SqlAlchemyCampaignCreationOperations", SqlAlchemyCampaignCreationOperations),
        ("SqlAlchemySettingsRepository", SqlAlchemySettingsRepository),
        ("SqlAlchemyStreamDraftRepository", SqlAlchemyStreamDraftRepository),
        (
            "SqlAlchemyStreamPublicationRepository",
            SqlAlchemyStreamPublicationRepository,
        ),
        (
            "SqlAlchemyStreamReconciliationRepository",
            SqlAlchemyStreamReconciliationRepository,
        ),
    )
    for attribute, repository_class in repository_pairs:

        def make_repository(
            cls: Any = repository_class, factory: Any = db.factory
        ) -> Any:
            """Construct a real repository against the temporary database."""
            return cls(factory)

        monkeypatch.setattr(main_module, attribute, make_repository)
    monkeypatch.delenv("HTTP_PROXY", raising=False)
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    return main_module.app

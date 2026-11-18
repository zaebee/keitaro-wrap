"""Real-SQLite regression test for the recovery pool checkout timeout."""

import asyncio
import time
from typing import cast

from sqlalchemy import text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

from app.application.ports import (
    KeitaroClientPort,
    StreamDraftRepository,
    StreamPublicationRepository,
    StreamReconciliationRepository,
)
from app.application.publication import PublicationService
from app.db.base import Base
from app.db.repositories import SqlAlchemyStreamPublicationRepository
from app.db.session import create_database_engine


class NoopClient:
    """Keitaro double that must not be reached."""

    def __init__(self):
        """Track any accidental remote call."""
        self.calls: list[str] = []

    async def get_stream_document(self, stream_ref: int):
        """Fail if recovery tries a remote read after a DB timeout."""
        self.calls.append(f"GET {stream_ref}")
        return {}


class NoopDrafts:
    """Draft port unused by this test."""

    def list_dirty(self, campaign_id: int):
        """No drafts are needed."""
        return ()

    def get_view(self, stream_ref: int):
        """No views are needed."""
        return None


class NoopSnapshots:
    """Snapshot port unused by this test."""

    def get_remote_snapshot(self, stream_ref: int):
        """No snapshots are needed."""
        return None


class TrackingPublications(SqlAlchemyStreamPublicationRepository):
    """Record that the pool checkout attempt finished before recovery returned."""

    def __init__(self, session_factory):
        """Start with an unfinished DB call marker."""
        super().__init__(session_factory)
        self.finished = False

    def list_recoverable(self, limit: int):
        """Set the completion marker even when the checkout times out."""
        try:
            return super().list_recoverable(limit)
        finally:
            self.finished = True


def test_recovery_pool_timeout_prevents_a_held_lock_from_hanging(tmp_path):
    """A held SQLite lock cannot hold startup past the finite pool wait."""
    busy_timeout = 0.05
    engine = create_database_engine(
        f"sqlite:///{tmp_path / 'locked.db'}",
        busy_timeout=busy_timeout,
        poolclass=QueuePool,
        pool_size=1,
        max_overflow=0,
    )
    try:
        pool = cast(QueuePool, engine.pool)
        assert pool.timeout() == busy_timeout
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
        client = NoopClient()
        publications = TrackingPublications(session_factory)
        service = PublicationService(
            cast(KeitaroClientPort, client),
            cast(StreamDraftRepository, NoopDrafts()),
            cast(StreamPublicationRepository, publications),
            cast(StreamReconciliationRepository, NoopSnapshots()),
            recovery_deadline_seconds=1.0,
        )
        with engine.connect() as holder:
            holder.execute(text("BEGIN IMMEDIATE"))
            started = time.monotonic()
            result = asyncio.run(service.recover())
            elapsed = time.monotonic() - started
    finally:
        engine.dispose()

    assert elapsed < 1.0
    assert result.degraded == 1
    assert result.deadline_reached is True
    assert client.calls == []
    assert publications.finished is True

"""Mocked-HTTP contract test for the complete Fetch path."""

from collections.abc import Generator

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.application.dto import FetchStreamsCommand
from app.application.fetch import FetchService
from app.db.base import Base
from app.db.repositories import SqlAlchemyStreamReconciliationRepository
from app.keitaro_client.client import KeitaroClient


@pytest.fixture
def session_factory(tmp_path) -> Generator[sessionmaker[Session], None, None]:
    """Create an isolated in-file SQLite schema for the contract test."""
    engine = create_engine(f"sqlite:///{tmp_path / 'contract.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    yield factory
    engine.dispose()


@pytest.mark.asyncio
async def test_fetch_contract_reads_all_streams_and_writes_only_locally(
    session_factory,
):
    """A real client parses the full stream list; no Keitaro mutation is sent."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        return httpx.Response(
            200,
            json=[
                {
                    "id": 11,
                    "campaign_id": 5,
                    "type": "forced",
                    "name": "country",
                    "schema": "redirect",
                    "action_type": "http",
                },
                {
                    "id": 12,
                    "campaign_id": 5,
                    "type": "regular",
                    "name": "offers",
                    "schema": "landings",
                    "offers": [
                        {"offer_id": 8, "share": 25, "state": "active"},
                        {"offer_id": 5, "share": 75, "state": "paused"},
                    ],
                },
            ],
        )

    repository = SqlAlchemyStreamReconciliationRepository(session_factory)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://example.com"
    ) as http:
        service = FetchService(KeitaroClient(http, api_key="secret-key"), repository)
        outcome = await service.fetch(FetchStreamsCommand(campaign_id=5))

    assert calls == ["GET /admin_api/v1/campaigns/5/streams"]
    assert (outcome.stream_count, outcome.reconciled_stream_count) == (2, 1)
    assert repository.get_stream_ref(11) is not None
    assert repository.get_bindings(11) == ()
    assert [item.offer_id for item in repository.get_bindings(12)] == [5, 8]
    cached = repository.get_remote_snapshot(12)
    assert cached is not None
    assert [
        (item.offer_id, item.share, item.state, item.position) for item in cached.offers
    ] == [
        (8, 25, "active", 0),
        (5, 75, "paused", 1),
    ]

import httpx
import pytest

from app import main as main_module
from app.main import app


async def no_recovery(self):
    """Skip durable recovery in the health smoke test."""
    return None


@pytest.mark.asyncio
async def test_health(monkeypatch):
    monkeypatch.setattr(main_module.PublicationService, "recover", no_recovery)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

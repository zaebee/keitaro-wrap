import httpx
import pytest

from app.main import app


@pytest.mark.asyncio
async def test_health():
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

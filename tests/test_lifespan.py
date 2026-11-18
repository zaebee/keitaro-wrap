"""Tests for the composition-root lifecycle."""

import httpx
import pytest

from app import main as main_module
from app.keitaro_client.client import KeitaroClient


async def no_recovery(self):
    """Avoid real Keitaro or DB work during composition-root tests."""
    return None


@pytest.mark.asyncio
async def test_lifespan_closes_owned_client(monkeypatch):
    """Normal teardown closes the HTTP client and disposes the engine."""
    closed: list[bool] = []
    disposed: list[bool] = []

    async def tracking_aclose(self):
        closed.append(True)

    monkeypatch.setattr(httpx.AsyncClient, "aclose", tracking_aclose)
    monkeypatch.setattr(main_module.engine, "dispose", lambda: disposed.append(True))
    monkeypatch.setattr(main_module.PublicationService, "recover", no_recovery)

    async with main_module.lifespan(main_module.app):
        assert isinstance(main_module.app.state.keitaro_client, KeitaroClient)

    assert closed == [True]
    assert disposed == [True]


@pytest.mark.asyncio
async def test_lifespan_closes_client_on_exceptional_teardown(monkeypatch):
    """An exception thrown during lifespan still closes the HTTP client."""
    closed: list[bool] = []
    disposed: list[bool] = []

    async def tracking_aclose(self):
        closed.append(True)

    monkeypatch.setattr(httpx.AsyncClient, "aclose", tracking_aclose)
    monkeypatch.setattr(main_module.engine, "dispose", lambda: disposed.append(True))
    monkeypatch.setattr(main_module.PublicationService, "recover", no_recovery)

    async def raise_during_lifespan():
        async with main_module.lifespan(main_module.app):
            raise RuntimeError("teardown failed")

    with pytest.raises(RuntimeError, match="teardown failed"):
        await raise_during_lifespan()

    assert closed == [True]
    assert disposed == [True]

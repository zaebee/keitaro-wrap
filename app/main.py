"""Application entry point."""

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request

from app.api.routes import router
from app.core.config import settings
from app.db.session import engine
from app.keitaro_client.client import KeitaroClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan."""
    http_client = httpx.AsyncClient(base_url=settings.KEITARO_BASE_URL, timeout=30.0)
    app.state.keitaro_client = KeitaroClient(http_client)
    yield
    await http_client.aclose()
    engine.dispose()


app = FastAPI(title="Keitaro Wrap", lifespan=lifespan)
app.include_router(router)


def get_keitaro_client(request: Request):
    """Get keitaro client."""
    return request.app.state.keitaro_client

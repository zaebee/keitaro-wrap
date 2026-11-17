"""FastAPI application entrypoint and lifespan management."""

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from app.api.routes import router
from app.core.config import settings
from app.db.session import engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application startup and shutdown resources."""
    app.state.http_client = httpx.AsyncClient(
        base_url=settings.KEITARO_BASE_URL, timeout=30.0
    )
    yield
    await app.state.http_client.aclose()
    engine.dispose()


app = FastAPI(title="Keitaro Wrap", lifespan=lifespan)
app.include_router(router)

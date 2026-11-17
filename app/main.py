import httpx
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.config import settings
from app.api.routes import router
from app.db.session import engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http_client = httpx.AsyncClient(base_url=settings.KEITARO_BASE_URL, timeout=30.0)
    yield
    await app.state.http_client.aclose()
    engine.dispose()


app = FastAPI(title="Keitaro Wrap", lifespan=lifespan)
app.include_router(router)

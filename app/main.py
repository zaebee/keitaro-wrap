"""Application entry point."""

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request

from app.api.errors import register_error_handlers
from app.api.routes import router
from app.application.campaign_creation import CampaignCreationService
from app.application.conflict_resolution import ConflictResolutionService
from app.application.draft import DraftService
from app.application.fetch import FetchService
from app.application.publication import PublicationService
from app.core.config import settings
from app.db.repositories import (
    SqlAlchemyCampaignCreationOperations,
    SqlAlchemySettingsRepository,
    SqlAlchemyStreamDraftRepository,
    SqlAlchemyStreamPublicationRepository,
    SqlAlchemyStreamReconciliationRepository,
)
from app.db.session import engine
from app.keitaro_client.client import KeitaroClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan; always close the owned HTTP client on exit."""
    http_client = httpx.AsyncClient(
        base_url=settings.KEITARO_BASE_URL, timeout=settings.KEITARO_TIMEOUT
    )
    app.state.keitaro_client = KeitaroClient(
        http_client, api_key=settings.KEITARO_API_KEY
    )
    app.state.campaign_creation_service = CampaignCreationService(
        client=app.state.keitaro_client,
        operations=SqlAlchemyCampaignCreationOperations(),
        settings=SqlAlchemySettingsRepository(),
    )
    app.state.fetch_service = FetchService(
        client=app.state.keitaro_client,
        repository=SqlAlchemyStreamReconciliationRepository(),
    )
    app.state.draft_service = DraftService(
        repository=SqlAlchemyStreamDraftRepository(),
    )
    app.state.conflict_resolution_service = ConflictResolutionService(
        client=app.state.keitaro_client,
        drafts=SqlAlchemyStreamDraftRepository(),
    )
    app.state.publication_service = PublicationService(
        client=app.state.keitaro_client,
        drafts=SqlAlchemyStreamDraftRepository(),
        publications=SqlAlchemyStreamPublicationRepository(),
        snapshots=SqlAlchemyStreamReconciliationRepository(),
        allow_live_writes=settings.KEITARO_ALLOW_PUBLICATION_WRITES,
    )
    await app.state.publication_service.recover()
    try:
        yield
    finally:
        try:
            await http_client.aclose()
        finally:
            engine.dispose()


app = FastAPI(title="Keitaro Wrap", lifespan=lifespan)
app.include_router(router)
register_error_handlers(app)


def get_keitaro_client(request: Request):
    """Get keitaro client."""
    return request.app.state.keitaro_client

"""Dependency providers for the Slice 7 API."""

from fastapi import Request

from app.application.campaign_creation import CampaignCreationService
from app.application.conflict_resolution import ConflictResolutionService
from app.application.draft import DraftService
from app.application.fetch import FetchService
from app.application.publication import PublicationService


def get_campaign_creation_service(request: Request) -> CampaignCreationService:
    """Return the composition-root campaign creation service."""
    return request.app.state.campaign_creation_service


def get_fetch_service(request: Request) -> FetchService:
    """Return the composition-root Fetch service."""
    return request.app.state.fetch_service


def get_draft_service(request: Request) -> DraftService:
    """Return the composition-root local draft service."""
    return request.app.state.draft_service


def get_conflict_resolution_service(request: Request) -> ConflictResolutionService:
    """Return the composition-root conflict-resolution service."""
    return request.app.state.conflict_resolution_service


def get_publication_service(request: Request) -> PublicationService:
    """Return the composition-root publication service."""
    return request.app.state.publication_service

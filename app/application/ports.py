"""Application ports."""

from typing import Protocol

from app.application.dto import (
    CampaignCreateDTO,
    CampaignDTO,
    DomainDTO,
    GroupDTO,
    OfferDTO,
    StreamCreateDTO,
    StreamDTO,
    StreamUpdateDTO,
    TrafficSourceDTO,
)


class KeitaroClientPort(Protocol):
    """Keitaro client port."""

    async def list_domains(self) -> list[DomainDTO]:
        """List domains."""
        ...

    async def list_groups(self, gtype: str) -> list[GroupDTO]:
        """List groups by type."""
        ...

    async def list_traffic_sources(self) -> list[TrafficSourceDTO]:
        """List traffic sources."""
        ...

    async def list_offers(self) -> list[OfferDTO]:
        """List offers."""
        ...

    async def get_offer(self, offer_id: int) -> OfferDTO:
        """Get offer."""
        ...

    async def create_campaign(self, payload: CampaignCreateDTO) -> CampaignDTO:
        """Create campaign."""
        ...

    async def list_campaigns(self) -> list[CampaignDTO]:
        """List campaigns."""
        ...

    async def get_campaign(self, campaign_id: int) -> CampaignDTO:
        """Get campaign."""
        ...

    async def list_campaign_streams(self, campaign_id: int) -> list[StreamDTO]:
        """List campaign streams."""
        ...

    async def create_stream(self, payload: StreamCreateDTO) -> StreamDTO:
        """Create stream."""
        ...

    async def get_stream(self, stream_id: int) -> StreamDTO:
        """Get stream."""
        ...

    async def update_stream(
        self, stream_id: int, payload: StreamUpdateDTO
    ) -> StreamDTO:
        """Update stream."""
        ...

    async def delete_stream(self, stream_id: int) -> None:
        """Delete stream."""
        ...

    async def list_stream_types(self) -> list[dict]:
        """List stream types."""
        ...

    async def list_stream_schemas(self) -> list[dict]:
        """List stream schemas."""
        ...

    async def list_stream_filters(self) -> list[dict]:
        """List stream filters."""
        ...

    async def list_stream_actions(self) -> list[dict]:
        """List stream actions."""
        ...

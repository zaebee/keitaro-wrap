"""Application ports."""

from typing import Protocol

from app.application.dto import (
    CampaignCreateDTO,
    CampaignDTO,
    ConfiguredResources,
    DomainDTO,
    DraftCommandBase,
    DraftCommandResult,
    DraftView,
    FetchOutcome,
    FetchSnapshot,
    GroupDTO,
    OfferDTO,
    RemoteSnapshotView,
    StreamActionDTO,
    StreamBindingView,
    StreamCreateDTO,
    StreamDraftView,
    StreamDTO,
    StreamFilterOptionDTO,
    StreamRefView,
    StreamSchemaDTO,
    StreamTypeDTO,
    StreamUpdateDTO,
    TrafficSourceDTO,
)
from app.domain.campaign_creation import (
    CampaignCreationOperation,
    CreationStage,
    OperationStatus,
)
from app.domain.draft import DraftCommand


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

    async def list_campaigns(
        self, offset: int = 0, limit: int = 100
    ) -> list[CampaignDTO]:
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

    async def list_stream_types(self) -> list[StreamTypeDTO]:
        """List stream types."""
        ...

    async def list_stream_schemas(self) -> list[StreamSchemaDTO]:
        """List stream schemas."""
        ...

    async def list_stream_filters(self) -> list[StreamFilterOptionDTO]:
        """List stream filters."""
        ...

    async def list_stream_actions(self) -> list[StreamActionDTO]:
        """List stream actions."""
        ...


class CampaignCreationOperationRepository(Protocol):
    """Synchronous operational store; callers offload calls off the event loop."""

    def add(self, operation: CampaignCreationOperation) -> CampaignCreationOperation:
        """Persist a new operation."""
        ...

    def get_by_uuid(self, operation_uuid: str) -> CampaignCreationOperation | None:
        """Load an operation by its stable UUID."""
        ...

    def get_by_alias(self, alias: str) -> CampaignCreationOperation | None:
        """Load an operation by its campaign alias."""
        ...

    def save(self, operation: CampaignCreationOperation) -> CampaignCreationOperation:
        """Persist non-step changes to an existing operation."""
        ...

    def claim_step(
        self, operation_uuid: str, stage: CreationStage
    ) -> CampaignCreationOperation | None:
        """Atomically claim a not_started step; return None if already claimed."""
        ...

    def confirm_step(
        self,
        operation_uuid: str,
        stage: CreationStage,
        *,
        remote_id: int | None,
        status: OperationStatus | None,
        error: str | None,
    ) -> CampaignCreationOperation | None:
        """Atomically confirm a claimed/ambiguous step and its remote ID."""
        ...

    def mark_step_ambiguous(
        self,
        operation_uuid: str,
        stage: CreationStage,
        *,
        status: OperationStatus | None,
        error: str | None,
    ) -> CampaignCreationOperation | None:
        """Atomically mark a claimed step ambiguous without authorizing a retry."""
        ...


class SettingsRepository(Protocol):
    """Reads operator-owned application configuration."""

    def get_config(self) -> ConfiguredResources:
        """Return configured resource IDs and the redirect destination."""
        ...


class StreamReconciliationRepository(Protocol):
    """Synchronous store for remote snapshots and committed bindings."""

    def reconcile(self, snapshot: FetchSnapshot) -> FetchOutcome:
        """Apply one complete remote observation in a single transaction."""
        ...

    def get_stream_ref(self, stream_ref: int) -> StreamRefView | None:
        """Load a cached remote stream reference by its Keitaro id."""
        ...

    def get_bindings(self, stream_ref: int) -> tuple[StreamBindingView, ...]:
        """Load committed bindings for one remote stream."""
        ...

    def get_remote_snapshot(self, stream_ref: int) -> RemoteSnapshotView | None:
        """Load the last remote offer cache for one remote stream."""
        ...

    def get_draft(self, stream_ref: int) -> StreamDraftView | None:
        """Load the staged state for one remote stream, if one exists."""
        ...


class StreamDraftRepository(Protocol):
    """Synchronous store for local staged edits; no external I/O."""

    def apply(
        self,
        command: DraftCommandBase,
        intent: DraftCommand,
    ) -> DraftCommandResult:
        """Apply one command atomically with optimistic concurrency."""
        ...

    def get_view(self, stream_ref: int) -> DraftView | None:
        """Load the derived staged view for one stream, if it has a draft."""
        ...

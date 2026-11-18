"""Local draft editing orchestration with an explicit D14 boundary."""

import asyncio

from app.application.dto import (
    AddOfferCommand,
    CancelDraftCommand,
    DraftCommandBase,
    DraftCommandResult,
    DraftView,
    RemoveOfferCommand,
    RestoreOfferCommand,
    SetPinCommand,
    SetShareCommand,
    to_domain_command,
)
from app.application.errors import (
    CAMPAIGN_ID_REQUIRED,
    STREAM_REF_REQUIRED,
    StreamNotFoundError,
)
from app.application.ports import StreamDraftRepository
from app.domain.reconciliation import ConflictDetail


class DraftStaleError(ValueError):
    """Editing is blocked while the draft carries a sticky Fetch conflict."""

    def __init__(self, stream_ref: int, conflicts: tuple[ConflictDetail, ...]):
        """Keep structured conflict details available to the caller."""
        self.stream_ref = stream_ref
        self.conflicts = conflicts
        super().__init__(
            f"draft for stream {stream_ref} is stale; resolve conflict first"
        )


class DraftVersionConflict(ValueError):
    """The draft changed since the caller read its version."""

    def __init__(
        self,
        message: str = "draft version changed",
        *,
        stream_ref: int | None = None,
        expected_version: int | None = None,
        current_version: int | None = None,
    ):
        """Keep optimistic-concurrency details structured for the transport."""
        self.stream_ref = stream_ref
        self.expected_version = expected_version
        self.current_version = current_version
        super().__init__(message)


class DraftService:
    """Application-owned local staging commands; no Keitaro dependency."""

    def __init__(self, repository: StreamDraftRepository):
        """Wire the synchronous draft repository."""
        self._repository = repository

    async def add(self, command: AddOfferCommand) -> DraftCommandResult:
        """Stage an offer addition."""
        return await self._apply(command)

    async def remove(self, command: RemoveOfferCommand) -> DraftCommandResult:
        """Stage an offer archive."""
        return await self._apply(command)

    async def restore(self, command: RestoreOfferCommand) -> DraftCommandResult:
        """Stage an archived offer reactivation."""
        return await self._apply(command)

    async def set_pin(self, command: SetPinCommand) -> DraftCommandResult:
        """Stage a pin or unpin intent."""
        return await self._apply(command)

    async def set_share(self, command: SetShareCommand) -> DraftCommandResult:
        """Stage an integer manual share edit, which also pins the offer."""
        return await self._apply(command)

    async def cancel(self, command: CancelDraftCommand) -> DraftCommandResult:
        """Discard local staged intent without resolving conflicts."""
        return await self._apply(command)

    async def get_view(self, stream_ref: int) -> DraftView | None:
        """Load the current derived staged view off the event loop."""
        if type(stream_ref) is not int or stream_ref <= 0:
            raise ValueError(STREAM_REF_REQUIRED)
        return await asyncio.to_thread(self._repository.get_view, stream_ref)

    async def get_view_for_campaign(
        self, campaign_id: int, stream_ref: int
    ) -> DraftView | None:
        """Load a draft view only when the stream belongs to the campaign."""
        if type(campaign_id) is not int or campaign_id <= 0:
            raise ValueError(CAMPAIGN_ID_REQUIRED)
        if type(stream_ref) is not int or stream_ref <= 0:
            raise ValueError(STREAM_REF_REQUIRED)
        owner = await asyncio.to_thread(
            self._repository.get_stream_campaign, stream_ref
        )
        if owner != campaign_id:
            raise StreamNotFoundError(campaign_id, stream_ref)
        return await asyncio.to_thread(self._repository.get_view, stream_ref)

    async def _apply(self, command: DraftCommandBase) -> DraftCommandResult:
        """Validate identity, convert the intent and offload the DB transaction."""
        if type(command.campaign_id) is not int or command.campaign_id <= 0:
            raise ValueError(CAMPAIGN_ID_REQUIRED)
        if type(command.stream_ref) is not int or command.stream_ref <= 0:
            raise ValueError(STREAM_REF_REQUIRED)
        if type(command.expected_version) is not int or command.expected_version < 0:
            raise ValueError("expected_version must be a non-negative int")
        intent = to_domain_command(command)
        return await asyncio.to_thread(self._repository.apply, command, intent)

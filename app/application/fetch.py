"""Fetch orchestration: validate a remote observation, then reconcile it locally."""

import asyncio
from datetime import UTC, datetime

from app.application.dto import (
    FetchedStream,
    FetchOutcome,
    FetchSnapshot,
    FetchStreamsCommand,
    StreamDTO,
)
from app.application.ports import KeitaroClientPort, StreamReconciliationRepository
from app.domain.reconciliation import (
    RemoteOffer,
    RemoteOfferValidationError,
    validate_remote_offers,
)


class FetchInputError(ValueError):
    """Remote or command data cannot be reconciled safely."""


class FetchService:
    """Application-owned Fetch use case with an explicit D14 boundary."""

    def __init__(
        self,
        client: KeitaroClientPort,
        repository: StreamReconciliationRepository,
    ):
        """Wire the read-only Keitaro port and the synchronous local repository."""
        self._client = client
        self._repository = repository

    async def fetch(self, command: FetchStreamsCommand) -> FetchOutcome:
        """Read all campaign streams before opening any local write transaction."""
        if type(command.campaign_id) is not int or command.campaign_id <= 0:
            raise FetchInputError("campaign_id must be a positive int")
        streams = await self._client.list_campaign_streams(command.campaign_id)
        captured_at = datetime.now(UTC).replace(tzinfo=None)
        fetched = tuple(
            self._to_fetched(stream, command.campaign_id) for stream in streams
        )
        snapshot = FetchSnapshot(
            campaign_id=command.campaign_id,
            streams=fetched,
            captured_at=captured_at,
        )
        return await asyncio.to_thread(self._repository.reconcile, snapshot)

    @staticmethod
    def _to_fetched(stream: StreamDTO, campaign_id: int) -> FetchedStream:
        """Validate one remote stream and preserve the remote offer order."""
        if type(stream.id) is not int or stream.id <= 0:
            raise FetchInputError("stream id must be a positive int")
        if type(stream.campaign_id) is not int or stream.campaign_id <= 0:
            raise FetchInputError(f"stream {stream.id}: campaign_id must be positive")
        if stream.campaign_id != campaign_id:
            raise FetchInputError(
                f"stream {stream.id}: campaign_id {stream.campaign_id} "
                f"does not match requested campaign {campaign_id}"
            )
        offers = tuple(
            RemoteOffer(
                offer_id=offer.offer_id,
                share=offer.share,
                state=offer.state,
                position=position,
            )
            for position, offer in enumerate(stream.offers)
        )
        try:
            validated = validate_remote_offers(offers)
        except RemoteOfferValidationError as exc:
            raise FetchInputError(f"stream {stream.id}: {exc}") from exc
        return FetchedStream(
            stream_ref=stream.id,
            campaign_id=stream.campaign_id,
            type=stream.type,
            name=stream.name,
            schema=stream.schema,
            offers=validated,
            comments=stream.comments,
        )

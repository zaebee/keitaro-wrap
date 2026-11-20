"""Explicit Accept-remote resolution of one sticky Fetch conflict."""

import asyncio
from collections.abc import Mapping
from datetime import UTC, datetime

from app.application.draft import DraftVersionConflict
from app.application.dto import AcceptRemoteCommand, AcceptRemoteResult, FetchedStream
from app.application.errors import (
    STREAM_REF_REQUIRED,
    ConflictChangedError,
    ConflictResolutionInputError,
    StreamNotFoundError,
)
from app.application.ports import KeitaroClientPort, StreamDraftRepository
from app.domain.reconciliation import (
    RemoteOffer,
    RemoteOfferValidationError,
    validate_remote_offers,
)


class ConflictResolutionService:
    """Application workflow for the single owner-approved Accept-remote action."""

    def __init__(
        self, client: KeitaroClientPort, drafts: StreamDraftRepository
    ) -> None:
        """Wire the read-only Keitaro port and the synchronous draft repository."""
        self._client = client
        self._drafts = drafts

    async def accept_remote(self, command: AcceptRemoteCommand) -> AcceptRemoteResult:
        """Resolve one stale draft from a fresh targeted remote observation."""
        self._validate_command(command)
        owner = await asyncio.to_thread(
            self._drafts.get_stream_campaign, command.stream_ref
        )
        if owner != command.campaign_id:
            raise StreamNotFoundError(command.campaign_id, command.stream_ref)
        view = await asyncio.to_thread(self._drafts.get_view, command.stream_ref)
        if view is None:
            raise ConflictResolutionInputError("no draft exists for this stream")
        if view.version != command.expected_version:
            raise DraftVersionConflict(
                "draft version changed",
                stream_ref=command.stream_ref,
                expected_version=command.expected_version,
                current_version=view.version,
            )
        if view.conflicts_fingerprint != command.expected_conflicts_fingerprint:
            raise ConflictChangedError(
                command.stream_ref,
                command.expected_conflicts_fingerprint,
                view.conflicts_fingerprint,
            )
        if not view.is_stale and not view.conflicts:
            return AcceptRemoteResult(command.stream_ref, view, True, view.version)
        if not view.is_stale:
            raise ConflictResolutionInputError(
                "draft has no sticky Fetch conflict to resolve"
            )

        document = await self._client.get_stream_document(command.stream_ref)
        observation = self._observation(
            command.campaign_id, command.stream_ref, document
        )
        captured_at = datetime.now(UTC).replace(tzinfo=None)
        return await asyncio.to_thread(
            self._drafts.accept_remote, command, observation, captured_at
        )

    @staticmethod
    def _validate_command(command: AcceptRemoteCommand) -> None:
        """Validate identity, version and the opaque conflict token."""
        if type(command.campaign_id) is not int or command.campaign_id <= 0:
            raise ConflictResolutionInputError("campaign_id must be a positive int")
        if type(command.stream_ref) is not int or command.stream_ref <= 0:
            raise ConflictResolutionInputError(STREAM_REF_REQUIRED)
        if type(command.expected_version) is not int or command.expected_version <= 0:
            raise ConflictResolutionInputError(
                "expected_version must be a positive int"
            )
        if type(
            command.expected_conflicts_fingerprint
        ) is not str or not command.expected_conflicts_fingerprint.startswith(
            "sha256:"
        ):
            raise ConflictResolutionInputError("invalid conflicts fingerprint")

    @staticmethod
    def _observation(
        campaign_id: int, stream_ref: int, document: Mapping[str, object]
    ) -> FetchedStream:
        """Validate one targeted stream document as a fresh remote observation."""
        if (
            document.get("id") != stream_ref
            or document.get("campaign_id") != campaign_id
        ):
            raise ConflictResolutionInputError(
                f"stream {stream_ref} does not belong to campaign {campaign_id}"
            )
        raw = document.get("offers")
        if not isinstance(raw, list):
            raise ConflictResolutionInputError("stream offers must be a list")
        offers: list[RemoteOffer] = []
        for position, item in enumerate(raw):
            if not isinstance(item, dict):
                raise ConflictResolutionInputError("stream offer is not an object")
            if "offer_id" not in item or "share" not in item:
                raise ConflictResolutionInputError(
                    "stream offer is missing offer_id or share"
                )
            offers.append(
                RemoteOffer(
                    offer_id=item["offer_id"],
                    share=item["share"],
                    state=item.get("state"),
                    position=position,
                )
            )
        try:
            validated = validate_remote_offers(offers)
        except RemoteOfferValidationError as exc:
            raise ConflictResolutionInputError(str(exc)) from exc
        comments = document.get("comments")
        return FetchedStream(
            stream_ref=stream_ref,
            campaign_id=campaign_id,
            type=str(document.get("type", "")),
            name=str(document.get("name", "")),
            schema=str(document.get("schema", "")),
            offers=validated,
            comments=comments if isinstance(comments, str) else None,
        )

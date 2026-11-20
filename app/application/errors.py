"""Application-owned error types shared by services and transport adapters."""

from __future__ import annotations

CAMPAIGN_ID_REQUIRED = "campaign_id must be a positive int"
STREAM_REF_REQUIRED = "stream_ref must be a positive int"


class UpstreamError(RuntimeError):
    """An external dependency failed; carries structured, redacted diagnostics."""

    def __init__(self, status: int, message: str):
        """Store the upstream status and a safe message."""
        self.status = status
        self.message = message
        super().__init__(f"upstream error {status}: {message}")


class ConflictResolutionInputError(ValueError):
    """The requested conflict resolution has no applicable conflicted draft."""


class ConflictChangedError(RuntimeError):
    """The conflict evidence changed since the operator reviewed it."""

    def __init__(
        self,
        stream_ref: int,
        expected_fingerprint: str,
        current_fingerprint: str,
    ):
        """Keep both fingerprints structured for the typed transport error."""
        self.stream_ref = stream_ref
        self.expected_fingerprint = expected_fingerprint
        self.current_fingerprint = current_fingerprint
        super().__init__(f"conflicts for stream {stream_ref} changed before resolution")


class StreamNotFoundError(KeyError):
    """A stream reference is unknown or belongs to another campaign."""

    def __init__(self, campaign_id: int, stream_ref: int):
        """Keep the requested campaign and stream identity structured."""
        self.campaign_id = campaign_id
        self.stream_ref = stream_ref
        super().__init__(
            f"stream {stream_ref} does not belong to campaign {campaign_id}"
        )

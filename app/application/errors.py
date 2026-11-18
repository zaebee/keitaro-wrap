"""Application-owned error types shared by services and transport adapters."""

from __future__ import annotations


class UpstreamError(RuntimeError):
    """An external dependency failed; carries structured, redacted diagnostics."""

    def __init__(self, status: int, message: str):
        """Store the upstream status and a safe message."""
        self.status = status
        self.message = message
        super().__init__(f"upstream error {status}: {message}")


class StreamNotFoundError(KeyError):
    """A stream reference is unknown or belongs to another campaign."""

    def __init__(self, campaign_id: int, stream_ref: int):
        """Keep the requested campaign and stream identity structured."""
        self.campaign_id = campaign_id
        self.stream_ref = stream_ref
        super().__init__(
            f"stream {stream_ref} does not belong to campaign {campaign_id}"
        )

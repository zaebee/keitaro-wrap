"""Pure campaign-creation operation model and state machine."""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class OperationStatus(StrEnum):
    """Durable status of a campaign-creation operation."""

    STARTED = "started"
    PARTIAL = "partial"
    AMBIGUOUS = "ambiguous"
    CREATED = "created"
    FAILED = "failed"
    ABANDONED = "abandoned"


ALLOWED_TRANSITIONS: dict[OperationStatus, frozenset[OperationStatus]] = {
    OperationStatus.STARTED: frozenset(
        {
            OperationStatus.PARTIAL,
            OperationStatus.AMBIGUOUS,
            OperationStatus.CREATED,
            OperationStatus.FAILED,
        }
    ),
    OperationStatus.PARTIAL: frozenset(
        {
            OperationStatus.CREATED,
            OperationStatus.AMBIGUOUS,
            OperationStatus.FAILED,
        }
    ),
    OperationStatus.AMBIGUOUS: frozenset(
        {
            OperationStatus.CREATED,
            OperationStatus.PARTIAL,
            OperationStatus.ABANDONED,
        }
    ),
    OperationStatus.CREATED: frozenset(),
    OperationStatus.FAILED: frozenset(),
    OperationStatus.ABANDONED: frozenset(),
}


class InvalidOperationTransition(ValueError):
    """Requested operation status transition is not allowed."""


@dataclass
class CampaignCreationOperation:
    """Wrapper-owned operational record for one campaign creation attempt."""

    operation_uuid: str
    alias: str
    name: str
    country_code: str
    offer_id: int
    domain_id: int
    group_id: int
    traffic_source_id: int
    status: OperationStatus = OperationStatus.STARTED
    keitaro_campaign_id: int | None = None
    flow_country_id: int | None = None
    flow_offer_id: int | None = None
    error_message: str | None = None
    id: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    def transition_to(
        self, status: OperationStatus, error_message: str | None = None
    ) -> None:
        """Move to an allowed status, recording an optional error message."""
        if status not in ALLOWED_TRANSITIONS[self.status]:
            raise InvalidOperationTransition(
                f"cannot transition from {self.status.value} to {status.value}"
            )
        self.status = status
        if error_message is not None:
            self.error_message = error_message


def make_alias(operation_uuid: str) -> str:
    """Build the deterministic operation-derived campaign alias."""
    return f"slug-{operation_uuid.replace('-', '')[:8]}"


def is_terminal(status: OperationStatus) -> bool:
    """Report whether no further transitions are allowed from a status."""
    return not ALLOWED_TRANSITIONS[status]

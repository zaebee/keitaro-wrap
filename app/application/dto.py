"""Module."""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class DomainDTO:
    """DomainDTO."""

    id: int
    name: str
    state: str | None = None


@dataclass
class GroupDTO:
    """GroupDTO."""

    id: int
    name: str
    type: str | None = None


@dataclass
class TrafficSourceDTO:
    """TrafficSourceDTO."""

    id: int
    name: str
    state: str | None = None


@dataclass
class OfferDTO:
    """OfferDTO."""

    id: int
    name: str
    state: str | None = None
    group_id: int | None = None


@dataclass
class OfferStreamDTO:
    """OfferStreamDTO."""

    offer_id: int
    share: int
    state: str | None = "active"


@dataclass
class StreamFilterDTO:
    """StreamFilterDTO."""

    name: str
    mode: str
    payload: list[str] = field(default_factory=list)


@dataclass
class StreamDTO:
    """StreamDTO."""

    id: int
    campaign_id: int
    type: str
    name: str
    schema: str
    action_type: str | None = None
    action_payload: str | None = None
    filters: list[StreamFilterDTO] = field(default_factory=list)
    offers: list[OfferStreamDTO] = field(default_factory=list)
    comments: str | None = None


@dataclass
class CampaignDTO:
    """CampaignDTO."""

    id: int
    name: str
    alias: str | None = None
    state: str | None = None
    domain_id: int | None = None
    group_id: int | None = None
    traffic_source_id: int | None = None


@dataclass
class CampaignCreateDTO:
    """CampaignCreateDTO."""

    alias: str
    name: str
    domain_id: int | None = None
    group_id: int | None = None
    traffic_source_id: int | None = None


@dataclass
class StreamCreateDTO:
    """StreamCreateDTO."""

    campaign_id: int
    type: str
    name: str
    schema: str
    action_type: str
    action_payload: str | None = None
    filters: list[dict[str, Any]] = field(default_factory=list)
    offers: list[dict[str, Any]] = field(default_factory=list)
    comments: str | None = None


@dataclass
class StreamUpdateDTO:
    """StreamUpdateDTO."""

    stream_id: int
    fields: dict[str, Any] = field(default_factory=dict)

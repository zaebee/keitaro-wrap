"""Database models."""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class AppSettings(Base):
    """Persisted application settings."""

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    keitaro_base_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    default_domain_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_group_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_offer_group_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_traffic_source_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), onupdate=func.now()
    )


class CampaignCreationOperationModel(Base):
    """Durable wrapper state for one campaign creation attempt."""

    __tablename__ = "campaign_creation_operations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    operation_uuid: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    alias: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    country_code: Mapped[str] = mapped_column(String(2), nullable=False)
    offer_id: Mapped[int] = mapped_column(Integer, nullable=False)
    keitaro_campaign_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    flow_country_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    flow_offer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    domain_id: Mapped[int] = mapped_column(Integer, nullable=False)
    group_id: Mapped[int] = mapped_column(Integer, nullable=False)
    traffic_source_id: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    error_message: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), onupdate=func.now()
    )

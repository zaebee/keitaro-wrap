"""Database models."""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base

STREAM_REF_FK = "stream_refs.id"


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
    redirect_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    error_message: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    campaign_step: Mapped[str] = mapped_column(String(20), nullable=False)
    country_flow_step: Mapped[str] = mapped_column(String(20), nullable=False)
    offer_flow_step: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), onupdate=func.now()
    )


class StreamRefModel(Base):
    """Cached identity of a remote Keitaro stream."""

    __tablename__ = "stream_refs"
    __table_args__ = (
        UniqueConstraint(
            "campaign_id", "keitaro_stream_id", name="uq_stream_refs_campaign_stream"
        ),
        Index("ix_stream_refs_campaign_id", "campaign_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(Integer, nullable=False)
    keitaro_stream_id: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    schema: Mapped[str] = mapped_column(String(40), nullable=False)
    comments: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), onupdate=func.now()
    )


class RemoteOfferSnapshotModel(Base):
    """Last remote offer array observed for one stream."""

    __tablename__ = "remote_offer_snapshots"
    __table_args__ = (
        UniqueConstraint("stream_ref_id", name="uq_remote_offer_snapshots_stream"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_ref_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(STREAM_REF_FK), nullable=False
    )
    offers_json: Mapped[str] = mapped_column(Text, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class StreamOfferBindingModel(Base):
    """Committed wrapper-owned binding for one offer in one stream."""

    __tablename__ = "stream_offer_bindings"
    __table_args__ = (
        UniqueConstraint(
            "stream_ref_id", "offer_id", name="uq_stream_offer_bindings_pair"
        ),
        Index("ix_stream_offer_bindings_lifecycle", "stream_ref_id", "lifecycle"),
        CheckConstraint(
            "lifecycle IN ('ACTIVE', 'ARCHIVED')", name="ck_binding_lifecycle"
        ),
        CheckConstraint(
            "last_remote_share IS NULL OR (last_remote_share BETWEEN 0 AND 100)",
            name="ck_binding_share_range",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_ref_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(STREAM_REF_FK), nullable=False
    )
    offer_id: Mapped[int] = mapped_column(Integer, nullable=False)
    lifecycle: Mapped[str] = mapped_column(String(10), nullable=False)
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_remote_share: Mapped[int | None] = mapped_column(Integer, nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reactivated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), onupdate=func.now()
    )


class StreamDraftModel(Base):
    """Minimal staged-state table; Fetch only writes its conflict markers."""

    __tablename__ = "stream_drafts"
    __table_args__ = (
        UniqueConstraint("stream_ref_id", name="uq_stream_drafts_stream"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_ref_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(STREAM_REF_FK), nullable=False
    )
    baseline_snapshot_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    baseline_captured_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    staged_changes_json: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_dirty: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_stale: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    conflict_details_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), onupdate=func.now()
    )

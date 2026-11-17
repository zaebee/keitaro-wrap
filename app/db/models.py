from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class AppSettings(Base):
    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    keitaro_base_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    default_domain_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_group_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_offer_group_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_traffic_source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), onupdate=func.now())

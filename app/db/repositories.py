"""Synchronous SQLAlchemy adapters for application-owned repository ports."""

from sqlalchemy.orm import Session, sessionmaker

from app.application.dto import ConfiguredResources
from app.core.config import settings
from app.db.models import AppSettings, CampaignCreationOperationModel
from app.db.session import SessionLocal
from app.domain.campaign_creation import CampaignCreationOperation, OperationStatus


class SqlAlchemyCampaignCreationOperations:
    """Persist campaign-creation operations in SQLite."""

    def __init__(self, session_factory: sessionmaker[Session] = SessionLocal):
        """Use an injectable session factory so tests can use a temporary DB."""
        self._session_factory = session_factory

    def add(self, operation: CampaignCreationOperation) -> CampaignCreationOperation:
        """Insert a new operation and populate its generated fields."""
        with self._session_factory() as session:
            model = CampaignCreationOperationModel(
                operation_uuid=operation.operation_uuid,
                alias=operation.alias,
                name=operation.name,
                country_code=operation.country_code,
                offer_id=operation.offer_id,
                domain_id=operation.domain_id,
                group_id=operation.group_id,
                traffic_source_id=operation.traffic_source_id,
                status=operation.status.value,
                error_message=operation.error_message,
            )
            session.add(model)
            session.commit()
            session.refresh(model)
            operation.id = model.id
            operation.created_at = model.created_at
            operation.updated_at = model.updated_at
        return operation

    def get_by_uuid(self, operation_uuid: str) -> CampaignCreationOperation | None:
        """Load an operation by its stable UUID."""
        with self._session_factory() as session:
            model = (
                session.query(CampaignCreationOperationModel)
                .filter_by(operation_uuid=operation_uuid)
                .one_or_none()
            )
            return self._to_domain(model) if model is not None else None

    def get_by_alias(self, alias: str) -> CampaignCreationOperation | None:
        """Load an operation by its campaign alias."""
        with self._session_factory() as session:
            model = (
                session.query(CampaignCreationOperationModel)
                .filter_by(alias=alias)
                .one_or_none()
            )
            return self._to_domain(model) if model is not None else None

    def save(self, operation: CampaignCreationOperation) -> CampaignCreationOperation:
        """Write the current operation state to the existing row."""
        with self._session_factory() as session:
            model = session.get(CampaignCreationOperationModel, operation.id)
            if model is None:
                raise ValueError(f"unknown operation id {operation.id}")
            model.status = operation.status.value
            model.keitaro_campaign_id = operation.keitaro_campaign_id
            model.flow_country_id = operation.flow_country_id
            model.flow_offer_id = operation.flow_offer_id
            model.error_message = operation.error_message
            session.commit()
            session.refresh(model)
            operation.updated_at = model.updated_at
        return operation

    @staticmethod
    def _to_domain(
        model: CampaignCreationOperationModel,
    ) -> CampaignCreationOperation:
        """Map a persisted row back to the pure domain record."""
        return CampaignCreationOperation(
            id=model.id,
            operation_uuid=model.operation_uuid,
            alias=model.alias,
            name=model.name,
            country_code=model.country_code,
            offer_id=model.offer_id,
            domain_id=model.domain_id,
            group_id=model.group_id,
            traffic_source_id=model.traffic_source_id,
            status=OperationStatus(model.status),
            keitaro_campaign_id=model.keitaro_campaign_id,
            flow_country_id=model.flow_country_id,
            flow_offer_id=model.flow_offer_id,
            error_message=model.error_message,
            created_at=model.created_at,
            updated_at=model.updated_at,
        )


class SqlAlchemySettingsRepository:
    """Read operator configuration from ``app_settings`` with env defaults."""

    def __init__(self, session_factory: sessionmaker[Session] = SessionLocal):
        """Use an injectable session factory so tests can use a temporary DB."""
        self._session_factory = session_factory

    def get_config(self) -> ConfiguredResources:
        """Return DB values when present, otherwise environment defaults."""
        with self._session_factory() as session:
            row = session.get(AppSettings, 1)
        return ConfiguredResources(
            domain_id=(
                row.default_domain_id
                if row is not None and row.default_domain_id is not None
                else settings.KEITARO_DEFAULT_DOMAIN_ID
            ),
            group_id=(
                row.default_group_id
                if row is not None and row.default_group_id is not None
                else settings.KEITARO_DEFAULT_GROUP_ID
            ),
            traffic_source_id=(
                row.default_traffic_source_id
                if row is not None and row.default_traffic_source_id is not None
                else settings.KEITARO_DEFAULT_TRAFFIC_SOURCE_ID
            ),
            redirect_url=settings.KEITARO_REDIRECT_URL,
        )

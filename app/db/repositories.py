"""Synchronous SQLAlchemy adapters for application-owned repository ports."""

import json
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import cast

from sqlalchemy import delete, exists, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.application.campaign_creation import (
    IdempotencyKeyConflict,
)
from app.application.draft import DraftStaleError, DraftVersionConflict
from app.application.dto import (
    AcceptRemoteCommand,
    AcceptRemoteResult,
    ConfiguredResources,
    DirtyDraftView,
    DraftCommandBase,
    DraftCommandResult,
    DraftView,
    FetchedStream,
    FetchOutcome,
    FetchSnapshot,
    PublicationOperationView,
    PublicationPlan,
    PublicationStatus,
    RemoteSnapshotView,
    StreamBindingView,
    StreamDraftView,
    StreamRefView,
)
from app.application.errors import (
    ConflictChangedError,
    ConflictResolutionInputError,
    StreamNotFoundError,
)
from app.application.publication import (
    PublicationConflictError,
    PublicationGateError,
)
from app.core.config import settings
from app.db.models import (
    AppSettings,
    CampaignCreationOperationModel,
    RemoteOfferSnapshotModel,
    StreamDraftModel,
    StreamOfferBindingModel,
    StreamPublicationModel,
    StreamRefModel,
)
from app.db.session import SessionLocal
from app.domain.campaign_creation import (
    STEP_FIELDS,
    CampaignCreationOperation,
    CreationStage,
    OperationStatus,
    StepState,
    get_step,
)
from app.domain.draft import (
    BaselineBinding,
    DraftBaselineUnavailable,
    DraftCommand,
    DraftCommandKind,
    DraftContext,
    DraftInputError,
    DraftIntent,
    DraftViewData,
    StagedOffer,
    baseline_view,
    load_baseline_bindings,
    plan_edit,
    staged_view,
)
from app.domain.publication import (
    UNRESOLVED_STATUSES,
    OfferEntry,
    can_transition,
)
from app.domain.reconciliation import (
    BindingLifecycle,
    BindingState,
    BindingTransition,
    ConflictDetail,
    DraftState,
    RemoteOffer,
    TransitionKind,
    canonical_conflicts_json,
    conflict_fingerprint,
    plan_reconciliation,
    validate_remote_offers,
)

_STEP_ID_FIELDS: dict[CreationStage, str] = {
    CreationStage.CAMPAIGN: "keitaro_campaign_id",
    CreationStage.COUNTRY_FLOW: "flow_country_id",
    CreationStage.OFFER_FLOW: "flow_offer_id",
}


class SqlAlchemyCampaignCreationOperations:
    """Persist campaign-creation operations in SQLite."""

    def __init__(self, session_factory: sessionmaker[Session] = SessionLocal):
        """Use an injectable session factory so tests can use a temporary DB."""
        self._session_factory = session_factory

    @staticmethod
    def _operation_model(
        operation: CampaignCreationOperation,
    ) -> CampaignCreationOperationModel:
        """Build a persistence model from a fully prepared operation."""
        return CampaignCreationOperationModel(
            operation_uuid=operation.operation_uuid,
            alias=operation.alias,
            name=operation.name,
            country_code=operation.country_code,
            offer_id=operation.offer_id,
            domain_id=operation.domain_id,
            group_id=operation.group_id,
            traffic_source_id=operation.traffic_source_id,
            redirect_url=operation.redirect_url,
            status=operation.status.value,
            error_message=operation.error_message,
            campaign_step=operation.campaign_step.value,
            country_flow_step=operation.country_flow_step.value,
            offer_flow_step=operation.offer_flow_step.value,
        )

    def add(self, operation: CampaignCreationOperation) -> CampaignCreationOperation:
        """Insert a new operation and populate its generated fields."""
        with self._session_factory() as session:
            model = self._operation_model(operation)
            session.add(model)
            session.commit()
            session.refresh(model)
            operation.id = model.id
            operation.created_at = model.created_at
            operation.updated_at = model.updated_at
        return operation

    def get_or_create(
        self, operation: CampaignCreationOperation
    ) -> tuple[CampaignCreationOperation, bool]:
        """Insert an operation atomically or replay a concurrent winner."""
        existing = self.get_by_uuid(operation.operation_uuid)
        if existing is not None:
            return existing, False
        with self._session_factory() as session:
            model = self._operation_model(operation)
            session.add(model)
            try:
                session.commit()
            except IntegrityError as exc:
                session.rollback()
                winner = self.get_by_uuid(operation.operation_uuid)
                if winner is not None:
                    return winner, False
                if self.get_by_alias(operation.alias) is not None:
                    raise IdempotencyKeyConflict(
                        f"operation alias {operation.alias} is already reserved"
                    ) from exc
                raise
            session.refresh(model)
            operation.id = model.id
            operation.created_at = model.created_at
            operation.updated_at = model.updated_at
        return operation, True

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
            terminal = (
                OperationStatus.CREATED.value,
                OperationStatus.FAILED.value,
                OperationStatus.ABANDONED.value,
            )
            if model.status in terminal and model.status != operation.status.value:
                return self._to_domain(model)
            model.status = operation.status.value
            model.keitaro_campaign_id = operation.keitaro_campaign_id
            model.flow_country_id = operation.flow_country_id
            model.flow_offer_id = operation.flow_offer_id
            model.error_message = operation.error_message
            session.commit()
            session.refresh(model)
            operation.updated_at = model.updated_at
        return operation

    def claim_step(
        self, operation_uuid: str, stage: CreationStage
    ) -> CampaignCreationOperation | None:
        """Atomically move a not_started step to in_flight."""
        column = STEP_FIELDS[stage]
        with self._session_factory() as session:
            result = session.execute(
                update(CampaignCreationOperationModel)
                .where(CampaignCreationOperationModel.operation_uuid == operation_uuid)
                .where(
                    getattr(CampaignCreationOperationModel, column)
                    == StepState.NOT_STARTED.value
                )
                .values(**{column: StepState.IN_FLIGHT.value})
            )
            session.commit()
            if getattr(result, "rowcount", 0) != 1:
                return None
        return self.get_by_uuid(operation_uuid)

    def confirm_step(
        self,
        operation_uuid: str,
        stage: CreationStage,
        *,
        remote_id: int | None,
        status: OperationStatus | None,
        error: str | None,
    ) -> CampaignCreationOperation | None:
        """Atomically confirm a claimed/ambiguous step and store its remote ID."""
        values: dict[str, object] = {
            STEP_FIELDS[stage]: StepState.CONFIRMED.value,
            _STEP_ID_FIELDS[stage]: remote_id,
        }
        if status is not None:
            values["status"] = status.value
        if error is not None:
            values["error_message"] = error
        stored = self.get_by_uuid(operation_uuid)
        if stored is not None and get_step(stored, stage) is StepState.CONFIRMED:
            confirmed_id = getattr(stored, _STEP_ID_FIELDS[stage])
            return stored if confirmed_id == remote_id else None
        return self._update_step(
            operation_uuid,
            stage,
            values,
            (StepState.IN_FLIGHT, StepState.AMBIGUOUS),
        )

    def mark_step_ambiguous(
        self,
        operation_uuid: str,
        stage: CreationStage,
        *,
        status: OperationStatus | None,
        error: str | None,
    ) -> CampaignCreationOperation | None:
        """Atomically move a claimed step to ambiguous without allowing a retry."""
        values: dict[str, object] = {STEP_FIELDS[stage]: StepState.AMBIGUOUS.value}
        if status is not None:
            values["status"] = status.value
        if error is not None:
            values["error_message"] = error
        return self._update_step(
            operation_uuid,
            stage,
            values,
            (StepState.IN_FLIGHT, StepState.AMBIGUOUS),
        )

    def _update_step(
        self,
        operation_uuid: str,
        stage: CreationStage,
        values: dict[str, object],
        allowed: tuple[StepState, ...],
    ) -> CampaignCreationOperation | None:
        """Apply a conditional step update and reload the row on success."""
        column = getattr(CampaignCreationOperationModel, STEP_FIELDS[stage])
        with self._session_factory() as session:
            result = session.execute(
                update(CampaignCreationOperationModel)
                .where(CampaignCreationOperationModel.operation_uuid == operation_uuid)
                .where(column.in_([state.value for state in allowed]))
                .values(**values)
            )
            session.commit()
            if getattr(result, "rowcount", 0) != 1:
                return None
        return self.get_by_uuid(operation_uuid)

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
            redirect_url=model.redirect_url,
            status=OperationStatus(model.status),
            keitaro_campaign_id=model.keitaro_campaign_id,
            flow_country_id=model.flow_country_id,
            flow_offer_id=model.flow_offer_id,
            error_message=model.error_message,
            campaign_step=StepState(model.campaign_step),
            country_flow_step=StepState(model.country_flow_step),
            offer_flow_step=StepState(model.offer_flow_step),
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


def _utc_now() -> datetime:
    """Return a naive UTC timestamp compatible with DateTime columns."""
    return datetime.now(UTC).replace(tzinfo=None)


def _dump_offers(offers: tuple[RemoteOffer, ...]) -> str:
    """Serialize an ordered remote offer array."""
    return json.dumps(
        [
            {
                "offer_id": offer.offer_id,
                "share": offer.share,
                "state": offer.state,
                "position": offer.position,
            }
            for offer in offers
        ],
        separators=(",", ":"),
    )


def _load_offers(raw: str) -> tuple[RemoteOffer, ...]:
    """Deserialize and validate an ordered remote offer array."""
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("remote offer snapshot is not a list")
    offers = tuple(
        RemoteOffer(
            offer_id=item["offer_id"],
            share=item["share"],
            state=item.get("state"),
            position=item.get("position", index),
        )
        for index, item in enumerate(data)
    )
    return validate_remote_offers(offers)


def _dump_conflicts(conflicts: tuple[ConflictDetail, ...]) -> str:
    """Serialize structured draft conflicts in canonical form."""
    return canonical_conflicts_json(conflicts)


def _load_conflicts(raw: str | None) -> tuple[ConflictDetail, ...]:
    """Deserialize structured draft conflicts; absent means no conflicts."""
    if raw is None:
        return ()
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("draft conflict details are not a list")
    return tuple(
        ConflictDetail(
            stream_ref=item["stream_ref"],
            offer_id=item["offer_id"],
            field=item["field"],
            expected=item.get("expected"),
            observed=item.get("observed"),
            reason=item["reason"],
        )
        for item in data
    )


def _load_staged_changes(raw: str) -> dict[str, object]:
    """Deserialize staged changes without interpreting their contents."""
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("draft staged changes are not an object")
    return data


def _dump_json(value: object) -> str:
    """Serialise evidence with stable key order for comparison."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _load_object(raw: str) -> dict[str, object]:
    """Deserialise a stored JSON object."""
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("stored publication evidence is not an object")
    return data


def _dump_entries(entries: tuple[OfferEntry, ...]) -> str:
    """Serialise the exact offer entries sent in a PUT body."""
    return _dump_json([entry.to_json() for entry in entries])


def _load_entries(raw: str) -> tuple[OfferEntry, ...]:
    """Deserialise the exact offer entries sent in a PUT body."""
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("publication offer entries are not a list")
    return tuple(
        OfferEntry(
            offer_id=item["offer_id"],
            share=item["share"],
            state=item.get("state"),
        )
        for item in data
    )


def _dump_staged_offers(offers: tuple[StagedOffer, ...]) -> str:
    """Serialise the immutable effective staged view of a publication."""
    return _dump_json(
        [
            {
                "offer_id": item.offer_id,
                "lifecycle": item.lifecycle.value,
                "is_pinned": item.is_pinned,
                "share": item.share,
                "state": item.state,
                "position": item.position,
            }
            for item in offers
        ]
    )


def _load_staged_offers(raw: str) -> tuple[StagedOffer, ...]:
    """Deserialise the immutable effective staged view of a publication."""
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("publication staged offers are not a list")
    return tuple(
        StagedOffer(
            offer_id=item["offer_id"],
            lifecycle=BindingLifecycle(item["lifecycle"]),
            is_pinned=item["is_pinned"],
            share=item["share"],
            state=item.get("state"),
            position=item["position"],
        )
        for item in data
    )


def _find_ref_by_remote(session: Session, stream_ref: int) -> StreamRefModel | None:
    """Find a cached stream reference by its remote id."""
    return (
        session.query(StreamRefModel)
        .filter_by(keitaro_stream_id=stream_ref)
        .one_or_none()
    )


def _has_unresolved_publication(session: Session, stream_ref_id: int) -> bool:
    """Read the durable gate for one stream inside the current transaction."""
    return (
        session.query(StreamPublicationModel)
        .filter_by(stream_ref_id=stream_ref_id)
        .filter(StreamPublicationModel.status.in_(UNRESOLVED_STATUSES))
        .first()
        is not None
    )


class SqlAlchemyStreamReconciliationRepository:
    """Apply one remote Fetch to local persistence in a single transaction."""

    def __init__(
        self,
        session_factory: sessionmaker[Session] = SessionLocal,
        *,
        max_attempts: int = 2,
    ):
        """Use an injectable session factory so tests can use a temporary DB."""
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        self._session_factory = session_factory
        self._max_attempts = max_attempts

    def reconcile(self, snapshot: FetchSnapshot) -> FetchOutcome:
        """Reconcile a whole snapshot, retrying only local unique-constraint races."""
        for attempt in range(self._max_attempts):
            try:
                return self._reconcile_once(snapshot)
            except IntegrityError:
                if attempt + 1 >= self._max_attempts:
                    raise
        raise RuntimeError("reconciliation attempts exhausted")

    def _reconcile_once(self, snapshot: FetchSnapshot) -> FetchOutcome:
        """Write all streams inside one transaction; anything else rolls back."""
        counts = {
            "created_bindings": 0,
            "archived_bindings": 0,
            "reactivated_bindings": 0,
            "share_updates": 0,
            "conflicted_drafts": 0,
        }
        reconciled = 0
        with self._session_factory() as session:
            try:
                for stream in snapshot.streams:
                    if self._reconcile_stream(session, snapshot, stream, counts):
                        reconciled += 1
                session.commit()
            except Exception:
                session.rollback()
                raise
        return FetchOutcome(
            campaign_id=snapshot.campaign_id,
            stream_count=len(snapshot.streams),
            reconciled_stream_count=reconciled,
            created_bindings=counts["created_bindings"],
            archived_bindings=counts["archived_bindings"],
            reactivated_bindings=counts["reactivated_bindings"],
            share_updates=counts["share_updates"],
            conflicted_drafts=counts["conflicted_drafts"],
        )

    def _reconcile_stream(
        self,
        session: Session,
        snapshot: FetchSnapshot,
        stream: FetchedStream,
        counts: dict[str, int],
    ) -> bool:
        """Reconcile one stream; return whether it had local reconciliation state."""
        ref = self._get_or_create_ref(session, snapshot.campaign_id, stream)
        bindings = self._load_bindings(session, ref.id)
        cached = (
            session.query(RemoteOfferSnapshotModel)
            .filter_by(stream_ref_id=ref.id)
            .one_or_none()
        )
        draft = (
            session.query(StreamDraftModel)
            .filter_by(stream_ref_id=ref.id)
            .one_or_none()
        )
        if not stream.offers and not bindings and cached is None and draft is None:
            return False
        remote = validate_remote_offers(stream.offers)
        plan = plan_reconciliation(
            stream_ref=stream.stream_ref,
            remote_offers=remote,
            previous_bindings=bindings,
            draft=self._draft_state(draft),
        )
        self._apply_transitions(session, ref.id, plan.transitions, counts)
        self._upsert_remote_snapshot(
            session, ref.id, plan.remote_offers, snapshot.captured_at, cached
        )
        if draft is not None and plan.conflicts:
            serialized = _dump_conflicts(plan.conflicts)
            is_new_marker = (
                not draft.is_stale or draft.conflict_details_json != serialized
            )
            draft.is_stale = True
            draft.conflict_details_json = serialized
            if is_new_marker:
                counts["conflicted_drafts"] += 1
        return True

    @staticmethod
    def _find_ref(session: Session, stream_ref: int) -> StreamRefModel | None:
        """Look up a cached stream by its remote id."""
        return (
            session.query(StreamRefModel)
            .filter_by(keitaro_stream_id=stream_ref)
            .one_or_none()
        )

    def _get_or_create_ref(
        self, session: Session, campaign_id: int, stream: FetchedStream
    ) -> StreamRefModel:
        """Insert or refresh the minimal cached identity of a remote stream."""
        ref = self._find_ref(session, stream.stream_ref)
        if ref is None:
            ref = StreamRefModel(
                campaign_id=campaign_id,
                keitaro_stream_id=stream.stream_ref,
                type=stream.type,
                name=stream.name,
                schema=stream.schema,
                comments=stream.comments,
            )
            session.add(ref)
            session.flush()
            return ref
        ref.campaign_id = campaign_id
        ref.type = stream.type
        ref.name = stream.name
        ref.schema = stream.schema
        ref.comments = stream.comments
        return ref

    @staticmethod
    def _load_bindings(
        session: Session, stream_ref_id: int
    ) -> tuple[BindingState, ...]:
        """Load committed binding state for one stream."""
        rows = (
            session.query(StreamOfferBindingModel)
            .filter_by(stream_ref_id=stream_ref_id)
            .all()
        )
        return tuple(
            BindingState(
                offer_id=row.offer_id,
                lifecycle=BindingLifecycle(row.lifecycle),
                is_pinned=row.is_pinned,
                last_remote_share=row.last_remote_share,
            )
            for row in rows
        )

    @staticmethod
    def _draft_state(row: StreamDraftModel | None) -> DraftState | None:
        """Load only the parts of a draft Fetch is allowed to read."""
        if row is None:
            return None
        baseline = (
            _load_offers(row.baseline_snapshot_json)
            if row.baseline_snapshot_json is not None
            else ()
        )
        return DraftState(
            baseline_offers=baseline,
            staged_changes=_load_staged_changes(row.staged_changes_json),
            is_stale=row.is_stale,
            conflicts=_load_conflicts(row.conflict_details_json),
        )

    def _apply_transitions(
        self,
        session: Session,
        stream_ref_id: int,
        transitions: tuple[BindingTransition, ...],
        counts: dict[str, int],
    ) -> None:
        """Apply planned binding changes without touching wrapper-owned pin state."""
        now = _utc_now()
        for transition in transitions:
            if transition.kind is TransitionKind.CREATED:
                session.add(
                    StreamOfferBindingModel(
                        stream_ref_id=stream_ref_id,
                        offer_id=transition.offer_id,
                        lifecycle=BindingLifecycle.ACTIVE.value,
                        is_pinned=False,
                        last_remote_share=transition.share,
                    )
                )
                counts["created_bindings"] += 1
                continue
            binding = (
                session.query(StreamOfferBindingModel)
                .filter_by(stream_ref_id=stream_ref_id, offer_id=transition.offer_id)
                .one_or_none()
            )
            if binding is None:
                raise RuntimeError(
                    f"missing binding for offer {transition.offer_id} "
                    f"in stream {stream_ref_id}"
                )
            if transition.kind is TransitionKind.ARCHIVED:
                binding.lifecycle = BindingLifecycle.ARCHIVED.value
                binding.last_remote_share = None
                binding.archived_at = now
                counts["archived_bindings"] += 1
            elif transition.kind is TransitionKind.REACTIVATED:
                binding.lifecycle = BindingLifecycle.ACTIVE.value
                binding.last_remote_share = transition.share
                binding.reactivated_at = now
                counts["reactivated_bindings"] += 1
            elif transition.kind is TransitionKind.SHARE_CHANGED:
                binding.last_remote_share = transition.share
                counts["share_updates"] += 1

    @staticmethod
    def _upsert_remote_snapshot(
        session: Session,
        stream_ref_id: int,
        offers: tuple[RemoteOffer, ...],
        captured_at: datetime,
        cached: RemoteOfferSnapshotModel | None,
    ) -> None:
        """Keep exactly one current remote cache row per stream."""
        serialized = _dump_offers(offers)
        if cached is None:
            session.add(
                RemoteOfferSnapshotModel(
                    stream_ref_id=stream_ref_id,
                    offers_json=serialized,
                    captured_at=captured_at,
                )
            )
            return
        cached.offers_json = serialized
        cached.captured_at = captured_at

    def list_by_campaign(self, campaign_id: int) -> tuple[StreamRefView, ...]:
        """List cached stream references of one campaign in id order."""
        with self._session_factory() as session:
            rows = (
                session.query(StreamRefModel)
                .filter_by(campaign_id=campaign_id)
                .order_by(StreamRefModel.keitaro_stream_id)
                .all()
            )
            return tuple(
                StreamRefView(
                    stream_ref=row.keitaro_stream_id,
                    campaign_id=row.campaign_id,
                    type=row.type,
                    name=row.name,
                    schema=row.schema,
                    comments=row.comments,
                )
                for row in rows
            )

    def get_stream_ref(self, stream_ref: int) -> StreamRefView | None:
        """Load a cached remote stream reference by its Keitaro id."""
        with self._session_factory() as session:
            row = self._find_ref(session, stream_ref)
            if row is None:
                return None
            return StreamRefView(
                stream_ref=row.keitaro_stream_id,
                campaign_id=row.campaign_id,
                type=row.type,
                name=row.name,
                schema=row.schema,
                comments=row.comments,
            )

    def get_bindings(self, stream_ref: int) -> tuple[StreamBindingView, ...]:
        """Load committed bindings for one remote stream."""
        with self._session_factory() as session:
            row = self._find_ref(session, stream_ref)
            if row is None:
                return ()
            bindings = self._load_bindings(session, row.id)
        return tuple(
            StreamBindingView(
                offer_id=item.offer_id,
                lifecycle=item.lifecycle.value,
                is_pinned=item.is_pinned,
                last_remote_share=item.last_remote_share,
            )
            for item in sorted(bindings, key=lambda item: item.offer_id)
        )

    def get_remote_snapshot(self, stream_ref: int) -> RemoteSnapshotView | None:
        """Load the last remote offer observation for one stream."""
        with self._session_factory() as session:
            row = self._find_ref(session, stream_ref)
            if row is None:
                return None
            cached = (
                session.query(RemoteOfferSnapshotModel)
                .filter_by(stream_ref_id=row.id)
                .one_or_none()
            )
            if cached is None:
                return None
            return RemoteSnapshotView(
                offers=_load_offers(cached.offers_json),
                captured_at=cached.captured_at,
            )

    def get_draft(self, stream_ref: int) -> StreamDraftView | None:
        """Load the staged state for one remote stream, if one exists."""
        with self._session_factory() as session:
            row = self._find_ref(session, stream_ref)
            if row is None:
                return None
            draft = (
                session.query(StreamDraftModel)
                .filter_by(stream_ref_id=row.id)
                .one_or_none()
            )
            if draft is None:
                return None
            return StreamDraftView(
                baseline_offers=(
                    _load_offers(draft.baseline_snapshot_json)
                    if draft.baseline_snapshot_json is not None
                    else ()
                ),
                staged_changes=_load_staged_changes(draft.staged_changes_json),
                version=draft.version,
                is_dirty=draft.is_dirty,
                is_stale=draft.is_stale,
                conflicts=_load_conflicts(draft.conflict_details_json),
            )


DRAFT_VERSION_CONFLICT = "draft version changed"


@dataclass(frozen=True)
class _DraftBaselines:
    """Immutable baselines loaded for one draft command."""

    offers: tuple[RemoteOffer, ...]
    bindings: tuple[BaselineBinding, ...]
    captured_at: datetime | None
    intent: DraftIntent
    version: int


@dataclass(frozen=True)
class _DraftEditContext:
    """Everything needed to plan and persist one draft command."""

    ref: StreamRefModel
    draft: StreamDraftModel | None
    baselines: _DraftBaselines
    plan_context: DraftContext
    conflicts: tuple[ConflictDetail, ...]
    is_stale: bool


def _dump_bindings(values: tuple[BaselineBinding, ...]) -> str:
    """Serialise the immutable committed-state baseline of a draft."""
    return json.dumps(
        [
            {
                "offer_id": item.offer_id,
                "lifecycle": item.lifecycle.value,
                "is_pinned": item.is_pinned,
            }
            for item in values
        ],
        separators=(",", ":"),
    )


def _load_bindings_baseline(raw: str) -> tuple[BaselineBinding, ...]:
    """Deserialise the immutable committed-state baseline of a draft."""
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("draft binding baseline is not a list")
    return load_baseline_bindings(
        tuple(
            BaselineBinding(
                offer_id=item["offer_id"],
                lifecycle=BindingLifecycle(item["lifecycle"]),
                is_pinned=item["is_pinned"],
            )
            for item in data
        )
    )


def _load_intent(raw: str) -> DraftIntent:
    """Deserialise staged intent without changing its meaning."""
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("draft staged changes are not an object")

    def ids(key: str) -> tuple[int, ...]:
        """Read a list of integer offer ids."""
        values = data.get(key, [])
        if not isinstance(values, list) or any(
            type(item) is not int for item in values
        ):
            raise ValueError(f"draft {key} must be a list of ints")
        return tuple(values)

    def mapping(key: str, expected: type) -> dict[int, object]:
        """Read an offer-id keyed mapping with checked value types."""
        values = data.get(key, {})
        if not isinstance(values, dict):
            raise ValueError(f"draft {key} must be an object")
        result: dict[int, object] = {}
        for key_value, value in values.items():
            if not isinstance(key_value, str) or not key_value.isdigit():
                raise ValueError(f"draft {key} has an invalid offer id")
            if type(value) is not expected:
                raise ValueError(f"draft {key} has an invalid value")
            result[int(key_value)] = value
        return result

    pin_values = mapping("pin_toggles", bool)
    share_values = mapping("share_edits", int)
    return DraftIntent(
        additions=ids("additions"),
        archives=ids("archives"),
        restores=ids("restores"),
        pin_toggles={key: bool(value) for key, value in pin_values.items()},
        share_edits={key: cast(int, value) for key, value in share_values.items()},
    )


def _draft_view(
    stream_ref: int,
    context: DraftContext,
    view: DraftViewData,
    staged: DraftIntent,
    version: int,
    is_stale: bool,
    conflicts: tuple[ConflictDetail, ...],
) -> DraftView:
    """Combine derived data with persisted draft metadata."""
    data: DraftViewData = view
    return DraftView(
        stream_ref=stream_ref,
        offers=data.offers,
        baseline_offers=context.baseline_offers,
        staged_changes=staged.to_json(),
        version=version,
        is_dirty=staged.has_changes,
        is_stale=is_stale,
        conflicts=conflicts,
        conflicts_fingerprint=conflict_fingerprint(conflicts),
        policy_cases=data.policy_cases,
        unallocated=data.unallocated,
    )


def _is_draft_create_unique_race(exc: IntegrityError) -> bool:
    """Recognise only the unique violation from a concurrent lazy create."""
    original = getattr(exc, "orig", None)
    if getattr(original, "sqlite_errorname", None) != "SQLITE_CONSTRAINT_UNIQUE":
        return False
    return "stream_drafts.stream_ref_id" in str(original)


class SqlAlchemyStreamDraftRepository:
    """Apply local draft commands atomically with optimistic concurrency."""

    def __init__(self, session_factory: sessionmaker[Session] = SessionLocal):
        """Use an injectable session factory so tests can use a temporary DB."""
        self._session_factory = session_factory

    def apply(
        self, command: DraftCommandBase, intent: DraftCommand
    ) -> DraftCommandResult:
        """Apply one staging command inside one local transaction."""
        with self._session_factory() as session:
            try:
                return self._apply(session, command, intent)
            except IntegrityError as exc:
                session.rollback()
                if _is_draft_create_unique_race(exc):
                    raise DraftVersionConflict(
                        "concurrent draft creation",
                        stream_ref=command.stream_ref,
                        expected_version=command.expected_version,
                    ) from exc
                raise
            except DraftVersionConflict as exc:
                session.rollback()
                if exc.stream_ref is None:
                    exc.stream_ref = command.stream_ref
                if exc.expected_version is None:
                    exc.expected_version = command.expected_version
                raise
            except Exception:
                session.rollback()
                raise

    @staticmethod
    def _require_ref(session: Session, command: DraftCommandBase) -> StreamRefModel:
        """Find the stream and verify it belongs to the requested campaign."""
        ref = (
            session.query(StreamRefModel)
            .filter_by(keitaro_stream_id=command.stream_ref)
            .one_or_none()
        )
        if ref is None or ref.campaign_id != command.campaign_id:
            raise DraftInputError("stream does not belong to the requested campaign")
        if _has_unresolved_publication(session, ref.id):
            raise PublicationGateError(
                f"stream {command.stream_ref} has an unresolved publication"
            )
        return ref

    @staticmethod
    def _baselines_from_cache(
        session: Session,
        ref: StreamRefModel,
        cached: RemoteOfferSnapshotModel | None,
        expected_version: int,
    ) -> _DraftBaselines:
        """Capture remote offers and committed bindings for a new draft."""
        if cached is None or not _load_offers(cached.offers_json):
            raise DraftInputError("stream has no remote offer snapshot to baseline")
        if expected_version != 0:
            raise DraftVersionConflict(
                "a new draft requires expected_version 0",
                stream_ref=ref.keitaro_stream_id,
                expected_version=expected_version,
                current_version=0,
            )
        rows = (
            session.query(StreamOfferBindingModel).filter_by(stream_ref_id=ref.id).all()
        )
        bindings = load_baseline_bindings(
            tuple(
                BaselineBinding(
                    offer_id=row.offer_id,
                    lifecycle=BindingLifecycle(row.lifecycle),
                    is_pinned=row.is_pinned,
                )
                for row in rows
            )
        )
        return _DraftBaselines(
            _load_offers(cached.offers_json),
            bindings,
            cached.captured_at,
            DraftIntent(),
            ref.draft_version_counter + 1,
        )

    @staticmethod
    def _baselines_from_draft(
        draft: StreamDraftModel, expected_version: int
    ) -> _DraftBaselines:
        """Load the immutable baselines of an existing draft."""
        if expected_version != draft.version:
            raise DraftVersionConflict(
                DRAFT_VERSION_CONFLICT,
                expected_version=expected_version,
                current_version=draft.version,
            )
        if draft.baseline_snapshot_json is None or draft.baseline_bindings_json is None:
            raise DraftBaselineUnavailable("draft baselines are missing")
        return _DraftBaselines(
            _load_offers(draft.baseline_snapshot_json),
            _load_bindings_baseline(draft.baseline_bindings_json),
            draft.baseline_captured_at,
            _load_intent(draft.staged_changes_json),
            draft.version,
        )

    @classmethod
    def _prepare_context(
        cls,
        session: Session,
        command: DraftCommandBase,
        intent: DraftCommand,
    ) -> _DraftEditContext:
        """Load the stream, enforce D22 and capture the planning inputs."""
        ref = cls._require_ref(session, command)
        cached = (
            session.query(RemoteOfferSnapshotModel)
            .filter_by(stream_ref_id=ref.id)
            .one_or_none()
        )
        draft = (
            session.query(StreamDraftModel)
            .filter_by(stream_ref_id=ref.id)
            .one_or_none()
        )
        conflicts = _load_conflicts(draft.conflict_details_json) if draft else ()
        is_stale = draft.is_stale if draft else False
        if (
            draft is not None
            and is_stale
            and intent.kind is not DraftCommandKind.CANCEL
        ):
            raise DraftStaleError(command.stream_ref, conflicts)
        if draft is None:
            baselines = cls._baselines_from_cache(
                session, ref, cached, command.expected_version
            )
        else:
            baselines = cls._baselines_from_draft(draft, command.expected_version)
        plan_context = DraftContext(
            command.stream_ref,
            baselines.offers,
            baselines.bindings,
            baselines.intent,
        )
        return _DraftEditContext(
            ref, draft, baselines, plan_context, conflicts, is_stale
        )

    @staticmethod
    def _is_clean_draft(prepared: _DraftEditContext) -> bool:
        """Return whether a draft can be removed without losing sticky state."""
        return (
            prepared.draft is not None
            and not prepared.is_stale
            and not prepared.conflicts
        )

    @classmethod
    def _normalize_noop(
        cls,
        session: Session,
        prepared: _DraftEditContext,
        expected_version: int,
        new_intent: DraftIntent,
        current_intent: DraftIntent,
    ) -> bool:
        """Normalise an effective edit; report whether the clean draft was deleted."""
        if new_intent.to_json() == current_intent.to_json():
            return False
        draft = prepared.draft
        if draft is None:
            return False
        deleted = not new_intent.has_changes and cls._is_clean_draft(prepared)
        if deleted:
            result = session.execute(
                delete(StreamDraftModel)
                .where(StreamDraftModel.id == draft.id)
                .where(StreamDraftModel.version == expected_version)
            )
        else:
            result = session.execute(
                update(StreamDraftModel)
                .where(StreamDraftModel.id == draft.id)
                .where(StreamDraftModel.version == expected_version)
                .values(
                    staged_changes_json=json.dumps(
                        new_intent.to_json(), separators=(",", ":")
                    ),
                    is_dirty=False,
                )
            )
        if getattr(result, "rowcount", 0) != 1:
            raise DraftVersionConflict(DRAFT_VERSION_CONFLICT)
        return deleted

    @classmethod
    def _write_plan(
        cls,
        session: Session,
        prepared: _DraftEditContext,
        command: DraftCommandBase,
        plan_intent: DraftIntent,
    ) -> tuple[int, bool]:
        """Insert, update or clean up a draft in one conditional write."""
        draft = prepared.draft
        if (
            draft is not None
            and not plan_intent.has_changes
            and cls._is_clean_draft(prepared)
        ):
            prepared.ref.draft_version_counter = max(
                prepared.ref.draft_version_counter, command.expected_version
            )
            result = session.execute(
                delete(StreamDraftModel)
                .where(StreamDraftModel.id == draft.id)
                .where(StreamDraftModel.version == command.expected_version)
            )
            if getattr(result, "rowcount", 0) != 1:
                raise DraftVersionConflict(DRAFT_VERSION_CONFLICT)
            return 0, False
        serialized = json.dumps(plan_intent.to_json(), separators=(",", ":"))
        if draft is None:
            version = prepared.baselines.version
            session.add(
                StreamDraftModel(
                    stream_ref_id=prepared.ref.id,
                    baseline_snapshot_json=_dump_offers(prepared.baselines.offers),
                    baseline_bindings_json=_dump_bindings(prepared.baselines.bindings),
                    baseline_captured_at=prepared.baselines.captured_at,
                    staged_changes_json=serialized,
                    version=version,
                    is_dirty=plan_intent.has_changes,
                    is_stale=False,
                )
            )
            prepared.ref.draft_version_counter = version
            return version, True
        version = command.expected_version + 1
        result = session.execute(
            update(StreamDraftModel)
            .where(StreamDraftModel.id == draft.id)
            .where(StreamDraftModel.version == command.expected_version)
            .values(
                staged_changes_json=serialized,
                version=version,
                is_dirty=plan_intent.has_changes,
            )
        )
        if getattr(result, "rowcount", 0) != 1:
            raise DraftVersionConflict(DRAFT_VERSION_CONFLICT)
        prepared.ref.draft_version_counter = max(
            prepared.ref.draft_version_counter, version
        )
        return version, False

    def _apply(
        self, session: Session, command: DraftCommandBase, intent: DraftCommand
    ) -> DraftCommandResult:
        """Load immutable baselines, plan the edit and write conditionally."""
        prepared = self._prepare_context(session, command, intent)
        plan = plan_edit(prepared.plan_context, intent)
        view = _draft_view(
            command.stream_ref,
            prepared.plan_context,
            plan.view,
            plan.intent,
            prepared.baselines.version,
            prepared.is_stale,
            prepared.conflicts,
        )
        if plan.noop:
            deleted = self._normalize_noop(
                session,
                prepared,
                command.expected_version,
                plan.intent,
                prepared.plan_context.intent,
            )
            session.commit()
            if deleted:
                return DraftCommandResult(
                    view=replace(view, version=0), created=False, noop=True
                )
            return DraftCommandResult(view=view, created=False, noop=True)
        new_version, created = self._write_plan(session, prepared, command, plan.intent)
        session.commit()
        return DraftCommandResult(
            view=replace(view, version=new_version),
            created=created,
            noop=False,
        )

    def get_stream_campaign(self, stream_ref: int) -> int | None:
        """Return the campaign id of a cached stream reference, if known."""
        with self._session_factory() as session:
            row = (
                session.query(StreamRefModel)
                .filter_by(keitaro_stream_id=stream_ref)
                .one_or_none()
            )
            return row.campaign_id if row is not None else None

    def list_dirty(self, campaign_id: int) -> tuple[DirtyDraftView, ...]:
        """List dirty drafts of one campaign for publication planning."""
        with self._session_factory() as session:
            rows = (
                session.query(StreamDraftModel)
                .join(
                    StreamRefModel,
                    StreamRefModel.id == StreamDraftModel.stream_ref_id,
                )
                .filter(StreamRefModel.campaign_id == campaign_id)
                .filter(StreamDraftModel.is_dirty.is_(True))
                .all()
            )
            return tuple(
                DirtyDraftView(
                    stream_ref=self._remote_id(session, row.stream_ref_id),
                    version=row.version,
                    intent=_load_intent(row.staged_changes_json).to_json(),
                    is_dirty=row.is_dirty,
                    is_stale=row.is_stale,
                )
                for row in rows
            )

    @staticmethod
    def _remote_id(session: Session, stream_ref_id: int) -> int:
        """Return the remote stream id of one cached reference."""
        ref = session.get(StreamRefModel, stream_ref_id)
        if ref is None:
            raise ValueError(f"unknown stream reference {stream_ref_id}")
        return ref.keitaro_stream_id

    def get_view(self, stream_ref: int) -> DraftView | None:
        """Load the derived staged view for one stream."""
        with self._session_factory() as session:
            ref = (
                session.query(StreamRefModel)
                .filter_by(keitaro_stream_id=stream_ref)
                .one_or_none()
            )
            if ref is None:
                return None
            draft = (
                session.query(StreamDraftModel)
                .filter_by(stream_ref_id=ref.id)
                .one_or_none()
            )
            if draft is None:
                return None
            if (
                draft.baseline_snapshot_json is None
                or draft.baseline_bindings_json is None
            ):
                raise DraftBaselineUnavailable("draft baselines are missing")
            baseline_offers = _load_offers(draft.baseline_snapshot_json)
            baseline_bindings = _load_bindings_baseline(draft.baseline_bindings_json)
            current_intent = _load_intent(draft.staged_changes_json)
            context = DraftContext(
                stream_ref, baseline_offers, baseline_bindings, current_intent
            )
            view = (
                staged_view(context, current_intent)
                if current_intent.has_changes
                else baseline_view(context)
            )
            return _draft_view(
                stream_ref,
                context,
                view,
                current_intent,
                draft.version,
                draft.is_stale,
                _load_conflicts(draft.conflict_details_json),
            )

    def accept_remote(
        self,
        command: AcceptRemoteCommand,
        observation: FetchedStream,
        captured_at: datetime,
    ) -> AcceptRemoteResult:
        """Atomically replace a conflicted draft with a fresh remote baseline."""
        with self._session_factory() as session:
            try:
                ref = (
                    session.query(StreamRefModel)
                    .filter_by(keitaro_stream_id=command.stream_ref)
                    .one_or_none()
                )
                if ref is None or ref.campaign_id != command.campaign_id:
                    raise StreamNotFoundError(command.campaign_id, command.stream_ref)
                draft = (
                    session.query(StreamDraftModel)
                    .filter_by(stream_ref_id=ref.id)
                    .one_or_none()
                )
                if draft is None:
                    raise ConflictResolutionInputError(
                        "no conflicted draft exists for this stream"
                    )
                current_conflicts = _load_conflicts(draft.conflict_details_json)
                current_fingerprint = conflict_fingerprint(current_conflicts)
                if current_fingerprint != command.expected_conflicts_fingerprint:
                    raise ConflictChangedError(
                        command.stream_ref,
                        command.expected_conflicts_fingerprint,
                        current_fingerprint,
                    )
                if draft.version != command.expected_version:
                    raise DraftVersionConflict(
                        DRAFT_VERSION_CONFLICT,
                        stream_ref=command.stream_ref,
                        expected_version=command.expected_version,
                        current_version=draft.version,
                    )
                if _has_unresolved_publication(session, ref.id):
                    raise PublicationGateError(
                        f"stream {command.stream_ref} has an unresolved publication"
                    )
                cached = (
                    session.query(RemoteOfferSnapshotModel)
                    .filter_by(stream_ref_id=ref.id)
                    .one_or_none()
                )
                if cached is not None and cached.captured_at > captured_at:
                    raise ConflictChangedError(
                        command.stream_ref,
                        command.expected_conflicts_fingerprint,
                        current_fingerprint,
                    )
                bindings = SqlAlchemyStreamReconciliationRepository._load_bindings(
                    session, ref.id
                )
                plan = plan_reconciliation(
                    stream_ref=command.stream_ref,
                    remote_offers=observation.offers,
                    previous_bindings=bindings,
                )
                updated_bindings = self._bindings_after_plan(bindings, plan.transitions)
                baseline_bindings = load_baseline_bindings(
                    tuple(
                        BaselineBinding(item.offer_id, item.lifecycle, item.is_pinned)
                        for item in updated_bindings
                    )
                )
                new_version = command.expected_version + 1
                gate_absent = ~exists(
                    select(StreamPublicationModel.id).where(
                        StreamPublicationModel.stream_ref_id == ref.id,
                        StreamPublicationModel.status.in_(UNRESOLVED_STATUSES),
                    )
                )
                snapshot_current = ~exists(
                    select(RemoteOfferSnapshotModel.id).where(
                        RemoteOfferSnapshotModel.stream_ref_id == ref.id,
                        RemoteOfferSnapshotModel.captured_at > captured_at,
                    )
                )
                result = session.execute(
                    update(StreamDraftModel)
                    .where(StreamDraftModel.id == draft.id)
                    .where(StreamDraftModel.version == command.expected_version)
                    .where(StreamDraftModel.is_stale.is_(True))
                    .where(
                        StreamDraftModel.conflict_details_json
                        == _dump_conflicts(current_conflicts)
                    )
                    .where(gate_absent)
                    .where(snapshot_current)
                    .values(
                        baseline_snapshot_json=_dump_offers(observation.offers),
                        baseline_bindings_json=_dump_bindings(baseline_bindings),
                        baseline_captured_at=captured_at,
                        staged_changes_json="{}",
                        is_dirty=False,
                        is_stale=False,
                        conflict_details_json=None,
                        version=new_version,
                    )
                )
                if getattr(result, "rowcount", 0) != 1:
                    raise ConflictChangedError(
                        command.stream_ref,
                        command.expected_conflicts_fingerprint,
                        current_fingerprint,
                    )
                counts = {
                    "created_bindings": 0,
                    "archived_bindings": 0,
                    "reactivated_bindings": 0,
                    "share_updates": 0,
                }
                SqlAlchemyStreamReconciliationRepository(
                    self._session_factory
                )._apply_transitions(session, ref.id, plan.transitions, counts)
                SqlAlchemyStreamReconciliationRepository._upsert_remote_snapshot(
                    session,
                    ref.id,
                    plan.remote_offers,
                    captured_at,
                    cached,
                )
                ref.draft_version_counter = max(ref.draft_version_counter, new_version)
                session.commit()
                context = DraftContext(
                    command.stream_ref,
                    observation.offers,
                    baseline_bindings,
                    DraftIntent(),
                )
                view = _draft_view(
                    command.stream_ref,
                    context,
                    baseline_view(context),
                    DraftIntent(),
                    new_version,
                    False,
                    (),
                )
                return AcceptRemoteResult(command.stream_ref, view, False, new_version)
            except Exception:
                session.rollback()
                raise

    @staticmethod
    def _bindings_after_plan(
        bindings: tuple[BindingState, ...],
        transitions: tuple[BindingTransition, ...],
    ) -> tuple[BindingState, ...]:
        """Apply planned committed transitions to a pure binding snapshot."""
        updated = {binding.offer_id: binding for binding in bindings}
        for transition in transitions:
            current = updated.get(transition.offer_id)
            if transition.kind is TransitionKind.CREATED:
                updated[transition.offer_id] = BindingState(
                    transition.offer_id,
                    BindingLifecycle.ACTIVE,
                    False,
                    transition.share,
                )
            elif transition.kind is TransitionKind.ARCHIVED:
                if current is None:
                    raise RuntimeError(
                        f"missing binding for offer {transition.offer_id}"
                    )
                updated[transition.offer_id] = replace(
                    current, lifecycle=BindingLifecycle.ARCHIVED, last_remote_share=None
                )
            elif transition.kind is TransitionKind.REACTIVATED:
                if current is None:
                    raise RuntimeError(
                        f"missing binding for offer {transition.offer_id}"
                    )
                updated[transition.offer_id] = replace(
                    current,
                    lifecycle=BindingLifecycle.ACTIVE,
                    last_remote_share=transition.share,
                )
            elif transition.kind is TransitionKind.SHARE_CHANGED:
                if current is None:
                    raise RuntimeError(
                        f"missing binding for offer {transition.offer_id}"
                    )
                updated[transition.offer_id] = replace(
                    current, last_remote_share=transition.share
                )
        return tuple(updated[offer_id] for offer_id in sorted(updated))


class SqlAlchemyStreamPublicationRepository:
    """Persist durable per-stream publication operations in SQLite."""

    def __init__(self, session_factory: sessionmaker[Session] = SessionLocal):
        """Use an injectable session factory so tests can use a temporary DB."""
        self._session_factory = session_factory

    @staticmethod
    def _to_view(model: StreamPublicationModel) -> PublicationOperationView:
        """Map a persisted publication row to its application view."""
        return PublicationOperationView(
            id=model.id,
            operation_uuid=model.operation_uuid,
            campaign_id=model.campaign_id,
            stream_ref=model.stream_ref,
            status=PublicationStatus(model.status),
            draft_version=model.draft_version,
            intent=_load_object(model.expected_intent_json),
            request_payload=_load_object(model.request_payload_json),
            remote_baseline_before=_load_object(model.remote_baseline_before_json),
            remote_baseline_after=(
                _load_offers(model.remote_baseline_after_json)
                if model.remote_baseline_after_json is not None
                else None
            ),
            effective_entries=_load_entries(model.effective_offers_json),
            staged_offers=_load_staged_offers(model.staged_offers_json),
            attempt_count=model.attempt_count,
            error=model.error,
            evidence=(
                _load_object(model.evidence_json)
                if model.evidence_json is not None
                else None
            ),
        )

    def create_pending(
        self, plans: tuple[PublicationPlan, ...]
    ) -> tuple[PublicationOperationView, ...]:
        """Atomically capture drafts and create one pending operation per plan."""
        if not plans:
            return ()
        with self._session_factory() as session:
            try:
                created: list[StreamPublicationModel] = []
                for plan in plans:
                    ref = _find_ref_by_remote(session, plan.stream_ref)
                    if ref is None or ref.campaign_id != plan.campaign_id:
                        raise PublicationConflictError(
                            f"stream {plan.stream_ref} does not belong to campaign "
                            f"{plan.campaign_id}"
                        )
                    draft = (
                        session.query(StreamDraftModel)
                        .filter_by(stream_ref_id=ref.id)
                        .one_or_none()
                    )
                    if (
                        draft is None
                        or not draft.is_dirty
                        or draft.is_stale
                        or draft.version != plan.draft_version
                    ):
                        raise PublicationConflictError(
                            f"draft for stream {plan.stream_ref} changed"
                        )
                    if _load_intent(draft.staged_changes_json).to_json() != dict(
                        plan.intent
                    ):
                        raise PublicationConflictError(
                            f"staged intent for stream {plan.stream_ref} changed"
                        )
                    if _has_unresolved_publication(session, ref.id):
                        raise PublicationGateError(
                            f"stream {plan.stream_ref} has an unresolved publication"
                        )
                    model = StreamPublicationModel(
                        operation_uuid=plan.correlation_marker,
                        campaign_id=plan.campaign_id,
                        stream_ref=plan.stream_ref,
                        stream_ref_id=ref.id,
                        status=PublicationStatus.PENDING.value,
                        draft_version=plan.draft_version,
                        attempt_count=0,
                        request_payload_json=_dump_json(dict(plan.payload)),
                        remote_baseline_before_json=_dump_json(dict(plan.preimage)),
                        expected_intent_json=_dump_json(dict(plan.intent)),
                        effective_offers_json=_dump_entries(plan.expected_entries),
                        staged_offers_json=_dump_staged_offers(plan.staged_offers),
                    )
                    session.add(model)
                    created.append(model)
                session.commit()
                views = tuple(self._to_view(model) for model in created)
            except IntegrityError as exc:
                session.rollback()
                raise PublicationConflictError(
                    "concurrent publication creation"
                ) from exc
            except Exception:
                session.rollback()
                raise
        return views

    def get(self, operation_id: int) -> PublicationOperationView | None:
        """Load one publication operation by its local id."""
        with self._session_factory() as session:
            model = session.get(StreamPublicationModel, operation_id)
            return self._to_view(model) if model is not None else None

    def claim(
        self, operation_id: int, worker_token: str
    ) -> PublicationOperationView | None:
        """Atomically claim a pending operation before its mutating PUT."""
        with self._session_factory() as session:
            result = session.execute(
                update(StreamPublicationModel)
                .where(StreamPublicationModel.id == operation_id)
                .where(StreamPublicationModel.status == PublicationStatus.PENDING.value)
                .values(
                    status=PublicationStatus.IN_PROGRESS.value,
                    attempt_count=StreamPublicationModel.attempt_count + 1,
                    worker_token=worker_token,
                    started_at=_utc_now(),
                    error=None,
                )
            )
            session.commit()
            if getattr(result, "rowcount", 0) != 1:
                return None
            model = session.get(StreamPublicationModel, operation_id)
            return self._to_view(model) if model is not None else None

    def mark_ambiguous(
        self, operation_id: int, error: str
    ) -> PublicationOperationView | None:
        """Move an in-progress operation to ambiguous without authorizing retry."""
        return self._update_terminal(
            operation_id,
            PublicationStatus.AMBIGUOUS,
            error=error,
        )

    def mark_failed(
        self,
        operation_id: int,
        error: str,
        evidence: Mapping[str, object],
    ) -> PublicationOperationView | None:
        """Move an operation to failed only with explicit absence evidence."""
        if not evidence:
            raise PublicationConflictError(
                "failed requires evidence that the side effect did not occur"
            )
        return self._update_terminal(
            operation_id,
            PublicationStatus.FAILED,
            error=error,
            evidence=evidence,
        )

    def _update_terminal(
        self,
        operation_id: int,
        status: PublicationStatus,
        *,
        error: str,
        evidence: Mapping[str, object] | None = None,
    ) -> PublicationOperationView | None:
        """Apply one conditional terminal transition to a claimed operation."""
        values: dict[str, object] = {
            "status": status.value,
            "error": error,
            "finished_at": _utc_now(),
        }
        if evidence is not None:
            values["evidence_json"] = _dump_json(dict(evidence))
        with self._session_factory() as session:
            result = session.execute(
                update(StreamPublicationModel)
                .where(StreamPublicationModel.id == operation_id)
                .where(
                    StreamPublicationModel.status == PublicationStatus.IN_PROGRESS.value
                )
                .values(**values)
            )
            session.commit()
            if getattr(result, "rowcount", 0) != 1:
                return None
            model = session.get(StreamPublicationModel, operation_id)
            return self._to_view(model) if model is not None else None

    def finalize_success(
        self,
        operation_id: int,
        remote_baseline_after: tuple[RemoteOffer, ...],
    ) -> PublicationOperationView | None:
        """Commit bindings, cache and draft together with a verified success."""
        with self._session_factory() as session:
            try:
                model = session.get(StreamPublicationModel, operation_id)
                if model is None:
                    return None
                status = PublicationStatus(model.status)
                if status is PublicationStatus.SUCCEEDED:
                    return self._to_view(model)
                if not can_transition(status, PublicationStatus.SUCCEEDED):
                    return None
                ref = session.get(StreamRefModel, model.stream_ref_id)
                draft = (
                    session.query(StreamDraftModel)
                    .filter_by(stream_ref_id=model.stream_ref_id)
                    .one_or_none()
                )
                if ref is None or draft is None:
                    return None
                expected = _load_object(model.expected_intent_json)
                if (
                    draft.version != model.draft_version
                    or _load_intent(draft.staged_changes_json).to_json() != expected
                ):
                    return None

                now = _utc_now()
                self._apply_committed_changes(
                    session, model, remote_baseline_after, now
                )
                self._advance_snapshot(
                    session, model.stream_ref_id, remote_baseline_after, now
                )
                self._clear_draft(session, draft, ref)
                result = session.execute(
                    update(StreamPublicationModel)
                    .where(StreamPublicationModel.id == operation_id)
                    .where(
                        StreamPublicationModel.status.in_(
                            [
                                PublicationStatus.IN_PROGRESS.value,
                                PublicationStatus.AMBIGUOUS.value,
                            ]
                        )
                    )
                    .values(
                        status=PublicationStatus.SUCCEEDED.value,
                        remote_baseline_after_json=_dump_offers(remote_baseline_after),
                        error=None,
                        finished_at=now,
                    )
                )
                if getattr(result, "rowcount", 0) != 1:
                    session.rollback()
                    raise PublicationConflictError(
                        "publication changed during confirmation"
                    )
                session.commit()
                view = self._to_view(model)
            except Exception:
                session.rollback()
                raise
        return view

    @classmethod
    def _apply_committed_changes(
        cls,
        session: Session,
        model: StreamPublicationModel,
        observed: tuple[RemoteOffer, ...],
        now: datetime,
    ) -> None:
        """Apply the captured staged lifecycle/pin intent to bindings."""
        shares = {offer.offer_id: offer.share for offer in observed}
        for staged in _load_staged_offers(model.staged_offers_json):
            binding = (
                session.query(StreamOfferBindingModel)
                .filter_by(
                    stream_ref_id=model.stream_ref_id,
                    offer_id=staged.offer_id,
                )
                .one_or_none()
            )
            if binding is None:
                session.add(cls._new_binding(model, staged, shares, now))
            else:
                cls._update_binding(binding, staged, shares, now)

    @staticmethod
    def _new_binding(
        model: StreamPublicationModel,
        staged: StagedOffer,
        shares: dict[int, int],
        now: datetime,
    ) -> StreamOfferBindingModel:
        """Build a new committed binding from the captured staged offer."""
        active = staged.lifecycle is BindingLifecycle.ACTIVE
        return StreamOfferBindingModel(
            stream_ref_id=model.stream_ref_id,
            offer_id=staged.offer_id,
            lifecycle=staged.lifecycle.value,
            is_pinned=staged.is_pinned,
            last_remote_share=shares.get(staged.offer_id) if active else None,
            archived_at=None if active else now,
            reactivated_at=now if active else None,
        )

    @staticmethod
    def _update_binding(
        binding: StreamOfferBindingModel,
        staged: StagedOffer,
        shares: dict[int, int],
        now: datetime,
    ) -> None:
        """Update an existing binding from the captured staged offer."""
        active = staged.lifecycle is BindingLifecycle.ACTIVE
        binding.lifecycle = staged.lifecycle.value
        binding.is_pinned = staged.is_pinned
        binding.last_remote_share = shares.get(staged.offer_id) if active else None
        if active:
            binding.reactivated_at = now
        else:
            binding.archived_at = now

    @staticmethod
    def _advance_snapshot(
        session: Session,
        stream_ref_id: int,
        offers: tuple[RemoteOffer, ...],
        now: datetime,
    ) -> None:
        """Advance the remote cache only when this evidence is not stale."""
        cached = (
            session.query(RemoteOfferSnapshotModel)
            .filter_by(stream_ref_id=stream_ref_id)
            .one_or_none()
        )
        if cached is None:
            session.add(
                RemoteOfferSnapshotModel(
                    stream_ref_id=stream_ref_id,
                    offers_json=_dump_offers(offers),
                    captured_at=now,
                )
            )
        elif cached.captured_at <= now:
            cached.offers_json = _dump_offers(offers)
            cached.captured_at = now

    @staticmethod
    def _clear_draft(
        session: Session,
        draft: StreamDraftModel,
        ref: StreamRefModel,
    ) -> None:
        """Normalise a clean draft or preserve sticky conflict state."""
        if not draft.is_stale and not _load_conflicts(draft.conflict_details_json):
            ref.draft_version_counter = max(ref.draft_version_counter, draft.version)
            session.delete(draft)
            return
        draft.staged_changes_json = "{}"
        draft.is_dirty = False

    def list_recoverable(self, limit: int) -> tuple[PublicationOperationView, ...]:
        """List bounded unresolved operations for startup reconciliation."""
        with self._session_factory() as session:
            rows = (
                session.query(StreamPublicationModel)
                .filter(StreamPublicationModel.status.in_(UNRESOLVED_STATUSES))
                .order_by(StreamPublicationModel.id)
                .limit(limit)
                .all()
            )
            return tuple(self._to_view(row) for row in rows)

    def get_latest(
        self, campaign_id: int, stream_ref: int
    ) -> PublicationOperationView | None:
        """Load the newest publication record for one stream."""
        with self._session_factory() as session:
            row = (
                session.query(StreamPublicationModel)
                .filter_by(campaign_id=campaign_id, stream_ref=stream_ref)
                .order_by(StreamPublicationModel.id.desc())
                .first()
            )
            return self._to_view(row) if row is not None else None

    def has_unresolved(self, campaign_id: int, stream_refs: tuple[int, ...]) -> bool:
        """Report whether durable state gates any of the given streams."""
        if not stream_refs:
            return False
        with self._session_factory() as session:
            row = (
                session.query(StreamPublicationModel)
                .filter(StreamPublicationModel.campaign_id == campaign_id)
                .filter(StreamPublicationModel.stream_ref.in_(stream_refs))
                .filter(StreamPublicationModel.status.in_(UNRESOLVED_STATUSES))
                .first()
            )
            return row is not None

    def get_unresolved(
        self, campaign_id: int, stream_ref: int
    ) -> PublicationOperationView | None:
        """Load one unresolved operation for safe pending resume."""
        with self._session_factory() as session:
            row = (
                session.query(StreamPublicationModel)
                .filter_by(campaign_id=campaign_id, stream_ref=stream_ref)
                .filter(StreamPublicationModel.status.in_(UNRESOLVED_STATUSES))
                .order_by(StreamPublicationModel.id.desc())
                .first()
            )
            return self._to_view(row) if row is not None else None

    def cancel(
        self, campaign_id: int, stream_ref: int, reason: str
    ) -> tuple[PublicationOperationView, bool] | None:
        """Atomically abandon a cancellable operation and discard its draft."""
        with self._session_factory() as session:
            try:
                model = (
                    session.query(StreamPublicationModel)
                    .filter_by(campaign_id=campaign_id, stream_ref=stream_ref)
                    .order_by(StreamPublicationModel.id.desc())
                    .first()
                )
                if model is None:
                    return None
                status = PublicationStatus(model.status)
                if status is PublicationStatus.FAILED and not model.evidence_json:
                    raise PublicationConflictError(
                        "failed publication needs absence evidence before Cancel"
                    )
                if not can_transition(status, PublicationStatus.ABANDONED):
                    return None
                ref = _find_ref_by_remote(session, stream_ref)
                if ref is None or ref.campaign_id != campaign_id:
                    raise PublicationConflictError("stream belongs to another campaign")
                discarded = self._discard_cancelled_draft(session, model, ref)
                result = session.execute(
                    update(StreamPublicationModel)
                    .where(StreamPublicationModel.id == model.id)
                    .where(StreamPublicationModel.status == status.value)
                    .values(
                        status=PublicationStatus.ABANDONED.value,
                        error=reason,
                        finished_at=_utc_now(),
                    )
                )
                if getattr(result, "rowcount", 0) != 1:
                    raise PublicationConflictError("publication changed during Cancel")
                session.commit()
                session.refresh(model)
                return self._to_view(model), discarded
            except Exception:
                session.rollback()
                raise

    @staticmethod
    def _discard_cancelled_draft(
        session: Session,
        model: StreamPublicationModel,
        ref: StreamRefModel,
    ) -> bool:
        """Discard captured intent with version checks inside the Cancel transaction."""
        draft = (
            session.query(StreamDraftModel)
            .filter_by(stream_ref_id=ref.id)
            .one_or_none()
        )
        if draft is None:
            return False
        expected = _load_object(model.expected_intent_json)
        if (
            draft.version != model.draft_version
            or _load_intent(draft.staged_changes_json).to_json() != expected
        ):
            raise PublicationConflictError("draft changed before Cancel")
        was_dirty = draft.is_dirty
        if not draft.is_stale and not _load_conflicts(draft.conflict_details_json):
            result = session.execute(
                delete(StreamDraftModel)
                .where(StreamDraftModel.id == draft.id)
                .where(StreamDraftModel.version == model.draft_version)
            )
            ref.draft_version_counter = max(
                ref.draft_version_counter, model.draft_version
            )
        else:
            result = session.execute(
                update(StreamDraftModel)
                .where(StreamDraftModel.id == draft.id)
                .where(StreamDraftModel.version == model.draft_version)
                .values(
                    staged_changes_json="{}",
                    is_dirty=False,
                    version=model.draft_version + 1,
                )
            )
            ref.draft_version_counter = max(
                ref.draft_version_counter, model.draft_version + 1
            )
        if getattr(result, "rowcount", 0) != 1:
            raise PublicationConflictError("draft changed during Cancel")
        return was_dirty

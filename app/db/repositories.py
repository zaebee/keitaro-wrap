"""Synchronous SQLAlchemy adapters for application-owned repository ports."""

import json
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import cast

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.application.draft import DraftStaleError, DraftVersionConflict
from app.application.dto import (
    ConfiguredResources,
    DraftCommandBase,
    DraftCommandResult,
    DraftView,
    FetchedStream,
    FetchOutcome,
    FetchSnapshot,
    RemoteSnapshotView,
    StreamBindingView,
    StreamDraftView,
    StreamRefView,
)
from app.core.config import settings
from app.db.models import (
    AppSettings,
    CampaignCreationOperationModel,
    RemoteOfferSnapshotModel,
    StreamDraftModel,
    StreamOfferBindingModel,
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
    baseline_view,
    load_baseline_bindings,
    plan_edit,
    staged_view,
)
from app.domain.reconciliation import (
    BindingLifecycle,
    BindingState,
    BindingTransition,
    ConflictDetail,
    DraftState,
    RemoteOffer,
    TransitionKind,
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
                redirect_url=operation.redirect_url,
                status=operation.status.value,
                error_message=operation.error_message,
                campaign_step=operation.campaign_step.value,
                country_flow_step=operation.country_flow_step.value,
                offer_flow_step=operation.offer_flow_step.value,
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
    """Serialize structured draft conflicts."""
    return json.dumps(
        [
            {
                "stream_ref": conflict.stream_ref,
                "offer_id": conflict.offer_id,
                "field": conflict.field,
                "expected": conflict.expected,
                "observed": conflict.observed,
                "reason": conflict.reason,
            }
            for conflict in conflicts
        ],
        separators=(",", ":"),
    )


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
        policy_cases=data.policy_cases,
        unallocated=data.unallocated,
    )


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
                raise DraftVersionConflict("concurrent draft creation") from exc
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
            raise DraftVersionConflict("a new draft requires expected_version 0")
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
            0,
        )

    @staticmethod
    def _baselines_from_draft(
        draft: StreamDraftModel, expected_version: int
    ) -> _DraftBaselines:
        """Load the immutable baselines of an existing draft."""
        if expected_version != draft.version:
            raise DraftVersionConflict(DRAFT_VERSION_CONFLICT)
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
    def _normalize_noop(
        session: Session,
        draft: StreamDraftModel | None,
        expected_version: int,
        new_intent: DraftIntent,
        current_intent: DraftIntent,
    ) -> None:
        """Persist semantic normalisation without bumping the version."""
        if draft is None or new_intent.to_json() == current_intent.to_json():
            return
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

    @classmethod
    def _write_plan(
        cls,
        session: Session,
        prepared: _DraftEditContext,
        command: DraftCommandBase,
        plan_intent: DraftIntent,
    ) -> tuple[int, bool]:
        """Insert a new draft or conditionally update an existing one."""
        serialized = json.dumps(plan_intent.to_json(), separators=(",", ":"))
        if prepared.draft is None:
            session.add(
                StreamDraftModel(
                    stream_ref_id=prepared.ref.id,
                    baseline_snapshot_json=_dump_offers(prepared.baselines.offers),
                    baseline_bindings_json=_dump_bindings(prepared.baselines.bindings),
                    baseline_captured_at=prepared.baselines.captured_at,
                    staged_changes_json=serialized,
                    version=1,
                    is_dirty=plan_intent.has_changes,
                    is_stale=False,
                )
            )
            return 1, True
        result = session.execute(
            update(StreamDraftModel)
            .where(StreamDraftModel.id == prepared.draft.id)
            .where(StreamDraftModel.version == command.expected_version)
            .values(
                staged_changes_json=serialized,
                version=command.expected_version + 1,
                is_dirty=plan_intent.has_changes,
            )
        )
        if getattr(result, "rowcount", 0) != 1:
            raise DraftVersionConflict(DRAFT_VERSION_CONFLICT)
        return command.expected_version + 1, False

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
            self._normalize_noop(
                session,
                prepared.draft,
                command.expected_version,
                plan.intent,
                prepared.plan_context.intent,
            )
            session.commit()
            return DraftCommandResult(view=view, created=False, noop=True)
        new_version, created = self._write_plan(session, prepared, command, plan.intent)
        session.commit()
        return DraftCommandResult(
            view=replace(view, version=new_version),
            created=created,
            noop=False,
        )

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

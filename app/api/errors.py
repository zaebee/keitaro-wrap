"""HTTP error translation for the Slice 7 API."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.application.campaign_creation import (
    CampaignConfigurationError,
    CampaignInputError,
    IdempotencyKeyConflict,
    IdempotencyKeyReused,
    OperationNotFoundError,
)
from app.application.draft import DraftStaleError, DraftVersionConflict
from app.application.errors import (
    ConflictChangedError,
    ConflictResolutionInputError,
    StreamNotFoundError,
    UpstreamError,
)
from app.application.fetch import FetchInputError
from app.application.publication import (
    PublicationConflictError,
    PublicationGateError,
    PublicationInputError,
)
from app.domain.allocation import AllocationError
from app.domain.campaign_creation import InvalidOperationTransition
from app.domain.draft import DraftBaselineUnavailable, DraftInputError
from app.domain.reconciliation import ConflictDetail, RemoteOfferValidationError


class ApiError(Exception):
    """Transport-level error with a stable public code and structured details."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ):
        """Store the HTTP status, stable code, message and typed details."""
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)


def error_response(
    status: int, code: str, message: str, details: dict[str, Any] | None = None
) -> JSONResponse:
    """Build the stable error envelope used by every non-2xx response."""
    return JSONResponse(
        status_code=status,
        content={
            "error": {
                "code": code,
                "message": message,
                "details": details or {},
            }
        },
    )


def _conflict(item: ConflictDetail) -> dict[str, Any]:
    """Serialize one structured conflict without losing its fields."""
    return {
        "stream_ref": item.stream_ref,
        "offer_id": item.offer_id,
        "field": item.field,
        "expected": item.expected,
        "observed": item.observed,
        "reason": item.reason,
    }


def _api_error_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a transport ApiError to the stable envelope."""
    error = (
        exc if isinstance(exc, ApiError) else ApiError(500, "INTERNAL_ERROR", str(exc))
    )
    return error_response(error.status, error.code, error.message, error.details)


def _validation_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate FastAPI shape validation into INVALID_REQUEST."""
    errors = []
    if isinstance(exc, RequestValidationError):
        for item in exc.errors():
            errors.append(
                {
                    "loc": list(item.get("loc", ())),
                    "msg": str(item.get("msg", "")),
                    "type": str(item.get("type", "")),
                }
            )
    return error_response(
        422, "INVALID_REQUEST", "request validation failed", {"errors": errors}
    )


def _campaign_input_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate invalid campaign input to a typed 422."""
    return error_response(
        422, "CAMPAIGN_INPUT_REJECTED", str(exc), {"reason": str(exc)}
    )


def _campaign_configuration_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate unusable operator configuration to a typed 409."""
    return error_response(
        409, "CAMPAIGN_CONFIGURATION_INVALID", str(exc), {"reason": str(exc)}
    )


def _idempotency_reused_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a reused idempotency key to a typed 409."""
    key = exc.operation_uuid if isinstance(exc, IdempotencyKeyReused) else ""
    return error_response(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        str(exc),
        {"operation_uuid": key},
    )


def _idempotency_conflict_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a concurrent identity reservation conflict to a typed 409."""
    return error_response(409, "IDEMPOTENCY_KEY_CONFLICT", str(exc), {})


def _operation_not_found_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate an unknown campaign operation to a typed 404."""
    return error_response(404, "OPERATION_NOT_FOUND", str(exc), {})


def _stream_not_found_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate an unknown or cross-campaign stream to a typed 404."""
    if isinstance(exc, StreamNotFoundError):
        details: dict[str, Any] = {
            "campaign_id": exc.campaign_id,
            "stream_ref": exc.stream_ref,
        }
    else:
        details = {}
    return error_response(404, "STREAM_NOT_FOUND", str(exc), details)


def _version_conflict_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a stale draft version to a typed 409 with structured details."""
    details: dict[str, Any] = {}
    if isinstance(exc, DraftVersionConflict):
        for key in ("stream_ref", "expected_version", "current_version"):
            value = getattr(exc, key)
            if value is not None:
                details[key] = value
    return error_response(409, "DRAFT_VERSION_CONFLICT", str(exc), details)


def _stale_draft_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a sticky Fetch conflict into a typed 409 with all conflict details."""
    details: dict[str, Any] = {}
    if isinstance(exc, DraftStaleError):
        details = {
            "stream_ref": exc.stream_ref,
            "conflicts": [_conflict(item) for item in exc.conflicts],
        }
    return error_response(409, "DRAFT_STALE_CONFLICT", str(exc), details)


def _baseline_unavailable_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a missing immutable draft baseline to a typed 409."""
    return error_response(409, "DRAFT_BASELINE_UNAVAILABLE", str(exc), {})


def _publication_gate_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a durable publication gate to a typed 409."""
    return error_response(409, "PUBLICATION_UNRESOLVED", str(exc), {})


def _publication_conflict_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a concurrent publication change to a typed 409."""
    return error_response(409, "PUBLICATION_CONCURRENT_CHANGE", str(exc), {})


def _conflict_changed_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate a changed conflict token into a typed 409 with details."""
    details: dict[str, Any] = {}
    if isinstance(exc, ConflictChangedError):
        details = {
            "stream_ref": exc.stream_ref,
            "expected": exc.expected_fingerprint,
            "observed": exc.current_fingerprint,
        }
    return error_response(409, "DRAFT_CONFLICT_CHANGED", str(exc), details)


def _domain_rejection_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate domain and workflow input rejections to a typed 422."""
    return error_response(
        422, "DOMAIN_POLICY_REJECTION", str(exc), {"reason": str(exc)}
    )


def _upstream_handler(_: Request, exc: Exception) -> JSONResponse:
    """Translate an application-owned upstream failure to a typed 502."""
    details: dict[str, Any] = {}
    if isinstance(exc, UpstreamError):
        details = {"upstream": {"status": exc.status, "message": exc.message}}
    return error_response(502, "KEITARO_UPSTREAM_FAILURE", str(exc), details)


def _internal_handler(_: Request, exc: Exception) -> JSONResponse:
    """Return a safe 500 without leaking internal exception details."""
    return error_response(500, "INTERNAL_ERROR", "internal server error", {})


def register_error_handlers(app: FastAPI) -> None:
    """Register every stable error mapping on the FastAPI application."""
    app.add_exception_handler(ApiError, _api_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(CampaignInputError, _campaign_input_handler)
    app.add_exception_handler(
        CampaignConfigurationError, _campaign_configuration_handler
    )
    app.add_exception_handler(IdempotencyKeyReused, _idempotency_reused_handler)
    app.add_exception_handler(IdempotencyKeyConflict, _idempotency_conflict_handler)
    app.add_exception_handler(OperationNotFoundError, _operation_not_found_handler)
    app.add_exception_handler(StreamNotFoundError, _stream_not_found_handler)
    app.add_exception_handler(DraftVersionConflict, _version_conflict_handler)
    app.add_exception_handler(ConflictChangedError, _conflict_changed_handler)
    app.add_exception_handler(DraftStaleError, _stale_draft_handler)
    app.add_exception_handler(DraftBaselineUnavailable, _baseline_unavailable_handler)
    app.add_exception_handler(PublicationGateError, _publication_gate_handler)
    app.add_exception_handler(PublicationConflictError, _publication_conflict_handler)
    app.add_exception_handler(FetchInputError, _domain_rejection_handler)
    app.add_exception_handler(ConflictResolutionInputError, _domain_rejection_handler)
    app.add_exception_handler(DraftInputError, _domain_rejection_handler)
    app.add_exception_handler(PublicationInputError, _domain_rejection_handler)
    app.add_exception_handler(AllocationError, _domain_rejection_handler)
    app.add_exception_handler(InvalidOperationTransition, _domain_rejection_handler)
    app.add_exception_handler(RemoteOfferValidationError, _domain_rejection_handler)
    app.add_exception_handler(UpstreamError, _upstream_handler)
    app.add_exception_handler(Exception, _internal_handler)

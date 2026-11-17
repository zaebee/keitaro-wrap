"""HTTP API routes."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health():
    """Return service health status."""
    return {"status": "ok"}

"""Database session management."""

from typing import Any

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings


def create_database_engine(
    url: str = settings.DATABASE_URL,
    *,
    busy_timeout: float = settings.KEITARO_DB_BUSY_TIMEOUT,
    **options: Any,
) -> Engine:
    """Create an engine with finite SQLite lock and pool checkout waits."""
    engine_options: dict[str, Any] = {
        "echo": False,
        "connect_args": {"timeout": busy_timeout},
        "pool_timeout": busy_timeout,
    }
    engine_options.update(options)
    return create_engine(url, **engine_options)


engine = create_database_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_session():
    """Yield a database session."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()

import os
import subprocess
import sys

from sqlalchemy import create_engine, inspect

S4_TABLES = {
    "stream_refs",
    "remote_offer_snapshots",
    "stream_offer_bindings",
    "stream_drafts",
}


def test_alembic_upgrade_head(tmp_path):
    db_path = tmp_path / "test.db"
    db_url = f"sqlite:///{db_path}"
    env = {**os.environ, "DATABASE_URL": db_url}
    cwd = os.getcwd()

    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        check=True,
        env=env,
        cwd=cwd,
    )
    engine = create_engine(db_url)
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    assert "alembic_version" in tables
    assert "app_settings" in tables
    assert "campaign_creation_operations" in tables
    assert S4_TABLES.issubset(tables)

    binding_uniques = {
        item["name"]
        for item in inspector.get_unique_constraints("stream_offer_bindings")
    }
    assert "uq_stream_offer_bindings_pair" in binding_uniques
    binding_indexes = {
        item["name"] for item in inspector.get_indexes("stream_offer_bindings")
    }
    assert "ix_stream_offer_bindings_lifecycle" in binding_indexes
    draft_uniques = {
        item["name"] for item in inspector.get_unique_constraints("stream_drafts")
    }
    assert "uq_stream_drafts_stream" in draft_uniques

    # downgrade and upgrade again
    subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "base"],
        check=True,
        env=env,
        cwd=cwd,
    )
    assert not S4_TABLES.intersection(inspect(engine).get_table_names())
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        check=True,
        env=env,
        cwd=cwd,
    )
    assert S4_TABLES.issubset(inspect(engine).get_table_names())

import os
import subprocess
import sys

from sqlalchemy import create_engine, inspect


def test_alembic_upgrade_head(tmp_path):
    db_path = tmp_path / "test.db"
    db_url = f"sqlite:///{db_path}"
    env = {**os.environ, "DATABASE_URL": db_url}
    cwd = os.getcwd()

    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True, env=env, cwd=cwd)
    engine = create_engine(db_url)
    tables = inspect(engine).get_table_names()
    assert "alembic_version" in tables
    assert "app_settings" in tables

    # downgrade and upgrade again
    subprocess.run([sys.executable, "-m", "alembic", "downgrade", "base"], check=True, env=env, cwd=cwd)
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True, env=env, cwd=cwd)

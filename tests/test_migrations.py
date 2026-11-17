import os
from sqlalchemy import inspect

from app.db.base import Base
from app.db import models  # noqa
from app.db.session import engine


def test_tables_created():
    Base.metadata.create_all(bind=engine)
    insp = inspect(engine)
    assert "app_settings" in insp.get_table_names()

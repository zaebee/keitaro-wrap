from app.core.config import Settings


def test_settings_defaults():
    s = Settings(KEITARO_API_KEY="x")
    assert s.APP_PORT == 8000
    assert s.DATABASE_URL.startswith("sqlite")
    assert s.KEITARO_REDIRECT_URL == "https://www.google.com"
    assert s.KEITARO_ALLOW_PUBLICATION_WRITES is False
    assert s.KEITARO_DB_BUSY_TIMEOUT == 2.0

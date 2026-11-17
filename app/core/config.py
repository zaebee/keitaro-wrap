"""Application settings loaded from environment."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Typed application configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        env_parse_none_str="",
    )

    KEITARO_BASE_URL: str = "https://tlgk.host"
    KEITARO_API_KEY: str = ""
    KEITARO_TIMEOUT: float = 30.0
    KEITARO_DEFAULT_DOMAIN_ID: int | None = None
    KEITARO_DEFAULT_GROUP_ID: int | None = None
    KEITARO_DEFAULT_TRAFFIC_SOURCE_ID: int | None = None
    KEITARO_REDIRECT_URL: str = "https://www.google.com"
    # Slice 6 stays fail-closed until offers-only PUT preservation is verified live.
    KEITARO_ALLOW_PUBLICATION_WRITES: bool = False

    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    DATABASE_URL: str = "sqlite:///./keitaro_app.db"


settings = Settings()

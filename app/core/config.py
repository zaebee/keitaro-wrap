from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    KEITARO_BASE_URL: str = "https://tlgk.host"
    KEITARO_API_KEY: str = ""
    KEITARO_DEFAULT_DOMAIN_ID: int | None = None
    KEITARO_DEFAULT_GROUP_ID: int | None = None
    KEITARO_DEFAULT_TRAFFIC_SOURCE_ID: int | None = None

    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    DATABASE_URL: str = "sqlite:///./keitaro_app.db"


settings = Settings()

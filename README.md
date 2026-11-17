# Keitaro Wrap

FastAPI + SQLAlchemy application (Slice 0 foundation).

## Setup
1. Create virtualenv: `uv venv .venv && source .venv/bin/activate`
2. Install deps: `uv pip install -e ".[dev]"` or `pip install -r requirements.txt`
3. Copy env: `cp .env.example .env` and set `KEITARO_API_KEY`.
4. Run migrations: `alembic upgrade head`
5. Start app: `uvicorn app.main:app --reload`

## Tests
`pytest -q`

## Health
GET /health -> {"status": "ok"}

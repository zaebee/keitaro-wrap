# Keitaro Wrap

FastAPI + SQLAlchemy application (Slice 0 foundation).

## Setup

1. Install [uv](https://docs.astral.sh/uv/).
2. Sync the project and development tools:

   ```bash
   uv sync
   ```

   This creates/uses `.venv` and installs the locked dependencies from `uv.lock`.
3. Copy env: `cp .env.example .env` and set `KEITARO_API_KEY`.
4. Run migrations: `uv run alembic upgrade head`
5. Start app: `uv run uvicorn app.main:app --reload`

`requirements.txt` is a compatibility shim for pip users and installs the runtime package only
(`pip install -r requirements.txt`); development tools are installed with `uv sync`.
uv is the canonical workflow.

## Lockfile policy

- `uv.lock` is committed and CI uses `uv sync --locked`.
- Update dependencies with `uv add`/`uv remove` or `uv lock --upgrade`, then commit `pyproject.toml` and `uv.lock` together.
- Do not edit `uv.lock` by hand.

## Checks

Run the full local verification suite:

```bash
make check
```

Individual targets:

- `make format` — format code with Ruff.
- `make format-check` — verify formatting without modifying files.
- `make lint` — run Ruff checks.
- `make type-check` — run Pyrefly.
- `make pytest` — run the test suite.
- `make coverage` — run tests with coverage (source: `app`, fail-under: 64%).
- `make coverage-html` — write an HTML coverage report to `htmlcov/`.
- `make doc-coverage` — run docstring coverage (source: `app`, fail-under: 100%).
- `make all-checks` — alias for `make check`.

## Interpreting results

- **Coverage**: measured against the `app` package with branch coverage. The initial gate is 64%, matching the current measured baseline. New code should not reduce coverage below this threshold; raise the threshold as coverage improves.
- **Docstring coverage**: measured against maintained application code in `app/` (init modules and generated/migration files are excluded). The initial gate is 100%.
- **Type checking**: Pyrefly checks `app/` and `tests/` with no baseline file; any new type error fails the gate.
- **Formatting**: CI runs `ruff format --check` and fails if files would be reformatted.

## Tests

```bash
uv run pytest -q
```

## Health

GET /health -> {"status": "ok"}

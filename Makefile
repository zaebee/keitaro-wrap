.PHONY: help format format-check lint type-check pytest coverage coverage-html doc-coverage check all-checks

help:
	@echo "Keitaro Wrap quality checks"
	@echo ""
	@echo "Targets:"
	@echo "  make format          - Format Python code with Ruff"
	@echo "  make format-check    - Verify Python formatting with Ruff"
	@echo "  make lint            - Run Ruff lint checks"
	@echo "  make type-check      - Run Pyrefly type checks"
	@echo "  make pytest          - Run test suite"
	@echo "  make coverage        - Run tests with coverage"
	@echo "  make coverage-html   - Run tests with HTML coverage report"
	@echo "  make doc-coverage    - Run docstring coverage checks"
	@echo "  make check           - Run all Python verification checks"
	@echo "  make all-checks      - Alias for all checks"

format:
	uv run ruff format .

format-check:
	uv run ruff format --check .

lint:
	uv run ruff check .

type-check:
	uv run pyrefly check

pytest:
	uv run pytest -q

coverage:
	uv run pytest --cov=app --cov-branch --cov-report=term-missing -q

coverage-html:
	uv run pytest --cov=app --cov-branch --cov-report=html -q

doc-coverage:
	uv run interrogate app

check: format-check lint type-check coverage doc-coverage

all-checks: check


up:
	@echo "Starting backend (8000) and frontend (5173)..."
	@trap 'kill 0' EXIT; uv run uvicorn app.main:app --reload --port 8000 & cd frontend && bun run dev

down:
	@echo "Stop processes manually (Ctrl+C in the terminal running make up)."

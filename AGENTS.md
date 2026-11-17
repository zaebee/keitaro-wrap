# AGENTS.md — repository guidance for coding agents

This file is operating guidance for contributors and coding agents, not a specification.
The canonical documents below are the source of truth. If they conflict with each other
or with an owner decision, flag the conflict rather than silently choosing one.

## 1. Orientation

Keitaro Wrap is a modular monolith: a FastAPI app with minimal local state that wraps the
Keitaro Admin API for campaign creation and offer editing. Python 3.12, uv, SQLite +
Alembic, Ruff, Pyrefly, pytest. Slices 0 (foundation), 1 (Keitaro client), 2
(allocation domain), 3 (campaign creation), 4 (Fetch/reconciliation) and 5
(local draft editing) are implemented; later slices are planned, not present —
check the docs and `git log` before assuming a capability exists.

Code map:

- `app/main.py` — FastAPI app, lifespan, composition root (wires the HTTP client).
- `app/api/` — HTTP transport (routes/schemas).
- `app/application/` — workflows (campaign creation, Fetch, local draft editing),
  DTOs and ports.
- `app/domain/` — pure domain logic (allocation, operation state machine, offer
  reconciliation, staged draft planning); no I/O.
- `app/core/` — settings from `.env`.
- `app/db/`, `alembic/` — SQLAlchemy models, repositories, sessions and migrations,
  including stream refs, remote offer snapshots, committed bindings and durable
  staged drafts with immutable offer/binding baselines.
- `app/keitaro_client/` — HTTP adapter implementing the Keitaro port.
- `tests/` — unit and mocked-HTTP contract tests.

## 2. Canonical documents (read before changing related code)

| Topic | Source of truth |
|---|---|
| Architecture, data ownership, reconciliation | `docs/architecture.md` |
| Module boundaries and dependency direction | `docs/implementation/module-boundaries.md` |
| Implementation slices, gates, retry/recovery mapping | `docs/implementation/implementation-plan.md` |
| Domain model, entities, invariants, state dimensions | `docs/spec/domain-model.md`, `docs/discovery/domain-analysis.md` |
| Offer allocation (LRM, tie-break, edge seams) | `docs/spec/offer-allocation.md` |
| Campaign creation workflow | `docs/spec/campaign-creation.md` |
| Campaign editor workflow (video-supported core) | `docs/spec/campaign-editor.md` |
| Persistence model, drafts, publication, recovery | `docs/architecture/persistence.md` |
| Accepted / proposed / open decisions | `docs/decisions.md` |
| Test scenarios and acceptance criteria | `docs/test-plan.md` |
| Keitaro API observations and OpenAPI snapshot | `docs/discovery/keitaro-api.md`, `docs/openapi.json` |
| Setup and check commands | `README.md`, `Makefile` |

Do not duplicate detailed business rules from these documents into code comments, this
file, or new docs; update the canonical document and link to it instead.

## 3. Architecture constraints

Preserve these unless the assigned task explicitly changes them:

- Dependency direction: API/transport → application → pure domain. Adapters implement
  application-owned ports; the composition root wires adapters. Keep the domain free of
  I/O, FastAPI, SQLAlchemy and Keitaro client dependencies.
- D13 (accepted): async `httpx.AsyncClient`, async adapter methods, FastAPI
  lifespan-managed client lifecycle; no sync calls in async request paths.
- D14 (accepted): synchronous SQLAlchemy is used; sync DB operations must not run
  directly on the event loop in async request paths — use a threadpool or an explicit
  boundary.
- Keitaro remains the external source of truth where specified. Do not invent API
  behavior: verified vs unverified behavior is recorded in `docs/discovery/keitaro-api.md`
  and `docs/openapi.json`; unresolved questions are decision gates, not facts.
- Fetch is read-only: remote reads happen outside DB transactions; one snapshot is
  reconciled atomically; the remote snapshot cache, committed bindings and staged draft
  state remain separate.
- Draft editing is local only: staging never mutates Keitaro, committed bindings or the
  remote snapshot cache; one command is one version-checked DB transaction.

## 4. Accepted vs proposed/open decisions

- Accepted: D1–D3, D8–D22 in `docs/decisions.md` (modular monolith, SQLite/Alembic,
  Keitaro as source of truth, unique binding with explicit duplicate failure, pin
  preservation on reappearance, committed vs staged separation, LRM allocation, offer_id
  tie-break, async HTTP, sync persistence with an event-loop boundary, `default` offer
  flow, configurable redirect URL, sticky Fetch conflicts, per-stream independence,
  auto-pin on manual share, integer share input, surfaced allocation policy cases and
  stale-draft edit blocking with local Cancel).
  D8/D9 and the Fetch decisions were approved in issue #29; D19–D22 in issue #31.
- Proposed or open: D4–D7 and the remaining decision gates in
  `docs/implementation/implementation-plan.md`. The editor's video-supported core is
  usable; edge cases marked provisional or unresolved are not settled product decisions.
- Never resolve an open product/contract decision by implication while implementing a
  slice. Surface the question and wait for owner approval.

## 5. Working and scope rules

- Implement only the slice or issue explicitly assigned. Do not pull later-slice
  behavior into an earlier slice.
- Do not resolve open product/contract decisions without owner approval; report API
  uncertainties, assumptions and owner decisions separately from completed work.
- Never blindly retry mutating Keitaro requests. Ambiguous POST/PUT outcomes follow the
  documented reconciliation policy; keep the operation ambiguous when the outcome
  cannot be established (`docs/architecture.md`, `docs/architecture/persistence.md`).
- Do not change migrations, dependencies (including `uv.lock`), public contracts or
  architecture boundaries without a task-specific reason.
- Never commit secrets or real credentials; `.env` is ignored, `.env.example` is the
  template.

## 6. Verification workflow

- Set up with `uv sync --locked` (CI uses the locked sync); never hand-edit `uv.lock`.
- Run `make check` before reporting completion. It runs format-check, Ruff lint,
  Pyrefly type-check, pytest with coverage, and docstring coverage. Individual targets
  are listed in `README.md` / `Makefile`.
- Iterate with targeted tests, but do not weaken gates or skip new tests/docstrings for
  new code. If a check is not run, say which one and why; report test results and the
  final HEAD SHA.

## 7. PR discipline

- Use English for PR titles/bodies, issues and review comments; chat with the repository
  owner is in Russian.
- Keep PRs focused and traceable to the assigned issue; for documentation-only changes,
  state explicitly that no application behavior, dependencies, migrations or CI changed.
- Do not merge unless explicitly authorized by the owner.
- Report API uncertainties, assumptions and owner decisions separately from the work
  completed, and flag any conflict between this file and a canonical specification.

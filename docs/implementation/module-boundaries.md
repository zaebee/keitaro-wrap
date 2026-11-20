# Module boundaries (IMPLEMENTATION-001)

## Dependency direction
Transport (FastAPI routes) → Application services → Domain (pure).
Adapters (Keitaro client, persistence repositories) implement application-owned ports.
Composition root wires dependencies. Domain remains pure and independent of I/O abstractions.

## Modules

### config
- Owns: settings from .env.
- Must not own: business logic.

### domain
- Owns: entities, invariants, allocation (LRM).
- Pure Python, no I/O, no ports.

### application
- Owns: workflows, orchestration, and ports/interfaces (KeitaroClientPort, repositories).
- Depends on domain + ports. Does not depend on adapters.

### keitaro_client (adapter)
- Owns: HTTP transport, auth, DTOs, safe read retries.
- Implements KeitaroClientPort.

### persistence (adapter)
- Owns: SQLAlchemy models, repositories, migrations.
- Implements repository ports.

### api (transport)
- Owns: routes, request/response schemas, dependency providers and HTTP error translation.
- Depends on application services and application-owned errors; never calls repositories or the Keitaro client directly.
- Publishes only allowlisted DTO projections; internal recovery evidence stays in application/persistence.

### frontend (implemented S8)
- Owns: browser UI, user input state, URL/session-scoped operation identity, advisory publication recovery lock and allowlisted server-view rendering.
- Depends on: generated wrapper OpenAPI client/types and the stable error envelope from the API transport only.
- Never imports `app/domain`, `app/application`, the Keitaro client, SQLAlchemy or the local database.
- Never reimplements allocation, publication eligibility, reconciliation, retry/recovery or draft-version rules; derives no authoritative server state optimistically.
- Live publication writes stay fail-closed. The Push endpoint exists in the runtime API, but the UI exposes no Push control and does not call it (`KEITARO_ALLOW_PUBLICATION_WRITES=false`).
- Setup, contract map and test commands live in `frontend/README.md`; S8 test coverage lives in `docs/test-plan.md`.

## Rules
- Application owns ports; adapters implement them.
- Domain independent of transport/persistence/I/O.
- Composition root wires adapters to application.

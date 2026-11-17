# Module boundaries (IMPLEMENTATION-001)

## Layers and dependency direction
Domain (pure) -> Application services -> Adapters (Keitaro client, persistence) -> Transport (FastAPI routes).

Domain must not depend on FastAPI, SQLAlchemy, or Keitaro transport. Adapters implement ports defined by application/domain.

## Modules

### config
- Owns: settings from .env (KEITARO_BASE_URL, API_KEY, defaults).
- Must not own: business logic.

### domain
- Owns: entities (CampaignRef, StreamRef, StreamOfferBinding, LocalDraft, PublicationOperation), invariants, allocation algorithm (LRM).
- Pure Python, no I/O.

### application
- Owns: campaign creation workflow, Fetch/reconciliation, draft editing, Push orchestration, recovery.
- Depends on domain + ports (KeitaroClientPort, repositories).
- Must not own: HTTP/DB details.

### keitaro_client (adapter)
- Owns: HTTP transport, auth, DTO mapping, retries for safe reads.
- Implements KeitaroClientPort.

### persistence (adapter)
- Owns: SQLAlchemy models, repositories, Alembic migrations.
- Implements repository ports.
- Must not own: domain rules.

### api (transport)
- Owns: FastAPI routes, request/response schemas, HTTP error mapping.
- Depends on application.

### frontend (optional)
- Owns: UI; calls API.

## Ownership rules
- Remote IDs are references; no full Keitaro mirror.
- Wrapper-owned state: bindings, drafts, publication ops.
- Domain logic independent of transport/persistence.
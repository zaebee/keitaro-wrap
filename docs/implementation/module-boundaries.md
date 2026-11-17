# Module boundaries (IMPLEMENTATION-001)

## Dependency direction
Transport (FastAPI routes) → Application services → Domain (pure).
Adapters (Keitaro client, persistence repositories) implement application/domain ports.
Composition root wires dependencies. Domain has no dependencies on FastAPI, SQLAlchemy, or Keitaro transport.

## Modules

### config
- Owns: settings from .env.
- Must not own: business logic.

### domain
- Owns: entities, invariants, allocation (LRM).
- Pure Python, no I/O.

### application
- Owns: workflows, orchestration, ports (interfaces).
- Depends on domain + ports.

### keitaro_client (adapter)
- Owns: HTTP transport, auth, DTOs, safe retries.
- Implements KeitaroClientPort.

### persistence (adapter)
- Owns: SQLAlchemy models, repositories, migrations.
- Implements repository ports.

### api (transport)
- Owns: routes, schemas, HTTP errors.
- Depends on application.

### frontend (optional)
- Owns: UI; calls API.

## Rules
- Domain independent of transport/persistence.
- Application depends on domain and ports, not adapters.
- Adapters implement ports; composition root wires.
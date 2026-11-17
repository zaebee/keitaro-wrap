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
- Owns: routes, schemas, HTTP errors.
- Depends on application.

### frontend (optional)
- Owns: UI; calls API.

## Rules
- Application owns ports; adapters implement them.
- Domain independent of transport/persistence/I/O.
- Composition root wires adapters to application.

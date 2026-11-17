# Decision log

| ID | Decision | Status | Rationale |
|---|---|---|---|
| D1 | Modular monolith over microservices | Accepted | Take-home scope |
| D2 | SQLite + Alembic | Accepted | Simple, migrations required |
| D3 | Keitaro as source of truth; minimal local operational state | Accepted | Avoid duplicating tracker data; operation state for recovery |
| D4 | Partial failure → operation state + reconciliation, no blind retry of POST | Proposed | API not transactional; ambiguous outcomes possible |
| D5 | Editor core workflow (stage/push/cancel, archive, pinning) | Proposed (video-supported core) | Demo video 2026-11-17; edge cases remain provisional |
| D6 | Resource IDs are operator-configured defaults, not arbitrary first-active | Proposed | Aligns with assignment (configured domain/group/source) |
| D7 | Snapshot-based drafts over event log | Proposed | Proportionate for take-home; deterministic; simpler |
| D8 | (stream_ref, offer_id) unique binding proposed | Proposed | One logical binding per pair; archive changes lifecycle |
| D9 | Pin survives archive/reactivation | Proposed (open owner decision) | Wrapper-owned preference |
| D10 | Committed vs staged separation | Accepted | Prevents draft overwriting committed state |
| D11 | Largest Remainder Method for allocation | Accepted | Deterministic integer allocation |
| D12 | Deterministic offer_id tie-break for LRM | Accepted | Stable allocation |
| D13 | HTTP client transport | Accepted | Use httpx.AsyncClient; async methods; FastAPI lifespan manages client; async tests; no sync calls in async path. Persistence async is separate decision. |
| D14 | Persistence SQLAlchemy sync vs async | Proposed (provisional) | Slice 0 uses sync SQLAlchemy for simplicity; async persistence remains separate owner decision (D13 covers HTTP only) |

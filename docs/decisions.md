# Decision log

| ID | Decision | Status | Rationale |
|---|---|---|---|
| D1 | Modular monolith over microservices | Accepted | Take-home scope |
| D2 | SQLite + Alembic | Accepted | Simple, migrations required |
| D3 | Keitaro as source of truth; minimal local mirror | Accepted | Avoid duplicating tracker data |
| D4 | Partial failure → partial status + retry, no auto-delete | Proposed | API not transactional |
| D5 | Equal rebalance with remainder to first offers | Proposed | Until video confirms |
EOF
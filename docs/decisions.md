# Decision log

| ID | Decision | Status | Rationale |
|---|---|---|---|
| D1 | Modular monolith over microservices | Accepted | Take-home scope |
| D2 | SQLite + Alembic | Accepted | Simple, migrations required |
| D3 | Keitaro as source of truth; minimal local operational state | Accepted | Avoid duplicating tracker data; operation state for recovery |
| D4 | Partial failure → operation state + reconciliation, no blind retry of POST | Proposed | API not transactional; ambiguous outcomes possible |
| D5 | Equal rebalance with remainder to first offers | Proposed (provisional) | Pending video review |
| D6 | Resource IDs are operator-configured defaults, not arbitrary first-active | Proposed | Aligns with assignment (configured domain/group/source) |
EOF
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
| D8 | (stream_ref, offer_id) unique binding; duplicate remote offer ids fail the whole Fetch explicitly | Accepted (owner, issue #29) | One logical binding per pair; archive changes lifecycle; no silent deduplication or occurrence-based identity |
| D9 | Pin survives archive/reactivation | Accepted (owner, issue #29, option A) | Wrapper-owned preference survives remote disappearance |
| D10 | Committed vs staged separation | Accepted | Prevents draft overwriting committed state |
| D11 | Largest Remainder Method for allocation | Accepted | Deterministic integer allocation |
| D12 | Deterministic offer_id tie-break for LRM | Accepted | Stable allocation |
| D13 | HTTP client transport | Accepted | Use httpx.AsyncClient; async methods; FastAPI lifespan manages client; async tests; no sync calls in async path. Persistence async is separate decision. |
| D14 | Persistence SQLAlchemy sync vs async | Accepted | Slice 0 uses sync SQLAlchemy. Constraint: sync SQLAlchemy operations must not run directly on async event loop; use FastAPI threadpool for sync endpoints or explicit boundary. Async persistence remains separate decision. |
| D15 | Offer flow type `default` for campaign creation | Accepted | Owner decision in issue #26: forced GEO flow precedes the default fallback; `regular` is not used for this two-flow configuration. |
| D16 | Configurable redirect destination, `https://www.google.com` by default | Accepted | Owner decision in issue #26: setting `KEITARO_REDIRECT_URL`; no UI work authorized in Slice 3. |
| D17 | Fetch conflict markers are sticky until explicit resolution in a later slice | Accepted (owner, issue #29, option A) | A repeated Fetch, including one where remote returns to the old baseline, must not silently clear a conflict |
| D18 | Fetch reconciles every offer-bearing stream independently; a non-empty offers array (not stream type) defines offer-bearing | Accepted (owner, issue #29) | Plan already says fetch all streams; persistence is keyed per stream; no designated target or selection policy |
| D19 | Manual share edit automatically pins the offer; explicit Unpin returns it to redistribution | Accepted (owner, issue #31, option A) | Keeps a manually chosen share fixed across later redistribution |
| D20 | Manual share input is an integer in 0..100 inclusive; bool is not an integer; invalid values are rejected before any DB write | Accepted (owner, issue #31, option A) | Matches the integer allocator and observed Keitaro share field; 0 is valid and distinct from archive |
| D21 | Staging allows zero/one active offers, all-pinned states and unallocated remainders; `policy_cases`/`unallocated` are surfaced in `DraftView`; `pinned_sum > 100` stays invalid | Accepted (owner, issue #31, option B) | Publication eligibility for unresolved cases is a Slice 6 decision, not an S5 policy |
| D22 | Editing commands are blocked on a stale/conflicted draft; local Cancel is allowed and preserves sticky conflict data unchanged | Accepted (owner, issue #31, option B) | D17 conflicts are never silently resolved; Cancel is local discard only |

# Implementation plan (IMPLEMENTATION-001)

## Goal
Dependency-ordered vertical slices with clear boundaries. Docs-only.

## Dependency order (implementation)
```mermaid
flowchart TD
  S0[Slice 0: Foundation] --> S1[Slice 1: Keitaro client]
  S0 --> S2[Slice 2: Allocation domain]
  S1 --> S3[Slice 3: Campaign creation]
  S1 --> S4[Slice 4: Fetch/reconciliation]
  S2 --> S4
  S4 --> S5[Slice 5: Draft editing]
  S5 --> S6[Slice 6: Push/Cancel/recovery]
```
Notes: Campaign creation does not depend on allocation. Fetch/reconciliation depends on Keitaro client and allocation domain (bindings), not on campaign creation.

## Slices

### Slice 0 — Foundation (bootstrap + persistence scaffolding)
- Capability: app starts, DB initialized, settings loaded, health.
- Modules: config, persistence bootstrap (engine/session), Alembic initial migration (infrastructure only), api health, composition root.
- Prerequisites: none.
- Persistence/API: bootstrap DB + settings table. Do not introduce domain tables/constraints that settle unresolved duplicate-binding policy yet.
- Tests: migration smoke, settings load, health.
- Failure cases: missing .env, invalid DB path.
- Completion: `alembic upgrade head` ok, `/health` ok.

### Slice 1 — Keitaro client
- Capability: typed HTTP client for domains/groups/sources/offers/campaigns/streams + discovery.
- Modules: keitaro_client adapter, DTOs.
- Prerequisites: Slice 0.
- Tests: contract tests (mocked HTTP), error mapping.
- Failure cases: 401, 404, timeout, 422.
- Completion: client methods covered by tests.

### Slice 2 — Allocation domain (pure)
- Capability: LRM allocation with offer_id tie-break, pinning, validation.
- Modules: domain allocation service.
- Prerequisites: none (pure).
- Tests: property/table-driven allocation.
- Failure cases: pinned_sum > 100, zero unpinned.
- Completion: deterministic allocation tests pass.

### Slice 3 — Campaign creation workflow
- Capability: create campaign with two flows, partial failure/reconciliation.
- Modules: application campaign service, operation persistence.
- Prerequisites: Slices 0-1 (not allocation).
- Persistence: CampaignCreationOperation states.
- Tests: partial failure, reconciliation (0/1/>1), ambiguous handling.
- Failure cases: timeout, 422, ambiguous POST.
- Completion: end-to-end campaign creation with recovery.

### Slice 4 — Fetch/reconciliation
- Capability: fetch all streams, reconcile remote offers into bindings, detect conflicts.
- Modules: application fetch service.
- Prerequisites: Slices 0-2 (client + allocation domain for binding invariants).
- Tests: remote add/remove/reappear/share change, conflict detection, no silent overwrite.
- Completion: Fetch updates committed cache and marks conflicts.

### Slice 5 — Local draft editing
- Capability: stage add/remove/restore/pin/share; Cancel restores committed.
- Modules: application draft service, persistence draft repo.
- Prerequisites: Slice 4.
- Tests: staging without mutation, cancel, restart durability, optimistic concurrency.
- Completion: drafts durable and isolated.

### Slice 6 — Push/Cancel/recovery
- Capability: batch Push per stream, partial success, ambiguous reconciliation, per-stream Cancel, startup recovery.
- Modules: application publication service.
- Prerequisites: Slices 4-5.
- Tests: partial Push, ambiguous retry rules, startup recovery, Cancel after partial.
- Completion: recovery without blind retries.

## Decision gates (open unless resolved)
| Question | Status | Implementation impact |
|---|---|---|
| pinned_sum > 100% | confirmed invalid | Safely deferred (validation already specified) |
| active total == 100%? | open | Provisional seam (S6) |
| empty offers array | open | Safely deferred (S3/S6) |
| manual share implies pinning? | open | Provisional seam (S5) |
| pin preservation on reappear | open | Provisional seam (S4) |
| duplicate bindings | open | Provisional seam (S4/S5) |
| zero/one active offers | open | Provisional seam (S2/S6) |
| all-pinned remainder | open | Provisional seam (S2/S6) |
| manual pinned-share changes | open | Provisional seam (S5) |
| duplicate archived offers | open | Provisional seam (S4/S5) |
| remote share changes during draft | open | Provisional seam (S4/S5) |
| Cancel after partial Push | open | Provisional seam (S6) |
| multiple offer-bearing streams | open | Provisional seam (S4/S5/S6) |
| flow type/priority | open | Blocking (S3) |
| Google destination fixed/configurable | open | Blocking (S3) |

## Retry safety
- Automatic retries may be used for safe read-only requests.
- Mutating requests must follow publication/reconciliation policy; never blindly retry ambiguous POST/PUT outcomes.

## Recovery mapping
- Restart during in-progress publication: Slice 6 startup reconciliation.
- Partial Push: Slice 6 per-stream outcomes.
- Ambiguous HTTP outcome: reconciliation before retry (Slices 3/6).
- Incomplete reconciliation: bounded retries, ambiguous if unresolved.
- Remote changes during draft: conflict detection in Slice 4/5.
- Retry authorization: only after absence confirmed.

## Diagrams

Runtime lifecycle:
```mermaid
sequenceDiagram
  participant U as User
  participant A as App
  participant K as Keitaro
  U->>A: Fetch Streams
  A->>K: GET campaigns/streams
  A->>A: reconcile + update committed cache
  U->>A: stage edits (draft)
  U->>A: Push
  A->>K: PUT streams (per stream)
  A->>A: commit/reconcile/recover
```

## Acceptance
- Traceable to merged docs.
- First slice identifiable.
- Module responsibilities unambiguous.
- Decision gates explicit.
- Failure/restart/partial publication represented.
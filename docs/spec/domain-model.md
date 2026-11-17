# Domain model (SPEC-001)

Cross-reference: persistence design in PERSIST-001 (`docs/architecture/persistence.md`).

## Entities and ownership

### CampaignRef (remote reference)
- keitaro_campaign_id (remote), alias, name (cached).
- Ownership: Keitaro. Wrapper stores reference + local operations.

### StreamRef (remote reference)
- keitaro_stream_id, campaign_id, type, schema, action_type, action_payload, filters (cached snapshot).
- Ownership: Keitaro. Wrapper caches for reconciliation.

### StreamOfferBinding (wrapper-owned committed state)
- id, stream_ref, offer_id
- lifecycle: ACTIVE | ARCHIVED
- is_pinned: bool
- last_remote_share (cache)
- timestamps
- Invariant: lifecycle and is_pinned independent.

### RemoteSnapshot (cache)
- stream_ref, offer array {offer_id, share, state}, captured_at.

### LocalDraft (wrapper-owned staged state)
- stream_ref (unique), baseline_snapshot, staged_snapshot (nullable), version (wrapper-side), is_dirty, timestamps.
- Does not overwrite committed binding state until Push commits.

### PublicationOperation (wrapper-owned)
- id, stream_ref, status, attempt_count, correlation_marker, payload, baselines, error, timestamps.

## State dimensions (three independent)
1. Remote state (Keitaro truth).
2. Committed wrapper state (binding lifecycle/pin).
3. Local draft state (staged changes).
4. Publication state (operation history/outcome) — durable per stream.

## Invariants
- Committed state ≠ staged state; draft never silently overwrites committed binding.
- Archived binding effective share 0 in draft; omitted from remote on successful Push.
- Pinning preserved across archive/reactivation (proposed; owner decision open).
- One draft per stream.
- Publication outcomes independent per stream in batch.

## Unresolved (owner decisions)
- Pin preservation on reappearance.
- Manual share edit implies pinning?
- Push requires active total == 100%?
- Empty offers array accepted?
- Duplicate bindings supported?
EOF
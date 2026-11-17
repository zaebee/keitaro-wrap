# Domain model (SPEC-001)

## Entities and ownership

### CampaignRef (remote reference)
- keitaro_campaign_id (remote), alias, name (cached).
- Ownership: Keitaro. Wrapper stores reference + local operations.

### StreamRef (remote reference)
- keitaro_stream_id, campaign_id, type, schema, action_type, action_payload, filters (cached snapshot).
- Ownership: Keitaro. Wrapper caches for reconciliation.

### StreamOfferBinding (wrapper-owned committed state)
- id, stream_ref, offer_id
- lifecycle: ACTIVE | ARCHIVED (committed)
- is_pinned: bool (committed)
- last_remote_share (cache)
- timestamps
- Invariant: lifecycle and is_pinned independent.

### RemoteSnapshot (cache)
- stream_ref, offer array {offer_id, share, state}, captured_at.

### LocalDraft (wrapper-owned staged state)
- stream_ref (unique), baseline_snapshot, staged_changes (additions, archives, restores, pin toggles, share edits), version (wrapper-side optimistic concurrency), is_dirty, timestamps.
- Does not overwrite committed binding state until Push commits.

### PublicationOperation (wrapper-owned)
- id, stream_ref, status, attempt_count, correlation_marker, payload, baselines, error, timestamps.

## State dimensions (four independent)
1. Remote state (Keitaro truth).
2. Committed wrapper state (binding lifecycle/pin).
3. Local draft state (staged changes).
4. Publication state (operation history/outcome).

## Invariants
- Committed state ≠ staged state; draft never silently overwrites committed binding.
- Archived binding effective share 0 in staged view; omitted from remote on successful Push.
- Pinning preserved across archive/reactivation (proposed; owner decision open).
- One draft per stream.
- Publication outcomes independent per stream in batch.

## Allocation inputs/authority
- Pinned shares (committed wrapper state) are fixed inputs.
- Remote share changes discovered by Fetch update baseline/cache, not staged shares; conflicts marked.
- Missing/reappearing offers handled via reconciliation (archive/reactivate).
- All-pinned and single-pinned cases per offer-allocation.md (some unresolved).

## Unresolved (owner decisions)
- Pin preservation on reappearance.
- Manual share edit implies pinning?
- Push requires active total == 100%?
- Empty offers array accepted?
- Duplicate bindings supported?

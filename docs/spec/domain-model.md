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
- Accepted D8 (#29): one binding per (stream_ref, offer_id); a duplicate remote offer id fails the whole Fetch explicitly.
- Accepted D9 (#29): `is_pinned` survives archive/reactivation.

### RemoteSnapshot (cache)
- stream_ref, offer array {offer_id, share, state, position}, captured_at.
- Distinct from `StreamDraft.baseline_snapshot`: the remote cache is the last observed remote state, while the draft baseline is a separate staged-side point in time. Fetch never copies one into the other.

### LocalDraft (wrapper-owned staged state)
- stream_ref (unique), baseline_snapshot (immutable remote offer array), baseline_bindings (immutable committed lifecycle/pin snapshot at creation), staged_changes (additions, archives, restores, pin toggles, share edits), version (wrapper-side optimistic concurrency), is_dirty, is_stale, conflict_details (nullable), timestamps.
- Naming: LocalDraft corresponds to StreamDraft in persistence.md; fields identical.
- The staged view is derived from the two baselines plus staged intent, never from mutable current bindings; a later Fetch may mark the draft stale but must not rewrite either baseline.
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
- Pinning preserved across archive/reactivation (accepted D9, issue #29).
- Conflicts from Fetch are sticky until explicit resolution in a later slice (accepted D17, issue #29).
- One draft per stream.
- Publication outcomes independent per stream in batch.

## Allocation inputs/authority
- Pinned shares are fixed inputs to `allocate()`. In a staged view they are the baseline committed pins overlaid with staged pin intent; a manual share edit also pins that offer (D19) until an explicit Unpin.
- Zero/one active offers, all-pinned states and unallocated remainders are allowed while staging and surfaced as `policy_cases`/`unallocated` (D21). Publication eligibility is a Slice 6 decision.
- Remote share changes discovered by Fetch update the remote cache/baseline only, not staged shares; conflicts are marked against the draft's own baseline.
- Missing/reappearing offers handled via reconciliation (archive/reactivate); every offer-bearing stream is independent (accepted D18, issue #29).
- All-pinned and single-pinned cases are surfaced while staging per offer-allocation.md; publication eligibility is resolved by D23/D24 and applied by Slice 6 publication.

## Resolved and unresolved publication decisions
- Resolved by owner in issue #33: D23 (Push requires active total exactly 100), D24 (empty offers rejected until live verification) and D25 (reconcile-first Cancel, with absence evidence required for `failed`).
- Duplicate bindings beyond the accepted Fetch rejection rule (later slices).
- Unverified API behavior: offers-only PUT preservation of non-offer stream fields; live writes remain fail-closed.

Resolved by owner in issue #29: pin preservation on reappearance (D9), duplicate remote ids and binding uniqueness (D8), multiple offer-bearing streams (D18), fetch conflict lifecycle (D17).
Resolved by owner in issue #31: manual share auto-pin (D19), integer share input (D20), surfacing allocation edge cases while staging (D21), stale-draft edit blocking with local Cancel (D22).

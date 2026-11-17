# Offer allocation specification

## Algorithm: Largest Remainder Method (accepted D11/D12)
Given active offers with pinned shares:
- pinned_total = sum(pinned shares)
- remaining = 100 - pinned_total (if negative → validation error, block Push)
- unpinned_count = number of active unpinned offers
- if unpinned_count == 0: each unpinned gets 0 (if remaining > 0, unresolved whether block)
- base = floor(remaining / unpinned_count)
- remainder = remaining - base * unpinned_count
- distribute remainder +1 to first `remainder` unpinned offers in stable order (by offer_id ascending).

Tie-break: offer_id ascending only (single deterministic rule).

## Worked example
Pinned offer A = 25%. Remaining 75% across 3 unpinned (B,C,D): base 25, remainder 0 → 25/25/25. Total 100.

If remaining 76 across 3: base 25, remainder 1 → B=26, C=25, D=25.

## Edge cases
Slice 5 does not choose Push policy. Staging allows these states and returns `policy_cases`/`unallocated` in `DraftView` (D21); Slice 6 must validate publication eligibility explicitly.
- Zero active offers: surface `NO_ACTIVE_OFFERS`; the allocator keeps its current behaviour.
- One active offer: surface `SINGLE_ACTIVE_OFFER`; the allocator keeps its current behaviour.
- All pinned: total = 100 is valid; total < 100 surfaces `UNALLOCATED_REMAINDER`.
- Any unallocated remainder is surfaced explicitly, never silently normalised or discarded.
- Pinned total > 100: hard validation error, rejected before any write (confirmed).
- Duplicate offers: rejected for Fetch by D8; later-slice UI selection policy remains open.

## Redistribution triggers
- Add offer (unpinned): redistribute unpinned.
- Remove (archive): redistribute unpinned.
- Restore: redistribute unpinned.
- Pin/unpin toggle: redistribute.
- Manual share edit: integer 0..100 (D20) and auto-pins the offer (D19); explicit Unpin returns it to redistribution and removes its fixed share.

## Authority after Fetch and during staging
- A later Fetch updates the remote snapshot cache; it does not rewrite an existing draft baseline.
- The first edit copies the then-current remote snapshot into an immutable draft baseline, together with an immutable committed lifecycle/pin baseline.
- Staged pin intent overlays the committed baseline; manual share edits are fixed inputs (D19).
- Archived bindings remain wrapper-owned and are represented with effective share 0 in the staged view.

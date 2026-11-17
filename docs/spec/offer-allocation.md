# Offer allocation specification

## Algorithm: Largest Remainder Method (proposed)
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

## Edge cases (some unresolved)
- Zero active offers: block Push (proposed); verify Keitaro accepts empty array (open).
- One active offer: 100% if unpinned; if pinned with share X, remaining distributed to none → X (open whether forced to 100).
- All pinned: if total = 100 ok; if < 100, open (block or allow).
- Pinned total > 100: validation error, Push blocked (confirmed).
- Duplicate offers: open.

## Redistribution triggers
- Add offer (unpinned): redistribute unpinned.
- Remove (archive): redistribute unpinned.
- Restore: redistribute unpinned.
- Pin/unpin toggle: redistribute.
- Manual share edit: open whether implies pinning.

## Authority after Fetch
- Remote shares become baseline for active offers.
- Wrapper-owned pinning preserved (proposed).
- Archived bindings remain wrapper-owned.
EOF
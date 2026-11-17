# Campaign offer editor behavior (PROVISIONAL)

## Scope
Edit offers inside a designated flow of a campaign. Target flow selection when multiple offer-bearing flows exist is not yet specified (Q6).

## Verified facts (from live instance)
- Offer flow: type=regular, schema=landings, offers array with {offer_id, share, state}.
- Keitaro does NOT enforce share sum = 100 (tested 60/40, 60/30 accepted).
- Keitaro allows duplicate offer_ids and share=0.
- PUT /streams/{id} replaces offers array fully.

## Provisional behavior (hypotheses, pending video review)
- Editor loads the flow and its offers with shares.
- Add offer: select from offer list, append, rebalance all shares equally (integer) summing to 100.
- Remove offer: remove from list, rebalance.
- Manual share edit: allowed with validation sum=100.
- Save: explicit button, PUT /streams/{id} with full offers array.
- Duplicates: disallow in UI (even if API allows).
- Edge cases: 0 offers → empty; 1 offer → 100%; N offers → equal split with remainder to first offers.

## Worked examples (provisional)
- 2 offers: 50/50.
- 3 offers: 34/33/33 (remainder +1 to first).
- Add 4th to 3 (34/33/33): rebalance → 25/25/25/25.
- Remove one from 4: rebalance → 34/33/33.

## Open questions
- Video may reveal different arithmetic; adjust after review.
- Whether edits are immediate or staged (Q7) — provisional staged with explicit Save.
- Target flow selection with multiple offer-bearing flows (Q6) — OPEN.
EOF
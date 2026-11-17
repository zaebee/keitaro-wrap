# Campaign offer editor behavior

## Scope
Edit offers inside a designated flow (typically the default/offer flow) of a campaign.

## Reconstructed behavior (hypotheses, to verify via video/live API)
- Editor loads the flow and its offers with shares.
- Add offer: select from offer list, append with share 0, then rebalance all shares equally (integer) summing to 100.
- Remove offer: remove from list, rebalance.
- Manual share edit: allowed? Unknown. Assume allowed with validation sum=100.
- Save: explicit button, PUT /streams/{id} with full offers array.
- Duplicates: disallow adding same offer_id twice.
- Edge cases: 0 offers → empty; 1 offer → 100%; N offers → equal split with remainder to first offers.

## Worked examples
- 2 offers: 50/50.
- 3 offers: 34/33/33 (remainder +1 to first).
- Add 4th to 3 (34/33/33): rebalance → 25/25/25/25.
- Remove one from 4: rebalance → 34/33/33.

## Open questions
- Whether shares must total 100 (Q5/Q10).
- Immediate vs staged save (Q7).
- One flow vs multiple (Q6).
EOF
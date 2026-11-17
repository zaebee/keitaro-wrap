# Test plan

## Unit tests (no live Keitaro)
- Offer share rebalance arithmetic (worked examples) — provisional.
- Country code validation.
- Alias slug generation.
- Error translation.
- Operation state transitions.

## Contract tests (mocked HTTP)
- Keitaro client parses responses.
- Campaign creation sequence calls endpoints in order.
- Partial failure at each step sets status=partial.
- Ambiguous POST outcome (timeout) → status=ambiguous, no blind retry.
- Resume/reconciliation reads Keitaro state.
- Multiple candidate flows selection.
- Concurrent edits handling.

## Integration tests (optional, with test instance + .env)
- Create campaign end-to-end.
- Edit offers and verify shares.

## Acceptance scenarios (provisional where noted)
- AC1: Given name/country/offer, campaign created with 2 flows; first flow has country filter and redirects to Google; second flow has offer with 100% share. (Q1 open for default vs regular)
- AC2: Offer editor add/remove recalculates shares to sum 100 (provisional).
- AC3: No secrets in repo.
EOF
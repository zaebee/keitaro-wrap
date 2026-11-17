# Test plan

## Unit tests (no live Keitaro)
- Offer share rebalance arithmetic (worked examples).
- Country code validation.
- Alias slug generation.
- Error translation.

## Contract tests (mocked HTTP)
- Keitaro client parses responses.
- Campaign creation sequence calls endpoints in order.
- Partial failure sets status=partial.

## Integration tests (optional, with test instance + .env)
- Create campaign end-to-end.
- Edit offers and verify shares.

## Acceptance scenarios
- AC1: Given name/country/offer, campaign created with 2 flows; first flow has country filter and redirects to Google; second flow has offer with 100% share.
- AC2: Offer editor add/remove recalculates shares to sum 100.
- AC3: No secrets in repo.
EOF
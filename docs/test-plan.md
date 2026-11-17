# Test plan

## Confirmed (tests)
- LRM with offer_id ascending tie-break.
- pinned_sum > 100% invalid blocks Push.
- Drafts/archive durable.
- Per-stream Push outcomes, partial success, failed/ambiguous retention, reconciliation.

## Confirmed constraints (tests)
- pinned_sum > 100% invalid blocks Push.
- Draft/archive state survives restart.
- Per-stream Push outcomes, partial success, failed/ambiguous retention, reconciliation.

## Committed vs staged tests
- Staged changes do not overwrite committed binding state until Push commits.
- Cancel restores committed state and discards staged changes.
- Failed/ambiguous Push retains draft.
- Remote deletion reconciliation archives binding without creating draft.
- Reappearance reactivates binding and updates cache.

## Unit tests (no live Keitaro)
- Country code validation.
- Alias slug generation (unique operation-derived).
- Error translation.
- Operation state transitions (allowed/forbidden), including ambiguous → abandoned without resource-absence implication.
- Reconciliation matching (0 after bounded attempts / 1 / >1).
- Bounded retry count enforcement.
- Share redistribution among unpinned offers (pinned unchanged) — video-supported core.

## Contract tests (mocked HTTP)
- Keitaro client parses responses.
- Campaign creation sequence calls endpoints in order.
- Partial failure at each step sets status=partial.
- Ambiguous POST outcome (timeout) → status=ambiguous, no blind retry.
- Reconciliation: 0 after bounded attempts → remain ambiguous (no retry); 1 → adopt; >1 → ambiguous.
- Resume/reconciliation reads Keitaro state.
- Multiple candidate flows selection.
- Concurrent edits handling.
- Missing/inactive configured resource IDs → validation error.
- Alias uniqueness (422 on duplicate) handled.
- Stream name non-uniqueness does not break correlation (comments marker).

## Editor tests (video-supported core)
- Fetching all streams, including streams without offers.
- Displaying streams without offers without modifying their filters or destinations.
- Staging changes without sending Keitaro mutations.
- Dirty/clean state transitions (yellow vs white).
- Cancel restoring the fetched state, including removing locally staged additions.
- Add / Remove / Restore lifecycle.
- Archived offers remaining available in the wrapper.
- Missing previously known offers being retained in the archive after Fetch.
- Equal redistribution among unpinned offers.
- Pinned shares remaining unchanged during redistribution.
- Unpinned offers receiving the remaining percentage.

## Pending specification (do not encode as expected outcomes)
- Integer rounding/remainder allocation rules.
- Manual share input constraints and validation.
- Behavior when pinned shares exceed 100%.
- Behavior with zero or one active offers.
- Behavior when all offers are pinned.
- Duplicate-offer handling.
- Push/Cancel failure semantics (partial success, timeout).
- Persistence durability across reload/restart.
- Multiple offer-bearing stream selection.

## Integration tests (optional, with test instance + .env)
- Create campaign end-to-end.
- Edit offers and verify shares.

## Acceptance scenarios
- AC1: Given name/country/offer, campaign created with 2 flows; first flow has country filter and redirects to Google; second flow has offer with 100% share. (Q1 open for default vs regular)
- AC2: Offer editor core workflow (fetch, stage, push, cancel) per video. (edge cases provisional)
- AC3: No secrets in repo.
- AC4: Ambiguous POST leaves operation ambiguous; no duplicate resources created by blind retry.
- AC5: Zero reconciliation matches after bounded attempts does not trigger automatic retry and leaves operation ambiguous.

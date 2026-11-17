# Test plan

## Confirmed (tests)
- LRM with offer_id ascending tie-break.
- pinned_sum > 100% invalid blocks Push.
- Drafts/archive durable (survive restart).
- Per-stream Push outcomes, partial success, failed/ambiguous retention, reconciliation.

## Executed for Slice 4 (issue #29)
- Pure reconciliation: duplicate/invalid remote offers, add/remove/reappearance/share transitions, idempotency, sticky conflicts, staged share-edit intersection.
- Apply-level: one remote read before any DB write, response validation before reconciliation (including campaign ownership), Keitaro failure leaves local state untouched, synchronous repository offloaded from the event loop (D14).
- Repository on real SQLite: first Fetch, remote add/delete/reappearance with pin preserved, share cache update, multi-stream isolation by stream_ref, repeated Fetch idempotency, draft conflict without touching staged state/baseline/version/dirty flag, whole-snapshot rollback on duplicate ids, two concurrent Fetches without duplicate bindings.
- Mocked HTTP contract: full `/campaigns/{id}/streams` response including a stream without offers and ordered offer entries; no Keitaro write request; an offer missing `share` fails Fetch with the HTTP status preserved and leaves local state unchanged.
- Migration: upgrade/downgrade/upgrade with the four new tables, binding uniqueness and draft uniqueness/indexes.

## Executed for Slice 5 (issue #31)
- Pure draft planner: integer share validation (bool rejected), LRM reuse/tie-break, auto-pin and explicit Unpin, D9 restore pin preservation, zero/one/all-pinned policy surfacing, `pinned_sum > 100` rejection, and semantic no-op normalisation (archive→restore, pin→unpin, share→baseline).
- Application service: all six commands dispatch to pure intents, optimistic-concurrency fields validated before persistence, D14 thread assertion, no Keitaro client dependency.
- Real temporary SQLite: lazy draft creation from snapshot + immutable binding baseline, staged intent without touching bindings/snapshot, no-op without row/version change, stale-version rejection, sticky-conflict preservation with Cancel-only access, restart durability across repositories, stream isolation, rollback on invalid input, legacy draft without binding baseline rejected.
- S4/S5 integration correction: remote share changes conflict for add/archive/restore/pin intents and other offers alongside share edits, but not for an offer with a manual share edit (its local fixed share replaces the remote input); `expected` comes from the immutable draft baseline and `observed` from the new remote value; no conflict for a clean draft or a locally archived offer; sticky de-duplication, stale-edit blocking and Cancel conflict preservation verified.
- `IntegrityError` handling: only a lazy-create unique race maps to `DraftVersionConflict`; other integrity failures propagate unchanged.
- Clean-draft lifecycle: SetShare → Unpin removes the draft; a Fetch between cleanup and the next edit rebases from the new snapshot; empty-intent stale/conflicted drafts are retained; true no-ops leave rows and versions unchanged; optimistic concurrency remains safe across cleanup/recreation.
- Migration: `stream_drafts.baseline_bindings_json` and `stream_refs.draft_version_counter` added and verified on upgrade/downgrade/upgrade.

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
- Manual share input constraints and validation.
- Behavior with zero or one active offers.
- Behavior when all offers are pinned.
- Duplicate-offer handling in later slices (Fetch rejection is resolved by issue #29).
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

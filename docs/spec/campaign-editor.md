# Campaign offer editor (video-supported core, provisional edge cases)

## Committed vs staged
- Committed state: binding lifecycle and is_pinned (durable).
- Staged state: LocalDraft staged_changes (add/archive/restore/pin/share). Does not overwrite committed until Push commits.

## Status
Core workflow supported by demo video (2026-11-17). Edge cases listed under "Unresolved" remain provisional.

## Confirmed constraints
- pinned_sum > 100% is invalid and blocks Push (UI validation).
- Drafts and wrapper-owned archive state survive restart (durable).
- Per-stream Push outcomes, partial success, failed/ambiguous draft retention, and reconciliation are specified (see persistence.md).

## Confirmed by demo video

### Flow discovery and scope
- `Fetch Streams` loads all streams belonging to the campaign.
- Streams without offers are displayed as rows/blocks; the wrapper does not parse or edit their filters or redirect destinations.
- Streams containing offers expose their offer list and weights; offer editing operates on those offer-bearing streams.
- Video shows a targeted GEO stream (Australia → Google) and an offer fallback that catches traffic not matched by the targeted stream.
- Routing behavior is intended (targeted GEO first, remaining traffic falls through to offer stream), but the exact Keitaro stream type value (`regular` vs `default`) and general priority mechanism remain unconfirmed.

### Staged editing and publishing
- Add, Remove, Restore, and share changes are staged locally; they do not immediately update Keitaro.
- A modified stream is shown in yellow (pending/unpublished); an unchanged/published stream is white.
- `Push to KT` publishes staged changes to Keitaro; after successful publication the stream returns to white.
- `Cancel` discards pending local edits and restores the original state. Newly added offers are removed from the wrapper's local pending state.

### Offer lifecycle
- `Remove` sets an offer's share to 0% and marks it grey/archived; it is not simply erased from the wrapper's local history.
- On `Push to KT`, the removed offer is omitted from the Keitaro offer array while its archived record remains in the wrapper.
- `Bring back` reactivates an archived offer and triggers share redistribution.
- If an offer is deleted directly in Keitaro, a subsequent `Fetch Streams` detects that it is absent remotely and moves it into the wrapper's archived/grey state, where it can be restored.

### Share distribution and pinning
- Adding an offer triggers equal redistribution across all unpinned offers; pinned shares remain unchanged.
- Pinned shares are treated as fixed allocations. Unpinned offers divide the remaining percentage up to 100%.
- Video demonstrates a pinned offer retaining 25% when another archived offer is restored; the remaining 75% is split among the unpinned offers.
- Removing or restoring an offer also triggers redistribution among unpinned offers.

## Observed in live Keitaro instance (2026-11-17)
- Offer flow: type=regular, schema=landings, offers array with {offer_id, share, state}.
- Keitaro does not enforce share sum = 100 (tested 60/40, 60/30 accepted).
- Keitaro allows duplicate offer_ids and share=0.
- PUT /streams replaces offers array fully.
- Campaign alias uniqueness enforced; stream names NOT unique.
- Comments field persisted and returned.

## Inferred (not verified)
- Wrapper-owned archive concept (not Keitaro-native). Persistence durability across reload/restart not established.
- Targeted GEO first / offer fallback routing intent (video shows, but exact Keitaro mechanism open).

## Unresolved product questions (from video)
1. Keitaro flow type and priority: exact `regular` vs `default` and how fallback relationship is configured/guaranteed.
2. Multiple offer-bearing streams: independently editable/published vs single target selection.
3. Google destination configurability: campaign creation always uses fixed Google URL from assignment? (wrapper does not parse/edit redirect URLs)
4. Manual share input constraints: permitted range, integer/decimal entry, validation, behavior when pinned totals exceed 100%.
5. Rounding: integer remainder allocation and deterministic ordering not shown.
6. Edge cases: zero active offers, one active offer, removing/restoring last offer, all offers pinned, no remaining unpinned offers.
7. Duplicate offers: whether UI prevents selecting an offer already present (including archived entries).
8. Push/Cancel failure semantics: partial success across multiple modified streams; Push fail/timeout; Cancel availability after partial push.
9. Persistence boundary: whether wrapper-local archived/pending state is durable across browser reloads/restarts and how stored.

## Explicitly not supported (do not assume)
- Earlier assumptions "remove deletes from the list and rebalances", "manual edit unrestricted subject to sum=100", "remainder goes to first offers", "all streams are a single designated target" are NOT supported by the video.
- Integer rounding/remainder allocation rules.
- Manual share editing constraints.
- Behavior when pinned shares exceed 100%.
- Behavior with zero or one active offers.
- Behavior when all offers are pinned.
- Duplicate-offer handling.
- Permanent retention / archive persistence policy.

## Notes
- Archive is wrapper-owned business concept, not Keitaro-native state.
- No claim that pending changes or archive state survive page reload or application restart.
EOF
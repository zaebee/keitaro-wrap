# Campaign creation workflow

## Campaign activation assumption
The plan does NOT assume campaigns can be created paused/disabled and activated after all streams are created. This behavior is unverified against the target Keitaro API. Do not introduce paused → active workflow unless API support is independently verified.

Cross-reference: domain model `docs/spec/domain-model.md`, persistence `docs/architecture/persistence.md`.

## Input
- name (string, required)
- country_code (ISO-2, required)
- offer_id (int, required, existing Keitaro offer)

## Verified flow semantics (from live instance)
- Flow 1: type=forced, schema=redirect, action_type=http, destination from the configured redirect URL (default https://www.google.com), filters=[{name:country, mode:accept, payload:[CODE]}].
- Flow 2: type=default (owner decision #26; the earlier live observation of type=regular was a single instance), schema=landings, action_type=http, offers=[{offer_id, share:100, state:active}], filters=[].
- Q1 resolved by the owner in issue #26: use `default` for the offer fallback; do not use `regular` for this two-flow configuration and do not invent a priority field.

## Resource selection
Domain/group/traffic source IDs are operator-configured defaults (app_settings), selectable via settings page. If unset, UI may suggest first active but must not silently use it. Missing or inactive configured ID → validation error.

## Uniqueness (verified 2026-11-17)
- Campaign alias: enforced unique by Keitaro.
- Stream name: NOT unique within campaign.
- Use operation id in stream `comments` for correlation.

## Steps
1. Validate input (country_code 2 letters; offer exists via GET /offers/{id}).
2. Resolve resources (configured defaults; error if missing/inactive).
3. Persist operation record (status=started) with operation-derived unique alias (slug-<short_uuid>) before the first mutating external request; read-only GET resolution may precede it. Store alias in operation.
4. Create campaign: POST /campaigns with unique alias. Store keitaro_campaign_id. On timeout → bounded reconciliation by alias; if unresolved → ambiguous.
5. Create Flow 1 (forced country→Google) with operation id in comments. Store flow_country_id. On timeout → bounded reconciliation by comments; if unresolved → ambiguous.
6. Create Flow 2 (observed regular offer flow) with operation id in comments. Store flow_offer_id.
7. Read back campaign + streams; verify.
8. Mark operation status=created.

## Reconciliation (bounded)
- 0 matches after bounded attempts → remain ambiguous. Do not retry automatically.
- 1 match → adopt.
- >1 → ambiguous + operator intervention.
- Retry is permitted only when reliable evidence establishes that the previous external side effect did not occur, or when a documented API guarantee makes retry safe. Zero matches after bounded reconciliation are never sufficient by themselves. Incomplete pagination or uncertain read-after-write consistency cannot establish absence. Operator confirmation alone cannot establish absence. If absence cannot be reliably established, preserve `ambiguous`; do not retry.

## State machine
See architecture.md. `failed` = definitive error, does not guarantee absence of external resources. `ambiguous` may become `abandoned` on operator decision without implying resources absent.

## Validation
- country_code must be 2 letters.
- offer_id must exist (GET /offers/{id}).

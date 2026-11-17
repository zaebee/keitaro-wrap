# Campaign creation workflow

## Input
- name (string, required)
- country_code (ISO-2, required)
- offer_id (int, required, existing Keitaro offer)

## Verified flow semantics (from live instance)
- Flow 1: type=forced, schema=redirect, action_type=http, action_payload=https://www.google.com, filters=[{name:country, mode:accept, payload:[CODE]}].
- Flow 2: observed as type=regular, schema=landings, action_type=http, offers=[{offer_id, share:100, state:active}], filters=[].
- Q1 (default vs regular / catch-all fallback) remains OPEN. Only one existing campaign observed. Do not assume fallback semantics until verified.

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
- Retry permitted only after explicit operator confirmation or documented API safety guarantee.

## State machine
See architecture.md. `failed` = definitive error, does not guarantee absence of external resources. `ambiguous` may become `abandoned` on operator decision without implying resources absent.

## Validation
- country_code must be 2 letters.
- offer_id must exist (GET /offers/{id}).

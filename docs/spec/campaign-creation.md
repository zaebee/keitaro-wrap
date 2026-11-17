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

## Steps
1. Validate input (country_code 2 letters; offer exists via GET /offers/{id}).
2. Resolve resources (configured defaults; error if missing/inactive).
3. Persist operation record (status=started) with operation-derived unique alias (slug-<short_uuid>) before external calls.
4. Create campaign: POST /campaigns with unique alias, name, domain_id, group_id, traffic_source_id. Store keitaro_campaign_id. On timeout → ambiguous; reconcile by alias.
5. Create Flow 1 (forced country→Google) with deterministic name. Store flow_country_id. On timeout → ambiguous; reconcile by name+type+schema.
6. Create Flow 2 (observed regular offer flow). Store flow_offer_id.
7. Read back campaign + streams; verify.
8. Mark operation status=created.

## Reconciliation
See architecture.md. Never rely on campaign name alone. Unique alias + deterministic stream names. 0 matches → retry; 1 → adopt; >1 → ambiguous, operator intervention.

## State machine
See architecture.md (started/partial/ambiguous/created/failed).

## Validation
- country_code must be 2 letters.
- offer_id must exist (GET /offers/{id}).
EOF
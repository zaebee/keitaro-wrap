# Campaign creation workflow

## Input
- name (string, required)
- country_code (ISO-2, required)
- offer_id (int, required, existing Keitaro offer)

## Verified flow semantics (from live instance)
- Flow 1: type=forced, schema=redirect, action_type=http, action_payload=https://www.google.com, filters=[{name:country, mode:accept, payload:[CODE]}].
- Flow 2: observed as type=regular, schema=landings, action_type=http, offers=[{offer_id, share:100, state:active}], filters=[].
- Q1 (default vs regular / catch-all fallback) remains OPEN. Only one existing campaign observed. Do not assume fallback semantics until verified.

## Steps
1. Validate input (country_code 2 letters; offer exists via GET /offers/{id}).
2. Resolve resources: domain_id, campaign group_id, traffic_source_id. These are operator-configured defaults (app_settings), selectable via settings page. If unset, suggest first active but require confirmation.
3. Persist operation record (status=started) before external calls.
4. Create campaign: POST /campaigns with alias (slug from name), name, domain_id, group_id, traffic_source_id. Store keitaro_campaign_id.
5. Create Flow 1 (forced country→Google). Store flow_country_id.
6. Create Flow 2 (observed regular offer flow). Store flow_offer_id.
7. Read back campaign + streams; verify.
8. Mark operation status=created.

## Partial failure recovery
- Operation row exists before any external call.
- Persist returned IDs immediately after each successful POST.
- On timeout/ambiguous POST outcome: do not retry automatically. Re-read Keitaro state to reconcile. Mark operation `ambiguous` if unresolved.
- Statuses: started, partial, ambiguous, created, failed.

## Validation
- country_code must be 2 letters.
- offer_id must exist (GET /offers/{id}).
EOF
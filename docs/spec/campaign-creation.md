# Campaign creation workflow

## Input
- name (string, required)
- country_code (ISO-2, required)
- offer_id (int, required, existing Keitaro offer)

## Verified flow semantics (from live instance)
- Flow 1: type=forced, schema=redirect, action_type=http, action_payload=https://www.google.com, filters=[{name:country, mode:accept, payload:[CODE]}].
- Flow 2: type=regular, schema=landings, action_type=http, offers=[{offer_id, share:100, state:active}], filters=[].

## Steps
1. Validate input (country_code 2 letters; offer exists).
2. Resolve defaults: domain_id (first active domain), campaign group_id (GET /groups?type=campaigns, first), traffic_source_id (first active source). Persist to app_settings.
3. Create campaign: POST /campaigns with alias (slug from name), name, domain_id, group_id, traffic_source_id.
4. Create Flow 1 (forced country→Google).
5. Create Flow 2 (regular offer flow).
6. Read back campaign + streams; verify.
7. Persist local campaign row with keitaro ids and status=created.

## Failure handling
- If campaign creation fails: status=failed.
- If Flow 1/Flow2 fails after campaign created: status=partial, store error. Retry can create missing flow.
- No automatic deletion; operator can clean up in Keitaro.

## Validation
- country_code must be 2 letters.
- offer_id must exist (GET /offers/{id}).
EOF
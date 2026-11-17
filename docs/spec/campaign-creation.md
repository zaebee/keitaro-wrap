# Campaign creation workflow

## Input
- name (string, required)
- country_code (ISO-2, required)
- offer_id (int, required, existing Keitaro offer)

## Steps
1. Validate input.
2. Resolve defaults: domain_id, campaign group_id, traffic_source_id. If not configured, list and pick first active; persist to app_settings.
3. Create campaign: POST /campaigns with alias (slug from name), name, domain_id, group_id, traffic_source_id.
4. Create Flow 1 (forced): country filter accept [country_code], schema redirect, action redirect to https://www.google.com.
5. Create Flow 2 (default): schema landings, offers [{offer_id, share:100, state:active}].
6. Read back campaign + streams; verify flow ids and offers.
7. Persist local campaign row with keitaro ids and status=created.

## Failure handling
- If campaign creation fails: status=failed, no partial.
- If Flow 1 fails after campaign created: status=partial, store error. Retry can create flow and update row.
- If Flow 2 fails: status=partial. Offer flow can be retried.
- No automatic deletion of partial campaign (operator decision). Could add cleanup option.

## Flow ordering
Forced flows evaluated first, then regular, then default. Country forced flow catches matching country; default flow catches all others (including non-matching country). This matches "first potok ловит всех из указанной страны ... второй поток редиректит на оффер".

## Validation
- country_code must be 2 letters.
- offer_id must exist (verify via GET /offers/{id}).
EOF
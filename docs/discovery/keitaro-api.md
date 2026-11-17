# Keitaro Admin API — verified endpoints (from OpenAPI + target instance)

Source: `docs/openapi.json` (published) and live instance https://tlgk.host (base path `/admin_api/v1`). Auth: `Api-Key` header.

## Verified runtime values
- Stream types: `forced`, `regular`, `default`.
- Stream schemas: `landings`, `redirect`, `action`.
- Stream filters: name `country` (mode `accept`/`reject`, payload list of ISO codes). Other filters include city, region, etc.
- Stream actions: redirect action key `http` (HttpRedirect, type redirect, field url).
- Groups endpoint requires query param `?type=campaigns|offers|landings|domains`.

## Domains
- `GET /domains` → Domain[]

## Groups
- `GET /groups?type={type}` → Group[]
- `POST /groups` body `{name, type}` → Group

## Traffic sources
- `GET /traffic_sources` → Source[]

## Offers
- `GET /offers` → Offer[]
- `GET /offers/{id}` → Offer

## Campaigns
- `POST /campaigns` body CampaignRequest (required alias, name) → Campaign
- `GET /campaigns` → Campaign[]
- `GET /campaigns/{id}` → Campaign
- `GET /campaigns/{id}/streams` → Stream[]

## Streams
- `GET /stream_types`, `/stream_schemas`, `/stream_filters`, `/streams_actions` (runtime discovery)
- `POST /streams` body StreamRequest → Stream
- `GET /streams/{id}` → Stream
- `PUT /streams/{id}` body StreamRequestPut → Stream
- `DELETE /streams/{id}` → success

## Minimal verified request examples

Create campaign:
```json
POST /admin_api/v1/campaigns
{ "alias": "my-campaign", "name": "My Campaign", "domain_id": 1, "group_id": 2, "traffic_source_id": 3 }
```

Create forced country→Google flow:
```json
POST /admin_api/v1/streams
{
  "campaign_id": 10,
  "type": "forced",
  "name": "US -> Google",
  "schema": "redirect",
  "action_type": "http",
  "action_payload": "https://www.google.com",
  "filters": [ { "name": "country", "mode": "accept", "payload": ["US"] } ]
}
```

Create offer flow (verified from existing campaign):
```json
POST /admin_api/v1/streams
{
  "campaign_id": 10,
  "type": "regular",
  "name": "Offer",
  "schema": "landings",
  "action_type": "http",
  "offers": [ { "offer_id": 5, "share": 100, "state": "active" } ]
}
```

Update stream offers:
```json
PUT /admin_api/v1/streams/42
{ "offers": [ { "offer_id": 5, "share": 50, "state": "active" }, { "offer_id": 7, "share": 50, "state": "active" } ] }
```

## Notes
- Partial failure: campaign creation and each stream creation are separate calls; no transactional guarantee. Implement partial state + retry/resume.
- Verified from live instance: existing campaign 213095 uses forced/regular flows as above.
EOF
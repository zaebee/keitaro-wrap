# Keitaro Admin API — verified endpoints (from OpenAPI)

Source: `docs/openapi.json` (fetched from https://admin-api.docs.keitaro.io/openapi.json). Target instance: https://tlgk.host (base path `/admin_api/v1`). Auth: `Api-Key` header.

## Domains
- `GET /domains` → Domain[]
- `GET /domains/{id}` → Domain

## Groups
- `GET /groups` → Group[]
- `POST /groups` body `{name, type}` → Group. type ∈ {campaigns, offers, landings, domains}

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
- `GET /stream_types` → StreamAction[] (runtime)
- `GET /stream_schemas` → StreamAction[]
- `GET /stream_filters` → StreamFilter[]
- `GET /streams_actions` → StreamAction[]
- `POST /streams` body StreamRequest → Stream
- `GET /streams/{id}` → Stream
- `PUT /streams/{id}` body StreamRequestPut → Stream
- `DELETE /streams/{id}` → success

## Minimal request examples (redacted)

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
  "action_type": "<from /streams_actions>",
  "action_payload": "https://www.google.com",
  "filters": [ { "name": "country", "mode": "accept", "payload": ["US"] } ]
}
```

Create offer flow:
```json
POST /admin_api/v1/streams
{
  "campaign_id": 10,
  "type": "default",
  "name": "Offer",
  "schema": "landings",
  "offers": [ { "offer_id": 5, "share": 100, "state": "active" } ]
}
```

Update stream offers:
```json
PUT /admin_api/v1/streams/42
{ "offers": [ { "offer_id": 5, "share": 50, "state": "active" }, { "offer_id": 7, "share": 50, "state": "active" } ] }
```

## Notes
- Exact `action_type` for HTTP redirect and country filter name must be confirmed via runtime endpoints (`/streams_actions`, `/stream_filters`) against the target instance. OpenAPI does not enumerate runtime values.
- Partial failure: campaign creation and each stream creation are separate calls; no transactional guarantee. Implement partial state + retry/resume.
EOF
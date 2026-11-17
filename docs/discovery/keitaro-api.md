# Keitaro Admin API — contract (OpenAPI vs runtime observations)

Source (OpenAPI): `docs/openapi.json` (published at https://admin-api.docs.keitaro.io/openapi.json).
Target instance: https://tlgk.host, observed 2026-11-17. Auth: `Api-Key` header.
Keitaro version: unknown (not exposed in OpenAPI). Record from admin panel when available.

## Legend
- **OpenAPI** — declared in published schema.
- **Observed** — confirmed against live instance on 2026-11-17.
- **Inferred** — reasoned, not yet verified.

## Verified runtime values (Observed)
- Stream types: `forced`, `regular`, `default`.
- Stream schemas: `landings`, `redirect`, `action`.
- Stream filters: name `country` (mode `accept`/`reject`, payload list of ISO codes). Others: city, region, etc.
- Stream actions: redirect action key `http` (HttpRedirect, type redirect, field url).
- Groups endpoint requires query param `?type=campaigns|offers|landings|domains`.

## Fields
- `action_payload`: used in requests/responses (Observed), but NOT declared in OpenAPI `StreamObject` (OpenAPI gap). Treat as runtime-only.
- `offers` in stream: OpenAPI declares `offers` in StreamObject and OfferStreamRequest.

## Domains (OpenAPI)
- `GET /domains` → Domain[]

## Groups (OpenAPI + Observed query param)
- `GET /groups?type={type}` → Group[] (type required; Observed)
- `POST /groups` body `{name, type}` → Group

## Traffic sources (OpenAPI)
- `GET /traffic_sources` → Source[]

## Offers (OpenAPI)
- `GET /offers` → Offer[]
- `GET /offers/{id}` → Offer

## Campaigns (OpenAPI)
- `POST /campaigns` body CampaignRequest (required alias, name) → Campaign
- `GET /campaigns` → Campaign[]
- `GET /campaigns/{id}` → Campaign
- `GET /campaigns/{id}/streams` → Stream[]

## Streams (OpenAPI + Observed)
- `GET /stream_types`, `/stream_schemas`, `/stream_filters`, `/streams_actions` (runtime discovery)
- `POST /streams` body StreamRequest → Stream
- `GET /streams/{id}` → Stream
- `PUT /streams/{id}` body StreamRequestPut → Stream
- `DELETE /streams/{id}` → success

## Minimal examples

Create campaign (OpenAPI):
```json
POST /admin_api/v1/campaigns
{ "alias": "my-campaign", "name": "My Campaign", "domain_id": 1, "group_id": 2, "traffic_source_id": 3 }
```

Create forced country→Google flow (Observed):
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

Create offer flow (Observed: type=regular):
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

Update stream offers (OpenAPI + Observed):
```json
PUT /admin_api/v1/streams/42
{ "offers": [ { "offer_id": 5, "share": 50, "state": "active" }, { "offer_id": 7, "share": 50, "state": "active" } ] }
```

## Notes
- `GET /campaigns/{id}/streams` declares only the campaign id path parameter in the published OpenAPI; no offset/limit. Slice 4 consumes the full returned array and does not invent pagination query parameters. Runtime pagination of streams is unverified.
- Partial failure: separate calls; no transactional guarantee. Implement operation state + reconciliation.
- OpenAPI does not declare `action_payload`; runtime uses it.

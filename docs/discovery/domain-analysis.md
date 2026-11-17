# Domain analysis — Keitaro campaign creator + offer editor

## Entities and relationships

- **Campaign** — top-level traffic container. Has name, alias, state, cost settings, and references to a Domain, Group, Traffic Source. Contains Streams (flows).
- **Stream / Flow** — routing rule inside a campaign. Has `type` (forced, regular, default), `schema` (redirect, landings, action), `action_type`/`action_payload` (for redirect), `filters` (conditions), and `offers` (with shares) for landings schema.
- **Filter** — condition on a stream (e.g. country). Has name, mode (accept/reject), payload (list of values).
- **Offer** — destination with payout. Can be assigned to a stream with a traffic share.
- **Offer share (weight)** — integer percentage of traffic sent to that offer within a stream.
- **Domain** — tracker domain used in campaign URL. Has id, name, state.
- **Group** — grouping for campaigns/offers/landings/domains. Has type (campaigns, offers, landings, domains).
- **Traffic source** — origin of traffic; provides parameters.

## Confirmed facts (from OpenAPI schema `docs/openapi.json`)

- Campaign required fields: `alias`, `name`. Optional: `domain_id`, `group_id`, `traffic_source_id`, `state`, `cost_type`, etc. (CampaignRequest)
- Stream required fields: `campaign_id`, `type`, `name`, `schema`, `action_type`. (StreamRequest)
- Stream.type enum: `forced`, `regular`, `default`.
- Stream.schema enum: `landings`, `redirect`, `action`.
- Stream filter: name, mode (accept/reject), payload (array of strings). (FilterStreamRequest)
- Offer in stream: offer_id, share (int), state (active/disabled). (OfferStreamRequest)
- Group types: campaigns, offers, landings, domains.
- Domains, groups, traffic sources, offers are separate list endpoints.

## Hypotheses (to verify with live API)

- H1: Country filter name is `country` and payload is list of ISO-2 codes. (Docs say "Country" filter; name likely `country`.)
- H2: Redirect action_type for Google redirect is one of `/streams_actions` values (e.g. `http_redirect`). Need to verify exact key.
- H3: Offer flow uses schema `landings` with `offers` array and no landings. Need to verify.
- H4: Forced flow with country filter catches matching traffic; default flow catches rest. Need to verify ordering: forced flows evaluated first, then regular, then default.
- H5: Offer shares must total 100%. Need to verify Keitaro constraint.
- H6: Default domain/group/traffic source can be resolved by listing and picking first active.

## Open questions

See issue #1 open questions Q1–Q10.
EOF
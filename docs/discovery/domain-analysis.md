# Domain analysis — Keitaro campaign creator + offer editor

## Entities and relationships

- **Campaign** — top-level traffic container. Has name, alias, state, cost settings, and references to a Domain, Group, Traffic Source. Contains Streams (flows).
- **Stream / Flow** — routing rule inside a campaign. Has `type` (forced, regular, default), `schema` (redirect, landings, action), `action_type`/`action_payload` (for redirect), `filters` (conditions), and `offers` (with shares) for landings schema.
- **Filter** — condition on a stream (e.g. country). Has name, mode (accept/reject), payload (list of values).
- **Offer** — destination with payout. Can be assigned to a stream with a traffic share.
- **Offer share (weight)** — integer percentage of traffic sent to that offer within a stream.
- **Domain** — tracker domain used in campaign URL. Has id, name, state.
- **Group** — grouping for campaigns/offers/landings/domains. Type filter required: campaigns, offers, landings, domains.
- **Traffic source** — origin of traffic; provides parameters.

## Confirmed facts (from live instance)

- Campaign required fields: `alias`, `name`. Optional: `domain_id`, `group_id`, `traffic_source_id`, `state`, etc.
- Stream required fields: `campaign_id`, `type`, `name`, `schema`, `action_type`.
- Stream.type enum: `forced`, `regular`, `default`.
- Stream.schema enum: `landings`, `redirect`, `action`.
- Stream filter: name `country`, mode `accept`/`reject`, payload list of ISO codes.
- Offer in stream: offer_id, share (int), state (active/disabled).
- Groups endpoint requires `?type=...`.
- Redirect action key: `http`.
- Campaign creation is multi-step; forced flow first, then regular offer flow.
- Verified example campaign 213095: forced country→Google, regular offer flow with one offer share 100.

## Open questions
- Offer editor arithmetic (add/remove rebalance, manual edit, save mode) pending video review.
EOF
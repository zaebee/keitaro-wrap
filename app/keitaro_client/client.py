import asyncio
from typing import Any

import httpx

from app.application.dto import (
    CampaignCreateDTO,
    CampaignDTO,
    DomainDTO,
    GroupDTO,
    OfferDTO,
    OfferStreamDTO,
    StreamCreateDTO,
    StreamDTO,
    StreamFilterDTO,
    StreamUpdateDTO,
    TrafficSourceDTO,
)
from app.application.ports import KeitaroClientPort
from app.core.config import settings


class KeitaroError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(f"Keitaro {status}: {message}")


class KeitaroClient(KeitaroClientPort):
    def __init__(self, http_client: httpx.AsyncClient):
        self._client = http_client
        self._base = "/admin_api/v1"

    async def _request(self, method: str, path: str, *, json: Any = None, retries: int = 0) -> Any:
        url = self._base + path
        last_exc = None
        for attempt in range(retries + 1):
            try:
                resp = await self._client.request(method, url, json=json)
            except (httpx.TimeoutException, httpx.ConnectError) as exc:
                last_exc = exc
                if method == "GET" and attempt < retries:
                    await asyncio.sleep(0.1)
                    continue
                raise KeitaroError(0, str(exc)) from exc
            if resp.status_code >= 400:
                try:
                    data = resp.json()
                    msg = data.get("error") if isinstance(data, dict) else str(data)
                except Exception:
                    msg = resp.text
                raise KeitaroError(resp.status_code, msg or resp.reason_phrase)
            if not resp.content:
                return None
            try:
                return resp.json()
            except Exception as exc:
                raise KeitaroError(resp.status_code, "malformed response") from exc
        raise KeitaroError(0, str(last_exc))

    # discovery
    async def list_stream_types(self) -> list[dict]:
        return await self._request("GET", "/stream_types", retries=2) or []

    async def list_stream_schemas(self) -> list[dict]:
        return await self._request("GET", "/stream_schemas", retries=2) or []

    async def list_stream_filters(self) -> list[dict]:
        return await self._request("GET", "/stream_filters", retries=2) or []

    async def list_stream_actions(self) -> list[dict]:
        return await self._request("GET", "/streams_actions", retries=2) or []

    # domains/groups/sources
    async def list_domains(self) -> list[DomainDTO]:
        data = await self._request("GET", "/domains", retries=2) or []
        return [DomainDTO(id=d["id"], name=d.get("name", ""), state=d.get("state")) for d in data]

    async def list_groups(self, gtype: str) -> list[GroupDTO]:
        data = await self._request("GET", f"/groups?type={gtype}", retries=2) or []
        return [GroupDTO(id=g["id"], name=g.get("name", ""), type=g.get("type")) for g in data]

    async def list_traffic_sources(self) -> list[TrafficSourceDTO]:
        data = await self._request("GET", "/traffic_sources", retries=2) or []
        return [TrafficSourceDTO(id=s["id"], name=s.get("name", ""), state=s.get("state")) for s in data]

    # offers
    async def list_offers(self) -> list[OfferDTO]:
        data = await self._request("GET", "/offers", retries=2) or []
        return [OfferDTO(id=o["id"], name=o.get("name", ""), state=o.get("state"), group_id=o.get("group_id")) for o in data]

    async def get_offer(self, offer_id: int) -> OfferDTO:
        o = await self._request("GET", f"/offers/{offer_id}", retries=2)
        return OfferDTO(id=o["id"], name=o.get("name", ""), state=o.get("state"), group_id=o.get("group_id"))

    # campaigns
    async def create_campaign(self, payload: CampaignCreateDTO) -> CampaignDTO:
        body = {"alias": payload.alias, "name": payload.name}
        if payload.domain_id is not None:
            body["domain_id"] = payload.domain_id
        if payload.group_id is not None:
            body["group_id"] = payload.group_id
        if payload.traffic_source_id is not None:
            body["traffic_source_id"] = payload.traffic_source_id
        c = await self._request("POST", "/campaigns", json=body)
        return CampaignDTO(id=c["id"], name=c.get("name", payload.name), alias=c.get("alias"), state=c.get("state"),
                           domain_id=c.get("domain_id"), group_id=c.get("group_id"), traffic_source_id=c.get("traffic_source_id"))

    async def list_campaigns(self) -> list[CampaignDTO]:
        data = await self._request("GET", "/campaigns", retries=2) or []
        return [CampaignDTO(id=c["id"], name=c.get("name", ""), alias=c.get("alias"), state=c.get("state")) for c in data]

    async def get_campaign(self, campaign_id: int) -> CampaignDTO:
        c = await self._request("GET", f"/campaigns/{campaign_id}", retries=2)
        return CampaignDTO(id=c["id"], name=c.get("name", ""), alias=c.get("alias"), state=c.get("state"))

    async def list_campaign_streams(self, campaign_id: int) -> list[StreamDTO]:
        data = await self._request("GET", f"/campaigns/{campaign_id}/streams", retries=2) or []
        return [self._to_stream(s, campaign_id) for s in data]

    # streams
    async def create_stream(self, payload: StreamCreateDTO) -> StreamDTO:
        body: dict[str, Any] = {
            "campaign_id": payload.campaign_id,
            "type": payload.type,
            "name": payload.name,
            "schema": payload.schema,
            "action_type": payload.action_type,
        }
        if payload.action_payload is not None:
            body["action_payload"] = payload.action_payload
        if payload.filters:
            body["filters"] = payload.filters
        if payload.offers:
            body["offers"] = payload.offers
        if payload.comments is not None:
            body["comments"] = payload.comments
        s = await self._request("POST", "/streams", json=body)
        return self._to_stream(s, payload.campaign_id)

    async def get_stream(self, stream_id: int) -> StreamDTO:
        s = await self._request("GET", f"/streams/{stream_id}", retries=2)
        return self._to_stream(s, s.get("campaign_id", 0))

    async def update_stream(self, stream_id: int, payload: StreamUpdateDTO) -> StreamDTO:
        s = await self._request("PUT", f"/streams/{stream_id}", json=payload.fields)
        return self._to_stream(s, s.get("campaign_id", 0))

    async def delete_stream(self, stream_id: int) -> None:
        await self._request("DELETE", f"/streams/{stream_id}")

    def _to_stream(self, s: dict, campaign_id: int) -> StreamDTO:
        filters = [StreamFilterDTO(name=f.get("name", ""), mode=f.get("mode", "accept"), payload=f.get("payload") or []) for f in (s.get("filters") or [])]
        offers = [OfferStreamDTO(offer_id=o["offer_id"], share=o.get("share", 0), state=o.get("state")) for o in (s.get("offers") or [])]
        return StreamDTO(
            id=s["id"],
            campaign_id=s.get("campaign_id", campaign_id),
            type=s.get("type", ""),
            name=s.get("name", ""),
            schema=s.get("schema", ""),
            action_type=s.get("action_type"),
            action_payload=s.get("action_payload"),
            filters=filters,
            offers=offers,
            comments=s.get("comments"),
        )

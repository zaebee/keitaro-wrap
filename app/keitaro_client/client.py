"""Module."""

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
    StreamActionDTO,
    StreamCreateDTO,
    StreamDTO,
    StreamFilterDTO,
    StreamFilterOptionDTO,
    StreamSchemaDTO,
    StreamTypeDTO,
    StreamUpdateDTO,
    TrafficSourceDTO,
)
from app.application.ports import KeitaroClientPort


class KeitaroError(Exception):
    """KeitaroError."""

    def __init__(self, status: int, message: str):
        """__init__."""
        self.status = status
        self.message = message
        super().__init__(f"Keitaro {status}: {message}")


class KeitaroClient(KeitaroClientPort):
    """KeitaroClient."""

    def __init__(self, http_client: httpx.AsyncClient, api_key: str):
        """__init__."""
        self._client = http_client
        self._base = "/admin_api/v1"
        self._api_key = api_key

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        retries: int = 0,
    ) -> Any:
        """Execute an HTTP request with bounded retries for safe reads."""
        url = self._base + path
        for attempt in range(retries + 1):
            try:
                resp = await self._client.request(
                    method,
                    url,
                    json=json,
                    params=params,
                    headers={"Api-Key": self._api_key},
                )
            except (httpx.TimeoutException, httpx.ConnectError) as exc:
                if method == "GET" and attempt < retries:
                    await asyncio.sleep(0.1)
                    continue
                raise KeitaroError(0, str(exc)) from exc
            return self._handle_response(resp)
        raise KeitaroError(0, "request failed")

    def _handle_response(self, resp: httpx.Response) -> Any:
        """Parse a successful response or raise a Keitaro error."""
        if resp.status_code >= 400:
            msg = self._extract_error(resp)
            raise KeitaroError(resp.status_code, msg or resp.reason_phrase)
        if not resp.content:
            return None
        try:
            return resp.json()
        except Exception as exc:
            raise KeitaroError(resp.status_code, "malformed response") from exc

    def _extract_error(self, resp: httpx.Response) -> str:
        """Extract an error message from a failed response."""
        # Do not expose response bodies or potential secrets.
        return resp.reason_phrase or f"HTTP {resp.status_code}"

    @staticmethod
    def _as_object_list(data: Any, context: str) -> list[Any]:
        """Require a list of objects; malformed data is never an empty list."""
        if not isinstance(data, list) or any(
            not isinstance(item, dict) for item in data
        ):
            raise KeitaroError(
                0, f"unexpected response shape for {context}: expected list of objects"
            )
        return data

    @classmethod
    def _optional_object_list(cls, value: Any, context: str) -> list[Any]:
        """Treat a missing/null nested collection as empty; validate a present one."""
        if value is None:
            return []
        return cls._as_object_list(value, context)

    # discovery
    async def list_stream_types(self) -> list[StreamTypeDTO]:
        """list_stream_types."""
        data = await self._request("GET", "/stream_types", retries=2)
        return [
            StreamTypeDTO(value=d.get("value", ""), name=d.get("name", ""))
            for d in self._as_object_list(data, "/stream_types")
        ]

    async def list_stream_schemas(self) -> list[StreamSchemaDTO]:
        """list_stream_schemas."""
        data = await self._request("GET", "/stream_schemas", retries=2)
        return [
            StreamSchemaDTO(value=d.get("value", ""), name=d.get("name", ""))
            for d in self._as_object_list(data, "/stream_schemas")
        ]

    async def list_stream_filters(self) -> list[StreamFilterOptionDTO]:
        """list_stream_filters."""
        data = await self._request("GET", "/stream_filters", retries=2)
        return [
            StreamFilterOptionDTO(
                value=d.get("value", ""), modes=d.get("modes"), group=d.get("group")
            )
            for d in self._as_object_list(data, "/stream_filters")
        ]

    async def list_stream_actions(self) -> list[StreamActionDTO]:
        """list_stream_actions."""
        data = await self._request("GET", "/streams_actions", retries=2)
        return [
            StreamActionDTO(
                key=d.get("key", ""), name=d.get("name", ""), type=d.get("type")
            )
            for d in self._as_object_list(data, "/streams_actions")
        ]

    # domains/groups/sources
    async def list_domains(self) -> list[DomainDTO]:
        """list_domains."""
        data = await self._request("GET", "/domains", retries=2)
        return [
            DomainDTO(id=d["id"], name=d.get("name", ""), state=d.get("state"))
            for d in self._as_object_list(data, "/domains")
        ]

    async def list_groups(self, gtype: str) -> list[GroupDTO]:
        """list_groups."""
        data = await self._request("GET", "/groups", params={"type": gtype}, retries=2)
        return [
            GroupDTO(id=g["id"], name=g.get("name", ""), type=g.get("type"))
            for g in self._as_object_list(data, "/groups")
        ]

    async def list_traffic_sources(self) -> list[TrafficSourceDTO]:
        """list_traffic_sources."""
        data = await self._request("GET", "/traffic_sources", retries=2)
        return [
            TrafficSourceDTO(id=s["id"], name=s.get("name", ""), state=s.get("state"))
            for s in self._as_object_list(data, "/traffic_sources")
        ]

    # offers
    async def list_offers(self) -> list[OfferDTO]:
        """list_offers."""
        data = await self._request("GET", "/offers", retries=2)
        return [
            OfferDTO(
                id=o["id"],
                name=o.get("name", ""),
                state=o.get("state"),
                group_id=o.get("group_id"),
            )
            for o in self._as_object_list(data, "/offers")
        ]

    async def get_offer(self, offer_id: int) -> OfferDTO:
        """get_offer."""
        o = await self._request("GET", f"/offers/{offer_id}", retries=2)
        return OfferDTO(
            id=o["id"],
            name=o.get("name", ""),
            state=o.get("state"),
            group_id=o.get("group_id"),
        )

    # campaigns
    async def create_campaign(self, payload: CampaignCreateDTO) -> CampaignDTO:
        """create_campaign."""
        body: dict[str, Any] = {"alias": payload.alias, "name": payload.name}
        if payload.domain_id is not None:
            body["domain_id"] = payload.domain_id
        if payload.group_id is not None:
            body["group_id"] = payload.group_id
        if payload.traffic_source_id is not None:
            body["traffic_source_id"] = payload.traffic_source_id
        c = await self._request("POST", "/campaigns", json=body)
        return CampaignDTO(
            id=c["id"],
            name=c.get("name", payload.name),
            alias=c.get("alias"),
            state=c.get("state"),
            domain_id=c.get("domain_id"),
            group_id=c.get("group_id"),
            traffic_source_id=c.get("traffic_source_id"),
        )

    async def list_campaigns(
        self, offset: int = 0, limit: int = 100
    ) -> list[CampaignDTO]:
        """List campaigns (page-oriented; offset/limit)."""
        data = await self._request(
            "GET",
            "/campaigns",
            params={"offset": offset, "limit": limit},
            retries=2,
        )
        return [
            CampaignDTO(
                id=c["id"],
                name=c.get("name", ""),
                alias=c.get("alias"),
                state=c.get("state"),
            )
            for c in self._as_object_list(data, "/campaigns")
        ]

    async def get_campaign(self, campaign_id: int) -> CampaignDTO:
        """get_campaign."""
        c = await self._request("GET", f"/campaigns/{campaign_id}", retries=2)
        return CampaignDTO(
            id=c["id"],
            name=c.get("name", ""),
            alias=c.get("alias"),
            state=c.get("state"),
        )

    async def list_campaign_streams(self, campaign_id: int) -> list[StreamDTO]:
        """list_campaign_streams."""
        data = await self._request(
            "GET", f"/campaigns/{campaign_id}/streams", retries=2
        )
        return [
            self._to_stream(s, campaign_id)
            for s in self._as_object_list(data, f"/campaigns/{campaign_id}/streams")
        ]

    # streams
    async def create_stream(self, payload: StreamCreateDTO) -> StreamDTO:
        """create_stream."""
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
            body["filters"] = [
                {"name": f.name, "mode": f.mode, "payload": f.payload}
                for f in payload.filters
            ]
        if payload.offers:
            body["offers"] = [
                {"offer_id": o.offer_id, "share": o.share, "state": o.state}
                for o in payload.offers
            ]
        if payload.comments is not None:
            body["comments"] = payload.comments
        s = await self._request("POST", "/streams", json=body)
        return self._to_stream(s, payload.campaign_id)

    async def get_stream(self, stream_id: int) -> StreamDTO:
        """get_stream."""
        s = await self._request("GET", f"/streams/{stream_id}", retries=2)
        return self._to_stream(s, s.get("campaign_id", 0))

    async def update_stream(
        self, stream_id: int, payload: StreamUpdateDTO
    ) -> StreamDTO:
        """update_stream."""
        s = await self._request("PUT", f"/streams/{stream_id}", json=payload.fields)
        return self._to_stream(s, s.get("campaign_id", 0))

    async def delete_stream(self, stream_id: int) -> None:
        """delete_stream."""
        await self._request("DELETE", f"/streams/{stream_id}")

    def _to_stream(self, s: dict, campaign_id: int) -> StreamDTO:
        """_to_stream."""
        filters = [
            StreamFilterDTO(
                name=f.get("name", ""),
                mode=f.get("mode", "accept"),
                payload=f.get("payload") or [],
            )
            for f in self._optional_object_list(s.get("filters"), "stream.filters")
        ]
        offers = [
            OfferStreamDTO(
                offer_id=o["offer_id"], share=o.get("share", 0), state=o.get("state")
            )
            for o in self._optional_object_list(s.get("offers"), "stream.offers")
        ]
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

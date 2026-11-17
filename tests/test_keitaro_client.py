"""Tests for Keitaro client."""

import httpx
import pytest

from app.application.dto import CampaignCreateDTO, DomainDTO
from app.keitaro_client.client import KeitaroClient, KeitaroError


def make_client(handler):
    """Create a client with a mock transport."""
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport, base_url="https://example.com")
    return KeitaroClient(http, api_key="secret-key")


@pytest.mark.asyncio
async def test_list_domains_success():
    """List domains returns typed DTOs."""

    def handler(request):
        assert request.headers.get("Api-Key") == "secret-key"
        return httpx.Response(200, json=[{"id": 1, "name": "d1", "state": "active"}])

    client = make_client(handler)
    domains = await client.list_domains()
    assert domains == [DomainDTO(id=1, name="d1", state="active")]


@pytest.mark.asyncio
async def test_401():
    """401 maps to KeitaroError."""

    def handler(request):
        return httpx.Response(401, json={"error": "Invalid API key"})

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.list_domains()
    assert exc.value.status == 401


@pytest.mark.asyncio
async def test_404():
    """404 maps to KeitaroError."""

    def handler(request):
        return httpx.Response(404, json={"error": "not found"})

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.get_offer(999)
    assert exc.value.status == 404


@pytest.mark.asyncio
async def test_422():
    """422 maps to KeitaroError."""

    def handler(request):
        return httpx.Response(422, json={"error": "validation"})

    payload = CampaignCreateDTO(alias="a", name="n")
    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.create_campaign(payload)
    assert exc.value.status == 422


@pytest.mark.asyncio
async def test_timeout():
    """Timeout maps to KeitaroError."""

    def handler(request):
        raise httpx.TimeoutException("timeout")

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.list_domains()
    assert exc.value.status == 0


@pytest.mark.asyncio
async def test_connection_failure():
    """Connection failure maps to KeitaroError."""

    def handler(request):
        raise httpx.ConnectError("boom")

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.list_domains()
    assert exc.value.status == 0


@pytest.mark.asyncio
async def test_malformed():
    """Malformed response maps to KeitaroError."""

    def handler(request):
        return httpx.Response(200, content=b"not json")

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.list_domains()
    assert exc.value.status == 200


@pytest.mark.asyncio
async def test_unexpected_shape():
    """Unexpected response shape does not crash list parsing."""

    def handler(request):
        return httpx.Response(200, json={"unexpected": True})

    client = make_client(handler)
    with pytest.raises(KeitaroError):
        await client.list_domains()


@pytest.mark.asyncio
async def test_bounded_get_retry():
    """GET retries on timeout up to bound."""

    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.TimeoutException("timeout")
        return httpx.Response(200, json=[])

    client = make_client(handler)
    result = await client.list_domains()
    assert result == []
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_no_retry_post():
    """POST is not retried on timeout."""

    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        raise httpx.TimeoutException("timeout")

    payload = CampaignCreateDTO(alias="a", name="n")
    client = make_client(handler)
    with pytest.raises(KeitaroError):
        await client.create_campaign(payload)
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_no_retry_put():
    """PUT is not retried on timeout."""

    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        raise httpx.TimeoutException("timeout")

    from app.application.dto import StreamUpdateDTO

    payload = StreamUpdateDTO(fields={"offers": []})
    client = make_client(handler)
    with pytest.raises(KeitaroError):
        await client.update_stream(1, payload)
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_no_retry_delete():
    """DELETE is not retried on timeout."""

    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        raise httpx.TimeoutException("timeout")

    client = make_client(handler)
    with pytest.raises(KeitaroError):
        await client.delete_stream(1)
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_list_campaigns_pagination():
    """list_campaigns uses offset/limit and aggregates pages."""

    def handler(request):
        offset = int(request.url.params.get("offset", 0))
        if offset == 0:
            return httpx.Response(200, json=[{"id": 1, "name": "c1"}])
        return httpx.Response(200, json=[{"id": 2, "name": "c2"}])

    client = make_client(handler)
    page1 = await client.list_campaigns(offset=0, limit=1)
    page2 = await client.list_campaigns(offset=1, limit=1)
    assert [c.id for c in page1] == [1]
    assert [c.id for c in page2] == [2]


@pytest.mark.asyncio
async def test_create_campaign_payload():
    """create_campaign sends typed payload."""

    def handler(request):
        body = request.read().decode()
        assert "alias" in body
        assert "name" in body
        return httpx.Response(200, json={"id": 10, "name": "n", "alias": "a"})

    payload = CampaignCreateDTO(
        alias="a", name="n", domain_id=1, group_id=2, traffic_source_id=3
    )
    client = make_client(handler)
    camp = await client.create_campaign(payload)
    assert camp.id == 10


@pytest.mark.asyncio
async def test_create_stream_payload():
    """create_stream sends typed payload."""

    from app.application.dto import StreamCreateDTO, StreamFilterInput, StreamOfferInput

    def handler(request):
        body = request.read().decode()
        assert "campaign_id" in body
        return httpx.Response(
            200,
            json={
                "id": 5,
                "campaign_id": 1,
                "type": "forced",
                "name": "s",
                "schema": "redirect",
            },
        )

    payload = StreamCreateDTO(
        campaign_id=1,
        type="forced",
        name="s",
        schema="redirect",
        action_type="http",
        filters=[StreamFilterInput(name="country", mode="accept", payload=["US"])],
        offers=[StreamOfferInput(offer_id=7, share=100)],
    )
    client = make_client(handler)
    stream = await client.create_stream(payload)
    assert stream.id == 5


@pytest.mark.asyncio
async def test_update_stream_replacement():
    """update_stream sends full replacement fields."""

    def handler(request):
        body = request.read().decode()
        assert "offers" in body
        return httpx.Response(
            200,
            json={
                "id": 5,
                "campaign_id": 1,
                "type": "regular",
                "name": "s",
                "schema": "landings",
                "offers": [{"offer_id": 7, "share": 100, "state": "active"}],
            },
        )

    from app.application.dto import StreamUpdateDTO

    payload = StreamUpdateDTO(
        fields={"offers": [{"offer_id": 7, "share": 100, "state": "active"}]}
    )
    client = make_client(handler)
    stream = await client.update_stream(5, payload)
    assert stream.id == 5


@pytest.mark.asyncio
async def test_error_message_no_secret():
    """Error messages do not include response body or secrets."""

    def handler(request):
        return httpx.Response(401, json={"error": "secret-token-123"})

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.list_domains()
    assert "secret-token-123" not in str(exc.value)

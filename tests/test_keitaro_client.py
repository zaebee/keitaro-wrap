import httpx
import pytest

from app.keitaro_client.client import KeitaroClient, KeitaroError
from app.application.dto import DomainDTO


def make_client(handler):
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport, base_url="https://example.com")
    return KeitaroClient(http)


@pytest.mark.asyncio
async def test_list_domains_success():
    def handler(request):
        return httpx.Response(200, json=[{"id": 1, "name": "d1", "state": "active"}])

    client = make_client(handler)
    domains = await client.list_domains()
    assert domains == [DomainDTO(id=1, name="d1", state="active")]


@pytest.mark.asyncio
async def test_401():
    def handler(request):
        return httpx.Response(401, json={"error": "Invalid API key"})

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.list_domains()
    assert exc.value.status == 401


@pytest.mark.asyncio
async def test_404():
    def handler(request):
        return httpx.Response(404, json={"error": "not found"})

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.get_offer(999)
    assert exc.value.status == 404


@pytest.mark.asyncio
async def test_422():
    def handler(request):
        return httpx.Response(422, json={"error": "validation"})

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.create_campaign(__import__("app.application.dto", fromlist=["CampaignCreateDTO"]).CampaignCreateDTO(alias="a", name="n"))
    assert exc.value.status == 422


@pytest.mark.asyncio
async def test_timeout():
    def handler(request):
        raise httpx.TimeoutException("timeout")

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.list_domains()
    assert exc.value.status == 0


@pytest.mark.asyncio
async def test_malformed():
    def handler(request):
        return httpx.Response(200, content=b"not json")

    client = make_client(handler)
    with pytest.raises(KeitaroError) as exc:
        await client.list_domains()
    assert exc.value.status == 200

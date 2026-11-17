"""Application-level tests for the Fetch use case and its D14 boundary."""

import threading
from typing import cast

import pytest

from app.application.dto import (
    FetchOutcome,
    FetchSnapshot,
    FetchStreamsCommand,
    OfferStreamDTO,
    StreamDTO,
)
from app.application.fetch import FetchInputError, FetchService
from app.application.ports import KeitaroClientPort, StreamReconciliationRepository
from app.keitaro_client.client import KeitaroError


class FakeClient:
    """Minimal async Keitaro port double for stream reads."""

    def __init__(self, streams: list[StreamDTO], failure: Exception | None = None):
        """Store the remote response and optional read failure."""
        self.streams = streams
        self.failure = failure
        self.calls: list[int] = []

    async def list_campaign_streams(self, campaign_id: int) -> list[StreamDTO]:
        """Return the configured streams or raise the configured failure."""
        self.calls.append(campaign_id)
        if self.failure is not None:
            raise self.failure
        return self.streams


class RecordingRepository:
    """Record snapshots and the thread that performed reconciliation."""

    def __init__(self):
        """Initialize empty records."""
        self.snapshots: list[FetchSnapshot] = []
        self.thread_ids: list[int] = []

    def reconcile(self, snapshot: FetchSnapshot) -> FetchOutcome:
        """Record a reconcile call from the offloaded thread."""
        self.snapshots.append(snapshot)
        self.thread_ids.append(threading.get_ident())
        return FetchOutcome(
            campaign_id=snapshot.campaign_id,
            stream_count=len(snapshot.streams),
            reconciled_stream_count=sum(bool(item.offers) for item in snapshot.streams),
        )


def workflow(client: FakeClient, repository: RecordingRepository) -> FetchService:
    """Cast minimal doubles to the application protocols."""
    return FetchService(
        cast(KeitaroClientPort, client),
        cast(StreamReconciliationRepository, repository),
    )


def stream(
    stream_id: int, offers: list[OfferStreamDTO], campaign_id: int = 5
) -> StreamDTO:
    """Build a remote stream DTO for tests."""
    return StreamDTO(
        id=stream_id,
        campaign_id=campaign_id,
        type="regular",
        name=f"stream-{stream_id}",
        schema="landings",
        offers=offers,
    )


@pytest.mark.asyncio
async def test_fetch_reads_once_and_offloads_reconciliation():
    """Fetch builds one snapshot, preserves order and respects the D14 boundary."""
    client = FakeClient(
        [
            stream(11, []),
            stream(
                12,
                [
                    OfferStreamDTO(offer_id=8, share=25, state="active"),
                    OfferStreamDTO(offer_id=5, share=75, state="active"),
                ],
            ),
        ]
    )
    repository = RecordingRepository()
    use_case = workflow(client, repository)

    outcome = await use_case.fetch(FetchStreamsCommand(campaign_id=5))

    assert client.calls == [5]
    assert outcome.stream_count == 2
    assert outcome.reconciled_stream_count == 1
    assert len(repository.snapshots) == 1
    snapshot = repository.snapshots[0]
    assert snapshot.campaign_id == 5
    assert [item.stream_ref for item in snapshot.streams] == [11, 12]
    assert snapshot.streams[0].offers == ()
    assert [
        (item.offer_id, item.share, item.position)
        for item in snapshot.streams[1].offers
    ] == [
        (8, 25, 0),
        (5, 75, 1),
    ]
    assert repository.thread_ids[0] != threading.get_ident()


@pytest.mark.asyncio
async def test_duplicate_remote_offers_fail_before_any_local_write():
    """A duplicate in one stream fails the whole Fetch before reconciliation."""
    client = FakeClient(
        [
            stream(11, [OfferStreamDTO(offer_id=1, share=100)]),
            stream(
                12,
                [
                    OfferStreamDTO(offer_id=7, share=50),
                    OfferStreamDTO(offer_id=7, share=50),
                ],
            ),
        ]
    )
    repository = RecordingRepository()
    use_case = workflow(client, repository)
    command = FetchStreamsCommand(campaign_id=5)
    with pytest.raises(FetchInputError, match="duplicate offer_id 7"):
        await use_case.fetch(command)
    assert repository.snapshots == []


@pytest.mark.asyncio
async def test_malformed_remote_offer_fails_before_any_local_write():
    """Invalid shares are rejected before the repository may run."""
    client = FakeClient([stream(12, [OfferStreamDTO(offer_id=7, share=101)])])
    repository = RecordingRepository()
    use_case = workflow(client, repository)
    command = FetchStreamsCommand(campaign_id=5)
    with pytest.raises(FetchInputError, match="share must be an int in 0..100"):
        await use_case.fetch(command)
    assert repository.snapshots == []


@pytest.mark.asyncio
async def test_client_read_failure_leaves_local_state_untouched():
    """Keitaro errors propagate and no reconcile happens."""
    failure = KeitaroError(0, "timeout")
    client = FakeClient([], failure=failure)
    repository = RecordingRepository()
    use_case = workflow(client, repository)
    command = FetchStreamsCommand(campaign_id=5)
    with pytest.raises(KeitaroError) as exc:
        await use_case.fetch(command)
    assert exc.value is failure
    assert repository.snapshots == []


@pytest.mark.asyncio
@pytest.mark.parametrize("stream_id, campaign_id", [(0, 5), (12, 0), (12, -1)])
async def test_invalid_remote_stream_identity_is_rejected(
    stream_id: int, campaign_id: int
):
    """Malformed remote stream ids fail before reconciliation."""
    bad = stream(stream_id, [], campaign_id=campaign_id)
    repository = RecordingRepository()
    use_case = workflow(FakeClient([bad]), repository)
    command = FetchStreamsCommand(campaign_id=5)
    with pytest.raises(FetchInputError, match="must be"):
        await use_case.fetch(command)
    assert repository.snapshots == []


@pytest.mark.asyncio
async def test_foreign_campaign_stream_aborts_fetch_before_repository():
    """A stream returned for another campaign fails the whole Fetch."""
    foreign = stream(12, [OfferStreamDTO(offer_id=7, share=100)], campaign_id=6)
    repository = RecordingRepository()
    use_case = workflow(FakeClient([foreign]), repository)
    command = FetchStreamsCommand(campaign_id=5)
    with pytest.raises(FetchInputError, match="does not match requested campaign 5"):
        await use_case.fetch(command)
    assert repository.snapshots == []


@pytest.mark.asyncio
@pytest.mark.parametrize("campaign_id", [0, -3, "5"])
async def test_invalid_command_is_rejected(campaign_id: object):
    """Fetch rejects non-positive or non-integer campaign ids."""
    repository = RecordingRepository()
    use_case = workflow(FakeClient([]), repository)
    command = FetchStreamsCommand(campaign_id=cast(int, campaign_id))
    with pytest.raises(FetchInputError, match="positive int"):
        await use_case.fetch(command)
    assert repository.snapshots == []

"""Application-level tests for local draft editing commands."""

import threading
from typing import cast

import pytest

from app.application.draft import DraftService
from app.application.dto import (
    AddOfferCommand,
    CancelDraftCommand,
    DraftCommandBase,
    DraftCommandResult,
    DraftView,
    RemoveOfferCommand,
    RestoreOfferCommand,
    SetPinCommand,
    SetShareCommand,
    to_domain_command,
)
from app.application.ports import StreamDraftRepository
from app.domain.draft import DraftCommandKind


class FakeRepository:
    """Record converted intents and the thread used for repository work."""

    def __init__(self):
        """Initialise empty records."""
        self.calls: list[tuple[DraftCommandBase, object]] = []
        self.thread_ids: list[int] = []
        self.view = cast(DraftView, object())

    def apply(self, command: DraftCommandBase, intent: object) -> DraftCommandResult:
        """Record one call from the offloaded thread."""
        self.calls.append((command, intent))
        self.thread_ids.append(threading.get_ident())
        return DraftCommandResult(view=self.view)

    def get_view(self, stream_ref: int) -> DraftView | None:
        """Return the configured view off the event loop."""
        self.thread_ids.append(threading.get_ident())
        return self.view


def service(repository: FakeRepository) -> DraftService:
    """Cast the minimal double to the application port."""
    return DraftService(cast(StreamDraftRepository, repository))


@pytest.mark.asyncio
async def test_all_commands_dispatch_and_offload_repository_work():
    """Every command converts to a pure intent and respects D14."""
    repository = FakeRepository()
    use_case = service(repository)
    main_thread = threading.get_ident()

    await use_case.add(AddOfferCommand(5, 12, 1, 9))
    await use_case.remove(RemoveOfferCommand(5, 12, 2, 5))
    await use_case.restore(RestoreOfferCommand(5, 12, 3, 5))
    await use_case.set_pin(SetPinCommand(5, 12, 4, 8, True))
    await use_case.set_share(SetShareCommand(5, 12, 5, 8, 40))
    await use_case.cancel(CancelDraftCommand(5, 12, 6))
    await use_case.get_view(12)

    kinds = [to_domain_command(command).kind for command, _ in repository.calls]
    assert kinds == [
        DraftCommandKind.ADD,
        DraftCommandKind.REMOVE,
        DraftCommandKind.RESTORE,
        DraftCommandKind.SET_PIN,
        DraftCommandKind.SET_SHARE,
        DraftCommandKind.CANCEL,
    ]
    assert len(repository.calls) == 6
    assert all(thread_id != main_thread for thread_id in repository.thread_ids)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        AddOfferCommand(0, 12, 0, 9),
        AddOfferCommand(5, 0, 0, 9),
        AddOfferCommand(5, 12, -1, 9),
    ],
)
async def test_invalid_command_is_rejected_before_repository(command):
    """Malformed identity/version input never reaches persistence."""
    repository = FakeRepository()
    use_case = service(repository)
    with pytest.raises(ValueError):
        await use_case._apply(command)
    assert repository.calls == []

"""Units for the resumable sync path (no node): range chunking and at-least-once appends.

``sync`` persists each acquired block range and checkpoints its end before requesting the
next, so these pin the two properties that makes safe: ranges tile ``[from, to]`` exactly,
each carrying both acquisition legs; and a range re-appended after an interruption loads
back once.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ethswarm_volumes import acquire, store
from ethswarm_volumes.model import EventLogRow

REGISTRY = "0x" + "11" * 20
BZZ = "0x" + "22" * 20
POSTAGE = "0x" + "33" * 20
DEP = (100, REGISTRY)


class _RecordingRpc:
    def __init__(self) -> None:
        self.calls: list[tuple[int, int, str, object]] = []

    def finalized_block_number(self) -> int:
        return 0

    def get_logs(self, *, from_block, to_block, address, topics):
        self.calls.append((from_block, to_block, address, topics))
        return [{"address": address, "range": (from_block, to_block)}]


def test_chunks_tile_the_range_with_both_legs():
    rpc = _RecordingRpc()
    chunks = list(
        acquire.iter_log_chunks(
            rpc,
            registry=REGISTRY,
            bzz_token=BZZ,
            postage=POSTAGE,
            from_block=5,
            to_block=29,
            chunk_size=10,
        )
    )
    assert [(s, e) for s, e, _ in chunks] == [(5, 14), (15, 24), (25, 29)]
    for start, end, logs in chunks:
        assert [log["address"] for log in logs] == [REGISTRY, BZZ]
        assert all(log["range"] == (start, end) for log in logs)
    # the fee leg is topic-filtered to Transfer(registry -> postage); the registry leg is not
    registry_topics = {topics for _, _, addr, topics in rpc.calls if addr == REGISTRY}
    fee_topics = [topics for _, _, addr, topics in rpc.calls if addr == BZZ]
    assert registry_topics == {None}
    assert fee_topics[0][0] == acquire.TRANSFER_TOPIC


def test_empty_range_requests_nothing():
    rpc = _RecordingRpc()
    kw = dict(registry=REGISTRY, bzz_token=BZZ, postage=POSTAGE, from_block=10, to_block=9)
    assert list(acquire.iter_log_chunks(rpc, **kw)) == []
    assert rpc.calls == []


def _row(block: int, log_index: int, event: str = "Toppedup") -> EventLogRow:
    return EventLogRow(
        deployment_id=DEP,
        block_number=block,
        block_ts=datetime(2026, 8, 6, tzinfo=timezone.utc),
        tx_hash="0x" + "ab" * 32,
        tx_index=0,
        log_index=log_index,
        emitter=REGISTRY,
        event_name=event,
        args={"volume_id": "0x01", "amount": 1, "new_normalised_balance": 2},
    )


def test_reappended_chunk_loads_once(tmp_path):
    """A process killed between appending a chunk and saving its head re-appends that
    chunk on the next run; loading dedupes by chain position."""
    chunk = [_row(10, 0), _row(10, 1), _row(12, 0)]
    store.append_rows(tmp_path, chunk)
    store.append_rows(tmp_path, chunk)  # the retried chunk
    store.append_rows(tmp_path, [_row(15, 3)])
    rows = store.load_event_log(tmp_path, DEP).merged()
    assert [(r.block_number, r.log_index) for r in rows] == [(10, 0), (10, 1), (12, 0), (15, 3)]

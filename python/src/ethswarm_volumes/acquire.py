"""The web3 acquisition layer: fetch + filter logs up to ``finalized``.

Part of the isolated web3 layer (``docs/ARCHITECTURE.md`` §2). Reads only to the
chain's ``finalized`` block, so there is no reorg handling. The acquisition filter
(``docs/data-model/event-log.md``) is: all registry events, plus BZZ ``Transfer`` logs
with ``from == registry`` and ``to == postage``. Logs are acquired per event type
(topic-filtered) and, once decoded, stored that way — one log per type
(:class:`~ethswarm_volumes.model.EventLog`), never merged into a single relation.

``RpcClient`` is the seam the tests replace with a replay/recorded transport.
"""

from __future__ import annotations

from typing import Any, Protocol

from web3 import Web3

from .model import DeploymentId

#: ``Transfer(address,address,uint256)`` topic0 — the ERC-20 fee leg selector.
TRANSFER_TOPIC = "0x" + Web3.keccak(text="Transfer(address,address,uint256)").hex()


class RpcClient(Protocol):
    """Minimal eth JSON-RPC surface the acquisition layer needs."""

    def finalized_block_number(self) -> int: ...

    def get_logs(
        self, *, from_block: int, to_block: int, address: str, topics: list[Any]
    ) -> list[dict[str, Any]]: ...


def _topic_address(address: str) -> str:
    """An address as a 32-byte (left zero-padded) topic, lowercased hex."""
    return "0x" + address[2:].lower().rjust(64, "0")


def _chunked(
    rpc: RpcClient,
    *,
    from_block: int,
    to_block: int,
    address: str,
    topics: list[Any] | None,
    chunk_size: int,
) -> list[dict[str, Any]]:
    """Range-chunked ``get_logs`` over ``[from_block, to_block]`` inclusive."""
    out: list[dict[str, Any]] = []
    start = from_block
    while start <= to_block:
        end = min(start + chunk_size - 1, to_block)
        out.extend(rpc.get_logs(from_block=start, to_block=end, address=address, topics=topics))
        start = end + 1
    return out


def acquire_logs(
    rpc: RpcClient,
    *,
    deployment_id: DeploymentId,
    registry: str,
    bzz_token: str,
    postage: str,
    from_block: int,
    to_block: int | None = None,
    chunk_size: int = 10_000,
) -> list[dict[str, Any]]:
    """Fetch the filtered raw logs from ``from_block`` up to the head block.

    Range-chunked by ``chunk_size``. Applies the ``docs/data-model/event-log.md`` acquisition
    filter — every registry
    event (no topic filter on the registry address), plus the canonical fee leg: BZZ
    ``Transfer`` logs with ``from == registry`` and ``to == postage`` (server-side topic
    filter).

    ``to_block`` is the inclusive head; when ``None`` it defaults to the chain's current
    ``finalized`` block (the reorg-safe head — ADR-0002), and is never read past. Callers
    pass it explicitly to pin a deterministic head — e.g. a node whose ``finalized`` tag
    does not track ``latest`` supplies ``latest`` directly. The returned list is unordered;
    the store/projector reconstruct chain order.
    """
    if to_block is None:
        to_block = rpc.finalized_block_number()
    if from_block > to_block:
        return []

    logs: list[dict[str, Any]] = []
    # All registry events (no topic filter — the registry address is the filter).
    logs.extend(
        _chunked(
            rpc,
            from_block=from_block,
            to_block=to_block,
            address=registry,
            topics=None,
            chunk_size=chunk_size,
        )
    )
    # The fee leg: BZZ Transfer(registry -> postage).
    logs.extend(
        _chunked(
            rpc,
            from_block=from_block,
            to_block=to_block,
            address=bzz_token,
            topics=[TRANSFER_TOPIC, _topic_address(registry), _topic_address(postage)],
            chunk_size=chunk_size,
        )
    )
    return logs

"""Production web3 layer: the live-node side of the indexer (``docs/ARCHITECTURE.md`` §2).

This is the only module the ``sync`` path uses to touch a chain. It holds:

- :class:`Web3RpcClient` — the production :class:`~ethswarm_volumes.acquire.RpcClient`,
  reading logs and the ``finalized`` head over JSON-RPC.
- :func:`resolve_extra` — the version-specific ``extra`` wiring (``postage`` / ``bzz`` /
  ``price_oracle`` / ``grace_blocks``), read back from the registry + postage contracts so
  it never has to be configured by hand (``docs/usage.md`` §2).
- :func:`find_genesis_block` / :func:`block_timestamp` — one-time genesis discovery and the
  block-time lookups the decoder needs.

Everything here produces web3-free values; the rows it feeds downstream cross the
``event_log`` boundary as plain data.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from web3 import Web3

#: Minimal ABI for the registry/postage getters used to resolve ``extra``.
_WIRING_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": name,
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"type": out}],
    }
    for name, out in (
        ("postage", "address"),
        ("bzz", "address"),
        ("graceBlocks", "uint64"),
        ("priceOracle", "address"),
    )
]


def connect(rpc_url: str) -> Web3:
    """A ``Web3`` connected to ``rpc_url`` (HTTP)."""
    return Web3(Web3.HTTPProvider(rpc_url))


class Web3RpcClient:
    """The production :class:`~ethswarm_volumes.acquire.RpcClient`, backed by web3.

    ``finalized_block_number`` reads the chain's ``finalized`` tag, so acquisition never
    reads past a reorg-safe head (``docs/ARCHITECTURE.md`` §2 / ADR-0002).
    """

    def __init__(self, w3: Web3) -> None:
        self._w3 = w3

    def finalized_block_number(self) -> int:
        return self._w3.eth.get_block("finalized")["number"]

    def get_logs(
        self, *, from_block: int, to_block: int, address: str, topics: list[Any] | None
    ) -> list[dict[str, Any]]:
        flt: dict[str, Any] = {"fromBlock": from_block, "toBlock": to_block}
        if address is not None:
            # Addresses travel verbatim (lowercase) as store partition keys; web3's
            # get_logs filter requires a checksum address, so convert at the boundary.
            flt["address"] = Web3.to_checksum_address(address)
        if topics is not None:
            flt["topics"] = topics
        return [dict(log) for log in self._w3.eth.get_logs(flt)]


def resolve_extra(w3: Web3, registry: str) -> dict[str, Any]:
    """Read the ``extra`` wiring from the registry (+ its postage) contract.

    Returns ``{grace_blocks, postage, price_oracle, bzz}`` — the v1 ``extra`` shape
    (``docs/SCHEMA.md`` §3). ``postage`` / ``bzz`` / ``graceBlocks`` are registry getters;
    ``priceOracle`` is read from the resolved postage contract (``docs/usage.md`` §2).
    """
    reg = w3.eth.contract(address=Web3.to_checksum_address(registry), abi=_WIRING_ABI)
    postage = reg.functions.postage().call()
    bzz = reg.functions.bzz().call()
    grace_blocks = reg.functions.graceBlocks().call()

    stamp = w3.eth.contract(address=Web3.to_checksum_address(postage), abi=_WIRING_ABI)
    try:
        price_oracle = stamp.functions.priceOracle().call()
    except Exception:
        price_oracle = None

    extra: dict[str, Any] = {
        "grace_blocks": grace_blocks,
        "postage": postage,
        "bzz": bzz,
    }
    if price_oracle is not None:
        extra["price_oracle"] = price_oracle
    return extra


def block_timestamp(w3: Web3, block_number: int) -> datetime:
    """The UTC, timezone-aware timestamp of ``block_number``."""
    ts = w3.eth.get_block(block_number)["timestamp"]
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def block_timestamps(w3: Web3, block_numbers: set[int]) -> dict[int, datetime]:
    """Resolve many block timestamps (one ``eth_getBlockByNumber`` each)."""
    return {n: block_timestamp(w3, n) for n in block_numbers}


def find_genesis_block(w3: Web3, address: str) -> int:
    """The contract-creation block of ``address``, by binary search on ``eth_getCode``.

    The lowest block at which the address has code. ``O(log n)`` calls — run once per
    deployment (the first sync), after which the per-deployment head supersedes it.
    """
    checksum = Web3.to_checksum_address(address)

    def has_code(block: int) -> bool:
        return len(w3.eth.get_code(checksum, block_identifier=block)) > 0

    lo, hi = 0, w3.eth.block_number
    if not has_code(hi):
        raise ValueError(f"no contract code at {address} as of block {hi}")
    while lo < hi:
        mid = (lo + hi) // 2
        if has_code(mid):
            hi = mid
        else:
            lo = mid + 1
    return lo

"""Production web3 seam (:mod:`ethswarm_volumes.node`): filter-construction regressions.

Pure units over :class:`~ethswarm_volumes.node.Web3RpcClient` with a recording stub in
place of a live ``web3`` — the integration tiers replace ``RpcClient`` wholesale, so the
production transport's own filter assembly is otherwise unexercised.
"""

from __future__ import annotations

from types import SimpleNamespace

from web3 import Web3

from ethswarm_volumes.node import Web3RpcClient

#: A registry address spelled the way the store carries it: verbatim, lowercase. This is the
#: partition key, deliberately un-normalized (see ``test_registry``).
LOWERCASE_REGISTRY = "0x9639ae4c7a8fa9efe585738d516a3915ddd02aad"


class _RecordingEth:
    """Stand-in for ``w3.eth`` that captures the filter handed to ``get_logs``."""

    def __init__(self) -> None:
        self.captured: dict | None = None

    def get_logs(self, flt: dict) -> list:
        self.captured = flt
        return []


def _client() -> tuple[Web3RpcClient, _RecordingEth]:
    eth = _RecordingEth()
    return Web3RpcClient(SimpleNamespace(eth=eth)), eth


def test_get_logs_checksums_lowercase_address() -> None:
    """The verbatim lowercase store address is checksummed before reaching ``get_logs``.

    Regression: ``web3``'s ``eth_getLogs`` rejects a non-checksum ``address`` with
    ``InvalidAddress``, so passing the store's lowercase partition-key address straight into
    the filter crashed every live ``sync``. The boundary must convert it.
    """
    client, eth = _client()
    client.get_logs(from_block=1, to_block=2, address=LOWERCASE_REGISTRY, topics=None)

    assert eth.captured is not None
    assert eth.captured["address"] == Web3.to_checksum_address(LOWERCASE_REGISTRY)
    # And it genuinely changed — guards against the address being passed through verbatim.
    assert eth.captured["address"] != LOWERCASE_REGISTRY


def test_get_logs_omits_unset_filter_keys() -> None:
    """A ``None`` address or topics list is left out of the filter entirely."""
    client, eth = _client()
    client.get_logs(from_block=5, to_block=9, address=None, topics=None)

    assert eth.captured == {"fromBlock": 5, "toBlock": 9}

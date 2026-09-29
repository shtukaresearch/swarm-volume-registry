"""Tier 1 — raw event-log decoder (``docs/TESTING.md``).

Drives a real timeline on the node, pulls the registry + fee-leg logs through the production
acquisition path (real ``eth_getLogs``), decodes each, and validates that the decoded
``EventLogRow`` conforms to the ``event_log`` schema (``data-model/event-log.md``). There is no
value oracle for a decoder in isolation — schema conformance is the ceiling — so that is what
this tier asserts; the *values* are checked end-to-end against node state in tier 2.

Red until ``acquire``/``decode`` are implemented.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ethswarm_volumes import acquire, decode

import harness as H

#: event_name -> the exact ``args`` key set (data-model/event-log.md catalogue).
CATALOGUE = {
    "VolumeCreated": {"volume_id", "owner", "chunk_signer", "depth", "ttl_expiry"},
    "VolumeRetired": {"volume_id", "reason"},
    "VolumeOwnershipTransferred": {"volume_id", "from", "to"},
    "AccountActivated": {"owner", "payer"},
    "AccountRevoked": {"owner", "payer", "revoker"},
    "Toppedup": {"volume_id", "amount", "new_normalised_balance"},
    "Transfer": {"from", "to", "value"},
    "PayerDesignated": {"owner", "payer"},
    "TopupSkipped": {"volume_id", "reason"},
}
_ADDR_FIELDS = {"owner", "payer", "from", "to", "revoker", "chunk_signer"}
_INT_FIELDS = {"depth", "ttl_expiry", "amount", "value", "new_normalised_balance"}


def _decoded_rows(chain):
    """Acquire (real ``eth_getLogs``) then decode every captured log."""
    rpc = H.Web3RpcClient(chain.w3)
    dep_id = (chain.w3.eth.chain_id, chain.s.registry.address)
    raw = acquire.acquire_logs(
        rpc,
        deployment_id=dep_id,
        registry=chain.s.registry.address,
        bzz_token=chain.s.bzz.address,
        postage=chain.s.stamp.address,
        from_block=chain.s.genesis_block,
    )
    return [
        decode.decode_log(log, deployment_id=dep_id, registry_version=chain.version) for log in raw
    ]


def test_block_ts_comes_from_the_log_and_matches_the_block(chain):
    """``block_ts`` is read off the log (``blockTimestamp``) with no block lookup; the
    node's own block header is the independent oracle for it."""
    H.drive_basic(chain)
    rows = _decoded_rows(chain)
    assert rows
    for row in rows:
        header_ts = chain.w3.eth.get_block(row.block_number)["timestamp"]
        assert row.block_ts == datetime.fromtimestamp(header_ts, tz=timezone.utc)


@pytest.mark.parametrize("value", ["0x6a7426e6", 1785997030])
def test_log_timestamp_accepts_hex_and_int(value):
    ts = decode.log_timestamp({"blockTimestamp": value})
    assert ts == datetime(2026, 8, 6, 6, 17, 10, tzinfo=timezone.utc)


def test_log_without_block_timestamp_is_an_error():
    """No fallback to ``eth_getBlockByNumber``: a node that omits the field is refused."""
    with pytest.raises(decode.MissingBlockTimestampError, match="blockTimestamp"):
        decode.log_timestamp({"blockNumber": 1})


def test_pinned_abis_match_version_fixture():
    """The two pinned copies of each version agree (pure unit, no node).

    ``decode._VERSIONS[v]`` (the package's decode reference data) and
    ``tests/fixtures/<v>/`` (the frozen build the harness deploys) are independent pins of
    the same deployed contract; this ties them together. The pinned event set must be
    exactly the fixture ``VolumeRegistry``'s events plus the ERC-20 ``Transfer`` (the fee
    leg), each ABI verbatim (name, inputs, indexed flags) — the version key doubles as the
    fixture directory name, so an entry without a fixture (or vice versa) also fails here.
    """

    def by_name(abi):
        return {e["name"]: e for e in abi if e["type"] == "event"}

    def shape(e):
        return (
            e["name"],
            e.get("anonymous", False),
            tuple((i["name"], i["type"], i["indexed"]) for i in e["inputs"]),
        )

    for version, ref in decode._VERSIONS.items():
        registry_events = by_name(H.load_artifact("VolumeRegistry", version)[0])
        erc20_events = by_name(H.load_artifact("TestToken", version)[0])
        pinned = by_name(ref["abis"])
        assert set(pinned) == set(registry_events) | {"Transfer"}, version
        for name, event in pinned.items():
            compiled = erc20_events[name] if name == "Transfer" else registry_events[name]
            assert shape(event) == shape(compiled), f"{version}:{name}"


def test_decoded_rows_conform_to_schema(chain):
    H.drive_basic(chain)
    rows = _decoded_rows(chain)
    assert rows, "expected the acquisition to return some logs"
    for r in rows:
        assert r.event_name in CATALOGUE, f"unknown event {r.event_name!r}"
        assert set(r.args) == CATALOGUE[r.event_name], f"args mismatch for {r.event_name}"
        # enums decoded to names (strings, not ints)
        if "reason" in r.args:
            assert isinstance(r.args["reason"], str) and not r.args["reason"].isdigit()
        # addresses are lowercased hex; amounts are integer atomic units
        for k in _ADDR_FIELDS & set(r.args):
            v = r.args[k]
            assert isinstance(v, str) and v.startswith("0x") and v == v.lower()
        for k in _INT_FIELDS & set(r.args):
            assert isinstance(r.args[k], int)
        if "volume_id" in r.args:
            assert isinstance(r.args["volume_id"], str) and r.args["volume_id"].startswith("0x")
        # boundary record stamps
        assert r.block_ts.tzinfo is not None
        assert isinstance(r.block_number, int) and isinstance(r.log_index, int)

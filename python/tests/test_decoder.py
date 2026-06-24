"""Tier 1 — raw event-log decoder (``docs/TESTING.md``).

Drives a real timeline on the node, pulls the registry + fee-leg logs through the production
acquisition path (real ``eth_getLogs``), decodes each, and validates that the decoded
``EventLogRow`` conforms to the ``event_log`` schema (``ARCHITECTURE.md`` §4.3). There is no
value oracle for a decoder in isolation — schema conformance is the ceiling — so that is what
this tier asserts; the *values* are checked end-to-end against node state in tier 2.

Red until ``acquire``/``decode`` are implemented.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ethswarm_volumes import acquire, decode

import harness as H

#: event_name -> the exact ``args`` key set (ARCHITECTURE.md §4.3 catalogue).
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
    rows = []
    for log in raw:
        ts = chain.w3.eth.get_block(log["blockNumber"])["timestamp"]
        rows.append(
            decode.decode_log(
                log,
                deployment_id=dep_id,
                block_ts=datetime.fromtimestamp(ts, tz=timezone.utc),
                registry_version="v1",
            )
        )
    return rows


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

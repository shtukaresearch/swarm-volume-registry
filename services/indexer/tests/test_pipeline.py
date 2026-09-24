"""Tier 2 — decoder + projector vs node state (``docs/TESTING.md``).

Drives a real timeline, runs the full pipeline (real ``eth_getLogs`` -> ``decode`` ->
``EventLog`` -> ``project_entry``), and asserts the projected artifact against an **independent
oracle read from the node**: per-UTC-day postage BZZ-balance deltas (fee), ``getActiveVolumeCount``
+ depths (capacity), and a ``getAccount`` recount (authorized), plus the as_of snapshot.

Red until ``acquire``/``decode``/``project`` are implemented.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ethswarm_volumes import acquire, capacity, decode, project
from ethswarm_volumes.model import Deployment, EventLog

import harness as H


def _project(chain, as_of_ts: int):
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
    rows = [
        decode.decode_log(
            log,
            deployment_id=dep_id,
            block_ts=datetime.fromtimestamp(
                chain.w3.eth.get_block(log["blockNumber"])["timestamp"], tz=timezone.utc
            ),
            registry_version="v1",
        )
        for log in raw
    ]
    d = chain.deployment_doc()
    dep = Deployment(
        label=d["label"],
        chain_id=d["chain_id"],
        registry=d["registry"],
        registry_version=d["registry_version"],
        genesis_ts=d["genesis_ts"],
        fiat_currencies=d["fiat_currencies"],
        extra=d["extra"],
    )
    return project.project_entry(
        dep,
        EventLog.from_rows(rows),
        [],
        as_of_block=chain.w3.eth.block_number,
        as_of_ts=datetime.fromtimestamp(as_of_ts, tz=timezone.utc),
    )


@pytest.mark.parametrize(
    "driver",
    [H.drive_basic, H.drive_revoke_reconfirm],
    ids=["basic", "revoke-reconfirm"],
)
def test_projection_matches_node_state(chain, driver):
    as_of_ts = driver(chain)
    orc = H.oracle(chain, as_of_ts)
    entry = _project(chain, as_of_ts)

    fee = {d.date: d.bzz for d in entry.fee_volume_daily}
    for date, bzz in orc.fee_bzz.items():
        assert fee[date] == pytest.approx(bzz)

    cap = {d.date: d for d in entry.capacity_daily}
    for date, (count, depths) in orc.cap.items():
        assert cap[date].active_volumes == count
        assert cap[date].nominal_bytes == sum(capacity.nominal_bytes(x) for x in depths)
        assert cap[date].effective_bytes == sum(capacity.effective_bytes(x) for x in depths)

    acc = {d.date: d.authorized for d in entry.accounts_daily}
    for date, a in orc.authorized.items():
        assert acc[date] == a

    assert entry.snapshot.capacity.active_volumes == orc.snap_active
    assert entry.snapshot.accounts.authorized == orc.snap_authorized
    assert entry.snapshot.fee_volume_total_bzz == pytest.approx(orc.fee_total_bzz)

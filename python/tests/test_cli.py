"""End-to-end CLI integration: real node -> ``sync`` -> artifact -> ``stat`` (``docs/ARCHITECTURE.md`` §7).

Exercises the whole write+read path through the production seams (``node`` RPC client,
contract-immutable + genesis discovery, serializer, view-model) — the layers the projector
tiers don't touch. Anvil pins its ``finalized`` tag to block 0, so ``sync`` is pointed at the
real head with ``--to-block <latest>`` (the argument that exists precisely for a node whose
``finalized`` does not track ``latest``); no monkeypatching.

Skips with the rest of the integration suite when ``anvil`` / artifacts are absent.
"""

from __future__ import annotations

import json

import pytest

from ethswarm_volumes import capacity, cli, serialize

import harness as H


def _write_config(tmp_path, chain) -> str:
    cfg = tmp_path / "registry.json"
    cfg.write_text(
        json.dumps(
            {
                "deployments": [
                    {
                        "label": "anvil",
                        "chain_id": chain.w3.eth.chain_id,
                        "registry": chain.s.registry.address,
                        "registry_version": "v1",
                    }
                ]
            }
        )
    )
    return str(cfg)


def test_cli_sync_then_stat(chain, tmp_path, capsys):
    H.drive_basic(chain)
    latest = chain.w3.eth.block_number
    as_of_ts = chain.w3.eth.get_block(latest)["timestamp"]
    orc = H.oracle(chain, as_of_ts)

    store_dir = str(tmp_path / "store")
    cfg = _write_config(tmp_path, chain)
    rpc_url = chain.w3.provider.endpoint_uri

    # --- sync to the real head ---
    rc = cli.main(
        [
            "--store-dir",
            store_dir,
            "sync",
            "--rpc",
            rpc_url,
            "--config",
            cfg,
            "--to-block",
            str(latest),
        ]
    )
    assert rc == 0

    artifact_path = tmp_path / "store" / "artifact.json"
    artifact = serialize.artifact_from_json(artifact_path.read_text())
    assert len(artifact.deployments) == 1
    entry = artifact.deployments[0]

    # genesis was discovered (no genesis_block in config); extra resolved from the contract
    assert entry.extra["postage"].lower() == chain.s.stamp.address.lower()
    assert entry.extra["bzz"].lower() == chain.s.bzz.address.lower()

    # --- projected artifact matches the independent node oracle ---
    fee = {d.date: d.bzz for d in entry.fee_volume_daily}
    for date, bzz in orc.fee_bzz.items():
        assert fee[date] == pytest.approx(bzz)

    cap = {d.date: d for d in entry.capacity_daily}
    for date, (count, depths) in orc.cap.items():
        assert cap[date].active_volumes == count
        assert cap[date].nominal_bytes == sum(capacity.nominal_bytes(x) for x in depths)

    assert entry.snapshot.capacity.active_volumes == orc.snap_active
    assert entry.snapshot.accounts.authorized == orc.snap_authorized
    assert entry.snapshot.fee_volume_total_bzz == pytest.approx(orc.fee_total_bzz)
    assert set(entry.snapshot.accounts.paid_in_window) == {"1d", "7d", "30d"}

    # --- incremental sync to the same head is a no-op ---
    capsys.readouterr()
    rc = cli.main(
        [
            "--store-dir",
            store_dir,
            "sync",
            "--rpc",
            rpc_url,
            "--config",
            cfg,
            "--to-block",
            str(latest),
        ]
    )
    assert rc == 0
    assert "0 new logs" in capsys.readouterr().err

    # --- stat --json reads the artifact back and folds it ---
    rc = cli.main(
        ["--store-dir", store_dir, "stat", "anvil", "--source", str(artifact_path), "--json"]
    )
    assert rc == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["deployment"]["label"] == "anvil"
    assert summary["capacity"]["active_volumes"] == orc.snap_active
    assert summary["accounts"]["authorized"] == orc.snap_authorized
    assert summary["fee_volume"]["unit"] == "BZZ"  # no fiat baked for a local chain

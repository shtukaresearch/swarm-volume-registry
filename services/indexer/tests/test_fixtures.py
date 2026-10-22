"""The pinned fixtures are what the deployment records say was deployed (no node, no build).

A release's ``VolumeRegistry`` fixture is derived from its committed deployment records
(``scripts/vendor_fixtures.py release``): this re-derives it and requires the committed
file to match, so a fixture can never drift from the record it claims to be. Fixtures that
predate deployment records (v1) carry no ``record`` in their provenance and are skipped.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

import harness as H

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "vendor_fixtures.py"
_spec = importlib.util.spec_from_file_location("vendor_fixtures", _SCRIPT)
vendor_fixtures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vendor_fixtures)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _record_backed(version: str) -> list[str]:
    provenance = json.loads((FIXTURES / version / "provenance.json").read_text())
    return [d["record"] for d in provenance.get("deployments", []) if "record" in d]


@pytest.mark.parametrize("version", H.REGISTRY_VERSIONS)
def test_fixture_matches_its_deployment_records(version):
    records = _record_backed(version)
    if not records:
        pytest.skip(f"{version} predates deployment records")
    committed = json.loads((FIXTURES / version / "VolumeRegistry.json").read_text())
    for record in records:
        derived, _ = vendor_fixtures.fixture_from_record(vendor_fixtures.REPO / record)
        assert derived == committed, record


def test_constructor_args_are_abi_encoded():
    abi = [
        {
            "type": "constructor",
            "inputs": [{"type": "address"}, {"type": "address"}, {"type": "uint64"}],
        }
    ]
    encoded = vendor_fixtures.encode_constructor_args(
        abi, ["0xcdfdC3752caaA826fE62531E0000C40546eC56A6", "0x" + "ab" * 20, 12]
    )
    assert encoded == (
        "000000000000000000000000cdfdc3752caaa826fe62531e0000c40546ec56a6"
        + "000000000000000000000000"
        + "ab" * 20
        + "000000000000000000000000000000000000000000000000000000000000000c"
    )


def _create2_record(tmp_path, monkeypatch, *, recorded_salt):
    """A CREATE2 record and its broadcast under ``tmp_path``, standing in for the repo."""
    monkeypatch.setattr(vendor_fixtures, "REPO", tmp_path)
    monkeypatch.setattr(vendor_fixtures, "CONTRACTS_DIR", tmp_path)
    abi = [{"type": "constructor", "inputs": [{"type": "uint64"}]}]
    salt = "0x" + b"v2-rc3".ljust(32, b"\0").hex()
    tx_hash = "0x" + "12" * 32
    arg = "00" * 31 + "0c"
    broadcast = {
        "transactions": [
            {
                "hash": tx_hash,
                "transactionType": "CREATE2",
                "transaction": {"input": salt + "6000c0ffee" + arg},
            }
        ]
    }
    (tmp_path / "run.json").write_text(json.dumps(broadcast))
    record = {
        "abi": abi,
        "args": [12],
        "address": "0x" + "ab" * 20,
        "transactionHash": tx_hash,
        "linkedData": {
            "chainId": 11155111,
            "broadcast": "run.json",
            "create2": {"salt": recorded_salt or salt},
        },
    }
    path = tmp_path / "sepolia" / "VolumeRegistry-v2-rc3.json"
    path.parent.mkdir()
    path.write_text(json.dumps(record))
    return path


def test_create2_fixture_is_initcode_after_the_salt(tmp_path, monkeypatch):
    path = _create2_record(tmp_path, monkeypatch, recorded_salt=None)
    fixture, entry = vendor_fixtures.fixture_from_record(path)
    assert fixture["bytecode"]["object"] == "0x6000c0ffee"
    assert entry["registry"] == "0x" + "ab" * 20


def test_create2_salt_must_match_the_record(tmp_path, monkeypatch):
    path = _create2_record(tmp_path, monkeypatch, recorded_salt="0x" + "00" * 32)
    with pytest.raises(SystemExit, match="CREATE2 salt"):
        vendor_fixtures.fixture_from_record(path)


def test_tag_commit_of_a_missing_tag_is_none():
    # CI checks out shallowly without tags, so only the missing case is portable.
    assert vendor_fixtures.tag_commit("v999-rc999") is None

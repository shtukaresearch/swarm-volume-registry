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

#!/usr/bin/env python3
"""Vendor the shared test-support contracts for the indexer's test suite.

``services/indexer/tests/fixtures/support/`` holds the test-support contracts the harness
deploys around the registry (``PostageStamp`` / ``PriceOracle`` / ``TestToken``, from the
``storage-incentives`` submodule). They are not part of any release, so one copy serves
every version. ``support`` refreshes them from a ``forge build`` in ``contracts/``; that is
needed only when the submodule pin moves.

The registry itself is not vendored: the harness reads each release's ABI and creation
bytecode from its deployment record in ``contracts/deployments/``.

Stdlib only. Run from anywhere inside the repo::

    python3 services/indexer/scripts/vendor_fixtures.py support   # after `forge build`
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
INDEXER = REPO / "services" / "indexer"
OUT = REPO / "contracts" / "out"
SUPPORT = INDEXER / "tests" / "fixtures" / "support"

#: Test-support contracts, vendored once into ``support/`` from a build.
SUPPORT_CONTRACTS = ("PostageStamp", "PriceOracle", "TestToken")


def fail(message: str) -> None:
    raise SystemExit(message)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def cmd_support() -> int:
    if not (OUT / "PostageStamp.sol" / "PostageStamp.json").exists():
        fail("no build artifacts: run `forge build` in contracts/ first")
    SUPPORT.mkdir(parents=True, exist_ok=True)
    for name in SUPPORT_CONTRACTS:
        doc = json.loads((OUT / f"{name}.sol" / f"{name}.json").read_text())
        slim = {"abi": doc["abi"], "bytecode": {"object": doc["bytecode"]["object"]}}
        (SUPPORT / f"{name}.json").write_text(json.dumps(slim, indent=1) + "\n")
        print(f"vendored {SUPPORT.relative_to(REPO)}/{name}.json")
    submodule = git("rev-parse", "HEAD:contracts/lib/storage-incentives")
    (SUPPORT / "provenance.json").write_text(
        json.dumps(
            {
                "description": (
                    "Test-support contracts the harness deploys around every registry "
                    "version: slim (abi + creation bytecode) Foundry build artifacts from "
                    "the storage-incentives submodule. Not part of any release."
                ),
                "storage_incentives_commit": submodule,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"wrote {SUPPORT.relative_to(REPO)}/provenance.json")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("support", help="refresh the shared test-support contracts from a forge build")
    parser.parse_args()
    return cmd_support()


if __name__ == "__main__":
    sys.exit(main())

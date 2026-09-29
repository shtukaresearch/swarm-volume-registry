#!/usr/bin/env python3
"""Vendor the pinned contract fixtures for the indexer's test suite.

Two kinds of fixture live under ``services/indexer/tests/fixtures/``:

- ``<version>/VolumeRegistry.json`` — the registry contract exactly as deployed under a
  release (release-procedure step B1; ``RELEASING.md``). ``release VERSION`` derives it
  from the committed deployment records, with no build: the ABI is the record's, and the
  creation bytecode is the recorded CREATE transaction's initcode (from the Foundry
  broadcast the record links to) with its ABI-encoded constructor arguments removed —
  checked against the record's ``args``. The fixture is therefore the deployed code by
  construction. Every network's record of the version is read, and they must agree.
  A ``provenance.json`` beside it names the records, transactions and release tag.
- ``support/`` — the test-support contracts the harness deploys around the registry
  (``PostageStamp`` / ``PriceOracle`` / ``TestToken``, from the ``storage-incentives``
  submodule). They are not part of any release, so one copy serves every version.
  ``support`` refreshes them from a ``forge build`` in ``contracts/``; that is needed only
  when the submodule pin moves.

Stdlib only. Run from anywhere inside the repo::

    python3 services/indexer/scripts/vendor_fixtures.py release v2-rc1
    python3 services/indexer/scripts/vendor_fixtures.py support   # after `forge build`
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[3]
INDEXER = REPO / "services" / "indexer"
CONTRACTS_DIR = REPO / "contracts"
RECORDS = CONTRACTS_DIR / "deployments"
OUT = CONTRACTS_DIR / "out"
FIXTURES = INDEXER / "tests" / "fixtures"
SUPPORT = FIXTURES / "support"

#: The versioned contract, vendored per release from its deployment records.
REGISTRY = "VolumeRegistry"
#: Test-support contracts, vendored once into ``support/`` from a build.
SUPPORT_CONTRACTS = ("PostageStamp", "PriceOracle", "TestToken")

_UINT = re.compile(r"uint(\d*)\Z")


def fail(message: str) -> None:
    raise SystemExit(message)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def _encode_static(abi_type: str, value: Any) -> str:
    """One static constructor argument as its 32-byte ABI word (hex, no prefix).

    Only the types a ``VolumeRegistry`` constructor uses are supported; anything else
    fails loudly rather than guessing at the encoding.
    """
    if abi_type == "address":
        return value.lower().removeprefix("0x").rjust(64, "0")
    if abi_type == "bool":
        return format(int(bool(value)), "064x")
    if _UINT.fullmatch(abi_type):
        return format(int(value, 0) if isinstance(value, str) else int(value), "064x")
    fail(f"unsupported constructor argument type {abi_type!r}")
    raise AssertionError  # unreachable


def encode_constructor_args(abi: list[dict[str, Any]], args: list[Any]) -> str:
    """The ABI encoding of ``args`` for the ABI's constructor (hex, no prefix)."""
    ctors = [e for e in abi if e["type"] == "constructor"]
    inputs = ctors[0]["inputs"] if ctors else []
    if len(inputs) != len(args):
        fail(f"constructor takes {len(inputs)} arguments; the record has {len(args)}")
    return "".join(_encode_static(i["type"], a) for i, a in zip(inputs, args))


def fixture_from_record(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(fixture, provenance entry)`` for one versioned deployment record."""
    record = json.loads(path.read_text(encoding="utf-8"))
    broadcast_path = CONTRACTS_DIR / record["linkedData"]["broadcast"]
    broadcast = json.loads(broadcast_path.read_text(encoding="utf-8"))
    creates = [
        tx
        for tx in broadcast["transactions"]
        if tx.get("hash", "").lower() == record["transactionHash"].lower()
        and tx.get("transactionType") == "CREATE"
    ]
    if len(creates) != 1:
        fail(f"{broadcast_path.relative_to(REPO)} has no single CREATE {record['transactionHash']}")
    initcode = creates[0]["transaction"]["input"].lower()
    encoded_args = encode_constructor_args(record["abi"], record["args"])
    if not initcode.endswith(encoded_args):
        fail(f"{path.relative_to(REPO)}: initcode does not end with the record's constructor args")
    creation = initcode[: len(initcode) - len(encoded_args)]
    fixture = {"abi": record["abi"], "bytecode": {"object": creation}}
    entry = {
        "network": path.parent.name,
        "chain_id": int(record["linkedData"]["chainId"]),
        "registry": record["address"].lower(),
        "transaction": record["transactionHash"].lower(),
        "record": str(path.relative_to(REPO)),
        "source_commit": record["linkedData"].get("commit"),
    }
    return fixture, entry


def cmd_release(version: str) -> int:
    paths = sorted(RECORDS.glob(f"*/{REGISTRY}-{version}.json"))
    if not paths:
        fail(f"no deployment record for {version} under {RECORDS.relative_to(REPO)}/*/")
    fixture, deployments = None, []
    for path in paths:
        this, entry = fixture_from_record(path)
        if fixture is not None and this != fixture:
            fail(f"{path.relative_to(REPO)} disagrees with {deployments[0]['record']}")
        fixture = this
        deployments.append(entry)
        print(f"read {entry['record']} ({entry['network']}, {entry['registry']})")

    tag_commit = git("rev-parse", "-q", "--verify", f"refs/tags/{version}^{{commit}}")
    provenance = {
        "registry_version": version,
        "description": (
            "Pinned VolumeRegistry fixture for this release, derived from the committed "
            "deployment records with no build: abi from the record; creation bytecode is "
            "the recorded CREATE transaction's initcode with its ABI-encoded constructor "
            "arguments (checked against the record's args) removed. The test-support "
            "contracts the harness deploys around it are shared, in ../support/."
        ),
        "tag": {"name": version, "commit": tag_commit} if tag_commit else None,
        "deployments": deployments,
    }

    dst = FIXTURES / version
    dst.mkdir(parents=True, exist_ok=True)
    (dst / f"{REGISTRY}.json").write_text(json.dumps(fixture, indent=1) + "\n")
    (dst / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"wrote {dst.relative_to(REPO)}/{{{REGISTRY},provenance}}.json")
    if tag_commit is None:
        print(f"note: no git tag {version!r} yet; provenance.tag is null", file=sys.stderr)
    return 0


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
    p_release = sub.add_parser("release", help="vendor a release's VolumeRegistry from its records")
    p_release.add_argument("version", help="release name, e.g. v2-rc1 (the fixture directory)")
    sub.add_parser("support", help="refresh the shared test-support contracts from a forge build")
    args = parser.parse_args()
    return cmd_release(args.version) if args.command == "release" else cmd_support()


if __name__ == "__main__":
    sys.exit(main())

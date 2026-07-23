#!/usr/bin/env python3
"""Vendor the pinned per-version contract fixtures for the Python test suite.

Release-procedure step 2 (see ``RELEASING.md`` and ``python/docs/VERSIONING.md``): freeze
slim (abi + creation bytecode) copies of the Foundry build artifacts at
``python/tests/fixtures/<version>/``, together with a ``provenance.json`` recording the
source commit, compiler settings, and — when ``--verify`` deployments are given — an
on-chain verification that the build being frozen is the code actually deployed.

The verification compares the build's ``deployedBytecode`` against ``eth_getCode`` for
each deployment, masking immutable references (constructor-set values baked into runtime
code) and reporting the CBOR metadata suffix separately: a **body** mismatch means the
build is not the deployed contract and the script fails; a metadata-only mismatch means
functionally identical code from drifted source text or settings, which is reported but
tolerated.

Stdlib only. Run from anywhere inside the repo, after ``forge build``::

    python3 scripts/vendor_fixtures.py v2 \\
        --verify gnosis 0xREGISTRY "$GNO_RPC_URL" \\
        --verify sepolia 0xREGISTRY "$SEP_RPC_URL"
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "contracts" / "out"
FIXTURES = REPO / "python" / "tests" / "fixtures"

#: The contracts the harness deploys (``python/tests/harness.py``). ``VolumeRegistry`` is
#: the versioned contract; the rest are vendored test-support contracts.
CONTRACTS = ("VolumeRegistry", "PostageStamp", "PriceOracle", "TestToken")

VERIFY_METHOD = (
    "eth_getCode runtime bytecode vs this build's deployedBytecode, immutable references "
    "masked; CBOR metadata suffix compared separately"
)


def load_artifact(name: str) -> dict[str, Any]:
    """The full Foundry build artifact for ``name`` (requires a prior ``forge build``)."""
    return json.loads((OUT / f"{name}.sol" / f"{name}.json").read_text())


def slim(doc: dict[str, Any]) -> dict[str, Any]:
    """Reduce a build artifact to what the harness deploys from: abi + creation bytecode."""
    return {"abi": doc["abi"], "bytecode": {"object": doc["bytecode"]["object"]}}


def rpc(url: str, method: str, params: list[Any]) -> Any:
    """One JSON-RPC call; returns the ``result`` or raises on an error response."""
    req = urllib.request.Request(
        url,
        json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        ).encode(),
        {"Content-Type": "application/json", "User-Agent": "vendor-fixtures"},
    )
    doc = json.load(urllib.request.urlopen(req))
    if "error" in doc:
        raise RuntimeError(f"{method} failed: {doc['error']}")
    return doc["result"]


def mask_immutables(code: bytes, immutable_refs: list[dict[str, int]]) -> bytes:
    """Zero the immutable-reference byte ranges, so builds and deployments compare."""
    out = bytearray(code)
    for ref in immutable_refs:
        out[ref["start"] : ref["start"] + ref["length"]] = b"\x00" * ref["length"]
    return bytes(out)


def split_metadata(code: bytes) -> tuple[bytes, bytes]:
    """Split runtime code into (body, CBOR metadata suffix); last 2 bytes give its length."""
    mlen = int.from_bytes(code[-2:], "big")
    return code[: -(mlen + 2)], code[-(mlen + 2) :]


def verify_deployment(
    artifact: dict[str, Any], label: str, address: str, rpc_url: str
) -> dict[str, Any]:
    """Compare the build's runtime bytecode with one live deployment.

    Returns the provenance entry: chain id (read from the RPC), address, and the two
    comparison results. A ``runtime_body_match`` of ``False`` is fatal to the caller.
    """
    refs = [
        r
        for ref_list in artifact["deployedBytecode"]
        .get("immutableReferences", {})
        .values()
        for r in ref_list
    ]
    local = mask_immutables(
        bytes.fromhex(artifact["deployedBytecode"]["object"][2:]), refs
    )
    chain_id = int(rpc(rpc_url, "eth_chainId", []), 16)
    onchain = mask_immutables(
        bytes.fromhex(rpc(rpc_url, "eth_getCode", [address, "latest"])[2:]), refs
    )
    local_body, local_meta = split_metadata(local)
    chain_body, chain_meta = split_metadata(onchain)
    return {
        "label": label,
        "chain_id": chain_id,
        "registry": address.lower(),
        "runtime_body_match": chain_body == local_body,
        "metadata_match": chain_meta == local_meta,
    }


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "version", help="registry_version to vendor (fixture dir name, e.g. v2)"
    )
    parser.add_argument(
        "--verify",
        nargs=3,
        metavar=("LABEL", "ADDRESS", "RPC_URL"),
        action="append",
        default=[],
        help="a live deployment to verify the build against (repeatable)",
    )
    args = parser.parse_args()

    if not (OUT / "VolumeRegistry.sol" / "VolumeRegistry.json").exists():
        print(
            "no build artifacts: run `forge build` in contracts/ first", file=sys.stderr
        )
        return 1
    if git("status", "--porcelain", "--", "contracts/src", "contracts/lib"):
        print("contracts source is dirty; commit before vendoring", file=sys.stderr)
        return 1

    dst = FIXTURES / args.version
    dst.mkdir(parents=True, exist_ok=True)
    for name in CONTRACTS:
        (dst / f"{name}.json").write_text(
            json.dumps(slim(load_artifact(name)), indent=1) + "\n"
        )
        print(f"vendored {dst.relative_to(REPO)}/{name}.json")

    registry = load_artifact("VolumeRegistry")
    settings = registry["metadata"]["settings"]

    deployments = []
    ok = True
    for label, address, rpc_url in args.verify:
        entry = verify_deployment(registry, label, address, rpc_url)
        deployments.append(entry)
        status = "OK" if entry["runtime_body_match"] else "MISMATCH"
        meta = (
            "" if entry["metadata_match"] else " (metadata differs: source-text drift)"
        )
        print(
            f"verify {label} (chain {entry['chain_id']}): runtime body {status}{meta}"
        )
        ok = ok and entry["runtime_body_match"]

    provenance = {
        "registry_version": args.version,
        "description": (
            "Pinned contract fixtures: slim (abi + creation bytecode) Foundry build "
            "artifacts the integration-test harness deploys from. VolumeRegistry is the "
            "versioned contract; PostageStamp / PriceOracle / TestToken are vendored "
            "test-support contracts."
        ),
        "source": {
            "commit": git("rev-parse", "HEAD"),
            "tag": None,  # filled in once the release commit is tagged (RELEASING.md)
            "solc": registry["metadata"]["compiler"]["version"],
            "optimizer": {
                "enabled": settings["optimizer"]["enabled"],
                "runs": settings["optimizer"]["runs"],
                "via_ir": settings.get("viaIR", False),
            },
        },
        "verified_against": {
            "date": datetime.now(timezone.utc).date().isoformat(),
            "method": VERIFY_METHOD,
            "deployments": deployments,
        }
        if deployments
        else None,
    }
    (dst / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"wrote {dst.relative_to(REPO)}/provenance.json")

    if not ok:
        print(
            "FATAL: runtime body mismatch — this build is not the deployed contract",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

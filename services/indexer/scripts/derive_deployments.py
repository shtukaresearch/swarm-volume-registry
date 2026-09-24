#!/usr/bin/env python3
"""Derive registry entries from the committed deployment records (release step B4).

Registration made mechanical but **manually triggered** (ADR-0011,
``services/indexer/docs/adr/0011-derived-deployment-registry.md``): this script scans the
committed deployment records (``contracts/deployments/<network>/VolumeRegistry-<version>.json``
— the *facts*, written and checked by ``contracts/script/export_deployment.py``) and
proposes, in the package's ``deployments.json`` (the *claim*):

- an entry for every recorded deployment whose version is **supported** (a key of
  ``decode._VERSIONS`` — the claim site this derivation is gated on) and not yet
  registered, with ``network`` / ``registry_version`` / ``chain_id`` / ``registry`` /
  ``genesis_block`` all read from the record, so nothing is hand-transcribed;
- the ``latest`` pointer for every network whose ``VolumeRegistry.json`` names a
  registered deployment (ADR-0012).

Records of unsupported versions are reported and left alone: facts may lead claims, so a
testnet release candidate deployed ahead of indexer support neither enters the fleet nor
moves an existing ``latest`` pointer. The one judgement left as an argument:

- ``--exclude NETWORK-VERSION`` keeps a recorded deployment out of the fleet.

Review the resulting diff and commit it. Run from the repo root, with the package importable::

    uv run --project services/indexer services/indexer/scripts/derive_deployments.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[3]
INDEXER = REPO / "services" / "indexer"
RECORDS = REPO / "contracts" / "deployments"
DEPLOYMENTS = INDEXER / "src" / "ethswarm_volumes" / "deployments.json"
CONTRACT = "VolumeRegistry"


def _import_package():
    """Import ``decode`` (the claim site) and ``registry``, source-checkout tolerant."""
    try:
        from ethswarm_volumes import decode, registry
    except ImportError:
        sys.path.insert(0, str(INDEXER / "src"))
        try:
            from ethswarm_volumes import decode, registry
        except ImportError as exc:
            sys.exit(
                f"cannot import ethswarm_volumes ({exc}); run via:"
                " uv run --project services/indexer services/indexer/scripts/derive_deployments.py"
            )
    return decode, registry


def _record_fact(network: str, path: Path) -> dict[str, Any]:
    """One versioned deployment record as ``{network, registry_version, chain_id, registry,
    genesis_block}``, cross-checking the filename against the recorded version."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    version = doc["linkedData"]["version"]
    if path.stem != f"{CONTRACT}-{version}":
        sys.exit(f"{path.relative_to(REPO)} records version {version!r}; filename disagrees")
    return {
        "network": network,
        "registry_version": version,
        "chain_id": int(doc["linkedData"]["chainId"]),
        "registry": doc["address"].lower(),
        "genesis_block": int(doc["receipt"]["blockNumber"]),
    }


def record_facts() -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Every versioned ``VolumeRegistry`` record, plus each network's latest-pointer version."""
    facts: list[dict[str, Any]] = []
    pointers: dict[str, str] = {}
    if not RECORDS.is_dir():
        return facts, pointers
    for network_dir in sorted(p for p in RECORDS.iterdir() if p.is_dir()):
        network = network_dir.name
        for path in sorted(network_dir.glob(f"{CONTRACT}-*.json")):
            facts.append(_record_fact(network, path))
        latest = network_dir / f"{CONTRACT}.json"
        if latest.is_file():
            pointers[network] = json.loads(latest.read_text(encoding="utf-8"))["linkedData"][
                "version"
            ]
    return facts, pointers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--exclude",
        metavar="NETWORK-VERSION",
        action="append",
        default=[],
        help="keep a recorded deployment out of the fleet, by label (repeatable)",
    )
    args = parser.parse_args()

    decode, registry = _import_package()
    supported = decode.supported_versions()
    reg = registry.registry_from_dict(json.loads(DEPLOYMENTS.read_text(encoding="utf-8")))
    specs = list(reg.deployments)
    latest = dict(reg.latest)
    registered_ids = {(s.chain_id, s.registry.lower()) for s in specs}
    labels = {s.label for s in specs}
    excluded = set(args.exclude)

    facts, pointers = record_facts()
    changed = False
    for fact in facts:
        label = registry.deployment_label(fact["network"], fact["registry_version"])
        if (fact["chain_id"], fact["registry"]) in registered_ids or label in excluded:
            continue
        if fact["registry_version"] not in supported:
            print(f"skip {label}: {fact['registry_version']!r} is not supported by this package")
            continue
        if label in labels:
            sys.exit(f"{label} is already registered at another address; fix the records first")
        specs.append(registry.DeploymentSpec(**fact))
        labels.add(label)
        changed = True
        print(
            f"registered {label}: chain {fact['chain_id']}, {fact['registry']},"
            f" genesis {fact['genesis_block']}"
        )

    for network, version in pointers.items():
        label = registry.deployment_label(network, version)
        if latest.get(network) == label:
            continue
        if label not in labels:
            print(
                f"latest {network} -> {label} not applied: not registered"
                f" (keeping {latest.get(network, 'no pointer')})"
            )
            continue
        print(f"latest {network}: {latest.get(network, 'no pointer')} -> {label}")
        latest[network] = label
        changed = True

    if not changed:
        print("registry is up to date with the deployment records; nothing to do")
        return 0
    doc = registry.registry_to_dict(registry.Registry(deployments=tuple(specs), latest=latest))
    registry.registry_from_dict(doc)  # the naming invariants hold before anything is written
    DEPLOYMENTS.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {DEPLOYMENTS.relative_to(REPO)} — review the diff and commit")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Derive registry entries from the committed deployment artifacts (release step 5).

Registration made mechanical but **manually triggered** (ADR-0011,
``python/docs/adr/0011-derived-deployment-registry.md``): this script scans the committed
Foundry broadcast records (``contracts/broadcast/`` — the *facts*), and proposes an entry
in the package's ``deployments.json`` (the *claim*) for every recorded ``VolumeRegistry``
deployment that is not yet registered — filling ``chain_id`` / ``registry`` /
``genesis_block`` from the receipts, so nothing is hand-transcribed. The human supplies
the judgement the facts don't carry:

- ``--version vN`` attributes the new deployments to a ``registry_version``, which must
  be **supported** (a key of ``decode._VERSIONS`` — the claim site this derivation is
  gated on; the script refuses otherwise).
- ``--label CHAIN_ID=NAME`` names a deployment when the built-in chain table doesn't
  cover it (unknown chain, or a second deployment on one chain).
- ``--exclude CHAIN_ID:ADDRESS`` keeps a recorded deployment out of the fleet
  (e.g. a botched-but-successful deploy).

Review the resulting diff and commit it. Run from the repo, with the package importable::

    uv run --project python scripts/derive_deployments.py --version v2
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
BROADCAST = REPO / "contracts" / "broadcast" / "DeployVolumeRegistry.s.sol"
DEPLOYMENTS = REPO / "python" / "src" / "ethswarm_volumes" / "deployments.json"

#: Default labels per chain id; ``--label`` overrides or extends.
CHAIN_LABELS = {1: "ethereum", 100: "gnosis", 11155111: "sepolia"}

#: Local/dev chains never registered.
SKIP_CHAINS = {31337}


def _import_decode():
    """Import ``ethswarm_volumes.decode`` (the claim site), source-checkout tolerant."""
    try:
        from ethswarm_volumes import decode
    except ImportError:
        sys.path.insert(0, str(REPO / "python" / "src"))
        try:
            from ethswarm_volumes import decode
        except ImportError as exc:
            sys.exit(
                f"cannot import ethswarm_volumes ({exc}); run via:"
                " uv run --project python scripts/derive_deployments.py …"
            )
    return decode


def broadcast_facts() -> list[dict[str, Any]]:
    """Every ``VolumeRegistry`` CREATE in the committed broadcast records.

    Returns ``{chain_id, registry, genesis_block}`` dicts, deduplicated by
    ``(chain_id, address)`` (``run-latest.json`` duplicates the newest timestamped run).
    Dry-run and local-chain records are skipped.
    """
    facts: dict[tuple[int, str], dict[str, Any]] = {}
    if not BROADCAST.is_dir():
        return []
    for run_file in sorted(BROADCAST.glob("*/run-*.json")):
        if "dry-run" in run_file.parts:
            continue
        chain_id = int(run_file.parent.name)
        if chain_id in SKIP_CHAINS:
            continue
        doc = json.loads(run_file.read_text(encoding="utf-8"))
        block_by_tx = {
            r["transactionHash"].lower(): int(r["blockNumber"], 16) for r in doc.get("receipts", [])
        }
        for tx in doc.get("transactions", []):
            if tx.get("transactionType") != "CREATE" or tx.get("contractName") != "VolumeRegistry":
                continue
            address = tx["contractAddress"].lower()
            facts[(chain_id, address)] = {
                "chain_id": chain_id,
                "registry": address,
                "genesis_block": block_by_tx.get(tx.get("hash", "").lower()),
            }
    return list(facts.values())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--version", help="registry_version to attribute new deployments to")
    parser.add_argument(
        "--label",
        metavar="CHAIN_ID=NAME",
        action="append",
        default=[],
        help="label for a chain the built-in table doesn't cover (repeatable)",
    )
    parser.add_argument(
        "--exclude",
        metavar="CHAIN_ID:ADDRESS",
        action="append",
        default=[],
        help="keep a recorded deployment out of the fleet (repeatable)",
    )
    args = parser.parse_args()

    decode = _import_decode()
    supported = decode.supported_versions()

    doc = json.loads(DEPLOYMENTS.read_text(encoding="utf-8"))
    registered = {(e["chain_id"], e["registry"].lower()) for e in doc["deployments"]}
    labels_in_use = {e["label"] for e in doc["deployments"]}
    label_overrides = {}
    for item in args.label:
        chain, _, name = item.partition("=")
        label_overrides[int(chain)] = name
    excluded = set()
    for item in args.exclude:
        chain, _, address = item.partition(":")
        excluded.add((int(chain), address.lower()))

    new = [
        f
        for f in broadcast_facts()
        if (f["chain_id"], f["registry"]) not in registered
        and (f["chain_id"], f["registry"]) not in excluded
    ]
    if not new:
        print("no unregistered deployments in the broadcast records; nothing to do")
        return 0

    if args.version is None:
        sys.exit(f"{len(new)} unregistered deployment(s) found; pass --version to attribute them")
    if args.version not in supported:
        sys.exit(
            f"registry_version {args.version!r} is not supported by this package"
            f" (supported: {', '.join(sorted(supported))});"
            " add the decode._VERSIONS entry first (release step 3)"
        )

    for fact in new:
        label = label_overrides.get(fact["chain_id"], CHAIN_LABELS.get(fact["chain_id"]))
        if label is None:
            sys.exit(f"no label for chain {fact['chain_id']}; pass --label {fact['chain_id']}=NAME")
        if label in labels_in_use:
            sys.exit(
                f"label {label!r} is already registered (second deployment on one chain?);"
                f" pass --label {fact['chain_id']}=NAME"
            )
        labels_in_use.add(label)
        entry = {
            "label": label,
            "chain_id": fact["chain_id"],
            "registry": fact["registry"],
            "registry_version": args.version,
            "genesis_block": fact["genesis_block"],
        }
        doc["deployments"].append(entry)
        print(
            f"registered {label}: chain {entry['chain_id']}, {entry['registry']}, genesis {entry['genesis_block']}"
        )

    DEPLOYMENTS.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {DEPLOYMENTS.relative_to(REPO)} — review the diff and commit")
    return 0


if __name__ == "__main__":
    sys.exit(main())

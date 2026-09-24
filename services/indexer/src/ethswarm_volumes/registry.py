"""The deployment registry: which ``VolumeRegistry`` deployments to index.

A deployment entry is a **reduced artifact** (``docs/data-model/deployment-registry.md``): the
contract-agnostic identity only — ``network``, ``registry_version``, ``chain_id``,
``registry`` and the deployment ``genesis_block``. Everything else in the artifact is sync
output: the ``extra`` wiring (``postage`` / ``bzz`` / ``price_oracle`` / ``grace_blocks``) is
read back from the registry contract at sync time (:mod:`ethswarm_volumes.node`),
``genesis_ts`` from the genesis block, and the daily series / snapshot from the projector.

A deployment's **label** is ``<network>-<registry_version>`` (``gnosis-v1``,
``sepolia-v2-rc1``): derived, never written down, and unique because a network carries at
most one deployment per version (ADR-0012). The bare network name is a separate, explicit
pointer — the document's ``latest`` map, ``{network: label}`` — mirroring the contracts
side's ``deployments/<network>/VolumeRegistry.json``. It moves only when a release says so.

``genesis_block`` is optional: it is expensive to query, so a known value is recorded here,
but when absent the indexer discovers the contract-creation block once on first sync.

The built-in :data:`DEFAULT_REGISTRY` covers the live fleet. It is loaded from the
package-data document ``deployments.json`` — same shape as an operator ``--config`` file,
one loader for both. That document is **derived, not hand-written**: registration is a
manually triggered run of ``scripts/derive_deployments.py``, which proposes entries from
the committed deployment records (``contracts/deployments/``) gated on version support
(ADR-0011). ``load_registry`` lets an operator override the fleet with a JSON file of the
same shape.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from importlib.resources import files
from pathlib import Path

from .model import DeploymentId

#: A release name (ADR-0012): ``vN`` for a mainnet release, ``vN-rcM`` for a testnet
#: release candidate. The same grammar as the contracts-side exporter enforces.
VERSION_NAME = re.compile(r"v[1-9][0-9]*(-rc[1-9][0-9]*)?\Z")

#: A network name — the ``contracts/deployments/<network>/`` directory it mirrors.
NETWORK_NAME = re.compile(r"[a-z0-9][a-z0-9_]*\Z")


def deployment_label(network: str, registry_version: str) -> str:
    """The label naming one deployment: ``<network>-<registry_version>``."""
    return f"{network}-{registry_version}"


@dataclass(frozen=True)
class DeploymentSpec:
    """Identity of one deployment to index — the reduced-artifact entry
    (``docs/data-model/deployment-registry.md``).

    ``genesis_block`` is the contract-creation block (the first block to index); ``None``
    means "discover it on first sync". The contract-resolved ``extra`` wiring and the
    derived ``genesis_ts`` are *not* here — they are sync output, not config.
    """

    network: str
    registry_version: str
    chain_id: int
    registry: str
    genesis_block: int | None = None

    @property
    def label(self) -> str:
        """``<network>-<registry_version>`` — the deployment's name (ADR-0012)."""
        return deployment_label(self.network, self.registry_version)

    @property
    def deployment_id(self) -> DeploymentId:
        """``(chain_id, registry)`` — the store partition key.

        The address is passed through verbatim (not normalized), matching
        :attr:`ethswarm_volumes.model.Deployment.deployment_id` so the rows keyed here and
        the deployment the projector narrows to agree byte-for-byte. Keep a deployment's
        configured address spelling stable across syncs.
        """
        return (self.chain_id, self.registry)


@dataclass(frozen=True)
class Registry:
    """A deployment registry document: the deployments plus the ``latest`` pointers.

    ``latest`` maps a bare network name to the label of that network's current
    deployment. It is explicit — set when a release promotes a deployment, never inferred
    from version order — so a network may have no pointer (e.g. while its current
    contracts-side deployment is a version this package does not yet support).
    """

    deployments: tuple[DeploymentSpec, ...]
    latest: dict[str, str] = field(default_factory=dict)

    def __iter__(self):
        return iter(self.deployments)

    def __len__(self) -> int:
        return len(self.deployments)


def _spec_from_dict(obj: dict) -> DeploymentSpec:
    """Parse one ``DeploymentSpec`` from a registry-file entry."""
    network = obj["network"]
    version = obj["registry_version"]
    if not NETWORK_NAME.fullmatch(network):
        raise ValueError(f"invalid network name {network!r}")
    if not VERSION_NAME.fullmatch(version):
        raise ValueError(f"invalid registry_version {version!r} (expected vN or vN-rcM)")
    return DeploymentSpec(
        network=network,
        registry_version=version,
        chain_id=obj["chain_id"],
        registry=obj["registry"],
        genesis_block=obj.get("genesis_block"),
    )


def registry_from_dict(doc: dict) -> Registry:
    """Parse and validate a registry document (``{"deployments": [...], "latest": {...}}``).

    Enforces the naming invariants: labels are unique (one deployment per network and
    version), and every ``latest`` pointer names a deployment of its own network.
    """
    specs = tuple(_spec_from_dict(e) for e in doc["deployments"])
    seen: set[str] = set()
    for spec in specs:
        if spec.label in seen:
            raise ValueError(f"duplicate deployment {spec.label!r} (one per network and version)")
        seen.add(spec.label)
    by_label = {s.label: s for s in specs}
    latest = dict(doc.get("latest", {}))
    for network, label in latest.items():
        target = by_label.get(label)
        if target is None or target.network != network:
            raise ValueError(f"latest[{network!r}] = {label!r} is not a {network} deployment")
    return Registry(deployments=specs, latest=latest)


def registry_to_dict(reg: Registry) -> dict:
    """The document shape :func:`registry_from_dict` reads (``deployments.json``)."""
    entries = []
    for s in reg.deployments:
        entry = {
            "network": s.network,
            "registry_version": s.registry_version,
            "chain_id": s.chain_id,
            "registry": s.registry,
        }
        if s.genesis_block is not None:
            entry["genesis_block"] = s.genesis_block
        entries.append(entry)
    return {"deployments": entries, "latest": dict(sorted(reg.latest.items()))}


def _load_default() -> Registry:
    """Load the built-in fleet from the ``deployments.json`` package data."""
    doc = json.loads(files(__package__).joinpath("deployments.json").read_text("utf-8"))
    return registry_from_dict(doc)


#: The live fleet, from the derived ``deployments.json`` (module docstring; ADR-0011).
#: ``genesis_block`` is recorded per deployment so the first sync needs no historical
#: state: discovery binary-searches ``eth_getCode`` over past blocks, which a pruned
#: (non-archive) node cannot serve, so an unset value would break ``sync`` on an
#: ordinary RPC.
DEFAULT_REGISTRY: Registry = _load_default()


def load_registry(path: str | os.PathLike[str] | None = None) -> Registry:
    """The deployment registry: the built-in fleet, or an operator JSON override.

    ``path`` (the ``--config`` value) points at a JSON document
    ``{"deployments": [ {network, registry_version, chain_id, registry, genesis_block?}, … ],
    "latest": {network: label, …}}`` — the reduced-artifact shape; ``latest`` is optional.
    With ``path`` unset, returns :data:`DEFAULT_REGISTRY`.
    """
    if path is None:
        return DEFAULT_REGISTRY
    return registry_from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


def resolve(items, latest: dict[str, str], selector: str | None):
    """Resolve a ``stat``/``sync`` deployment selector against named deployments.

    ``items`` are registry specs or artifact entries (anything with ``label`` /
    ``chain_id`` / ``registry``). ``selector`` matches, in order: a label
    (``gnosis-v1``); a bare network name through the ``latest`` pointer (``gnosis``);
    ``chain:address`` (case-insensitive). ``None`` returns the sole deployment when there
    is exactly one, else ``None`` (the caller lists the choices — ``docs/CLIENT.md``).
    """
    items = list(items)
    if selector is None:
        return items[0] if len(items) == 1 else None
    by_label = {i.label: i for i in items}
    if selector in by_label:
        return by_label[selector]
    if selector in latest and latest[selector] in by_label:
        return by_label[latest[selector]]
    for i in items:
        if f"{i.chain_id}:{i.registry}".lower() == selector.lower():
            return i
    return None


def select(reg: Registry, selector: str | None) -> DeploymentSpec | None:
    """Resolve a selector against a registry document (see :func:`resolve`)."""
    return resolve(reg.deployments, reg.latest, selector)

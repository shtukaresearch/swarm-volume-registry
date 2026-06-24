"""The deployment registry: which ``VolumeRegistry`` deployments to index.

A deployment entry is a **reduced artifact** (``docs/ARCHITECTURE.md`` §4.2): the
contract-agnostic identity only — ``label``, ``chain_id``, ``registry``,
``registry_version`` and the deployment ``genesis_block``. Everything else in the artifact
is sync output: the ``extra`` wiring (``postage`` / ``bzz`` / ``price_oracle`` /
``grace_blocks``) is read back from the registry contract at sync time
(:mod:`ethswarm_volumes.node`), ``genesis_ts`` from the genesis block, and the daily
series / snapshot from the projector.

``genesis_block`` is optional: it is expensive to query, so a known value is recorded here,
but when absent the indexer discovers the contract-creation block once on first sync.

The built-in :data:`DEFAULT_REGISTRY` covers the live fleet; ``load_registry`` lets an
operator override it with a JSON file of the same shape.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .model import DeploymentId


@dataclass(frozen=True)
class DeploymentSpec:
    """Identity of one deployment to index — the reduced-artifact entry (§4.2).

    ``genesis_block`` is the contract-creation block (the first block to index); ``None``
    means "discover it on first sync". The contract-resolved ``extra`` wiring and the
    derived ``genesis_ts`` are *not* here — they are sync output, not config.
    """

    label: str
    chain_id: int
    registry: str
    registry_version: str = "v1"
    genesis_block: int | None = None

    @property
    def deployment_id(self) -> DeploymentId:
        """``(chain_id, registry)`` — the store partition key.

        The address is passed through verbatim (not normalized), matching
        :attr:`ethswarm_volumes.model.Deployment.deployment_id` so the rows keyed here and
        the deployment the projector narrows to agree byte-for-byte. Keep a deployment's
        configured address spelling stable across syncs.
        """
        return (self.chain_id, self.registry)


#: The live fleet (addresses from ``docs/usage.md`` §2). ``genesis_block`` is recorded
#: per deployment so the first sync needs no historical state: discovery binary-searches
#: ``eth_getCode`` over past blocks, which a pruned (non-archive) node cannot serve, so an
#: unset value would break ``sync`` on an ordinary RPC. Creation blocks are from Blockscout.
DEFAULT_REGISTRY: tuple[DeploymentSpec, ...] = (
    DeploymentSpec(
        label="gnosis",
        chain_id=100,
        registry="0x9639ae4c7a8fa9efe585738d516a3915ddd02aad",
        genesis_block=45822122,
    ),
    DeploymentSpec(
        label="sepolia",
        chain_id=11155111,
        registry="0x3a99b4b52a4bd75760667219ea93c627051b1af8",
        genesis_block=10715515,
    ),
)


def _spec_from_dict(obj: dict) -> DeploymentSpec:
    """Parse one ``DeploymentSpec`` from a registry-file entry."""
    return DeploymentSpec(
        label=obj["label"],
        chain_id=obj["chain_id"],
        registry=obj["registry"],
        registry_version=obj.get("registry_version", "v1"),
        genesis_block=obj.get("genesis_block"),
    )


def load_registry(path: str | os.PathLike[str] | None = None) -> tuple[DeploymentSpec, ...]:
    """The deployment registry: the built-in fleet, or an operator JSON override.

    ``path`` (the ``--config`` value) points at a JSON document
    ``{"deployments": [ {label, chain_id, registry, registry_version?, genesis_block?}, … ]}``
    — the reduced-artifact shape. With ``path`` unset, returns :data:`DEFAULT_REGISTRY`.
    """
    if path is None:
        return DEFAULT_REGISTRY
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    return tuple(_spec_from_dict(e) for e in doc["deployments"])


def select(specs: tuple[DeploymentSpec, ...], selector: str | None) -> DeploymentSpec | None:
    """Resolve a ``stat``/``sync`` deployment selector against the registry.

    ``selector`` matches a ``label`` first, then ``chain:address`` (case-insensitive).
    ``None`` returns the sole deployment when there is exactly one, else ``None`` (the
    caller lists the choices — ``docs/ARCHITECTURE.md`` §7).
    """
    if selector is None:
        return specs[0] if len(specs) == 1 else None
    for spec in specs:
        if spec.label == selector:
            return spec
    for spec in specs:
        if f"{spec.chain_id}:{spec.registry}".lower() == selector.lower():
            return spec
    return None

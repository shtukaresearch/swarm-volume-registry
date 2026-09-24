"""Deployment registry: id consistency and selector/loader behaviour.

Regression cover for the deployment-id mismatch the CLI smoke test surfaced: the rows are
keyed by ``DeploymentSpec.deployment_id`` while the projector narrows by
``Deployment.deployment_id`` — the two must agree byte-for-byte, else the projection sees no
rows. The address is carried verbatim (no normalization) so a configured spec and the
projector's deployment produce the same key.
"""

from __future__ import annotations

import json

from ethswarm_volumes import cli, decode, registry
from ethswarm_volumes.model import Deployment


def test_spec_and_model_deployment_ids_agree():
    addr = "0x9639Ae4C7a8FA9EFE585738D516a3915dDd02AaD"  # mixed-case checksum
    spec = registry.DeploymentSpec(label="x", chain_id=100, registry=addr)
    dep = Deployment(
        label="x",
        chain_id=100,
        registry=addr,
        registry_version="v1",
        genesis_ts=None,
        fiat_currencies=[],
        extra={},
    )
    assert spec.deployment_id == dep.deployment_id


def test_default_registry_is_the_live_fleet():
    labels = {s.label for s in registry.DEFAULT_REGISTRY}
    assert {"gnosis", "sepolia"} <= labels


def test_default_registry_is_closed_over_supported_versions():
    """Support closure (ADR-0011): every shipped registry entry's ``registry_version``
    has decode reference data behind it. This gates publishing — a released package can
    never carry an entry it cannot decode."""
    for spec in registry.DEFAULT_REGISTRY:
        assert spec.registry_version in decode.supported_versions(), spec.label


def test_sync_guard_flags_unsupported_versions():
    """The runtime guard for operator ``--config`` files, which bypass the test gate."""
    ok = registry.DeploymentSpec(label="ok", chain_id=1, registry="0xa")
    future = registry.DeploymentSpec(
        label="future", chain_id=1, registry="0xb", registry_version="v99"
    )
    assert cli._unsupported([ok, future]) == [future]


def test_load_registry_override(tmp_path):
    cfg = tmp_path / "registry.json"
    cfg.write_text(
        json.dumps({"deployments": [{"label": "local", "chain_id": 31337, "registry": "0xabc"}]})
    )
    specs = registry.load_registry(cfg)
    assert len(specs) == 1
    assert specs[0].label == "local"
    assert specs[0].registry_version == "v1"  # defaulted
    assert specs[0].genesis_block is None  # absent -> discover on sync


def test_select_by_label_then_chain_address():
    specs = registry.DEFAULT_REGISTRY
    assert registry.select(specs, "gnosis").label == "gnosis"
    assert (
        registry.select(specs, "100:0x9639AE4C7A8FA9EFE585738D516A3915DDD02AAD").label == "gnosis"
    )
    assert registry.select(specs, "nope") is None
    assert registry.select(specs, None) is None  # ambiguous: several present

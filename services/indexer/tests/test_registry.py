"""Deployment registry: id consistency, naming invariants, and selector/loader behaviour.

Regression cover for the deployment-id mismatch the CLI smoke test surfaced: the rows are
keyed by ``DeploymentSpec.deployment_id`` while the projector narrows by
``Deployment.deployment_id`` — the two must agree byte-for-byte, else the projection sees no
rows. The address is carried verbatim (no normalization) so a configured spec and the
projector's deployment produce the same key.

Naming (ADR-0012): a deployment is labelled ``<network>-<registry_version>``; the bare
network name resolves only through the registry's explicit ``latest`` pointer.
"""

from __future__ import annotations

import json

import pytest

from ethswarm_volumes import cli, decode, registry
from ethswarm_volumes.model import Deployment

GNOSIS_V1 = "0x9639AE4C7A8FA9EFE585738D516A3915DDD02AAD"


def _entry(network, version, chain_id=1, address="0xa", **extra):
    return {
        "network": network,
        "registry_version": version,
        "chain_id": chain_id,
        "registry": address,
        **extra,
    }


def test_spec_and_model_deployment_ids_agree():
    addr = "0x9639Ae4C7a8FA9EFE585738D516a3915dDd02AaD"  # mixed-case checksum
    spec = registry.DeploymentSpec(
        network="gnosis", registry_version="v1", chain_id=100, registry=addr
    )
    dep = Deployment(
        label=spec.label,
        chain_id=100,
        registry=addr,
        registry_version="v1",
        genesis_ts=None,
        fiat_currencies=[],
        extra={},
    )
    assert spec.deployment_id == dep.deployment_id


def test_label_is_network_and_version():
    spec = registry.DeploymentSpec(
        network="sepolia", registry_version="v2-rc1", chain_id=11155111, registry="0xa"
    )
    assert spec.label == "sepolia-v2-rc1"


def test_default_registry_is_the_live_fleet():
    labels = {s.label for s in registry.DEFAULT_REGISTRY}
    assert {"gnosis-v1", "sepolia-v1"} <= labels
    assert registry.DEFAULT_REGISTRY.latest["gnosis"] == "gnosis-v1"


def test_default_registry_is_closed_over_supported_versions():
    """Support closure (ADR-0011): every shipped registry entry's ``registry_version``
    has decode reference data behind it. This gates publishing — a released package can
    never carry an entry it cannot decode."""
    for spec in registry.DEFAULT_REGISTRY:
        assert spec.registry_version in decode.supported_versions(), spec.label


def test_supported_versions_are_release_names():
    """Every claim-site key is a release name (``vN`` / ``vN-rcM``), so it can label a
    deployment and match a tag (ADR-0012)."""
    for version in decode.supported_versions():
        assert registry.VERSION_NAME.fullmatch(version), version


@pytest.mark.parametrize("version", ["v1", "v2", "v2-rc1", "v10-rc12"])
def test_version_names_accepted(version):
    assert registry.VERSION_NAME.fullmatch(version)


@pytest.mark.parametrize("version", ["1", "v0", "v2rc1", "v2-rc0", "v2-beta1", "V2", "v2-rc"])
def test_version_names_rejected(version):
    assert not registry.VERSION_NAME.fullmatch(version)


def test_sync_guard_flags_unsupported_versions():
    """The runtime guard for operator ``--config`` files, which bypass the test gate."""
    ok = registry.DeploymentSpec(network="a", registry_version="v1", chain_id=1, registry="0xa")
    future = registry.DeploymentSpec(
        network="a", registry_version="v99", chain_id=1, registry="0xb"
    )
    assert cli._unsupported([ok, future]) == [future]


def test_load_registry_override(tmp_path):
    cfg = tmp_path / "registry.json"
    cfg.write_text(json.dumps({"deployments": [_entry("local", "v1", 31337, "0xabc")]}))
    reg = registry.load_registry(cfg)
    assert len(reg) == 1
    (spec,) = reg
    assert spec.label == "local-v1"
    assert spec.genesis_block is None  # absent -> discover on sync
    assert reg.latest == {}  # optional; no pointer unless stated


def test_registry_document_round_trips():
    doc = {
        "deployments": [_entry("gnosis", "v1", 100, "0xa", genesis_block=7)],
        "latest": {"gnosis": "gnosis-v1"},
    }
    assert registry.registry_to_dict(registry.registry_from_dict(doc)) == doc


def test_version_is_required():
    with pytest.raises(KeyError):
        registry.registry_from_dict(
            {"deployments": [{"network": "x", "chain_id": 1, "registry": "0xa"}]}
        )


def test_rejects_malformed_version():
    with pytest.raises(ValueError, match="registry_version"):
        registry.registry_from_dict({"deployments": [_entry("x", "2.0")]})


def test_rejects_two_deployments_of_one_version_on_one_network():
    doc = {"deployments": [_entry("x", "v1", address="0xa"), _entry("x", "v1", address="0xb")]}
    with pytest.raises(ValueError, match="duplicate deployment 'x-v1'"):
        registry.registry_from_dict(doc)


@pytest.mark.parametrize(
    "latest",
    [{"x": "x-v9"}, {"y": "x-v1"}],
    ids=["unknown-label", "other-network"],
)
def test_rejects_latest_pointer_off_its_network(latest):
    doc = {"deployments": [_entry("x", "v1"), _entry("y", "v1", address="0xb")], "latest": latest}
    with pytest.raises(ValueError, match="latest"):
        registry.registry_from_dict(doc)


def test_select_by_label_network_then_chain_address():
    reg = registry.DEFAULT_REGISTRY
    assert registry.select(reg, "gnosis-v1").label == "gnosis-v1"
    assert registry.select(reg, "gnosis").label == "gnosis-v1"  # via latest
    assert registry.select(reg, f"100:{GNOSIS_V1}").label == "gnosis-v1"
    assert registry.select(reg, "nope") is None
    assert registry.select(reg, None) is None  # ambiguous: several present


def test_bare_network_without_pointer_does_not_resolve():
    """No pointer, no guess: a bare name never falls back to version order."""
    reg = registry.registry_from_dict(
        {"deployments": [_entry("x", "v1", address="0xa"), _entry("x", "v2-rc1", address="0xb")]}
    )
    assert registry.select(reg, "x") is None
    assert registry.select(reg, "x-v2-rc1").registry == "0xb"


def test_latest_pointer_moves_explicitly():
    doc = {
        "deployments": [_entry("x", "v1", address="0xa"), _entry("x", "v2-rc1", address="0xb")],
        "latest": {"x": "x-v1"},
    }
    assert registry.select(registry.registry_from_dict(doc), "x").registry == "0xa"
    doc["latest"] = {"x": "x-v2-rc1"}
    assert registry.select(registry.registry_from_dict(doc), "x").registry == "0xb"

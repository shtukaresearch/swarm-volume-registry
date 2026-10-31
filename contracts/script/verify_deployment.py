#!/usr/bin/env python3
"""Verify an exported VolumeRegistry deployment on its configured block explorer."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from deploy import CONTRACTS, load_profile
from export_deployment import (
    ADDRESS,
    CONSTRUCTOR_ARGS,
    SAFE_NAME,
    VERSION_NAME,
    constructor_args,
    constructor_args_mismatch,
    encode_constructor_args,
    fail,
    quantity,
    read_json,
    versioned_name,
)


CONTRACT = "src/VolumeRegistry.sol:VolumeRegistry"
ENCODED_CONSTRUCTOR = re.compile(r"0x[0-9a-f]{256}\Z")
SUPPORTED_VERIFIERS = {"etherscan", "blockscout"}


def profile_string(profile: dict[str, Any], key: str, profile_name: str) -> str:
    value = profile.get(key)
    if not isinstance(value, str) or not value:
        fail(f"deployment profile {profile_name!r} is missing a valid {key!r}")
    return value


def verification_settings(profile_name: str, profile: dict[str, Any]) -> dict[str, str]:
    network = profile_string(profile, "deployment_network", profile_name)
    if not SAFE_NAME.fullmatch(network):
        fail(f"deployment profile {profile_name!r} has an invalid deployment_network")

    verifier = profile_string(profile, "verifier", profile_name)
    if verifier not in SUPPORTED_VERIFIERS:
        choices = ", ".join(sorted(SUPPORTED_VERIFIERS))
        fail(
            f"deployment profile {profile_name!r} has unsupported verifier {verifier!r}; "
            f"expected one of: {choices}"
        )

    settings = {"network": network, "verifier": verifier}
    verifier_url = profile.get("verifier_url")
    if verifier_url is not None:
        if not isinstance(verifier_url, str) or not verifier_url.startswith("https://"):
            fail(f"deployment profile {profile_name!r} has an invalid verifier_url")
        settings["verifier_url"] = verifier_url
    if verifier == "blockscout" and "verifier_url" not in settings:
        fail(f"deployment profile {profile_name!r} must configure verifier_url for Blockscout")

    api_key_env = profile.get("verifier_api_key_env")
    if api_key_env is not None:
        if not isinstance(api_key_env, str) or not api_key_env:
            fail(f"deployment profile {profile_name!r} has an invalid verifier_api_key_env")
        if not os.environ.get(api_key_env):
            fail(f"{api_key_env} must be set for deployment profile {profile_name!r}")
        settings["api_key_env"] = api_key_env

    explorer_url = profile_string(profile, "explorer_url", profile_name)
    if "{address}" not in explorer_url or not explorer_url.startswith("https://"):
        fail(f"deployment profile {profile_name!r} has an invalid explorer_url")
    settings["explorer_url"] = explorer_url
    return settings


def load_deployment(
    profile_name: str,
    profile: dict[str, Any],
    network: str,
    version: str,
) -> tuple[Path, dict[str, Any]]:
    record = versioned_name("VolumeRegistry", version)
    path = CONTRACTS / "deployments" / network / f"{record}.json"
    deployment = read_json(path, "deployment record")

    address = deployment.get("address")
    if not isinstance(address, str) or not ADDRESS.fullmatch(address):
        fail(f"deployment record has an invalid address: {path}")

    linked_data = deployment.get("linkedData")
    if not isinstance(linked_data, dict):
        fail(f"deployment record is missing linkedData: {path}")
    if quantity(linked_data.get("chainId"), "deployment record chain ID") != profile["chain_id"]:
        fail(f"deployment record chain does not match profile {profile_name!r}: {path}")
    if linked_data.get("profile") != profile_name:
        fail(f"deployment record profile does not match {profile_name!r}: {path}")
    if linked_data.get("version") != version:
        fail(f"deployment record version does not match {version!r}: {path}")

    arguments = deployment.get("args")
    if not isinstance(arguments, list) or len(arguments) != len(CONSTRUCTOR_ARGS):
        fail(f"deployment record is missing constructor arguments: {path}")
    mismatch = constructor_args_mismatch(arguments, profile)
    if mismatch is not None:
        fail(f"deployment record {mismatch} does not match profile {profile_name!r}: {path}")
    return path, deployment


def encode_constructor(profile: dict[str, Any]) -> str:
    """The profile's ABI-encoded constructor arguments, ``0x``-prefixed."""
    encoded = "0x" + encode_constructor_args(constructor_args(profile))
    if not ENCODED_CONSTRUCTOR.fullmatch(encoded):
        fail("invalid encoded constructor arguments")
    return encoded


def verification_command(
    profile: dict[str, Any],
    settings: dict[str, str],
    address: str,
    rpc_url: str,
    constructor_args: str,
) -> list[str]:
    command = [
        "forge",
        "verify-contract",
        address,
        CONTRACT,
        "--chain",
        str(profile["chain_id"]),
        "--rpc-url",
        rpc_url,
        "--constructor-args",
        constructor_args,
        "--verifier",
        settings["verifier"],
    ]
    if "verifier_url" in settings:
        command.extend(("--verifier-url", settings["verifier_url"]))
    command.append("--watch")
    return command


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", help="profile name from deployments.toml")
    parser.add_argument("--version", required=True, help="release name of the deployment")
    parser.add_argument(
        "--rpc-url",
        default=os.environ.get("RPC_URL"),
        help="target-chain RPC URL (defaults to RPC_URL)",
    )
    args = parser.parse_args()

    if not VERSION_NAME.fullmatch(args.version):
        parser.error("version must be vN or vN-rcM (e.g. v2, v2-rc1)")
    if not args.rpc_url:
        parser.error("--rpc-url is required when RPC_URL is not set")

    profile = load_profile(args.profile)
    settings = verification_settings(args.profile, profile)
    deployment_path, deployment = load_deployment(
        args.profile,
        profile,
        settings["network"],
        args.version,
    )
    constructor_args = encode_constructor(profile)
    command = verification_command(
        profile,
        settings,
        deployment["address"],
        args.rpc_url,
        constructor_args,
    )

    print(f"verifying {deployment_path.relative_to(CONTRACTS)} with {settings['verifier']}")
    subprocess.run(command, cwd=CONTRACTS, check=True)
    print(settings["explorer_url"].format(address=deployment["address"]))


if __name__ == "__main__":
    main()

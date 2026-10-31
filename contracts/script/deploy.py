#!/usr/bin/env python3
"""Resolve a named deployment profile and invoke the Foundry script.

The registry is deployed with CREATE2 through ``CREATE2_FACTORY``, salted with the
release name, so a release's address on a chain is fixed by the source, the profile and
the release name alone.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any, NoReturn


CONTRACTS = Path(__file__).resolve().parent.parent
CONFIG = CONTRACTS / "deployments.toml"
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
MIN_FOUNDRY = (1, 7, 1)
# Release names: vN for a mainnet release, vN-rcM for a testnet release candidate. The
# same grammar as the indexer's registry (services/indexer, registry.VERSION_NAME).
VERSION_NAME = re.compile(r"v[1-9][0-9]*(-rc[1-9][0-9]*)?\Z")
# Arachnid's deterministic deployment proxy, Foundry's default CREATE2 deployer. It is
# deployed at this address on every chain we use; its calldata is salt ‖ initcode.
CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c"
# DeployVolumeRegistry.run(postageStamp, bzz, graceBlocks, bzzPermitExpiry, salt).
SCRIPT_SIGNATURE = "run(address,address,uint64,bool,bytes32)"


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def load_profile(name: str) -> dict[str, Any]:
    with CONFIG.open("rb") as config_file:
        profiles = tomllib.load(config_file).get("profiles", {})

    if name not in profiles:
        choices = ", ".join(sorted(profiles)) or "none"
        fail(f"unknown deployment profile {name!r}; available profiles: {choices}")

    profile = profiles[name]
    for key in ("chain_id", "postage_stamp", "bzz", "grace_blocks", "bzz_permit_expiry"):
        if key not in profile:
            fail(f"deployment profile {name!r} is missing {key!r}")

    if not ADDRESS.fullmatch(profile["postage_stamp"]):
        fail(f"deployment profile {name!r} has an invalid postage_stamp")
    if not ADDRESS.fullmatch(profile["bzz"]):
        fail(f"deployment profile {name!r} has an invalid bzz")
    if not isinstance(profile["chain_id"], int) or isinstance(profile["chain_id"], bool):
        fail(f"deployment profile {name!r} has an invalid chain_id")
    grace = profile["grace_blocks"]
    if not isinstance(grace, int) or isinstance(grace, bool) or not 0 <= grace < 2**64:
        fail(f"deployment profile {name!r} has an invalid grace_blocks")
    if not isinstance(profile["bzz_permit_expiry"], bool):
        fail(f"deployment profile {name!r} has an invalid bzz_permit_expiry")

    return profile


def release_salt(version: str) -> str:
    """The CREATE2 salt for a release: its name in ASCII, left-aligned and zero-padded.

    This is what ``cast format-bytes32-string`` produces, so the salt reads as the
    release name on a block explorer. A network holds at most one deployment per release
    name, so the salt is never reused for the same initcode.
    """
    if not VERSION_NAME.fullmatch(version):
        fail(f"invalid release name {version!r}; expected vN or vN-rcM")
    return "0x" + version.encode("ascii").ljust(32, b"\0").hex()


def foundry_version() -> tuple[int, int, int]:
    output = subprocess.run(
        ["forge", "--version"], check=True, capture_output=True, text=True
    ).stdout
    match = re.search(r"Version:\s*(\d+)\.(\d+)\.(\d+)", output)
    if match is None:
        fail("could not parse forge --version")
    return tuple(int(part) for part in match.groups())


def rpc_chain_id(rpc_url: str) -> int:
    result = subprocess.run(
        ["cast", "chain-id", "--rpc-url", rpc_url],
        check=True,
        capture_output=True,
        text=True,
    )
    return int(result.stdout.strip())


def prompt_password(account: str) -> str:
    """Ask for the keystore password in a desktop dialog (zenity).

    The password is returned to this process only; it is never echoed, put in
    argv or the environment, or written to disk. Cancelling the dialog aborts.
    """
    try:
        result = subprocess.run(
            ["zenity", "--password", f"--title=Unlock Foundry keystore {account!r}"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        fail("--password-prompt requires zenity")
    if result.returncode != 0:
        fail("password prompt cancelled")
    return result.stdout.removesuffix("\n")


def password_memfd(password: str) -> int:
    """Return a file descriptor for an anonymous in-memory file holding `password`.

    Forge reads it through `--password-file /dev/fd/<fd>`. Forge only accepts a
    regular file there, which rules out a pipe; a memfd is a regular file that
    lives in RAM, has no name in any filesystem and vanishes when closed.
    Linux-only, like the zenity prompt.
    """
    fd = os.memfd_create("keystore-password", os.MFD_CLOEXEC)
    os.write(fd, password.encode())
    return fd


def has_code(address: str, rpc_url: str) -> bool:
    result = subprocess.run(
        ["cast", "code", address, "--rpc-url", rpc_url],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() not in ("", "0x")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", help="profile name from deployments.toml")
    parser.add_argument(
        "--version",
        required=True,
        help="release name (vN or vN-rcM); also the CREATE2 salt",
    )
    parser.add_argument("--rpc-url", required=True, help="target chain RPC URL")
    parser.add_argument("--account", help="Foundry keystore account name")
    parser.add_argument("--broadcast", action="store_true", help="send the deployment transaction")
    parser.add_argument(
        "--password-prompt",
        action="store_true",
        help="ask for the keystore password in a desktop dialog instead of the terminal",
    )
    args = parser.parse_args(argv)

    if args.broadcast and args.account is None:
        parser.error("--account is required with --broadcast")
    if args.password_prompt and args.account is None:
        parser.error("--account is required with --password-prompt")

    version = foundry_version()
    if version < MIN_FOUNDRY:
        required = ".".join(str(part) for part in MIN_FOUNDRY)
        actual = ".".join(str(part) for part in version)
        fail(
            f"forge {actual} does not infer --sender from a single --account; "
            f"upgrade to at least {required}"
        )

    salt = release_salt(args.version)
    profile = load_profile(args.profile)
    actual_chain_id = rpc_chain_id(args.rpc_url)
    if actual_chain_id != profile["chain_id"]:
        fail(
            f"profile {args.profile!r} requires chain {profile['chain_id']}, "
            f"but the RPC reports chain {actual_chain_id}"
        )
    if not has_code(CREATE2_FACTORY, args.rpc_url):
        fail(f"CREATE2 factory {CREATE2_FACTORY} has no code on chain {actual_chain_id}")

    command = [
        "forge",
        "script",
        "script/DeployVolumeRegistry.s.sol:DeployVolumeRegistry",
        "--sig",
        SCRIPT_SIGNATURE,
        profile["postage_stamp"],
        profile["bzz"],
        str(profile["grace_blocks"]),
        "true" if profile["bzz_permit_expiry"] else "false",
        salt,
        "--create2-deployer",
        CREATE2_FACTORY,
        "--rpc-url",
        args.rpc_url,
    ]
    if args.account is not None:
        command.extend(("--account", args.account))
    if args.broadcast:
        # Forge's local simulation runs under the project's evm_version (paris,
        # the newest solc 0.8.19 supports), so it misprices state creation on
        # chains with EIP-8037 (Glamsterdam): about 2.2M gas instead of ~12M
        # for this contract. --skip-simulation makes forge take each gas limit
        # from the RPC's eth_estimateGas, times --gas-estimate-multiplier.
        command.extend(("--broadcast", "--skip-simulation"))

    if not args.password_prompt:
        subprocess.run(command, cwd=CONTRACTS, check=True)
        return

    read_fd = password_memfd(prompt_password(args.account))
    try:
        command.extend(("--password-file", f"/dev/fd/{read_fd}"))
        subprocess.run(command, cwd=CONTRACTS, check=True, pass_fds=(read_fd,))
    finally:
        os.close(read_fd)


if __name__ == "__main__":
    main()

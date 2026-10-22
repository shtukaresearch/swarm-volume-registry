#!/usr/bin/env python3
"""Resolve a named deployment profile and invoke the Foundry script."""

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


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def load_profile(name: str) -> dict[str, Any]:
    with CONFIG.open("rb") as config_file:
        profiles = tomllib.load(config_file).get("profiles", {})

    if name not in profiles:
        choices = ", ".join(sorted(profiles)) or "none"
        fail(f"unknown deployment profile {name!r}; available profiles: {choices}")

    profile = profiles[name]
    for key in ("chain_id", "postage_stamp", "bzz", "grace_blocks"):
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

    return profile


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


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", help="profile name from deployments.toml")
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

    profile = load_profile(args.profile)
    actual_chain_id = rpc_chain_id(args.rpc_url)
    if actual_chain_id != profile["chain_id"]:
        fail(
            f"profile {args.profile!r} requires chain {profile['chain_id']}, "
            f"but the RPC reports chain {actual_chain_id}"
        )

    command = [
        "forge",
        "script",
        "script/DeployVolumeRegistry.s.sol:DeployVolumeRegistry",
        "--sig",
        "run(address,address,uint64)",
        profile["postage_stamp"],
        profile["bzz"],
        str(profile["grace_blocks"]),
        "--rpc-url",
        args.rpc_url,
    ]
    if args.account is not None:
        command.extend(("--account", args.account))
    if args.broadcast:
        command.append("--broadcast")

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

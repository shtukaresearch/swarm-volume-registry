#!/usr/bin/env python3
"""Create a keeper deployment's wallet in the Foundry keystore and fund it with gas.

Every keeper Worker has its own wallet, so a new registry deployment needs a new
one. The keystore account is named after the Worker,
``keeper-cloudflare-<label>``, where ``<label>`` is the deployment label that
keys the env in ``wrangler.jsonc`` (``sepolia-v2-rc3``). It is funded from
another keystore account — the registry deployer by default — with the native
token only: a keeper pays gas and never holds BZZ.

The script refuses a label with no committed deployment record, an RPC on a
different chain from that record, and an account name already in the keystore.
``--existing`` instead requires the account to exist and only funds it, which
finishes a run that created the wallet but failed to fund it, or tops one up.
It never prints or stores the private key; ``RELEASING.md`` shows how to hand it
to the Worker.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import NoReturn

REPO = Path(__file__).resolve().parents[3]
RECORDS = REPO / "contracts" / "deployments"
KEYSTORES = Path.home() / ".foundry" / "keystores"
# `<network>-<release>`, as contracts/deployments/ and wrangler.jsonc name it.
LABEL = re.compile(
    r"(?P<network>[a-z][a-z0-9]*)-(?P<release>v[1-9][0-9]*(-rc[1-9][0-9]*)?)\Z"
)
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
ADDRESS_LINE = re.compile(r"^Address:\s*(0x[0-9a-fA-F]{40})\s*$", re.MULTILINE)
DEFAULT_FUNDER = "volume-registry-deployer"


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def account_name(label: str) -> str:
    """The keystore account for a deployment label: the name of its Worker."""
    return f"keeper-cloudflare-{label}"


def record_chain_id(label: str, records: Path = RECORDS) -> int:
    """The chain of the committed deployment `label` names.

    Fails unless `label` is a deployment label and its versioned record exists.
    """
    match = LABEL.fullmatch(label)
    if match is None:
        fail(
            f"invalid deployment label {label!r}; expected <network>-vN or <network>-vN-rcM"
        )
    network = records / match["network"]
    record = network / f"VolumeRegistry-{match['release']}.json"
    if not record.is_file():
        fail(f"no deployment record {record.relative_to(records.parent.parent)}")
    return int((network / ".chainId").read_text().strip())


def parse_value(value: str) -> str:
    """Validate a positive amount of the native token, in ether units."""
    try:
        amount = Decimal(value)
    except InvalidOperation:
        fail(f"invalid --value {value!r}")
    if not amount.is_finite() or amount <= 0:
        fail(f"--value must be positive, got {value!r}")
    return f"{amount}ether"


def created_address(output: str) -> str:
    """The address `cast wallet new` reports for the keystore it wrote."""
    match = ADDRESS_LINE.search(output)
    if match is None:
        fail("could not find the new wallet's address in cast's output")
    return match[1]


def check_keystore(account: str, exists: bool, existing: bool) -> None:
    """Fail unless the keystore account's presence is what the run expects.

    A new wallet must not overwrite one; ``--existing`` must name one.
    """
    if existing and not exists:
        fail(f"--existing: keystore account {account!r} does not exist")
    if not existing and exists:
        fail(
            f"keystore account {account!r} already exists; "
            "rerun with --existing to fund it"
        )


def reported_address(output: str) -> str:
    """The address `cast wallet address` prints."""
    address = output.strip()
    if not ADDRESS.fullmatch(address):
        fail(f"cast did not report an address: {address!r}")
    return address


def rpc_chain_id(rpc_url: str) -> int:
    result = subprocess.run(
        ["cast", "chain-id", "--rpc-url", rpc_url],
        check=True,
        capture_output=True,
        text=True,
    )
    return int(result.stdout.strip())


def zenity_password(title: str) -> str:
    """Ask for a password in a desktop dialog; cancelling aborts."""
    try:
        result = subprocess.run(
            ["zenity", "--password", f"--title={title}"],
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
    """An anonymous in-memory regular file holding `password`, for `--password-file`.

    Foundry only accepts a regular file there, which rules out a pipe. Linux-only,
    like the zenity prompt.
    """
    fd = os.memfd_create("keystore-password", os.MFD_CLOEXEC)
    os.write(fd, password.encode())
    return fd


def create_wallet(account: str, password_prompt: bool) -> str:
    """Write a new encrypted keystore `account` and return its address.

    Without `password_prompt`, cast asks for the new password on the terminal.
    With it, the password comes from two zenity dialogs and reaches cast through
    ``CAST_PASSWORD`` in the child's environment only: `cast wallet new` reads a
    password from nothing else besides a terminal.
    """
    command = ["cast", "wallet", "new", account]
    env = None
    if password_prompt:
        password = zenity_password(f"New password for keystore {account!r}")
        if zenity_password(f"Repeat the password for {account!r}") != password:
            fail("passwords do not match")
        env = {**os.environ, "CAST_PASSWORD": password}
    result = subprocess.run(
        command, check=True, stdout=subprocess.PIPE, text=True, env=env
    )
    return created_address(result.stdout)


def existing_address(account: str, password_prompt: bool) -> str:
    """Unlock keystore `account` and return its address.

    The keystore file does not record the address, so this takes the account's
    password: on the terminal from cast, or from a zenity dialog.
    """
    command = ["cast", "wallet", "address", "--account", account]
    if not password_prompt:
        result = subprocess.run(command, check=True, stdout=subprocess.PIPE, text=True)
        return reported_address(result.stdout)
    fd = password_memfd(zenity_password(f"Unlock Foundry keystore {account!r}"))
    try:
        command.extend(("--password-file", f"/dev/fd/{fd}"))
        result = subprocess.run(
            command, check=True, stdout=subprocess.PIPE, text=True, pass_fds=(fd,)
        )
    finally:
        os.close(fd)
    return reported_address(result.stdout)


def fund(
    address: str, value: str, funder: str, rpc_url: str, password_prompt: bool
) -> None:
    """Send `value` from keystore account `funder` to `address`, and wait for it."""
    command = [
        "cast",
        "send",
        address,
        "--value",
        value,
        "--account",
        funder,
        "--rpc-url",
        rpc_url,
    ]
    if not password_prompt:
        subprocess.run(command, check=True)
        return
    fd = password_memfd(zenity_password(f"Unlock Foundry keystore {funder!r}"))
    try:
        command.extend(("--password-file", f"/dev/fd/{fd}"))
        subprocess.run(command, check=True, pass_fds=(fd,))
    finally:
        os.close(fd)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("label", help="deployment label, e.g. sepolia-v2-rc3")
    parser.add_argument(
        "--rpc-url", required=True, help="RPC URL of the deployment's chain"
    )
    parser.add_argument("--value", required=True, help="amount to fund, in ether units")
    parser.add_argument(
        "--funder",
        default=DEFAULT_FUNDER,
        help=f"keystore account that pays (default: {DEFAULT_FUNDER})",
    )
    parser.add_argument(
        "--existing",
        action="store_true",
        help="fund the existing keystore account instead of creating it",
    )
    parser.add_argument(
        "--password-prompt",
        action="store_true",
        help="ask for keystore passwords in desktop dialogs instead of the terminal",
    )
    args = parser.parse_args(argv)

    account = account_name(args.label)
    value = parse_value(args.value)
    chain_id = record_chain_id(args.label)
    check_keystore(account, (KEYSTORES / account).exists(), args.existing)
    actual = rpc_chain_id(args.rpc_url)
    if actual != chain_id:
        fail(f"{args.label} is on chain {chain_id}, but the RPC reports chain {actual}")

    # Flushed as it goes, so a failure later still shows how far the run got.
    if args.existing:
        address = existing_address(account, args.password_prompt)
        print(f"using keystore account {account}: {address}", flush=True)
    else:
        address = create_wallet(account, args.password_prompt)
        print(f"created keystore account {account}: {address}", flush=True)
    fund(address, value, args.funder, args.rpc_url, args.password_prompt)
    print(f"funded {address} with {value} from {args.funder}", flush=True)


if __name__ == "__main__":
    main()

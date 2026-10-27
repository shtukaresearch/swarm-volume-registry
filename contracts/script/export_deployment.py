#!/usr/bin/env python3
"""Export a Forge broadcast as a hardhat-deploy-compatible deployment record.

Each deployment is recorded once, immutably, as ``deployments/<network>/<Contract>-<version>.json``
where ``<version>`` is the release name (``vN`` on mainnets, ``vN-rcM`` for testnet release
candidates). ``deployments/<network>/<Contract>.json`` is the network's *latest* pointer: a
byte-identical copy of one versioned record, written only when ``--latest`` is passed.

A deployment is either a plain contract-creation transaction (``CREATE``; releases up to
v2-rc2) or a call to ``deploy.CREATE2_FACTORY`` whose calldata is salt ‖ initcode
(``CREATE2``). A CREATE2 deployment must be salted with ``deploy.release_salt(version)``,
and its address is recomputed from factory, salt and initcode with ``cast``.

A record's ``bytecode`` is the deployed creation bytecode: the initcode without its
ABI-encoded constructor arguments (which must be the profile's), equal to the compiled
artifact's. It is what a consumer needs to redeploy the release, e.g. in tests.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any, NoReturn

from deploy import CONTRACTS, CREATE2_FACTORY, VERSION_NAME, load_profile, release_salt


DEFAULT_SCRIPT = "DeployVolumeRegistry.s.sol"
DEFAULT_CONTRACT = "VolumeRegistry"
DEFAULT_ARTIFACT = Path("out/VolumeRegistry.sol/VolumeRegistry.json")
DEFAULT_DEPLOYMENTS = Path("deployments")
LATEST_BROADCAST = "run-latest.json"
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
TRANSACTION_HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
DEPLOYMENT_TYPES = ("CREATE", "CREATE2")


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def read_json(path: Path, description: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        fail(f"{description} not found: {path}")
    except json.JSONDecodeError as error:
        fail(f"invalid JSON in {description} {path}: {error}")

    if not isinstance(value, dict):
        fail(f"{description} must contain a JSON object: {path}")
    return value


def quantity(value: Any, description: str) -> int:
    if isinstance(value, bool):
        fail(f"{description} must be an integer quantity")
    if isinstance(value, int):
        result = value
    elif isinstance(value, str):
        base = 16 if value.startswith(("0x", "0X")) else 10
        try:
            result = int(value, base)
        except ValueError:
            fail(f"{description} must be an integer quantity")
    else:
        fail(f"{description} must be an integer quantity")

    if result < 0:
        fail(f"{description} must be a non-negative integer quantity")
    return result


def resolve_from_contracts(path: Path) -> Path:
    return path if path.is_absolute() else CONTRACTS / path


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(CONTRACTS))
    except ValueError:
        return str(path)


def find_deployment(
    broadcast: dict[str, Any], contract_name: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    transactions = broadcast.get("transactions")
    if not isinstance(transactions, list):
        fail("broadcast is missing its transactions array")

    matches = [
        transaction
        for transaction in transactions
        if isinstance(transaction, dict)
        and transaction.get("transactionType") in DEPLOYMENT_TYPES
        and transaction.get("contractName") == contract_name
    ]
    if len(matches) != 1:
        fail(
            f"broadcast must contain exactly one CREATE or CREATE2 for {contract_name}; "
            f"found {len(matches)}"
        )

    transaction = matches[0]
    transaction_hash = transaction.get("hash")
    address = transaction.get("contractAddress")
    if not isinstance(transaction_hash, str) or not TRANSACTION_HASH.fullmatch(transaction_hash):
        fail(f"{contract_name} deployment has an invalid transaction hash")
    if not isinstance(address, str) or not ADDRESS.fullmatch(address):
        fail(f"{contract_name} deployment has an invalid contract address")

    receipts = broadcast.get("receipts")
    if not isinstance(receipts, list):
        fail("broadcast is missing its receipts array")
    receipt_matches = [
        receipt
        for receipt in receipts
        if isinstance(receipt, dict)
        and isinstance(receipt.get("transactionHash"), str)
        and receipt["transactionHash"].lower() == transaction_hash.lower()
    ]
    if len(receipt_matches) != 1:
        fail(
            f"broadcast must contain exactly one receipt for transaction {transaction_hash}; "
            f"found {len(receipt_matches)}"
        )

    receipt = receipt_matches[0]
    if quantity(receipt.get("status"), "deployment receipt status") != 1:
        fail(f"deployment transaction {transaction_hash} did not succeed")
    if transaction["transactionType"] == "CREATE":
        # A contract-creation transaction: the receipt names the created contract.
        receipt_address = receipt.get("contractAddress")
        if not isinstance(receipt_address, str) or receipt_address.lower() != address.lower():
            fail("deployment receipt contract address does not match the CREATE transaction")
    else:
        # A call to the factory: the receipt names no contract; the address is checked
        # against the salt and initcode in deployment_initcode.
        raw_transaction = transaction.get("transaction")
        to = raw_transaction.get("to") if isinstance(raw_transaction, dict) else None
        if not isinstance(to, str) or to.lower() != CREATE2_FACTORY:
            fail(f"CREATE2 deployment was not sent to the factory {CREATE2_FACTORY}")
        receipt_to = receipt.get("to")
        if not isinstance(receipt_to, str) or receipt_to.lower() != CREATE2_FACTORY:
            fail(f"deployment receipt is not for a call to the factory {CREATE2_FACTORY}")
    return transaction, receipt


def create2_address(factory: str, salt: str, initcode: str) -> str:
    """keccak256(0xff ‖ factory ‖ salt ‖ keccak256(initcode))[12:], computed by ``cast``."""
    output = subprocess.run(
        ["cast", "compute-address", factory, "--salt", salt, "--init-code", initcode],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    match = re.search(r"0x[0-9a-fA-F]{40}", output)
    if match is None:
        fail(f"could not parse cast compute-address output: {output!r}")
    return match.group(0)


def deployment_initcode(transaction: dict[str, Any], version: str) -> tuple[str, str | None]:
    """``(initcode with constructor arguments, CREATE2 salt or None)`` of a deployment.

    For CREATE the transaction input is the initcode. For CREATE2 it is salt ‖ initcode;
    the salt must be the release's, and the address forge recorded must be the one the
    factory derives from salt and initcode.
    """
    raw_transaction = transaction.get("transaction")
    data = raw_transaction.get("input") if isinstance(raw_transaction, dict) else None
    if not isinstance(data, str) or not data.startswith("0x"):
        fail("deployment transaction is missing its input bytecode")
    if transaction["transactionType"] == "CREATE":
        return data, None

    salt, initcode = "0x" + data[2:66].lower(), "0x" + data[66:]
    expected_salt = release_salt(version)
    if salt != expected_salt:
        fail(f"CREATE2 salt {salt} is not release {version!r}'s salt {expected_salt}")
    derived = create2_address(CREATE2_FACTORY, salt, initcode)
    if derived.lower() != transaction["contractAddress"].lower():
        fail(
            f"CREATE2 address {derived} derived from factory, salt and initcode does not "
            f"match the recorded {transaction['contractAddress']}"
        )
    return initcode, salt


def validate_profile(
    profile_name: str,
    profile: dict[str, Any],
    broadcast: dict[str, Any],
    transaction: dict[str, Any],
) -> None:
    chain_id = quantity(broadcast.get("chain"), "broadcast chain")
    if chain_id != profile["chain_id"]:
        fail(
            f"profile {profile_name!r} requires chain {profile['chain_id']}, "
            f"but the broadcast records chain {chain_id}"
        )

    arguments = transaction.get("arguments")
    if not isinstance(arguments, list) or len(arguments) != 3:
        fail("deployment must record its three constructor arguments")

    postage_matches = (
        isinstance(arguments[0], str)
        and arguments[0].lower() == profile["postage_stamp"].lower()
    )
    if not postage_matches:
        fail("broadcast PostageStamp constructor argument does not match the selected profile")
    if not isinstance(arguments[1], str) or arguments[1].lower() != profile["bzz"].lower():
        fail("broadcast BZZ constructor argument does not match the selected profile")
    if quantity(arguments[2], "graceBlocks constructor argument") != profile["grace_blocks"]:
        fail("broadcast graceBlocks constructor argument does not match the selected profile")


def normalized_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    result = dict(receipt)
    for field in ("blockNumber", "transactionIndex", "status"):
        if field in result:
            result[field] = quantity(result[field], f"receipt {field}")
    for field in ("cumulativeGasUsed", "gasUsed", "effectiveGasPrice"):
        if field in result:
            result[field] = str(quantity(result[field], f"receipt {field}"))
    if "status" in result:
        result["byzantium"] = True

    logs = result.get("logs")
    if isinstance(logs, list):
        normalized_logs: list[dict[str, Any]] = []
        for index, log in enumerate(logs):
            if not isinstance(log, dict):
                fail(f"receipt log {index} must be an object")
            normalized_log = dict(log)
            for field in ("blockNumber", "transactionIndex", "logIndex"):
                if field in normalized_log:
                    normalized_log[field] = quantity(
                        normalized_log[field], f"receipt log {index} {field}"
                    )
            normalized_logs.append(normalized_log)
        result["logs"] = normalized_logs
    return result


def constructor_args(profile: dict[str, Any]) -> list[Any]:
    """``VolumeRegistry(postageStamp, bzz, graceBlocks)``'s arguments, as the profile sets them."""
    return [profile["postage_stamp"], profile["bzz"], profile["grace_blocks"]]


def encode_constructor_args(args: list[Any]) -> str:
    """``abi.encode(address, address, uint64)`` of ``args``, as hex without a prefix."""
    postage_stamp, bzz, grace_blocks = args
    return (
        postage_stamp.lower().removeprefix("0x").rjust(64, "0")
        + bzz.lower().removeprefix("0x").rjust(64, "0")
        + format(grace_blocks, "064x")
    )


def creation_bytecode(initcode: str, args: list[Any]) -> str:
    """The deployed creation bytecode: ``initcode`` without its ABI-encoded ``args``."""
    initcode = initcode.lower()
    encoded = encode_constructor_args(args)
    if not initcode.endswith(encoded):
        fail("deployed initcode does not end with the profile's encoded constructor arguments")
    return initcode[: len(initcode) - len(encoded)]


def validate_artifact(artifact: dict[str, Any], deployed_bytecode: str) -> list[Any]:
    abi = artifact.get("abi")
    if not isinstance(abi, list):
        fail("contract artifact is missing its ABI array")

    bytecode = artifact.get("bytecode")
    artifact_bytecode = bytecode.get("object") if isinstance(bytecode, dict) else None
    if not isinstance(artifact_bytecode, str) or not artifact_bytecode.startswith("0x"):
        fail("contract artifact is missing its creation bytecode")
    if artifact_bytecode.lower() != deployed_bytecode:
        fail("compiled artifact bytecode does not match the deployed creation bytecode")
    return abi


def latest_run(latest_path: Path) -> Path:
    """The immutable run file that ``latest_path`` (a ``run-latest.json``) is a copy of.

    Forge writes each broadcast twice in one step: to ``run-<ms>.json`` (``<ms>`` is the
    run's start, not the broadcast's ``timestamp``) and to ``run-latest.json``, which the
    next broadcast overwrites. A record must cite the former, which is the one sibling
    ``run-*.json`` with identical bytes; none or several is an error. Which wrong runs this
    can and cannot pick up is recorded in ``docs/adr/0006-immutable-deployment-records.md``.
    """
    try:
        latest = latest_path.read_bytes()
    except FileNotFoundError:
        fail(f"Forge broadcast not found: {latest_path}")
    twins = [
        sibling
        for sibling in sorted(latest_path.parent.glob("run-*.json"))
        if sibling != latest_path and sibling.read_bytes() == latest
    ]
    if len(twins) != 1:
        fail(
            f"{display_path(latest_path)} must have exactly one identical run-<ms>.json "
            f"beside it; found {len(twins)}. Pass that run file with --broadcast."
        )
    return twins[0]


def build_manifest(
    profile_name: str,
    version: str,
    profile: dict[str, Any],
    broadcast: dict[str, Any],
    artifact: dict[str, Any],
    contract_name: str,
    broadcast_path: Path,
) -> dict[str, Any]:
    transaction, receipt = find_deployment(broadcast, contract_name)
    validate_profile(profile_name, profile, broadcast, transaction)

    initcode, salt = deployment_initcode(transaction, version)
    args = constructor_args(profile)
    bytecode = creation_bytecode(initcode, args)
    abi = validate_artifact(artifact, bytecode)

    if broadcast_path.name == LATEST_BROADCAST:
        fail(f"a record must cite an immutable run file, not {LATEST_BROADCAST}")
    timestamp = broadcast.get("timestamp")

    linked_data: dict[str, Any] = {
        "version": version,
        "chainId": profile["chain_id"],
        "profile": profile_name,
        "broadcast": str(broadcast_path.relative_to(CONTRACTS)),
    }
    if isinstance(timestamp, int):
        linked_data["timestamp"] = timestamp
    if isinstance(broadcast.get("commit"), str):
        linked_data["commit"] = broadcast["commit"]
    if salt is not None:
        linked_data["create2"] = {"factory": CREATE2_FACTORY, "salt": salt}

    return {
        "address": transaction["contractAddress"],
        "abi": abi,
        "bytecode": bytecode,
        "transactionHash": transaction["hash"],
        "receipt": normalized_receipt(receipt),
        "args": args,
        "linkedData": linked_data,
    }


def versioned_name(contract_name: str, version: str) -> str:
    return f"{contract_name}-{version}"


def write_manifest(
    output_root: Path,
    network: str,
    contract_name: str,
    version: str,
    chain_id: int,
    manifest: dict[str, Any],
    latest: bool = False,
) -> list[Path]:
    network_dir = output_root / network
    chain_file = network_dir / ".chainId"
    output_file = network_dir / f"{versioned_name(contract_name, version)}.json"
    latest_file = network_dir / f"{contract_name}.json"

    if chain_file.exists():
        recorded_chain = quantity(chain_file.read_text().strip(), f"chain ID in {chain_file}")
        if recorded_chain != chain_id:
            fail(
                f"deployment network {network!r} already records chain {recorded_chain}, "
                f"not {chain_id}"
            )

    # One deployment per network and version: a record may be regenerated, never replaced
    # by another deployment. A redeploy is a new release candidate or release.
    if output_file.exists():
        recorded = read_json(output_file, "deployment record")
        if str(recorded.get("address", "")).lower() != str(manifest["address"]).lower():
            fail(
                f"{network} already records {contract_name} {version} at "
                f"{recorded.get('address')}; a new deployment needs a new version"
            )

    text = json.dumps(manifest, indent=2) + "\n"
    network_dir.mkdir(parents=True, exist_ok=True)
    chain_file.write_text(f"{chain_id}\n")
    output_file.write_text(text)
    written = [output_file]
    if latest:
        latest_file.write_text(text)
        written.append(latest_file)
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", help="profile name from deployments.toml")
    parser.add_argument(
        "--version",
        required=True,
        help="release name: vN on a mainnet, vN-rcM for a testnet release candidate",
    )
    parser.add_argument(
        "--latest",
        action="store_true",
        help=f"also point the network's {DEFAULT_CONTRACT}.json at this deployment",
    )
    parser.add_argument(
        "--network",
        help="override the profile's deployment network directory name",
    )
    parser.add_argument("--contract-name", default=DEFAULT_CONTRACT)
    parser.add_argument(
        "--broadcast",
        type=Path,
        help=(
            "Forge broadcast run file to export, used as given (default: the run-<ms>.json "
            "that the selected chain's run-latest.json copies)"
        ),
    )
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--deployments-dir", type=Path, default=DEFAULT_DEPLOYMENTS)
    args = parser.parse_args()

    if not SAFE_NAME.fullmatch(args.contract_name):
        parser.error("contract name must contain only letters, digits, '.', '_' or '-'")
    if not VERSION_NAME.fullmatch(args.version):
        parser.error("version must be vN or vN-rcM (e.g. v2, v2-rc1)")

    profile = load_profile(args.profile)
    network = args.network or profile.get("deployment_network")
    if not isinstance(network, str) or not SAFE_NAME.fullmatch(network):
        fail(
            f"deployment profile {args.profile!r} must define a valid "
            "'deployment_network', or pass --network"
        )
    if args.broadcast:
        broadcast_path = resolve_from_contracts(args.broadcast)
    else:
        broadcast_path = latest_run(
            CONTRACTS / "broadcast" / DEFAULT_SCRIPT / str(profile["chain_id"]) / LATEST_BROADCAST
        )
    artifact_path = resolve_from_contracts(args.artifact)
    output_root = resolve_from_contracts(args.deployments_dir)

    broadcast = read_json(broadcast_path, "Forge broadcast")
    artifact = read_json(artifact_path, "contract artifact")
    try:
        manifest = build_manifest(
            args.profile,
            args.version,
            profile,
            broadcast,
            artifact,
            args.contract_name,
            broadcast_path,
        )
    except ValueError:
        fail(f"broadcast path must be beneath the contracts directory: {broadcast_path}")

    written = write_manifest(
        output_root,
        network,
        args.contract_name,
        args.version,
        profile["chain_id"],
        manifest,
        latest=args.latest,
    )
    for path in written:
        print(f"wrote {display_path(path)}")


if __name__ == "__main__":
    main()

"""The web3 decode layer: raw logs -> ``EventLogRow`` (``docs/ARCHITECTURE.md`` §2).

The *mechanical* ABI decode (topics/data split, field order, types) is delegated to a
trusted ABI library (web3.py's :func:`get_event_data`) driven by the **compiled contract
ABI** — see ``ARCHITECTURE.md`` §2 for the build dependency that implies. Nothing
bespoke there.

The bespoke, tested part is :func:`map_event_args` — a per-version mapping from the
library's decoded event (ABI param names, raw enum ints) to our ``event_log`` ``args``
shape (snake_case keys, enum names). That mapping is the only thing the decode unit tests
target; everything else rides on the library and is checked end-to-end by the contract
fixtures.

Decode is per-log: each :func:`decode_log` yields one :class:`~ethswarm_volumes.model.EventLogRow`.
The rows land in the per-event-type ``event_log`` (``EventLog.from_rows``;
``docs/data-model/event-log.md``), grouped by ``event_name`` — this layer does no merging.

The event ABIs below are the **version-pinned reference data** the architecture calls a
build dependency: they are the events ABI of ``contracts/out/VolumeRegistry.sol`` plus the
ERC-20 ``Transfer`` of the BZZ token (the fee leg). Pinning them per ``registry_version``
keeps the package self-contained — the decode is still mechanical, driven by these ABIs.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from hexbytes import HexBytes
from web3 import Web3
from web3._utils.events import get_event_data

from .model import DeploymentId, EventLogRow

# ---------------------------------------------------------------------------
# Version-pinned reference data
# ---------------------------------------------------------------------------

#: The ``VolumeRegistry`` (v1) events ABI, verbatim from Foundry's build output, plus the
#: ERC-20 ``Transfer`` ABI used to decode the captured BZZ fee leg. Driving
#: :func:`get_event_data` with these is the whole of the mechanical decode.
_V1_EVENT_ABIS: list[dict[str, Any]] = [
    {
        "type": "event",
        "name": "AccountActivated",
        "anonymous": False,
        "inputs": [
            {"name": "owner", "type": "address", "indexed": True},
            {"name": "payer", "type": "address", "indexed": True},
        ],
    },
    {
        "type": "event",
        "name": "AccountRevoked",
        "anonymous": False,
        "inputs": [
            {"name": "owner", "type": "address", "indexed": True},
            {"name": "payer", "type": "address", "indexed": True},
            {"name": "revoker", "type": "address", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "PayerDesignated",
        "anonymous": False,
        "inputs": [
            {"name": "owner", "type": "address", "indexed": True},
            {"name": "payer", "type": "address", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "Toppedup",
        "anonymous": False,
        "inputs": [
            {"name": "volumeId", "type": "bytes32", "indexed": True},
            {"name": "amount", "type": "uint256", "indexed": False},
            {"name": "newNormalisedBalance", "type": "uint256", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "TopupSkipped",
        "anonymous": False,
        "inputs": [
            {"name": "volumeId", "type": "bytes32", "indexed": True},
            {"name": "reason", "type": "uint8", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "VolumeCreated",
        "anonymous": False,
        "inputs": [
            {"name": "volumeId", "type": "bytes32", "indexed": True},
            {"name": "owner", "type": "address", "indexed": True},
            {"name": "chunkSigner", "type": "address", "indexed": False},
            {"name": "depth", "type": "uint8", "indexed": False},
            {"name": "ttlExpiry", "type": "uint64", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "VolumeOwnershipTransferred",
        "anonymous": False,
        "inputs": [
            {"name": "volumeId", "type": "bytes32", "indexed": True},
            {"name": "from", "type": "address", "indexed": True},
            {"name": "to", "type": "address", "indexed": True},
        ],
    },
    {
        "type": "event",
        "name": "VolumeRetired",
        "anonymous": False,
        "inputs": [
            {"name": "volumeId", "type": "bytes32", "indexed": True},
            {"name": "reason", "type": "uint8", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "Transfer",  # ERC-20 (BZZ token); the captured fee leg
        "anonymous": False,
        "inputs": [
            {"name": "from", "type": "address", "indexed": True},
            {"name": "to", "type": "address", "indexed": True},
            {"name": "value", "type": "uint256", "indexed": False},
        ],
    },
]

#: ``VolumeRetired.reason`` enum -> name (contract constants ``REASON_*``).
_V1_RETIRE_REASONS: dict[int, str] = {
    1: "OwnerDeleted",
    2: "VolumeExpired",
    3: "BatchDied",
    4: "DepthChanged",
    5: "BatchOwnerMismatch",
}

#: ``TopupSkipped.reason`` enum -> name (contract constants ``SKIP_*``).
_V1_SKIP_REASONS: dict[int, str] = {
    1: "NoAuth",
    2: "PaymentFailed",
}

#: Per-event enum decoders, keyed ``(event_name, arg_key)`` -> ``int -> name``.
_V1_ENUMS: dict[tuple[str, str], dict[int, str]] = {
    ("VolumeRetired", "reason"): _V1_RETIRE_REASONS,
    ("TopupSkipped", "reason"): _V1_SKIP_REASONS,
}

#: All version-specific reference data, keyed by ``registry_version``.
_VERSIONS = {
    "v1": {"abis": _V1_EVENT_ABIS, "enums": _V1_ENUMS},
}

_CODEC = Web3().codec


def _event_signature(event_abi: dict[str, Any]) -> str:
    """The canonical event signature, e.g. ``Transfer(address,address,uint256)``."""
    types = ",".join(i["type"] for i in event_abi["inputs"])
    return f"{event_abi['name']}({types})"


def _topic_index(registry_version: str) -> dict[bytes, dict[str, Any]]:
    """``topic0`` (32 raw bytes) -> event ABI, for one registry version."""
    abis = _VERSIONS[registry_version]["abis"]
    return {bytes(Web3.keccak(text=_event_signature(a))): a for a in abis}


#: Memoised ``topic0 -> event ABI`` index per registry version.
_TOPIC_INDEX: dict[str, dict[bytes, dict[str, Any]]] = {v: _topic_index(v) for v in _VERSIONS}

#: ``camelCase`` / ``PascalCase`` -> ``snake_case`` for ABI param names.
_CAMEL_RE = re.compile(r"(?<!^)(?=[A-Z])")


def _snake(name: str) -> str:
    """ABI param name (camelCase) -> our ``args`` key (snake_case).

    ``volumeId`` -> ``volume_id``, ``chunkSigner`` -> ``chunk_signer``,
    ``newNormalisedBalance`` -> ``new_normalised_balance``; already-snake names
    (``from``, ``owner``, ``value``) pass through unchanged.
    """
    return _CAMEL_RE.sub("_", name).lower()


def _normalize_value(abi_type: str, value: Any) -> Any:
    """Normalize one decoded value to the web3-free ``args`` representation.

    Addresses are lowercased hex; ``bytes*`` become ``0x``-prefixed hex strings; numeric
    and boolean types are kept as the faithful integer/bool the library produced.
    """
    if abi_type == "address":
        return value.lower()
    if abi_type.startswith("bytes"):
        return "0x" + bytes(value).hex()
    return value


def map_event_args(
    event_name: str, abi_args: dict[str, Any], *, registry_version: str
) -> dict[str, Any]:
    """Map a library-decoded event's args to the ``event_log`` ``args`` representation.

    Two transforms, both version-specific reference data:

    - **Key rename**: ABI param names (camelCase) -> our keys (snake_case), e.g.
      ``chunkSigner`` -> ``chunk_signer``, ``newNormalisedBalance`` -> ``new_normalised_balance``.
    - **Enum -> name**: integer enum values -> their names, e.g. ``VolumeRetired.reason``
      ``3`` -> ``"BatchDied"``, ``TopupSkipped.reason`` ``1`` -> ``"NoAuth"``.

    Addresses are already lowercased and amounts are the faithful integer atomic value —
    neither is transformed here (that happens during the mechanical decode).
    """
    enums = _VERSIONS[registry_version]["enums"]
    out: dict[str, Any] = {}
    for abi_key, value in abi_args.items():
        key = _snake(abi_key)
        enum = enums.get((event_name, key))
        out[key] = enum[value] if enum is not None else value
    return out


def decode_log(
    raw_log: dict[str, Any],
    *,
    deployment_id: DeploymentId,
    block_ts: datetime,
    registry_version: str,
) -> EventLogRow:
    """Decode one raw log into a web3-free :class:`EventLogRow`.

    Mechanical ABI decode (library + compiled ABI) to recover ``event_name`` and the
    ABI-named args, then :func:`map_event_args` to the ``event_log`` representation.
    ``block_ts`` is supplied by the caller (resolved from the block).
    """
    topic0 = bytes(HexBytes(raw_log["topics"][0]))
    event_abi = _TOPIC_INDEX[registry_version][topic0]
    decoded = get_event_data(_CODEC, event_abi, raw_log)

    abi_args = {
        i["name"]: _normalize_value(i["type"], decoded["args"][i["name"]])
        for i in event_abi["inputs"]
    }
    args = map_event_args(decoded["event"], abi_args, registry_version=registry_version)

    return EventLogRow(
        deployment_id=deployment_id,
        block_number=int(raw_log["blockNumber"]),
        block_ts=block_ts,
        tx_hash="0x" + bytes(HexBytes(raw_log["transactionHash"])).hex(),
        tx_index=int(raw_log["transactionIndex"]),
        log_index=int(raw_log["logIndex"]),
        emitter=raw_log["address"].lower(),
        event_name=decoded["event"],
        args=args,
    )

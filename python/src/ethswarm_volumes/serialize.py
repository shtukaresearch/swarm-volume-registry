"""Artifact wire-format (de)serialization: :class:`Artifact` <-> JSON (``docs/SCHEMA.md`` §3).

The projector produces in-memory :class:`~ethswarm_volumes.model.Artifact` dataclasses; this
module is the single seam that renders them to the published JSON document and parses that
document back (clients read it). It is the only place the on-disk field layout is fixed, so
the dataclasses can evolve independently of the wire shape.

Conventions (``docs/SCHEMA.md`` §1): timestamps are UTC ISO 8601 with a ``Z`` suffix; BZZ
and byte amounts are plain JSON numbers; ``date`` is ``YYYY-MM-DD``.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .model import (
    AccountsSnapshot,
    Artifact,
    ArtifactEntry,
    AsOf,
    Capacity,
    DailyAccounts,
    DailyCapacity,
    DailyFee,
    DailyPrice,
    Snapshot,
)

#: Artifact-structure version (``docs/SCHEMA.md`` §2). Semver; synced fleet-wide.
SCHEMA_VERSION = "1.0.0"


def _iso(dt: datetime) -> str:
    """A timezone-aware datetime as UTC ISO 8601 with a ``Z`` suffix (``docs/SCHEMA.md`` §1)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s: str) -> datetime:
    """Inverse of :func:`_iso`; also accepts an explicit ``+00:00`` offset."""
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Encode (dataclass -> wire dict)
# ---------------------------------------------------------------------------


def entry_to_dict(entry: ArtifactEntry) -> dict[str, Any]:
    """One deployment entry as its ``docs/SCHEMA.md`` §3 wire object."""
    return {
        "label": entry.label,
        "chain_id": entry.chain_id,
        "registry": entry.registry,
        "registry_version": entry.registry_version,
        "genesis_ts": _iso(entry.genesis_ts),
        "as_of": {"block": entry.as_of.block, "ts": _iso(entry.as_of.ts)},
        "fiat_currencies": list(entry.fiat_currencies),
        "extra": entry.extra,
        "snapshot": {
            "fee_volume_total_bzz": entry.snapshot.fee_volume_total_bzz,
            "capacity": {
                "active_volumes": entry.snapshot.capacity.active_volumes,
                "nominal_bytes": entry.snapshot.capacity.nominal_bytes,
                "effective_bytes": entry.snapshot.capacity.effective_bytes,
            },
            "accounts": {
                "authorized": entry.snapshot.accounts.authorized,
                "paid_in_window": entry.snapshot.accounts.paid_in_window,
            },
        },
        "fee_volume_daily": [{"date": d.date, "bzz": d.bzz} for d in entry.fee_volume_daily],
        "capacity_daily": [
            {
                "date": d.date,
                "active_volumes": d.active_volumes,
                "nominal_bytes": d.nominal_bytes,
                "effective_bytes": d.effective_bytes,
            }
            for d in entry.capacity_daily
        ],
        "accounts_daily": [
            {"date": d.date, "authorized": d.authorized} for d in entry.accounts_daily
        ],
        "price_daily": [{"date": d.date, "bzz_fiat": d.bzz_fiat} for d in entry.price_daily],
    }


def artifact_to_dict(artifact: Artifact) -> dict[str, Any]:
    """The full published artifact as a JSON-serializable dict (``docs/SCHEMA.md`` §3)."""
    return {
        "schema_version": artifact.schema_version,
        "generated_at": _iso(artifact.generated_at),
        "deployments": [entry_to_dict(e) for e in artifact.deployments],
    }


def artifact_to_json(artifact: Artifact, *, indent: int | None = 2) -> str:
    """The published artifact as a JSON string."""
    return json.dumps(artifact_to_dict(artifact), indent=indent)


# ---------------------------------------------------------------------------
# Decode (wire dict -> dataclass)
# ---------------------------------------------------------------------------


def entry_from_dict(obj: dict[str, Any]) -> ArtifactEntry:
    """Parse one deployment entry from its wire object."""
    snap = obj["snapshot"]
    return ArtifactEntry(
        label=obj["label"],
        chain_id=obj["chain_id"],
        registry=obj["registry"],
        registry_version=obj["registry_version"],
        genesis_ts=_parse_iso(obj["genesis_ts"]),
        as_of=AsOf(block=obj["as_of"]["block"], ts=_parse_iso(obj["as_of"]["ts"])),
        fiat_currencies=list(obj["fiat_currencies"]),
        extra=obj["extra"],
        snapshot=Snapshot(
            fee_volume_total_bzz=snap["fee_volume_total_bzz"],
            capacity=Capacity(
                active_volumes=snap["capacity"]["active_volumes"],
                nominal_bytes=snap["capacity"]["nominal_bytes"],
                effective_bytes=snap["capacity"]["effective_bytes"],
            ),
            accounts=AccountsSnapshot(
                authorized=snap["accounts"]["authorized"],
                paid_in_window=snap["accounts"]["paid_in_window"],
            ),
        ),
        fee_volume_daily=[DailyFee(date=d["date"], bzz=d["bzz"]) for d in obj["fee_volume_daily"]],
        capacity_daily=[
            DailyCapacity(
                date=d["date"],
                active_volumes=d["active_volumes"],
                nominal_bytes=d["nominal_bytes"],
                effective_bytes=d["effective_bytes"],
            )
            for d in obj["capacity_daily"]
        ],
        accounts_daily=[
            DailyAccounts(date=d["date"], authorized=d["authorized"]) for d in obj["accounts_daily"]
        ],
        price_daily=[
            DailyPrice(date=d["date"], bzz_fiat=d["bzz_fiat"]) for d in obj["price_daily"]
        ],
    )


def artifact_from_dict(obj: dict[str, Any]) -> Artifact:
    """Parse a full published artifact from its wire dict (``docs/SCHEMA.md`` §3)."""
    return Artifact(
        schema_version=obj["schema_version"],
        generated_at=_parse_iso(obj["generated_at"]),
        deployments=[entry_from_dict(e) for e in obj["deployments"]],
    )


def artifact_from_json(text: str) -> Artifact:
    """Parse a full published artifact from a JSON string."""
    return artifact_from_dict(json.loads(text))

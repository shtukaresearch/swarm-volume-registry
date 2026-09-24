"""Artifact wire-format (de)serialization (``docs/SCHEMA.md`` §3).

Unlike the projector, the serializer has a non-circular oracle — the schema literal itself —
so it is a pure unit test needing no node. Asserts the wire shape (key presence, ``Z``-suffixed
UTC timestamps, plain-number amounts) and a lossless dataclass <-> JSON round trip.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from ethswarm_volumes import serialize
from ethswarm_volumes.model import (
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


def _utc(*args) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


def _sample_artifact() -> Artifact:
    entry = ArtifactEntry(
        label="gnosis",
        chain_id=100,
        registry="0x9639",
        registry_version="v1",
        genesis_ts=_utc(2026, 5, 20, 8, 0, 0),
        as_of=AsOf(block=38211904, ts=_utc(2026, 6, 9, 12, 0, 0)),
        fiat_currencies=["USD"],
        extra={"grace_blocks": 17280, "postage": "0x45a1"},
        snapshot=Snapshot(
            fee_volume_total_bzz=1204.3,
            capacity=Capacity(active_volumes=1182, nominal_bytes=0, effective_bytes=0),
            accounts=AccountsSnapshot(
                authorized=470, paid_in_window={"1d": 12, "7d": 41, "30d": 88}
            ),
        ),
        fee_volume_daily=[DailyFee(date="2026-06-08", bzz=3.1)],
        capacity_daily=[
            DailyCapacity(
                date="2026-06-08", active_volumes=1180, nominal_bytes=0, effective_bytes=0
            )
        ],
        accounts_daily=[DailyAccounts(date="2026-06-08", authorized=469)],
        price_daily=[DailyPrice(date="2026-06-08", bzz_fiat={"USD": 0.34})],
    )
    return Artifact(
        schema_version=serialize.SCHEMA_VERSION,
        generated_at=_utc(2026, 6, 9, 12, 0, 0),
        deployments=[entry],
    )


def test_wire_shape_matches_schema():
    art = _sample_artifact()
    doc = serialize.artifact_to_dict(art)

    assert set(doc) == {"schema_version", "generated_at", "deployments"}
    assert doc["generated_at"] == "2026-06-09T12:00:00Z"  # Z-suffixed UTC

    e = doc["deployments"][0]
    assert e["genesis_ts"] == "2026-05-20T08:00:00Z"
    assert e["as_of"] == {"block": 38211904, "ts": "2026-06-09T12:00:00Z"}
    assert e["snapshot"]["accounts"]["paid_in_window"] == {"1d": 12, "7d": 41, "30d": 88}
    assert e["fee_volume_daily"][0] == {"date": "2026-06-08", "bzz": 3.1}
    assert e["price_daily"][0] == {"date": "2026-06-08", "bzz_fiat": {"USD": 0.34}}
    # amounts are plain JSON numbers, not strings
    assert isinstance(e["snapshot"]["fee_volume_total_bzz"], float)
    assert isinstance(e["capacity_daily"][0]["nominal_bytes"], int)


def test_round_trip_is_lossless():
    art = _sample_artifact()
    # dataclass -> JSON text -> dataclass
    restored = serialize.artifact_from_json(serialize.artifact_to_json(art))
    assert restored == art


def test_parses_z_and_offset_timestamps():
    art = _sample_artifact()
    doc = serialize.artifact_to_dict(art)
    # an external producer may emit an explicit +00:00 offset instead of Z
    doc["generated_at"] = "2026-06-09T12:00:00+00:00"
    parsed = serialize.artifact_from_dict(json.loads(json.dumps(doc)))
    assert parsed.generated_at == art.generated_at

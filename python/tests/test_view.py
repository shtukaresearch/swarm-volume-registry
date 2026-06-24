"""Client read-path folding: artifact entry -> resolved view-model (``docs/SCHEMA.md`` §4).

Pure and network-free, with a non-circular oracle (the schema). Exercises the flow-vs-stock
fold split, the fiat on/off shape, bucketing, and the ``fiat_currencies`` guard.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ethswarm_volumes import view
from ethswarm_volumes.model import (
    AccountsSnapshot,
    ArtifactEntry,
    AsOf,
    Capacity,
    DailyAccounts,
    DailyCapacity,
    DailyFee,
    DailyPrice,
    Snapshot,
)


def _entry() -> ArtifactEntry:
    # 4 contiguous UTC days; fee is a flow, capacity/accounts are stocks.
    days = ["2026-06-05", "2026-06-06", "2026-06-07", "2026-06-08"]
    fee = [1.0, 2.0, 3.0, 4.0]
    authd = [1, 2, 2, 3]
    nominal = [0, 100, 100, 300]
    return ArtifactEntry(
        label="gnosis",
        chain_id=100,
        registry="0x9639",
        registry_version="v1",
        genesis_ts=datetime(2026, 6, 5, tzinfo=timezone.utc),
        as_of=AsOf(block=100, ts=datetime(2026, 6, 8, 12, tzinfo=timezone.utc)),
        fiat_currencies=["USD"],
        extra={},
        snapshot=Snapshot(
            fee_volume_total_bzz=sum(fee),
            capacity=Capacity(active_volumes=3, nominal_bytes=300, effective_bytes=30),
            accounts=AccountsSnapshot(authorized=3, paid_in_window={"1d": 1, "7d": 2, "30d": 3}),
        ),
        fee_volume_daily=[DailyFee(date=d, bzz=b) for d, b in zip(days, fee)],
        capacity_daily=[
            DailyCapacity(date=d, active_volumes=a, nominal_bytes=n, effective_bytes=n // 10)
            for d, a, n in zip(days, authd, nominal)
        ],
        accounts_daily=[DailyAccounts(date=d, authorized=a) for d, a in zip(days, authd)],
        price_daily=[DailyPrice(date=d, bzz_fiat={"USD": 0.5}) for d in days],
    )


def test_daily_buckets_flow_and_stock():
    v = view.resolve_view(_entry(), view.ViewOptions(bucket_width="1d", bucket_count=30))
    assert v["fee_volume"]["unit"] == "BZZ"
    assert v["fee_volume"]["total"] == 10.0  # since genesis
    assert v["fee_volume"]["window"] == 10.0  # all 4 days in window
    # flow: each daily bucket holds that day's fee
    assert [p["bzz"] for p in v["fee_volume"]["series"]] == [1.0, 2.0, 3.0, 4.0]
    # stock: capacity/accounts sample the (single-day) bucket edge
    assert [p["authorized"] for p in v["accounts"]["series"]] == [1, 2, 2, 3]
    assert v["capacity"]["bytes"] == 300  # nominal snapshot
    # fiat fields absent when --fiat none
    assert "fiat" not in v["fee_volume"]["series"][0]


def test_weekly_bucket_sums_flow_samples_stock():
    # one 7d bucket covering all 4 days
    v = view.resolve_view(_entry(), view.ViewOptions(bucket_width="7d", bucket_count=1))
    assert len(v["fee_volume"]["series"]) == 1
    assert v["fee_volume"]["series"][0]["bzz"] == 10.0  # summed flow
    assert v["accounts"]["series"][0]["authorized"] == 3  # right-edge stock
    assert v["fee_volume"]["series"][0]["start"] == "2026-06-05"


def test_fiat_changes_unit_and_adds_fields():
    v = view.resolve_view(_entry(), view.ViewOptions(fiat="USD"))
    assert v["fee_volume"]["unit"] == "USD"
    assert v["fee_volume"]["total"] == pytest.approx(5.0)  # 10 BZZ * 0.5
    assert v["fee_volume"]["series"][0]["fiat"] == pytest.approx(0.5)


def test_unknown_fiat_rejected():
    with pytest.raises(ValueError):
        view.resolve_view(_entry(), view.ViewOptions(fiat="EUR"))


def test_effective_basis_and_since():
    v = view.resolve_view(
        _entry(), view.ViewOptions(capacity_basis="effective", since="2026-06-07")
    )
    assert v["capacity"]["basis"] == "effective"
    assert v["capacity"]["bytes"] == 30  # effective snapshot
    # since trims the window to the last two days
    assert [p["start"] for p in v["fee_volume"]["series"]] == ["2026-06-07", "2026-06-08"]
    assert v["fee_volume"]["window"] == 7.0

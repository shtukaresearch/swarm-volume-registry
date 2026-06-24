"""The client read path: fold an artifact entry into the resolved summary (``docs/SCHEMA.md`` §4).

Web3-free and network-free — the dashboard and the CLI both build this same view-model from
the single fetched artifact (``docs/ARCHITECTURE.md`` §7, ADR-0009). :func:`resolve_view`
produces the ``--json`` object; :func:`render_text` renders the human table over it.

Folds follow the flow-vs-stock split: fee volume (a flow) sums across a bucket; capacity and
accounts (stocks) sample the bucket's right edge. ``paid_in_window`` is copied through from
the snapshot (fixed 1/7/30-day windows, independent of the bucket options).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from . import fiat as fiat_mod
from .model import ArtifactEntry

#: ``--bucket-width`` token -> width in UTC days.
BUCKET_WIDTHS: dict[str, int] = {"1d": 1, "7d": 7, "30d": 30}

_CHUNK_BYTES = 4096
_BINARY_UNITS = (("TiB", 2**40), ("GiB", 2**30), ("MiB", 2**20), ("KiB", 2**10), ("B", 1))


@dataclass(frozen=True)
class ViewOptions:
    """Resolved ``stat`` options (``docs/ARCHITECTURE.md`` §7)."""

    bucket_width: str = "1d"
    bucket_count: int = 30
    since: str | None = None
    capacity_basis: str = "nominal"
    capacity_unit: str = "auto"
    fiat: str | None = None


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _format_bytes(n: int, unit: str) -> str:
    """Human display of ``n`` bytes per ``capacity_unit`` (``auto`` / ``GiB`` / ``TiB`` / ``chunks``)."""
    if unit == "chunks":
        return f"{n / _CHUNK_BYTES:,.0f} chunks"
    if unit in ("GiB", "TiB"):
        return f"{n / (2**40 if unit == 'TiB' else 2**30):.2f} {unit}"
    # auto: largest binary unit whose value is >= 1
    for name, size in _BINARY_UNITS:
        if n >= size:
            return f"{n / size:.2f} {name}"
    return "0 B"


def _buckets(window_dates: list[str], width: int) -> list[list[str]]:
    """Group contiguous ``window_dates`` into left-aligned buckets of ``width`` days."""
    return [window_dates[i : i + width] for i in range(0, len(window_dates), width)]


def resolve_view(entry: ArtifactEntry, opts: ViewOptions) -> dict:
    """Fold ``entry`` into the ``docs/SCHEMA.md`` §4 view-model under ``opts``.

    Raises ``ValueError`` if ``opts.fiat`` names a currency the artifact did not bake
    (``fiat_currencies`` bounds the choice — ``docs/ARCHITECTURE.md`` §7).
    """
    if opts.fiat is not None and opts.fiat not in entry.fiat_currencies:
        raise ValueError(
            f"fiat {opts.fiat!r} not available; baked currencies: {entry.fiat_currencies}"
        )

    width = BUCKET_WIDTHS[opts.bucket_width]
    dates = [d.date for d in entry.fee_volume_daily]

    # --- select the window of days (since wins over bucket_count) ---
    if opts.since is not None:
        window_dates = [d for d in dates if d >= opts.since]
    else:
        window_dates = dates[-(opts.bucket_count * width) :]
    buckets = _buckets(window_dates, width)

    # --- index the daily series for O(1) lookup ---
    fee_by_date = {d.date: d.bzz for d in entry.fee_volume_daily}
    cap_by_date = {d.date: d for d in entry.capacity_daily}
    acc_by_date = {d.date: d.authorized for d in entry.accounts_daily}
    rate_by_date = {p.date: p.bzz_fiat for p in entry.price_daily}

    use_fiat = opts.fiat is not None
    unit = opts.fiat if use_fiat else "BZZ"

    # --- fee volume (flow: sum across the bucket) ---
    def fee_fiat(date: str, bzz: float) -> float:
        rates = rate_by_date.get(date)
        return bzz * rates[opts.fiat] if rates and opts.fiat in rates else 0.0

    fee_series = []
    for bucket in buckets:
        bzz = sum(fee_by_date.get(d, 0.0) for d in bucket)
        point = {"start": bucket[0], "bzz": bzz}
        if use_fiat:
            point["fiat"] = sum(fee_fiat(d, fee_by_date.get(d, 0.0)) for d in bucket)
        fee_series.append(point)

    window_bzz = sum(fee_by_date.get(d, 0.0) for d in window_dates)
    if use_fiat:
        fee_total = fiat_mod.fee_fiat_total(entry.fee_volume_daily, entry.price_daily, opts.fiat)
        fee_window = sum(fee_fiat(d, fee_by_date.get(d, 0.0)) for d in window_dates)
    else:
        fee_total = entry.snapshot.fee_volume_total_bzz
        fee_window = window_bzz

    # --- capacity (stock: sample the bucket's right edge) ---
    def cap_bytes(day) -> int:
        return day.nominal_bytes if opts.capacity_basis == "nominal" else day.effective_bytes

    cap_series = []
    for bucket in buckets:
        edge = cap_by_date.get(bucket[-1])
        cap_series.append(
            {
                "start": bucket[0],
                "active_volumes": edge.active_volumes if edge else 0,
                "bytes": cap_bytes(edge) if edge else 0,
            }
        )

    snap_cap = entry.snapshot.capacity
    snap_bytes = (
        snap_cap.nominal_bytes if opts.capacity_basis == "nominal" else snap_cap.effective_bytes
    )

    # --- accounts (stock: sample the right edge; paid_in_window passed through) ---
    acc_series = [
        {"start": bucket[0], "authorized": acc_by_date.get(bucket[-1], 0)} for bucket in buckets
    ]

    return {
        "deployment": {
            "label": entry.label,
            "chain_id": entry.chain_id,
            "registry": entry.registry,
            "registry_version": entry.registry_version,
            "genesis_ts": _iso(entry.genesis_ts),
            "as_of": {"block": entry.as_of.block, "ts": _iso(entry.as_of.ts)},
        },
        "options": {
            "bucket_width": opts.bucket_width,
            "bucket_count": opts.bucket_count,
            "capacity_basis": opts.capacity_basis,
            "capacity_unit": opts.capacity_unit,
            "fiat": opts.fiat,
        },
        "fee_volume": {
            "unit": unit,
            "total": fee_total,
            "window": fee_window,
            "series": fee_series,
        },
        "capacity": {
            "active_volumes": snap_cap.active_volumes,
            "basis": opts.capacity_basis,
            "bytes": snap_bytes,
            "display": _format_bytes(snap_bytes, opts.capacity_unit),
            "series": cap_series,
        },
        "accounts": {
            "authorized": entry.snapshot.accounts.authorized,
            "paid_in_window": entry.snapshot.accounts.paid_in_window,
            "series": acc_series,
        },
    }


def render_text(view: dict) -> str:
    """Render the human-readable summary over a resolved :func:`resolve_view` view-model."""
    dep = view["deployment"]
    fee = view["fee_volume"]
    cap = view["capacity"]
    acc = view["accounts"]
    unit = fee["unit"]
    width = view["options"]["bucket_width"]

    lines = [
        f"{dep['label']}  (chain {dep['chain_id']}, {dep['registry']}, {dep['registry_version']})",
        f"  as of block {dep['as_of']['block']}  ({dep['as_of']['ts']})",
        "",
        f"  fee volume   total {fee['total']:,.2f} {unit}   window {fee['window']:,.2f} {unit}",
        f"  capacity     {cap['active_volumes']:,} volumes   {cap['display']} ({cap['basis']})",
        "  accounts     "
        + f"{acc['authorized']:,} authorized   "
        + "paid "
        + ", ".join(f"{k}={v}" for k, v in acc["paid_in_window"].items()),
        "",
        f"  per-{width} series:",
        # Explicit two-space gaps between columns so a wide cell (e.g. a chunk count) can
        # never run into its neighbour, regardless of the field widths.
        f"    {'start':<12}  {'fee/' + unit:>14}  {'volumes':>9}  {'capacity':>18}  {'auth':>6}",
    ]
    for f, c, a in zip(fee["series"], cap["series"], acc["series"]):
        fee_val = f.get("fiat", f["bzz"]) if unit != "BZZ" else f["bzz"]
        lines.append(
            f"    {f['start']:<12}  {fee_val:>14,.2f}  {c['active_volumes']:>9,}  "
            f"{_format_bytes(c['bytes'], view['options']['capacity_unit']):>18}  {a['authorized']:>6,}"
        )
    return "\n".join(lines)

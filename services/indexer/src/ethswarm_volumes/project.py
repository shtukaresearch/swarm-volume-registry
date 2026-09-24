"""The pure projector: ``event_log`` rows -> artifact (``docs/data-model/projection.md``).

Everything here is web3-free. The top-level entry point is :func:`project_entry`;
its derived facts live in the sub-functions below (fee volume, capacity, accounts,
paid-in-window), which are the units the test suite exercises directly.

All bucketing is on the **UTC calendar day** (``docs/SCHEMA.md`` §1). A day's right edge
is the next UTC midnight (exclusive); the final, partial day's edge is ``as_of``. Stocks
(capacity, accounts) are sampled at that edge; flows (fee volume) are summed within it.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from . import capacity as capacity_ref
from .model import (
    AccountsSnapshot,
    ArtifactEntry,
    AsOf,
    Capacity,
    DailyAccounts,
    DailyCapacity,
    DailyFee,
    DailyPrice,
    Deployment,
    EventLog,
    Snapshot,
)

#: Default trailing windows (days) for ``paid_in_window`` (``docs/SCHEMA.md`` §3).
PAID_IN_WINDOW_DAYS: tuple[int, ...] = (1, 7, 30)

#: Seconds in a UTC calendar day.
ONE_DAY = 86_400

#: Atomic units (PLUR) per 1 BZZ. BZZ has 16 decimals; the conversion to the artifact's
#: lossy ``float`` BZZ divides by this.
BZZ_DECIMALS = 16
PLUR_PER_BZZ = 10**BZZ_DECIMALS


def _epoch(dt: datetime) -> int:
    """A timezone-aware datetime as integer UTC epoch seconds."""
    return int(dt.timestamp())


def _date_str(day_index: int) -> str:
    """``YYYY-MM-DD`` for the UTC day whose midnight is ``day_index * ONE_DAY``."""
    return datetime.fromtimestamp(day_index * ONE_DAY, tz=timezone.utc).strftime("%Y-%m-%d")


def _day_of_date(date: str) -> int:
    """Inverse of :func:`_date_str`: ``YYYY-MM-DD`` -> UTC day index."""
    dt = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp()) // ONE_DAY


def _day_end(day_index: int, as_of_ts: int) -> int:
    """The inclusive right edge (epoch seconds) of UTC day ``day_index``.

    Every day but the last ends at one second before the next UTC midnight; the final day
    (the one containing ``as_of``) ends at ``as_of`` — the partial-edge rule of
    ``docs/SCHEMA.md`` §1. Events with ``block_ts <= _day_end`` are within the day.
    """
    as_of_day = as_of_ts // ONE_DAY
    if day_index == as_of_day:
        return as_of_ts
    return (day_index + 1) * ONE_DAY - 1


def fee_volume_daily(events: EventLog, *, as_of: datetime) -> list[DailyFee]:
    """Per-UTC-day fee volume in BZZ, first event's day through ``as_of`` (gap-filled).

    The series spans ``[first-event-day, as_of-day]``; :func:`project_entry` left-pads
    it to the deployment genesis day. ``events`` are this deployment's logs only.

    Every captured ``Transfer`` row is a fee forward (registry -> postage); its BZZ value
    is summed into its UTC day. The ``Toppedup`` / ``VolumeCreated`` siblings carry no
    additional BZZ (they only name the volume), and ``TopupSkipped`` moves none — so the
    daily flow is exactly the sum of ``Transfer`` values. Empty days are present with
    ``bzz == 0`` (gap-filled). Amounts convert PLUR -> BZZ (lossy).
    """
    as_of_ts = _epoch(as_of)
    as_of_day = as_of_ts // ONE_DAY

    per_day: dict[int, int] = defaultdict(int)
    first_day: int | None = None
    for row in events.of("Transfer"):
        ts = _epoch(row.block_ts)
        if ts > as_of_ts:
            continue
        day = ts // ONE_DAY
        per_day[day] += row.args["value"]
        first_day = day if first_day is None else min(first_day, day)

    if first_day is None:
        first_day = as_of_day
    return [
        DailyFee(date=_date_str(d), bzz=per_day.get(d, 0) / PLUR_PER_BZZ)
        for d in range(first_day, as_of_day + 1)
    ]


def _active_set_at(events: EventLog, cutoff_ts: int) -> dict[str, int]:
    """The active volumes (``volume_id -> depth``) as of ``cutoff_ts`` (inclusive).

    Replays the ``VolumeCreated`` / ``VolumeRetired`` logs in chain order: a create adds
    the volume at its depth, any retire reason removes it. Rows are in non-decreasing
    ``block_ts`` order, so the walk stops at the first event past the cutoff.
    """
    active: dict[str, int] = {}
    for row in events.of("VolumeCreated", "VolumeRetired"):
        if _epoch(row.block_ts) > cutoff_ts:
            break
        if row.event_name == "VolumeCreated":
            active[row.args["volume_id"]] = row.args["depth"]
        else:
            active.pop(row.args["volume_id"], None)
    return active


def capacity_daily(events: EventLog, *, as_of: datetime) -> list[DailyCapacity]:
    """Per-UTC-day capacity level (stock), sampled at each day's end.

    Active-set membership is reconstructed from the ``VolumeCreated`` / ``VolumeRetired``
    logs merged in chain order (any retire reason removes). ``nominal_bytes`` /
    ``effective_bytes`` sum the per-depth lookups (:mod:`ethswarm_volumes.capacity`) over
    the active set at the day boundary. A volume created and retired within one day is
    absent at day end.
    """
    as_of_ts = _epoch(as_of)
    as_of_day = as_of_ts // ONE_DAY

    creates = events.of("VolumeCreated")
    first_day = (
        min(_epoch(r.block_ts) // ONE_DAY for r in creates if _epoch(r.block_ts) <= as_of_ts)
        if any(_epoch(r.block_ts) <= as_of_ts for r in creates)
        else as_of_day
    )

    out: list[DailyCapacity] = []
    for day in range(first_day, as_of_day + 1):
        active = _active_set_at(events, _day_end(day, as_of_ts))
        depths = active.values()
        out.append(
            DailyCapacity(
                date=_date_str(day),
                active_volumes=len(active),
                nominal_bytes=sum(capacity_ref.nominal_bytes(d) for d in depths),
                effective_bytes=sum(capacity_ref.effective_bytes(d) for d in depths),
            )
        )
    return out


def _authorized_at(events: EventLog, cutoff_ts: int) -> int:
    """Count of currently-authorized owners as of ``cutoff_ts`` (inclusive).

    Net level of ``AccountActivated`` minus ``AccountRevoked`` per owner: activation adds
    the owner, revocation removes it, re-confirmation adds it again (so the level is not
    monotonic). An owner is counted once while active.
    """
    active: set[str] = set()
    for row in events.of("AccountActivated", "AccountRevoked"):
        if _epoch(row.block_ts) > cutoff_ts:
            break
        if row.event_name == "AccountActivated":
            active.add(row.args["owner"])
        else:
            active.discard(row.args["owner"])
    return len(active)


def accounts_daily(events: EventLog, *, as_of: datetime) -> list[DailyAccounts]:
    """Per-UTC-day authorized-account level (stock), sampled at each day's end.

    Reads only the ``AccountActivated`` / ``AccountRevoked`` logs. ``authorized`` is
    their net level per owner; re-confirmation raises it again (not monotonic) and an
    owner is counted once while active.
    """
    as_of_ts = _epoch(as_of)
    as_of_day = as_of_ts // ONE_DAY

    acct_events = events.of("AccountActivated", "AccountRevoked")
    days = [_epoch(r.block_ts) // ONE_DAY for r in acct_events if _epoch(r.block_ts) <= as_of_ts]
    first_day = min(days) if days else as_of_day

    return [
        DailyAccounts(
            date=_date_str(day), authorized=_authorized_at(events, _day_end(day, as_of_ts))
        )
        for day in range(first_day, as_of_day + 1)
    ]


def _owner_timeline(events: EventLog) -> dict[str, list[tuple[int, str]]]:
    """Per-volume ownership history: ``volume_id -> [(block, owner), ...]`` in chain order.

    The initial owner comes from ``VolumeCreated``; each ``VolumeOwnershipTransferred``
    appends the new owner. Keyed by ``block_number`` only: ownership is resolved *up to the
    payment block* (``docs/data-model/projection.md``), and the create that establishes a
    volume's first owner is emitted in the same tx as — but at a higher ``log_index`` than —
    its own create-fee ``Transfer``, so a (block, log_index) cut would miss it.
    """
    timeline: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for row in events.of("VolumeCreated", "VolumeOwnershipTransferred"):
        owner = row.args["owner"] if row.event_name == "VolumeCreated" else row.args["to"]
        timeline[row.args["volume_id"]].append((row.block_number, owner))
    return timeline


def paid_in_window(
    events: EventLog, *, as_of: datetime, windows: tuple[int, ...] = PAID_IN_WINDOW_DAYS
) -> dict[str, int]:
    """Distinct paying accounts within each trailing window ending at ``as_of``.

    Each captured ``Transfer`` is a payment; its same-tx sibling (``VolumeCreated`` /
    ``Toppedup``, matched in ``log_index`` order — a batched ``trigger`` interleaves
    several pairs) names the volume, and the payment is attributed to the volume's owner
    *resolved at the payment block* (replaying the ownership log). An account paying twice
    counts once; the window boundary is inclusive of payments exactly ``N`` days before
    ``as_of``. Returns e.g. ``{"1d": 3, "7d": 9, "30d": 20}``.
    """
    as_of_ts = _epoch(as_of)
    timeline = _owner_timeline(events)

    # Pair each Transfer with its same-tx sibling in log_index order.
    by_tx_transfers: dict[str, list] = defaultdict(list)
    by_tx_siblings: dict[str, list] = defaultdict(list)
    for row in events.of("Transfer", "Toppedup", "VolumeCreated"):
        if row.event_name == "Transfer":
            by_tx_transfers[row.tx_hash].append(row)
        else:
            by_tx_siblings[row.tx_hash].append(row)

    # payment -> (ts, volume_id, block_number)
    payments: list[tuple[int, str, int]] = []
    for tx_hash, transfers in by_tx_transfers.items():
        siblings = by_tx_siblings.get(tx_hash, [])
        for transfer, sibling in zip(transfers, siblings):
            payments.append(
                (_epoch(transfer.block_ts), sibling.args["volume_id"], transfer.block_number)
            )

    def owner_at(volume_id: str, block: int) -> str | None:
        owner: str | None = None
        for b, o in timeline.get(volume_id, ()):
            if b <= block:
                owner = o
            else:
                break
        return owner

    result: dict[str, int] = {}
    for n in windows:
        lo = as_of_ts - n * ONE_DAY
        owners = {owner_at(vid, blk) for ts, vid, blk in payments if lo <= ts <= as_of_ts}
        owners.discard(None)
        result[f"{n}d"] = len(owners)
    return result


def _pad_front(series: list, genesis_day: int, make_zero) -> list:
    """Left-pad ``series`` with zero-valued days from ``genesis_day`` to its first day.

    Each measure spans ``[first-event-day, as_of-day]``; the artifact requires full daily
    history from genesis (``docs/SCHEMA.md`` §1), so the gap before the first event is
    filled with the measure's zero day (``make_zero(day_index)``).
    """
    if not series:
        return series
    first_day = _day_of_date(series[0].date)
    if genesis_day >= first_day:
        return series
    pad = [make_zero(d) for d in range(genesis_day, first_day)]
    return pad + series


def project_entry(
    deployment: Deployment,
    events: EventLog,
    price_daily: list[DailyPrice],
    *,
    as_of_block: int,
    as_of_ts: datetime,
) -> ArtifactEntry:
    """Fold one deployment's ``event_log`` into its artifact entry.

    Narrows ``events`` to this deployment (``events.for_deployment``), then composes the
    sub-functions above and the ``snapshot`` (whose values equal the day-end series /
    window results at ``as_of``). ``price_daily`` is passed through to the entry; fiat
    conversion itself is the client's job (:mod:`ethswarm_volumes.fiat`).
    """
    ev = events.for_deployment(deployment.deployment_id)

    fee = fee_volume_daily(ev, as_of=as_of_ts)
    cap = capacity_daily(ev, as_of=as_of_ts)
    acc = accounts_daily(ev, as_of=as_of_ts)
    piw = paid_in_window(ev, as_of=as_of_ts)

    genesis_day = _epoch(deployment.genesis_ts) // ONE_DAY
    fee = _pad_front(fee, genesis_day, lambda d: DailyFee(date=_date_str(d), bzz=0.0))
    cap = _pad_front(
        cap,
        genesis_day,
        lambda d: DailyCapacity(
            date=_date_str(d), active_volumes=0, nominal_bytes=0, effective_bytes=0
        ),
    )
    acc = _pad_front(acc, genesis_day, lambda d: DailyAccounts(date=_date_str(d), authorized=0))

    last_cap = cap[-1]
    snapshot = Snapshot(
        fee_volume_total_bzz=sum(d.bzz for d in fee),
        capacity=Capacity(
            active_volumes=last_cap.active_volumes,
            nominal_bytes=last_cap.nominal_bytes,
            effective_bytes=last_cap.effective_bytes,
        ),
        accounts=AccountsSnapshot(authorized=acc[-1].authorized, paid_in_window=piw),
    )

    return ArtifactEntry(
        label=deployment.label,
        chain_id=deployment.chain_id,
        registry=deployment.registry,
        registry_version=deployment.registry_version,
        genesis_ts=deployment.genesis_ts,
        as_of=AsOf(block=as_of_block, ts=as_of_ts),
        fiat_currencies=deployment.fiat_currencies,
        extra=deployment.extra,
        snapshot=snapshot,
        fee_volume_daily=fee,
        capacity_daily=cap,
        accounts_daily=acc,
        price_daily=price_daily,
    )

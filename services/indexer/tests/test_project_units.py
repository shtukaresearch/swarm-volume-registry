"""Pure projector unit tests: owner attribution + window boundaries (``paid_in_window``)
and imported-volume admission (``capacity_daily``).

The integration suite (``test_pipeline``) does not assert ``paid_in_window``, and its inputs
have a non-circular oracle only for the node-state measures. The windowing and
owner-at-payment logic, though, is plain arithmetic over hand-specified rows — so it is
tested directly here. Regression cover for two bugs the CLI smoke test surfaced: the
create-fee ``Transfer`` precedes its ``VolumeCreated`` sibling in the same tx (owner must
still resolve), and window boundaries are inclusive at exactly ``N`` days.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from ethswarm_volumes.model import EventLog, EventLogRow
from ethswarm_volumes.project import capacity_daily, paid_in_window

_DEP = (100, "0xreg")
_DAY = 86_400
_T0 = datetime(2030, 1, 1, tzinfo=timezone.utc)


def _row(event_name, *, block, log_index, day, args, tx="0xtx"):
    return EventLogRow(
        deployment_id=_DEP,
        block_number=block,
        block_ts=_T0 + timedelta(days=day),
        tx_hash=tx,
        tx_index=0,
        log_index=log_index,
        emitter="0xreg",
        event_name=event_name,
        args=args,
    )


def _create_payment(*, block, day, vol, owner, tx):
    """A create: the fee Transfer (lower log_index) + its VolumeCreated sibling (higher)."""
    return [
        _row("Transfer", block=block, log_index=1, day=day, args={"value": 5}, tx=tx),
        _row(
            "VolumeCreated",
            block=block,
            log_index=2,
            day=day,
            args={"volume_id": vol, "owner": owner, "depth": 20},
            tx=tx,
        ),
    ]


def test_create_payment_attributed_to_owner_despite_log_order():
    # Single create on day 0; as_of day 3. The Transfer is at a *lower* log_index than the
    # VolumeCreated that names the owner — a (block, log_index) cut would attribute to no one.
    rows = _create_payment(block=10, day=0, vol="0xv1", owner="0xA", tx="0xt1")
    as_of = _T0 + timedelta(days=3)
    result = paid_in_window(EventLog.from_rows(rows), as_of=as_of)
    assert result == {"1d": 0, "7d": 1, "30d": 1}


def test_distinct_owners_and_dedup():
    rows = [
        *_create_payment(block=10, day=0, vol="0xv1", owner="0xA", tx="0xt1"),
        *_create_payment(block=11, day=0, vol="0xv2", owner="0xB", tx="0xt2"),
        # A pays again (topup) on day 2 — counted once.
        _row("Transfer", block=20, log_index=1, day=2, args={"value": 5}, tx="0xt3"),
        _row(
            "Toppedup",
            block=20,
            log_index=2,
            day=2,
            args={"volume_id": "0xv1", "amount": 5, "new_normalised_balance": 9},
            tx="0xt3",
        ),
    ]
    as_of = _T0 + timedelta(days=3)
    # two distinct owners (A, B) within the 7d/30d windows; A within 1d via the day-2 topup
    assert paid_in_window(EventLog.from_rows(rows), as_of=as_of) == {"1d": 1, "7d": 2, "30d": 2}


def test_window_boundary_inclusive_at_exactly_n_days():
    # Payment exactly 7 days before as_of is inside the 7d window (inclusive boundary).
    rows = _create_payment(block=10, day=0, vol="0xv1", owner="0xA", tx="0xt1")
    as_of = _T0 + timedelta(days=7)
    result = paid_in_window(EventLog.from_rows(rows), as_of=as_of)
    assert result["7d"] == 1
    assert result["1d"] == 0


def test_ownership_transfer_reattributes_later_payment():
    rows = [
        *_create_payment(block=10, day=0, vol="0xv1", owner="0xA", tx="0xt1"),
        _row(
            "VolumeOwnershipTransferred",
            block=20,
            log_index=1,
            day=5,
            args={"volume_id": "0xv1", "from": "0xA", "to": "0xB"},
            tx="0xt2",
        ),
        # topup after the transfer -> attributed to B
        _row("Transfer", block=30, log_index=1, day=8, args={"value": 5}, tx="0xt3"),
        _row(
            "Toppedup",
            block=30,
            log_index=2,
            day=8,
            args={"volume_id": "0xv1", "amount": 5, "new_normalised_balance": 9},
            tx="0xt3",
        ),
    ]
    as_of = _T0 + timedelta(days=9)
    # within 1d: only the day-8 payment (owner B); within 30d: both A (day0) and B (day8)
    result = paid_in_window(EventLog.from_rows(rows), as_of=as_of)
    assert result == {"1d": 1, "7d": 1, "30d": 2}


def _import(*, block, day, vol, owner, tx, log_index=1):
    """A ``VolumeImported`` admit (v2-rc3): it names the owner but moves no BZZ."""
    return _row(
        "VolumeImported",
        block=block,
        log_index=log_index,
        day=day,
        args={"volume_id": vol, "owner": owner, "batch_id": "0xb" + vol[2:], "depth": 20},
        tx=tx,
    )


def _topup_payment(*, block, day, vol, tx, log_index=2):
    """A topup: the fee Transfer + its Toppedup sibling (higher log_index)."""
    return [
        _row("Transfer", block=block, log_index=log_index, day=day, args={"value": 5}, tx=tx),
        _row(
            "Toppedup",
            block=block,
            log_index=log_index + 1,
            day=day,
            args={"volume_id": vol, "amount": 5, "new_normalised_balance": 9},
            tx=tx,
        ),
    ]


def test_import_payment_attributed_to_importer():
    # importVolume: VolumeImported, then the topup's Transfer + Toppedup, all in one tx.
    # The Transfer pairs with the Toppedup, and the owner comes from the VolumeImported.
    rows = [
        _import(block=10, day=0, vol="0xv1", owner="0xA", tx="0xt1"),
        *_topup_payment(block=10, day=0, vol="0xv1", tx="0xt1"),
    ]
    as_of = _T0 + timedelta(days=3)
    assert paid_in_window(EventLog.from_rows(rows), as_of=as_of) == {"1d": 0, "7d": 1, "30d": 1}


def test_topup_of_registered_volume_attributed_to_its_owner():
    # registerVolume moves no BZZ; the volume's first payment is a later trigger.
    rows = [
        _import(block=10, day=0, vol="0xv1", owner="0xA", tx="0xt1"),
        *_topup_payment(block=20, day=2, vol="0xv1", tx="0xt2"),
    ]
    as_of = _T0 + timedelta(days=2, hours=12)
    assert paid_in_window(EventLog.from_rows(rows), as_of=as_of) == {"1d": 1, "7d": 1, "30d": 1}


def test_imported_volume_counts_toward_capacity_until_retired():
    rows = [
        _import(block=10, day=0, vol="0xv1", owner="0xA", tx="0xt1"),
        _row(
            "VolumeRetired",
            block=30,
            log_index=1,
            day=2,
            args={"volume_id": "0xv1", "reason": "OwnerDeleted"},
            tx="0xt3",
        ),
    ]
    cap = capacity_daily(EventLog.from_rows(rows), as_of=_T0 + timedelta(days=3))
    assert [d.active_volumes for d in cap] == [1, 1, 0, 0]
    assert cap[0].date == "2030-01-01"

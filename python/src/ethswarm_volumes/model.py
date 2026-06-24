"""Web3-free data types shared across the indexer's projection layer.

These are plain data carriers — no behaviour, no web3 knowledge. ``EventLogRow``
is the decoded boundary record (``docs/ARCHITECTURE.md`` §4.3); the ``Artifact*``
types mirror the wire format in ``docs/SCHEMA.md`` §3.

Amounts in ``EventLogRow.args`` are *faithful integer atomic units* (PLUR); the
``Artifact*`` types carry the agreed lossy ``float`` BZZ. ``block_ts`` and other
timestamps are timezone-aware UTC ``datetime``s.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

#: A deployment is identified by ``(chain_id, registry_address)``. The address is
#: stored lowercased hex.
DeploymentId = tuple[int, str]


@dataclass(frozen=True)
class EventLogRow:
    """One decoded log — the persisted ``event_log`` boundary record.

    ``args`` holds the decoded, typed event payload (addresses as lowercased hex
    strings, amounts as integer PLUR, enums as their names). No topics, no bytes.

    The store partitions these into one log per ``event_name`` (see :class:`EventLog`
    and ``docs/ARCHITECTURE.md`` §4.3). The field is retained on the row so a merged,
    cross-type stream stays self-describing for the projector's folds.
    """

    deployment_id: DeploymentId
    block_number: int
    block_ts: datetime
    tx_hash: str
    tx_index: int
    log_index: int
    emitter: str
    event_name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class EventLog:
    """The persisted event store — partitioned into one log per event type.

    The data model (``docs/ARCHITECTURE.md`` §4.3) keeps a separate log per
    ``event_name`` rather than one merged table, matching how the web3 layer acquires
    each type (its own topic-filtered ``getLogs``). No projection needs every type in
    one stream: each fold pulls only the logs it cares about via :meth:`of` and the
    cross-type chain order it needs is a read-time k-way merge on
    ``(block_number, log_index)`` — a derivable view, not stored pre-merged.

    ``by_event`` maps ``event_name`` -> that log's rows, each log in canonical
    ``(block_number, log_index)`` order. Rows may span deployments; narrow with
    :meth:`for_deployment`.
    """

    by_event: Mapping[str, tuple[EventLogRow, ...]]

    @staticmethod
    def from_rows(rows: Iterable[EventLogRow]) -> "EventLog":
        """Partition a flat row iterable by ``event_name`` into per-type logs.

        Each per-type log is sorted into canonical ``(block_number, log_index)`` order,
        so the input order is irrelevant — this is the in-memory analogue of writing the
        decoded rows out to their per-type relations.
        """
        buckets: dict[str, list[EventLogRow]] = {}
        for row in rows:
            buckets.setdefault(row.event_name, []).append(row)
        return EventLog(
            {
                name: tuple(sorted(rs, key=lambda r: (r.block_number, r.log_index)))
                for name, rs in buckets.items()
            }
        )

    def of(self, *event_names: str) -> list[EventLogRow]:
        """Rows of the named event type(s), merged into canonical chain order.

        A k-way merge across the requested per-type logs by ``(block_number,
        log_index)`` — the only ordering the folds rely on (e.g. the fee join needs each
        ``Transfer`` interleaved with its same-tx ``Toppedup`` / ``VolumeCreated``
        sibling). Names absent from the store contribute nothing.
        """
        rows = [row for name in event_names for row in self.by_event.get(name, ())]
        rows.sort(key=lambda r: (r.block_number, r.log_index))
        return rows

    def merged(self) -> list[EventLogRow]:
        """Every log merged into a single canonical-ordered replay stream."""
        return self.of(*self.by_event)

    def for_deployment(self, deployment_id: DeploymentId) -> "EventLog":
        """A view holding only ``deployment_id``'s rows, per-type partition preserved."""
        return EventLog(
            {
                name: tuple(r for r in rs if r.deployment_id == deployment_id)
                for name, rs in self.by_event.items()
            }
        )


@dataclass(frozen=True)
class Deployment:
    """Generic deployment identity plus the version-specific ``extra`` bag.

    Mirrors the deployment registry (``docs/ARCHITECTURE.md`` §4.2) joined with
    the artifact entry's identity/``extra`` fields (``docs/SCHEMA.md`` §3).
    """

    label: str
    chain_id: int
    registry: str
    registry_version: str
    genesis_ts: datetime
    fiat_currencies: list[str]
    extra: dict[str, Any]

    @property
    def deployment_id(self) -> DeploymentId:
        return (self.chain_id, self.registry)


@dataclass(frozen=True)
class AsOf:
    block: int
    ts: datetime


@dataclass(frozen=True)
class DailyFee:
    date: str  # "YYYY-MM-DD" (UTC)
    bzz: float


@dataclass(frozen=True)
class DailyCapacity:
    date: str
    active_volumes: int
    nominal_bytes: int
    effective_bytes: int


@dataclass(frozen=True)
class DailyAccounts:
    date: str
    authorized: int


@dataclass(frozen=True)
class DailyPrice:
    date: str
    bzz_fiat: dict[str, float]  # currency -> fiat per 1 BZZ


@dataclass(frozen=True)
class Capacity:
    active_volumes: int
    nominal_bytes: int
    effective_bytes: int


@dataclass(frozen=True)
class AccountsSnapshot:
    authorized: int
    paid_in_window: dict[str, int]  # e.g. {"1d": 3, "7d": 9, "30d": 20}


@dataclass(frozen=True)
class Snapshot:
    fee_volume_total_bzz: float
    capacity: Capacity
    accounts: AccountsSnapshot


@dataclass(frozen=True)
class ArtifactEntry:
    """One deployment's entry in the published artifact (``docs/SCHEMA.md`` §3)."""

    label: str
    chain_id: int
    registry: str
    registry_version: str
    genesis_ts: datetime
    as_of: AsOf
    fiat_currencies: list[str]
    extra: dict[str, Any]
    snapshot: Snapshot
    fee_volume_daily: list[DailyFee]
    capacity_daily: list[DailyCapacity]
    accounts_daily: list[DailyAccounts]
    price_daily: list[DailyPrice]


@dataclass(frozen=True)
class Artifact:
    """The single published file (``docs/SCHEMA.md`` §3)."""

    schema_version: str
    generated_at: datetime
    deployments: list[ArtifactEntry]

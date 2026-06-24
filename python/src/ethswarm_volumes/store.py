"""The ``event_log`` cache: append-only JSONLines under a configurable store directory.

The persisted store is a **cache**, not a source of truth (``docs/ARCHITECTURE.md``
§4.3.1): one append-only JSONLines file per ``(deployment, event_type)`` plus a
``head.json`` per deployment, all under a store directory. It is fully reconstructible by
re-syncing from genesis, so loss or corruption is non-fatal. There is no database — the
data is small and append-only and the projector folds it linearly in Python.

Path resolution (:func:`resolve_store_dir`, :func:`event_log_path`, …) is pure and
implemented here. The serialization I/O (:func:`append_rows`, :func:`load_event_log`,
:func:`load_head`, :func:`save_head`) is left as interface stubs for the builder, pinned by
``tests/test_store.py``.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path

from .model import DeploymentId, EventLog, EventLogRow

#: Key under which :func:`save_head` / :func:`load_head` store the last finalized block.
HEAD_BLOCK_KEY = "finalized_block"

#: Environment variable overriding the default store-directory location.
STORE_DIR_ENV = "ETHSWARM_VOLUMES_STORE"

#: Application subdirectory placed under the resolved cache root.
APP_DIR_NAME = "ethswarm-volumes"

#: Filename of the per-deployment head marker (last ``finalized`` block synced).
HEAD_FILENAME = "head.json"


def default_store_dir() -> Path:
    """The default store directory.

    ``$XDG_CACHE_HOME/ethswarm-volumes`` when ``XDG_CACHE_HOME`` is set, else
    ``~/.cache/ethswarm-volumes``.
    """
    xdg = os.environ.get("XDG_CACHE_HOME")
    root = Path(xdg) if xdg else Path.home() / ".cache"
    return root / APP_DIR_NAME


def resolve_store_dir(explicit: str | os.PathLike[str] | None = None) -> Path:
    """Resolve the store directory by precedence: explicit arg > env var > default.

    ``explicit`` is the ``--store-dir`` CLI value (``None`` when unset); the env var is
    :data:`STORE_DIR_ENV`; the fallback is :func:`default_store_dir`.
    """
    if explicit is not None:
        return Path(explicit)
    env = os.environ.get(STORE_DIR_ENV)
    if env:
        return Path(env)
    return default_store_dir()


def deployment_dir(store_dir: str | os.PathLike[str], deployment_id: DeploymentId) -> Path:
    """The per-deployment subdirectory ``<store-dir>/<chain_id>_<registry>``."""
    chain_id, registry = deployment_id
    return Path(store_dir) / f"{chain_id}_{registry}"


def event_log_path(
    store_dir: str | os.PathLike[str], deployment_id: DeploymentId, event_name: str
) -> Path:
    """The append-only JSONLines file for one ``(deployment, event_type)``."""
    return deployment_dir(store_dir, deployment_id) / f"{event_name}.jsonl"


def head_path(store_dir: str | os.PathLike[str], deployment_id: DeploymentId) -> Path:
    """The ``head.json`` recording the last ``finalized`` block synced for a deployment."""
    return deployment_dir(store_dir, deployment_id) / HEAD_FILENAME


# ---- serialization I/O ----


def _row_to_json(row: EventLogRow) -> dict:
    """One ``EventLogRow`` as a JSON-serializable dict (``block_ts`` as ISO 8601).

    ``deployment_id`` and ``event_name`` are written too so a line is self-describing,
    though on load they are taken from the file's path (the partition key, §4.3).
    """
    return {
        "deployment_id": list(row.deployment_id),
        "block_number": row.block_number,
        "block_ts": row.block_ts.isoformat(),
        "tx_hash": row.tx_hash,
        "tx_index": row.tx_index,
        "log_index": row.log_index,
        "emitter": row.emitter,
        "event_name": row.event_name,
        "args": row.args,
    }


def _row_from_json(obj: dict) -> EventLogRow:
    """Inverse of :func:`_row_to_json`."""
    chain_id, registry = obj["deployment_id"]
    return EventLogRow(
        deployment_id=(chain_id, registry),
        block_number=obj["block_number"],
        block_ts=datetime.fromisoformat(obj["block_ts"]),
        tx_hash=obj["tx_hash"],
        tx_index=obj["tx_index"],
        log_index=obj["log_index"],
        emitter=obj["emitter"],
        event_name=obj["event_name"],
        args=obj["args"],
    )


def append_rows(store_dir: str | os.PathLike[str], rows: Iterable[EventLogRow]) -> None:
    """Append decoded rows to their per-``(deployment, event_type)`` JSONLines files.

    One JSON object per line; ``block_ts`` as UTC ISO 8601; integer PLUR amounts kept exact.
    Creates the deployment directory and files on first write. Append-only — never rewrites
    existing lines, since finalized rows are immutable.
    """
    by_file: dict[Path, list[EventLogRow]] = defaultdict(list)
    for row in rows:
        by_file[event_log_path(store_dir, row.deployment_id, row.event_name)].append(row)
    for path, file_rows in by_file.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            for row in file_rows:
                fh.write(json.dumps(_row_to_json(row)) + "\n")


def load_event_log(store_dir: str | os.PathLike[str], deployment_id: DeploymentId) -> EventLog:
    """Load a deployment's persisted rows into the per-event-type :class:`EventLog`.

    Reads every ``<event_name>.jsonl`` under the deployment directory; the inverse of
    :func:`append_rows`. A missing deployment directory yields an empty ``EventLog``.
    """
    dep_dir = deployment_dir(store_dir, deployment_id)
    if not dep_dir.is_dir():
        return EventLog.from_rows(())
    rows: list[EventLogRow] = []
    for path in dep_dir.glob("*.jsonl"):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    rows.append(_row_from_json(json.loads(line)))
    return EventLog.from_rows(rows)


def load_head(store_dir: str | os.PathLike[str], deployment_id: DeploymentId) -> int | None:
    """The last ``finalized`` block synced for a deployment, or ``None`` if never synced."""
    path = head_path(store_dir, deployment_id)
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))[HEAD_BLOCK_KEY]


def save_head(
    store_dir: str | os.PathLike[str], deployment_id: DeploymentId, block_number: int
) -> None:
    """Record ``block_number`` as the deployment's last-synced ``finalized`` head."""
    path = head_path(store_dir, deployment_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({HEAD_BLOCK_KEY: block_number}) + "\n", encoding="utf-8")

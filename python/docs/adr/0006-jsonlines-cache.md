# ADR-0006: `event_log` persisted as a JSONLines cache

Status: Accepted (supersedes the earlier DuckDB sketch)

## Context

`event_log` must persist between hourly `sync` runs so acquisition can resume from a saved head instead of re-scanning from genesis every time. An early sketch reached for DuckDB. The actual workload is small, append-only, and folded linearly in Python — there are no SQL queries and no analytical access patterns. The data is fully reconstructible from chain.

## Decision

Persist `event_log` as append-only JSONLines: one file per `(deployment, event_type)`, plus a `head.json` per deployment recording the last `finalized` block synced, all under a configurable store directory. Treat the store as a rebuildable cache.

## Consequences

- No database dependency; the files are human-inspectable, and adding an event type is a new file with no schema migration. DuckDB / SQLite are rejected as unwarranted for an append-only, SQL-free workload.
- Because it is a cache, loss or corruption is non-fatal: delete the directory and re-sync from genesis.
- `sync` resumes from `head.json` and the incremental path yields the same `event_log` as a full genesis re-sync (a property the test suite pins).
- Store-directory location is configurable (`--store-dir`, `$ETHSWARM_VOLUMES_STORE`, default `$XDG_CACHE_HOME/ethswarm-volumes`); resolution lives in `ethswarm_volumes.store`.

# `event_log` (per-deployment, per-event-type persisted cache)

Part of the [data model](./README.md). `event_log` is the output of the web3-isolation boundary ([`ARCHITECTURE.md`](../ARCHITECTURE.md) §2): decoded, web3-free rows that everything downstream consumes.

`event_log` is partitioned by **`(deployment, event_type)`**: one log per event type, per deployment. Each log holds decoded rows carrying a per-event `args` payload. A fold that needs cross-type chain order reconstructs it with a k-way merge on `(block_number, log_index)` at read time. `registry_version` (a property of the deployment) selects the decoder/projector and fixes the `args` shape for that deployment's logs ([ADR-0005](../adr/0005-event-log-partition.md)).

Each log shares the row shape below; `deployment_id` and `event_name` are the log's identity — its directory and file (see [On disk](#on-disk--jsonlines)):

```
event_log[<event_name>](          -- one relation per event type
  deployment_id,              -- FK to the deployment registry
  block_number,
  block_ts,                   -- UTC; drives day bucketing
  tx_hash, tx_index,          -- tx grouping for the fee join
  log_index,                  -- (block_number, log_index) = chain order, within and across logs
  emitter,                    -- registry address, or the BZZ token address
  args,                       -- decoded, typed, web3-free
  PRIMARY KEY (deployment_id, block_number, log_index)
)
```

## On disk — JSONLines

The store is a directory of append-only **JSONLines** files, one per `(deployment, event_type)`, plus a head marker per deployment ([ADR-0006](../adr/0006-jsonlines-cache.md)):

```
<store-dir>/
  <chain_id>_<registry>/        -- one directory per deployment
    VolumeCreated.jsonl         -- one append-only file per event type; one decoded row per line
    Transfer.jsonl
    AccountActivated.jsonl
    …
    head.json                   -- { "finalized_block": N } : last finalized block synced
```

`block_ts` is written as UTC ISO 8601; PLUR amounts are exact integer JSON numbers. The store is a **cache**, fully reconstructible by re-syncing from genesis. `sync` reads `head.json`, fetches `(head, finalized]`, appends the new rows to their per-type files, advances `head.json`, and re-projects. The first run for a deployment syncs from `genesis_block`, yielding the same `event_log` as a full genesis re-sync — an invariant of the event-sourced, `finalized`-only design (no reorgs to reconcile).

**Location.** The store directory is configurable: `--store-dir <path>`, else `$ETHSWARM_VOLUMES_STORE`, else the default `$XDG_CACHE_HOME/ethswarm-volumes` (falling back to `~/.cache/ethswarm-volumes`). Resolution lives in `ethswarm_volumes.store`.

## A complete and faithful decode

Decoding at the boundary produces a **complete and faithful** log:

- **All** registry events are captured (including events beyond the current measures): `event_log` is a faithful decode of the registry's log.
- **Enums decoded to names** — `VolumeRetired.reason` → `"BatchDied"`, `TopupSkipped.reason` → `"NoAuth"` (version-specific mapping in the decoder).
- **Amounts as integer atomic units** (PLUR) in `args`; BZZ rounding happens in projection.

## v1 event catalogue (`event_name` → `args`)

| `event_name` | `emitter` | `args` | Used by |
|---|---|---|---|
| `VolumeCreated` | registry | `{volume_id, owner, chunk_signer, depth, ttl_expiry}` | capacity; fee (create sibling) |
| `VolumeRetired` | registry | `{volume_id, reason}` | capacity |
| `VolumeOwnershipTransferred` | registry | `{volume_id, from, to}` | fee owner-resolution |
| `AccountActivated` | registry | `{owner, payer}` | accounts authorized |
| `AccountRevoked` | registry | `{owner, payer, revoker}` | accounts authorized |
| `Toppedup` | registry | `{volume_id, amount, new_normalised_balance}` | fee (topup sibling) |
| `Transfer` | BZZ token | `{from, to, value}` | fee volume |
| `PayerDesignated` | registry | `{owner, payer}` | fidelity |
| `TopupSkipped` | registry | `{volume_id, reason}` | diagnostics |

**Acquisition filter.** All logs with `emitter == registry` (decoded against the registry ABI), plus BZZ `Transfer` logs with `emitter == bzz_token`, `from == registry`, `to == postage` — the canonical fee leg, resolved server-side by topic filter. Both up to `finalized`.

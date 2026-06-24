# Volume Registry Data API — Architecture

The architecture of the data API wrapping the `VolumeRegistry` contract (the contract
itself: `../../docs/DESIGN.md`, `../../docs/usage.md`). It covers components, data flow, the
versioning model, and the client interface. The wire format is specified in
[`SCHEMA.md`](./SCHEMA.md); decision rationale lives in [`adr/`](./adr/).

## 1. Goal

Serve three aggregate measures — **fee volume**, **storage capacity**, **accounts** — for
one or more `VolumeRegistry` deployments to two clients (a local CLI and a public web
dashboard), with low integration complexity, fast load times, and hourly freshness.

## 2. The three measures

Every consumer query is a time-series view of one of three measures. Each is a **flow**
(additive over an interval) or a **stock** (a level sampled at an instant); flow-vs-stock is
the one structural difference. The temporal access patterns — as-of a point, over a window,
as a bucketed series — are identical across all three.

| Measure | Type | Reconstructed from |
|---|---|---|
| Fee volume (BZZ → Postage) | flow | `Transfer(registry → postage)` legs + the create-time charge |
| Storage capacity (bytes / chunks) | stock | per-volume `depth` × active-set membership |
| Accounts (currently authorized) | stock | `AccountActivated` / `AccountRevoked` net level |

These three are the **stable public contract**: defined semantically, independent of event
layout, and stable across contract-version changes
([ADR-0001](./adr/0001-three-measures.md)).

## 3. Components

```
  chain          ethswarm-volumes sync (off-chain, hourly)        static host          clients
 ┌──────────┐ getLogs ┌──────────────────────────────────────┐ upload ┌────────┐ fetch ┌─────────┐
 │ Registry │ ──────▶ │ WEB3: acquire + ABI-decode            │ ─────▶ │ one    │ ────▶ │ CLI     │
 │ + BZZ    │ to      │   ↓ event_log (decoded, web3-free)    │        │ JSON   │ (CORS)│ d-board │
 └──────────┘ finalized│ projector (pure) → single artifact   │        │ file   │       └─────────┘
                       └──────────────────────────────────────┘        └────────┘  fold/render local
```

- **Indexer (`ethswarm-volumes sync`)** — the only stateful process; runs offline, hourly
  ([ADR-0002](./adr/0002-finalized-only-indexer.md)). A walled-off **web3 layer** (RPC + ABI
  decode) reads logs via `eth_getLogs` to the chain's `finalized` block and lands decoded
  rows in `event_log`; a **web3-free projector** folds `event_log` into the artifact and
  publishes it (§4).
- **Artifact** — one JSON file ([`SCHEMA.md`](./SCHEMA.md)). The contract between indexer and
  clients.
- **Clients** — CLI (`ethswarm-volumes stat`) and web dashboard. Both read the *same*
  artifact and do all windowing, bucketing, and fiat conversion locally. Two thin renderers
  over one data contract ([ADR-0009](./adr/0009-client-side-folding.md)).

## 4. Data model

Two persisted things — a generic **deployment registry** and a per-deployment,
per-event-type **`event_log`** (an on-disk cache, §4.3) — plus the **artifact** (the
output). One pure projection runs from `event_log` to the artifact (§4.4); its per-entity
sub-results (`volume`, `payment`, …) are sub-functions of that projection
([ADR-0004](./adr/0004-single-projection.md)).

### 4.1 The web3-isolation boundary

All web3-dependent code — RPC, the eth API, and ABI decoding — lives in one layer whose only
output is decoded, web3-free rows in the per-event-type `event_log`. Everything downstream
consumes `event_log` alone. `event_log` *is* the boundary.

```
  ┌─ WEB3 (isolated) ─┐   ┌──────────────── web3-free ────────────────┐
  RPC + ABI decode  →  event_log  →  projector (pure)  →  artifact entry
  per-type getLogs    per-type logs    each fold merges only the logs it needs
```

The web3 layer drives a trusted ABI library (`eth-abi` / web3.py) with the **compiled
contract ABI**; the only bespoke code is a small per-version mapping (ABI param names →
`args` keys, enum ints → names). The compiled ABI is a **build dependency** of `sync` — the
events ABI from `../../contracts/out/<Contract>.sol/<Contract>.json` (Foundry's build
output), pinned per `registry_version` ([ADR-0003](./adr/0003-web3-isolation.md)).

### 4.2 Deployment registry (generic)

Holds deployment identity and version pointers:

```
deployment(
  deployment_id        = (chain_id, registry_address),   -- PK
  registry_version,    -- selects the web3 decoder + projector for this deployment
  genesis_block,       -- first block to index
  label
)
```

Version-specific facts (`grace_blocks`, dependency addresses) live in the artifact's `extra`
([`SCHEMA.md`](./SCHEMA.md)).

### 4.3 `event_log` (per-deployment, per-event-type persisted cache)

`event_log` is partitioned by **`(deployment, event_type)`**: one log per event type, per
deployment. Each log holds decoded rows carrying a per-event `args` payload. A fold that
needs cross-type chain order reconstructs it with a k-way merge on `(block_number,
log_index)` at read time. `registry_version` (a property of the deployment) selects the
decoder/projector and fixes the `args` shape for that deployment's logs
([ADR-0005](./adr/0005-event-log-partition.md)).

Each log shares the row shape below; `deployment_id` and `event_name` are the log's identity
— its directory and file (§4.3.1):

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

#### 4.3.1 On disk — JSONLines

The store is a directory of append-only **JSONLines** files, one per `(deployment,
event_type)`, plus a head marker per deployment
([ADR-0006](./adr/0006-jsonlines-cache.md)):

```
<store-dir>/
  <chain_id>_<registry>/        -- one directory per deployment
    VolumeCreated.jsonl         -- one append-only file per event type; one decoded row per line
    Transfer.jsonl
    AccountActivated.jsonl
    …
    head.json                   -- { "finalized_block": N } : last finalized block synced
```

`block_ts` is written as UTC ISO 8601; PLUR amounts are exact integer JSON numbers. The
store is a **cache**, fully reconstructible by re-syncing from genesis. `sync` reads
`head.json`, fetches `(head, finalized]`, appends the new rows to their per-type files,
advances `head.json`, and re-projects. The first run for a deployment syncs from
`genesis_block`, yielding the same `event_log` as a full genesis re-sync — an invariant of the
event-sourced, `finalized`-only design (no reorgs to reconcile).

**Location.** The store directory is configurable: `--store-dir <path>`, else
`$ETHSWARM_VOLUMES_STORE`, else the default `$XDG_CACHE_HOME/ethswarm-volumes` (falling back
to `~/.cache/ethswarm-volumes`). Resolution lives in `ethswarm_volumes.store`.

Decoding at the boundary produces a **complete and faithful** log:

- **All** registry events are captured (including events beyond the current measures):
  `event_log` is a faithful decode of the registry's log.
- **Enums decoded to names** — `VolumeRetired.reason` → `"BatchDied"`, `TopupSkipped.reason`
  → `"NoAuth"` (version-specific mapping in the decoder).
- **Amounts as integer atomic units** (PLUR) in `args`; BZZ rounding happens in projection.

#### v1 event catalogue (`event_name` → `args`)

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

**Acquisition filter.** All logs with `emitter == registry` (decoded against the registry
ABI), plus BZZ `Transfer` logs with `emitter == bzz_token`, `from == registry`,
`to == postage` — the canonical fee leg, resolved server-side by topic filter. Both up to
`finalized`.

### 4.4 Projection (`event_log` → artifact)

One pure, version-specific projector folds `event_log` into the artifact entry (and the
version-specific `extra`) through these sub-functions:

- **Fee volume** — merges the `Transfer`, `Toppedup` and `VolumeCreated` logs into chain
  order; each captured `Transfer` is a fee forward, and its same-tx sibling (`VolumeCreated`
  → `create`, `Toppedup` → `topup`) supplies `volume_id` and `kind`. Batched `trigger(ids[])`
  puts several `Toppedup` + `Transfer` pairs in one tx, matched in `log_index` order.
  Owner-at-payment is resolved by replaying the `VolumeOwnershipTransferred` log up to the
  payment block.
- **Capacity** — active-set membership from the `VolumeCreated` / `VolumeRetired` logs merged
  in chain order, sampled at UTC day end; `depth → effective_bytes` is a fixed lookup
  (bucketDepth 16, unencrypted; `../../docs/usage.md` §12), nominal bytes =
  `(1 << depth) × 4096`.
- **Accounts authorized** — net level of `AccountActivated` − `AccountRevoked` per owner
  (re-confirmation raises it again), reading those two logs.

The projector normalizes heterogeneous contract versions onto the three stable measures.

## 5. Versioning model

Two orthogonal axes ([ADR-0008](./adr/0008-version-axes.md)):

| Axis | Versions | Cadence | Across deployments |
|---|---|---|---|
| `registry_version` | the deployed **contract** (`v1`, `v2`, …) | when a new contract is deployed | heterogeneous |
| `schema_version` | the **artifact JSON structure** | when the artifact shape changes | fleet-wide, synced |

- A new contract that projects into the existing shape flips that deployment's
  `registry_version` and leaves `schema_version` unchanged.
- `schema_version` follows semver: **major** = breaking change to a kernel field (clients
  update in lockstep); **minor** = additive optional section (old clients ignore unknown
  keys); **patch** = non-structural.
- **Sync publishing.** Every publish cycle regenerates every deployment's data at the
  indexer's current `schema_version` (re-emission from immutable on-chain events). The fleet
  runs a single live schema with one client build for all deployments.
- **Client compatibility.** Accept equal major, ignore unknown keys (forward-compatible on
  minor), refuse a higher major.

## 6. Delivery

- The artifact is a single static file. Publish to any static host with a CDN (object store,
  static pages, IPFS, or Swarm itself), permissive CORS for browser fetches, and a cache TTL
  matching the refresh cadence ([ADR-0007](./adr/0007-static-artifact-delivery.md)).
- Public traffic is absorbed by the CDN; the request path is a static fetch.
- **Build order:** local indexer → local artifact file → client reading a local path; the
  URL / CDN source follows.

## 7. Client interface

The tool is `ethswarm-volumes`. The read client and dashboard share one set of option
semantics; the CLI renders them as flags, the dashboard as controls. Both read the same
artifact and fold locally.

```
ethswarm-volumes sync [options]                 # run the indexer (the §3 write path)
ethswarm-volumes stat [<deployment>] [options]  # render the 3-measure summary
```

`sync` reads to `finalized`, updates the `event_log` cache, projects, and writes/publishes
the artifact. Its main option is `--store-dir <path>` (the §4.3.1 cache location; default
`$XDG_CACHE_HOME/ethswarm-volumes`, overridable via `$ETHSWARM_VOLUMES_STORE`), alongside the
RPC endpoint configuration. `stat` is the read path below. Further verbs (e.g. volume
management) come later; v1 is these two.

`<deployment>` selects by `label` (primary) or `chain:address` (unambiguous fallback);
optional when only one deployment is present. With no `<deployment>` and several present,
`stat` lists them.

| Option | Meaning | Default |
|---|---|---|
| `--source <url\|path>` | where to read the artifact | URL once published; local path used first |
| `--bucket-width 1d\|7d\|30d` | fold width | `1d` |
| `--bucket-count N` / `-n` | series length (number of buckets back) | 30 |
| `--since DATE` | explicit start (alternative to `--bucket-count`) | — |
| `--capacity-basis nominal\|effective` | which capacity figure | `nominal` |
| `--capacity-unit auto\|GiB\|TiB\|chunks` | display unit | `auto` |
| `--fiat none\|USD\|…` | fiat conversion of fee figures (validated against `fiat_currencies`) | `none` |
| `--json` | emit the resolved summary as JSON | — |

How each consumer query resolves against the artifact (all client-side, over the single
fetched artifact):

| Need | Computation |
|---|---|
| Fee volume, window / since genesis | sum `fee_volume_daily.bzz` over the slice |
| Fee volume in fiat | `Σ (bzz × price_daily[fiat])` over the slice — historical per day |
| Capacity now / at a past point | `snapshot.capacity` / `capacity_daily` lookup; basis picks the field |
| Capacity / accounts series | sample the daily series at bucket edges (stocks sample; flows sum) |
| Accounts authorized | `snapshot.accounts.authorized` / `accounts_daily` |
| Accounts paid in window | `snapshot.accounts.paid_in_window[N]` — fixed N (1/7/30 d) |

`paid_in_window` is a **fixed pre-baked set** (1/7/30 d), independent of the bucket options;
the accounts series carries the `authorized` level
([ADR-0009](./adr/0009-client-side-folding.md)).

## 8. Symmetries

- Three measures × identical temporal access patterns (as-of / window / series); flow-vs-stock
  is the one structural difference.
- One artifact, two renderers (CLI / dashboard) with shared option semantics.
- Stable public contract (artifact) over per-version private decode (the per-deployment,
  per-event-type `event_log` + the projector selected by `registry_version`).
- The web3 layer acquires per event type, the store keeps per event type, and the projector
  merges only the logs each measure needs — one shape across acquisition, storage, and read.
- Two clean seams: `event_log` separates web3 from everything else; the artifact separates
  the indexer write path from the client read path.

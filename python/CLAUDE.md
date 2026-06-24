This directory is a workspace for a data API wrapping the smart contract in <reporoot>/contracts.

The end user will want to consume aggregate data such as:
* How much fee volume has a a particular deployment of the Volume Registry processed?
  * In the past N days?
  * Since deployment?
  * In each of the last M N-day intervals?
* How much storage capacity is currently being managed by this Volume Registry?
  * Nominal or effective?
  * Currently or at any given point in the past?
* How many total accounts are there?
  * Growth over time?
  * How many with payments made in the past N days?

Candidate consumers are a CLI one runs locally and a public web dashboard. For each use case, loading times and integration complexity are a concern so the API designer should take pains to make the interface as human-friendly as possible.

## Design status (as of 2026-06-24)

Implemented. The indexer (`sync`) and read client (`stat`) both work end-to-end; the test
suite is green. Three design docs remain authoritative:

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, web3-isolation boundary, data model (`event_log` + pure projector), versioning, delivery, client interface.
* [`docs/SCHEMA.md`](docs/SCHEMA.md) — the artifact wire format and the client `--json` view-model.
* [`docs/TESTING.md`](docs/TESTING.md) — indexer + contract-fixture test strategy.

Decisions locked so far:

* **Three measures**: fee volume (flow), storage capacity (stock), accounts (stock). All share the same temporal access patterns (as-of / window / series); flow-vs-stock is the only structural difference.
* **Tool** is `ethswarm-volumes`, two verbs: `sync` (the indexer) and `stat` (the summary). More verbs (e.g. volume management) later.
* **Indexer** is event-sourced, off-chain, hourly, no archive node; reads to the `finalized` block only (so no reorg handling). Fee volume comes from the `Transfer(registry → postage)` BZZ leg joined by tx — no price-history reconstruction.
* **Web3 isolation**: RPC + eth API + ABI decode are walled off; their only output is decoded, web3-free rows in `event_log`. Everything downstream (the projector) is web3-agnostic. `event_log` is the boundary.
* **Data model = two persisted things**: a generic deployment registry + a per-deployment, per-event-type `event_log` (complete, faithful, integer atomic amounts, enums-as-names), plus the artifact (output). `event_log` is **partitioned `(deployment, event_type)`** — one log per event type, per deployment (`registry_version` selects the decoder/projector but is not the partition key); the shape the web3 layer acquires (topic-filtered `getLogs`). Each projection reads only the logs it needs and reconstructs chain order with a k-way merge on `(block_number, log_index)` at read time. Persisted as **append-only JSONLines** under a configurable cache dir (`--store-dir` / `$ETHSWARM_VOLUMES_STORE`, default `$XDG_CACHE_HOME/ethswarm-volumes`) — **not DuckDB**; the store is a rebuildable cache, not a source of truth, and `sync` resumes from a per-deployment `head.json`. One pure projection between store and artifact — **no intermediate derived tables** (building `volume`/`payment`/… is itself a projection; kept as pure sub-functions).
* **Single static artifact file** holding all deployments; clients fold/convert locally. No live read-API in v1. Delivery via static host + CDN; **build the local indexer first** for testing, URL source later.
* **Two version axes**: `registry_version` (the contract, per-deployment, heterogeneous) vs `schema_version` (artifact structure, semver, synced fleet-wide). `event_log` shape + projector are private per contract version; only the artifact is the stable cross-version contract.
* **Client `stat` options**: `--source`, `--bucket-width`, `--bucket-count`/`-n`, `--since`, `--capacity-basis` (default nominal), `--capacity-unit`, `--fiat` (default none; historical per-bucket, rates baked into the artifact), `--json`.
* **Accounts**: only `authorized` (currently confirmed payer) + `paid_in_window` over fixed `[1, 7, 30]`-day windows. Degraded/revoked breakdown deferred.

Modules in `src/ethswarm_volumes/`. Web3 layer (isolated): `acquire.py` (chunked `getLogs` to a head block — registry events + the `Transfer(registry→postage)` fee leg), `decode.py` (mechanical decode via web3.py `get_event_data` over **version-pinned event ABIs** embedded per `registry_version`, plus `map_event_args` for enum int→name and ABI param-name→`args` key), and `node.py` (production `Web3RpcClient`, `extra` resolved from the registry/postage contract immutables, genesis-block binary-search discovery, block-timestamp lookups). Web3-free downstream: `store.py` (append-only JSONLines + `head.json`), `project.py` (the pure projector and its fee/capacity/accounts/paid-in-window sub-folds), `serialize.py` (`Artifact` ↔ `SCHEMA.md` §3 JSON, both directions), `fiat.py` + `prices.py` (DeFiLlama historical per-day baking), `view.py` (the `SCHEMA.md` §4 client view-model + human renderer), and `cli.py` (`sync`/`stat`). `registry.py` holds the built-in deployment fleet (reduced-artifact specs; `--config` override). `model.py`/`capacity.py` are the data types and reference table.

The deployment registry is a **reduced artifact**: identity only (`label`, `chain_id`, `registry`, `registry_version`, optional `genesis_block`). Everything else is sync output — `extra` is read back from the contract, `genesis_ts`/`as_of` from blocks, the daily series + snapshot from the projector, `price_daily` from DeFiLlama. `sync` resolves the head from `--to-block` (else the chain's `finalized` tag), advances `head.json`, re-projects, and merges into the single artifact file.

Test structure: **integration-first against a live node**, plus pure units for the spec-defined web3-free pieces (non-circular oracle = the schema). `tests/conftest.py` boots an Anvil subprocess; `tests/harness.py` deploys the real contracts (from `contracts/out`, mirroring `RegistryFixture.sol`), drives time-controlled scenarios via web3, and reads node-state oracles. Integration tiers: `test_decoder.py` (acquire+decode → `event_log` schema conformance), `test_pipeline.py` (acquire+decode+project → asserted vs node state: postage BZZ-balance delta for fee, `getActiveVolumeCount`+depths for capacity, `getAccount` recount for authorized), and `test_cli.py` (full `sync`→artifact→`stat` via the production seams, head pinned with `--to-block <latest>` since Anvil's `finalized` tag stays at block 0). Pure units: `test_serialize.py`, `test_view.py`, `test_registry.py`, `test_project_units.py` (owner attribution + window boundaries for `paid_in_window`). `uv run --group dev python -m pytest` → all green; skips the node tiers when `anvil`/artifacts are absent.

Deferred: more scenarios (batched trigger, the 5 retire reasons, multiple as_of cuts) are ~10-line additions on the `Chain` driver; the standalone projector unit tests via a one-time Foundry export (`docs/TESTING.md` §6); a URL/CDN artifact source for `stat --source` (currently a local path); the degraded/revoked account breakdown.

Per the project owner's workflow this is waterfall design-/test-driven development: the test suite was written before implementation, then the stubs filled to turn it green.


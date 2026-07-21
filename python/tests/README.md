# Indexer test suite

Implements the strategy in [`../docs/TESTING.md`](../docs/TESTING.md): **integration tests against
a live node** (Anvil) driving the real contracts, with no pure-Python unit tier.

## Status

A **TDD red suite**: the tests are written against the interface stubs in
`src/ethswarm_volumes/` (the `acquire` / `decode` / `project` bodies raise `NotImplementedError`).
Each test boots a node, deploys, drives a real timeline, and reads node-state oracles — all of
which works today — then calls the production pipeline, which is still a stub. So the suite is red
at `acquire.acquire_logs` and goes green as the stubs are filled in.

Run: `uv run --group dev pytest`. Needs `anvil` + `forge build` artifacts (`contracts/out`);
**skips** cleanly when either is absent.

## Layout

| File | Role |
|---|---|
| `conftest.py` | session-scoped Anvil lifecycle + a clean, freshly-deployed `chain` per test |
| `harness.py` | deploy stack, the `Chain` timeline driver + oracle reads, scenarios, and `Web3RpcClient` |
| `test_decoder.py` | **Tier 1** — acquire + decode → `event_log` schema conformance |
| `test_pipeline.py` | **Tier 2** — acquire + decode + project → asserted vs node state |

## Coverage → location

### Tier 1 — decoder schema (`docs/TESTING.md` §3)

`test_decoder.py::test_decoded_rows_conform_to_schema` — drives `drive_basic`, acquires the real
logs, decodes them, and asserts each `EventLogRow`: known `event_name`, exact `args` keys per the
[`data-model/event-log.md`](../docs/data-model/event-log.md) catalogue, enum→name, lowercased
addresses, integer amounts, tz-aware `block_ts`.

### Tier 2 — decoder + projector vs node state (`docs/TESTING.md` §3)

`test_pipeline.py::test_projection_matches_node_state[basic|revoke-reconfirm]` — runs the full
pipeline and asserts the daily series + snapshot against the node oracle:

| Measure | Node oracle |
|---|---|
| fee daily + total | postage BZZ-balance delta per UTC day-end |
| capacity active set + day-end levels | `getActiveVolumeCount` + `getActiveVolumes` depths |
| capacity bytes (nominal / effective) | `Σ lookup(depth)` over the trusted `capacity.py` table |
| accounts authorized (daily + snapshot) | `getAccount` recount |

Scenarios live in `harness.py` (`drive_basic`, `drive_revoke_reconfirm`); the per-day oracle is
`harness.oracle`.

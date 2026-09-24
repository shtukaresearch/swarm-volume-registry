# Indexer test suite

Implements the strategy in [`../docs/TESTING.md`](../docs/TESTING.md): **integration tests against
a live node** (Anvil) driving the real contracts, with no pure-Python unit tier.

## Status

Green. Originally written as a TDD red suite against the interface stubs; the implementation
has since filled in.

Run: `uv run --group dev pytest`. Needs `anvil`; **skips** the node tiers cleanly when it is
absent. The contract artifacts the harness deploys are the pinned per-version fixtures in
`fixtures/<registry_version>/` (committed — no `forge build` needed); see `docs/TESTING.md` §2a
and each fixture dir's `provenance.json`.

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

`test_decoder.py::test_pinned_abis_match_version_fixture` — pure unit: for every
`registry_version`, the decode-layer pinned event ABIs match the frozen fixture build verbatim.

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

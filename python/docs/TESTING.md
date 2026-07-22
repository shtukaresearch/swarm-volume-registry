# Volume Registry Data API — Test Strategy

Scope: the **indexer** (`ethswarm-volumes sync`) — the web3 acquisition + decode layer and the pure projector. The read client (`stat`) is covered separately. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the components and [`SCHEMA.md`](./SCHEMA.md) for the artifact the projector produces.

## 1. Approach: integration-first, against a real node

The thing under test pulls logs from a chain RPC (`eth_getLogs`) and reads block timestamps and contract state. So the tests run against a **real node** — a local **Anvil** — driving genuine transactions through the real contracts and asserting against **state read back from the node**. No hand-built log fixtures, and no separately-maintained "what `eth_getLogs` returns" format: the node is the single source of truth for both the input (logs) and the oracle (state).

There are **no pure-Python unit tests** in the suite to start. A decoder or projector tested in isolation has no independent oracle for event values without re-encoding them, which is circular. Correctness is established end-to-end against the node instead (§3). (If pure-Python projector unit tests are wanted later, craft them with a one-time Foundry export of synthetic event + state cases — hand-authored, no simulation; §6.)

Requirements: the `anvil` binary only. The contract artifacts the harness deploys are **pinned per-version fixtures** committed under `tests/fixtures/<registry_version>/` (§2a) — no Foundry toolchain is needed. The suite **skips** cleanly when `anvil` is absent, so a node-less environment does not fail.

## 2. The harness

`tests/harness.py` + `tests/conftest.py` provide the live-node rig:

- **Node lifecycle** (`conftest.py`) — a session-scoped Anvil subprocess on a free port; each test gets a clean chain (`anvil_reset`) and a fresh deployment.
- **Deploy** (`harness.deploy_stack`) — deploys the vendored `PostageStamp` / `PriceOracle` / `TestToken` + a fresh `VolumeRegistry` from the pinned fixture artifacts (§2a), mirroring `contracts/test/fixtures/RegistryFixture.sol` (the one `.sol` fixture still needed).
- **Timeline driver** (`harness.Chain`) — drives real transactions with controlled time: `set_day(n)` moves the cursor to a UTC day; each action (`activate` / `create` / `delete` / `revoke` / …) mines one block at the next cursor second via Anvil's `evm_setNextBlockTimestamp`, from the appropriate actor account, with an explicit gas limit.
- **Oracle reads** (`harness.Chain` + `harness.oracle`) — `getActiveVolumeCount` / `getActiveVolumes` / `getAccount` and the postage BZZ balance, read at any historical block via `eth_call`.
- **Real RPC client** (`harness.Web3RpcClient`) — the production `acquire.RpcClient` (`ARCHITECTURE.md` §2, the web3-isolation boundary) backed by web3, so acquisition goes through genuine `eth_getLogs`.

### 2a. Pinned per-version fixtures

The suite tests each `registry_version` against **the contracts actually deployed under that version**, not against contracts `HEAD`. `tests/fixtures/<registry_version>/` holds slim (abi + creation bytecode) Foundry build artifacts frozen at the deployed release, with a `provenance.json` recording the source commit/tag, compiler settings, and the on-chain verification (runtime bytecode vs `eth_getCode`, immutable references masked). The harness deploys from these; `decode.py`'s pinned event ABIs are cross-checked against them by a pure unit in `test_decoder.py` (the `registry_version` string doubles as the fixture directory name).

Consequences: contracts `HEAD` can change without touching this suite — a new contract version is *absorbed*, not *tracked*, by adding a new fixture dir + decode reference data + (if semantics changed) driver variants and scenarios (the `registry_version` axis — [`VERSIONING.md`](./VERSIONING.md)). The `Chain` driver's function signatures and oracle reads are as version-specific as the bytecode, so a semantics-changing version gets its own driver variant rather than edits to the existing one.

**Why a Python (web3) driver, not forge.** A `forge script` collects its broadcast transactions and submits them as a batch *after* the script body runs, while `vm.rpc` cheats fire *during* it — so a single forge run cannot interleave "set the clock → send tx → set the clock → send tx" and can't place transactions on different days. web3 holds Anvil's account keys and interleaves time-control with transactions directly, which is both simpler and the only thing that actually works for a time-controlled, multi-actor scenario.

## 3. The two tiers

| Tier | File | What | Oracle |
|---|---|---|---|
| **Decoder** | `test_decoder.py` | acquire (real `eth_getLogs`) -> `decode_log`; assert each `EventLogRow` conforms to the `event_log` schema | none — schema conformance only |
| **Decoder + projector** | `test_pipeline.py` | acquire -> decode -> `EventLog` -> `project_entry`; assert the artifact | node state read back via `eth_call` |

**Tier 1 — decoder (schema).** Drives a scenario, pulls the registry + fee-leg logs, decodes them, and checks the decoded rows: `event_name` in the [`event-log.md`](./data-model/event-log.md) catalogue, exact `args` key set per event, enums decoded to names (not ints), addresses lowercased hex, amounts integer, timestamps tz-aware. There is no value oracle for a decoder alone, so this is the ceiling for the tier.

**Tier 2 — decoder + projector vs node state.** Drives a scenario, runs the whole pipeline, and asserts the projected daily series + snapshot against an **independent oracle read from the node**, sampled at each UTC day-end (the last block before the next midnight, or `as_of` for the partial final day):

- **Fee** — postage contract's BZZ-balance delta over the day. Every fee leg lands in the postage pot, so its increase *is* the fee volume — a state read independent of event decoding, and unaffected by payer funding.
- **Capacity** — `getActiveVolumeCount` for the count and `getActiveVolumes` depths; bytes are `Σ lookup(depth)` over the trusted reference table (`capacity.py`), since the contract has no notion of bytes.
- **Authorized accounts** — `getAccount(owner)` recount over the actor set.

## 4. Scenarios

Scenarios are Python timeline drivers in `harness.py`, straddling the seams the projector cares about. Built so far:

- **`drive_basic`** — activate + two creates (depth 20 / 22) on the genesis day, a delete on day 3, mid-day `as_of`: fee (two create legs), capacity (creates add / delete retires / empty gap-filled days), authorized = 1, partial final bucket.
- **`drive_revoke_reconfirm`** — activate + create, revoke, re-confirm: `authorized` non-monotonic (1 → 0 → 1), owner counted once.

Adding a scenario is a ~10-line function on `Chain`. Further ones from the original plan are easy follow-ons: batched `trigger(ids[])`, each of the 5 retire reasons, an exact `paid_in_window` boundary, ownership transfer mid-window, and multiple `as_of` cuts.

## 5. Determinism

Anvil's accounts and addresses are deterministic; the driver controls block timestamps explicitly (`evm_setNextBlockTimestamp`) so day bucketing is reproducible. The timeline genesis is a fixed future UTC midnight, so warping forward from the node's (real-clock) deploy blocks is always monotonic. Day-boundary block selection and oracle sampling are computed post-hoc from the actual block timestamps, so they hold regardless of exact block placement.

## 6. Deferred

- **Pure-Python projector unit tests** — if wanted, a one-time Foundry export of hand-crafted synthetic `event_log` + state cases (no timeline simulation) would let the projector be tested without a node. Not built; the `.sol` fixtures remain so it stays possible.
- **Fiat** conversion, **client (`stat`)** rendering/formatting, and **reorg** handling (out by construction — `finalized` only).

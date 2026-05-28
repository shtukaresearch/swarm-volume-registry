# Tests

This document is for two audiences:

- **Reviewer.** Verifying that the test suite covers the architecture in
  [`../../docs/DESIGN.md`](../../docs/DESIGN.md) correctly and completely.
- **Contributor.** Editing `DESIGN.md` and needing to know which tests
  must change in lockstep.

The §-references throughout this file point into `DESIGN.md`. The suite
is organised around those sections; if a section changes, find its row
in [DESIGN ↔ tests](#designmd--tests) and update accordingly.

## Strategy

Four design decisions shape the suite.

### 1. Example tests by default, fuzz only where the state space is intractable

Every named state transition, retirement edge, and public-function
precondition gets a hand-written witness with concrete inputs, exact
balance assertions, and `vm.expectEmit` checks. Witnesses are debuggable
and fail loudly when intent drifts.

Property-based / invariant testing is layered on top **only** for the
three invariants whose joint state space — accounts × volumes × call
sequence — is too large to enumerate by hand:

- **I3** (payer bounded exposure),
- **I8** (charge correctness),
- **I9** (revocation atomicity).

All three reduce to a single fuzzable property: *every BZZ outflow from a
payer is accounted for by a `Toppedup` or `createVolume` event the
contract emitted on the guarded path*. The shared handler exposes the
contract's public surface to Foundry's invariant runner and maintains
per-payer ghost sums `spentByPayer` (observed outflow) and
`allowedByPayer` (formula-attributable charges from observed events);
the three invariant contracts each assert a relation between those sums
(strict equality for I8/I9, ≤ for I3).

Invariants like I1, I2, I5, I6, I7 are *not* fuzzed — they have a small
number of concretely-namable witnesses and adding random exploration on
top would not improve coverage.

### 2. Real Postage / PriceOracle / TestToken bytecode, not mocks

Several invariants are *joint* properties of `VolumeRegistry` and
`PostageStamp`:

- **I1** asserts that an Active volume corresponds to a live Postage
  batch at the recorded depth — only verifiable if `PostageStamp.batches`
  reports the real thing.
- **I2** asserts retirement on Postage-side divergence (depth changes,
  batch death, owner mismatch). Detecting those edges requires Postage's
  real state machine.
- **I6** depends on `PriceOracle.changeRate[0] / priceBase` (the `K_max`
  ceiling); the floor factor `f ≈ 0.9567` is *derived in-test* from the
  live oracle's constants, not hardcoded.

So `storage-incentives` is a real submodule, not a mock surface. The
fixture pins `PostageStamp.minimumValidityBlocks` to 12 (matching the
Sepolia floor) and grants the test contract `PRICE_ORACLE_ROLE` so
`lastPrice` can be set directly, but everything else is the upstream
contract.

### 3. One file per DESIGN section, not per invariant

Invariants weave through multiple state transitions; sections of
`DESIGN.md` correspond to coherent surfaces (account state machine,
volume lifecycle, trigger semantics, ...). A new reader locates a test
by where they remember the concept from in the design doc, then sees
which invariants that file covers in its `@notice` header.

Invariant-axis navigation is provided by the cross-reference table
below.

### 4. Fork tests are a parity check, not a correctness re-run

Correctness coverage lives in L1. The Sepolia fork suite catches a
different failure mode: ABI / parameter drift between the pinned
`storage-incentives` submodule and the live chain bytecode. It runs a
small happy-path subset plus `setUp` parity assertions.

## DESIGN.md ↔ tests

### By DESIGN section

| Section | Topic | Tests |
|---|---|---|
| §4 | Data model — `Volume`, `Account`, `volumeId` derivation, `nextNonce` | [`NonceAndVolumeId.t.sol`](NonceAndVolumeId.t.sol); struct fields exercised throughout |
| §5 | Threat model — signer / owner / payer compromise | I3 / I8 / I9 coverage below; signer-compromise (`PostageStamp.increaseDepth` direct) in [`TriggerSemantics.test_trigger_depthChanged_retires`](TriggerSemantics.t.sol) |
| §6.1 | Volume state machine, five retirement edges | [`RetirementEdges.t.sol`](RetirementEdges.t.sol), [`VolumeLifecycle.test_deleteVolume_*`](VolumeLifecycle.t.sol), [`TriggerSemantics.test_trigger_*_retires`](TriggerSemantics.t.sol) |
| §6.2 | Account state machine | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.1 | Owner API | [`VolumeLifecycle.t.sol`](VolumeLifecycle.t.sol); `designateFundingWallet` in [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.2 | Payer API (`confirmAuth`, `revoke`) | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.3 | Keeper API (`trigger`, batched `trigger`, `reap`) | [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) |
| §7.4 | Views | [`ActiveSetAndViews.t.sol`](ActiveSetAndViews.t.sol); `invariant_volumeViewMatchesAccount` in [`invariants/TransferOnlyIfGuarded.t.sol`](invariants/TransferOnlyIfGuarded.t.sol) |
| §8 | Trigger check-order | [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) (ordering tests pin the §8 step sequence) |
| §9 | Events | Asserted via `vm.expectEmit` throughout — no dedicated file |
| §10 | Constructor checks (`graceBlocks ≥ floor`, non-zero `postage`/`bzz`) | `graceBlocks` floor: [`VolumeLifecycle.test_createVolume_graceBlocksBelowPostageFloor_constructorReverts`](VolumeLifecycle.t.sol); zero-address: not covered (see [Coverage gaps](#coverage-gaps)) |
| §10.1 | Survival-floor derivation | [`SurvivalFloor.t.sol`](SurvivalFloor.t.sol) |
| §11 | Keeper interface (permissionless) | Same as §7.3; stranger-as-caller exercised in [`invariants/PayerHandler.sol`](invariants/PayerHandler.sol)'s `strangerCalls` action |

### By invariant

| Invariant (§5) | Example lens | Fuzz lens |
|---|---|---|
| **I1** — Volume ⇔ batch | [`VolumeLifecycle.test_createVolume_happy`](VolumeLifecycle.t.sol) asserts the batch is created with the recorded owner/depth; [`RetirementEdges.t.sol`](RetirementEdges.t.sol) covers the contrapositive | — (small witness set; fuzz unnecessary) |
| **I2** — Batch immutability | [`RetirementEdges.test_i2_defensiveBatchOwnerMismatch`](RetirementEdges.t.sol) (vm.store-driven), [`TriggerSemantics.test_trigger_depthChanged_retires`](TriggerSemantics.t.sol) | — |
| **I3** — Payer bounded exposure | [`PayerBoundedExposure.t.sol`](PayerBoundedExposure.t.sol) (3 witnesses) | [`invariants/TransferOnlyIfGuarded.invariant_payerSpendNeverExceedsFormula`](invariants/TransferOnlyIfGuarded.t.sol) |
| **I4** — Auth bilaterality | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) (10 tests covering the full §6.2 state machine) | — |
| **I5** — Trigger idempotence | [`TriggerSemantics.test_trigger_idempotence_sameBlock`](TriggerSemantics.t.sol), `test_trigger_zeroDeficit_noop` | — |
| **I6** — Survival | [`SurvivalFloor.t.sol`](SurvivalFloor.t.sol) (worst-case Gnosis, short-grace, flat, falling-price) | — (worst case is analytic, not random) |
| **I7** — Removal finality | [`RetirementEdges.t.sol`](RetirementEdges.t.sol) (5 tests including `test_retired_noTransferFromPayer`) | — |
| **I8** — Charge correctness | [`ChargeCorrectness.t.sol`](ChargeCorrectness.t.sol) (2 formula assertions) | [`invariants/NoOtherPathSpendsPayer.invariant_spentEqualsAllowedPerPayer`](invariants/NoOtherPathSpendsPayer.t.sol) |
| **I9** — Revocation atomicity | [`RevocationAtomicity.t.sol`](RevocationAtomicity.t.sol) (1 test, 5-volume pair) | [`invariants/RevokedOwnerSpendsZero.invariant_spentMatchesAllowed`](invariants/RevokedOwnerSpendsZero.t.sol) |

## Files

### Fixture

[`fixtures/RegistryFixture.sol`](fixtures/RegistryFixture.sol) — abstract
base for every L1 test. Deploys a fresh `VolumeRegistry` (`graceBlocks
= 15`), `PostageStamp` (`minimumValidityBlocks` coerced to 12),
`PriceOracle`, and `TestToken`; grants `PRICE_ORACLE_ROLE` to the test
contract and primes `lastPrice` to a non-zero value before the registry
is constructed. Exposes canonical actors (`OWNER`, `OWNER_B`, `PAYER`,
`PAYER2`, `CHUNK_SIGNER`, `STRANGER`) and helpers `_activateAccount`,
`_createDefaultVolume`, `_createVolumeWithTtl`, `_roll`,
`_expectedCreateCharge`.

### Example tests

| File | Coverage |
|---|---|
| [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) | The owner→payer `designate` / `confirmAuth` / `revoke` handshake. Bilateral revoke authority, atomic re-confirm overwrite, `revoke` preserves `payer` storage but re-activation requires a fresh `designate` (matching the §6.2 diagram). |
| [`VolumeLifecycle.t.sol`](VolumeLifecycle.t.sol) | `createVolume` happy path with exact charge; reverts on inactive account, insufficient balance, insufficient allowance, and on construction below the Postage floor. `deleteVolume` and `transferVolumeOwnership` including account-context-follows-new-owner. |
| [`ActiveSetAndViews.t.sol`](ActiveSetAndViews.t.sol) | Swap-and-pop maintenance of `activeVolumeIds`, pagination, `getVolume` payer resolution before and after `revoke`. |
| [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) | Full §8 check-order: happy topup, zero-deficit no-op, same-block idempotence, NoAuth / PaymentFailed skip paths (no retire), each retire edge in isolation, ordering tests pinning that every retire edge beats the auth check, batched-`trigger` try/catch isolation, `reap`. |
| [`RetirementEdges.t.sol`](RetirementEdges.t.sol) | A retired volume cannot be triggered, deleted again, or transferred; is absent from `activeVolumeIds`; never causes a BZZ delta. Includes a `vm.store`-driven I2 defensive witness that forces `batches(id).owner != chunkSigner` and observes `REASON_BATCH_OWNER_MISMATCH`. |
| [`ChargeCorrectness.t.sol`](ChargeCorrectness.t.sol) | Asserts `createVolume` and `trigger` move exactly the formula-computed BZZ amount from the payer. The "no other path spends payer BZZ" half is in the invariant suite. |
| [`PayerBoundedExposure.t.sol`](PayerBoundedExposure.t.sol) | Corner witnesses: revoked account does not drain; retired volume does not drain; after re-designating the payer, the old payer is never touched. |
| [`SurvivalFloor.t.sol`](SurvivalFloor.t.sol) | Drives `PostageStamp.setPrice` at the worst-case `K_max`-per-`ROUND_LENGTH` schedule `PriceOracle` permits and measures observed batch-death blocks. Asserts `T ≥ ⌊f × graceBlocks⌋` with `f` computed in-test from the vendored oracle's `changeRate` / `priceBase` (Taylor expansion of `ln`), plus flat-price and falling-price control cases. |
| [`RevocationAtomicity.t.sol`](RevocationAtomicity.t.sol) | A single `revoke` call disables topups across every volume under the (owner, payer) pair in one cycle; no BZZ moves; no volume retires. |
| [`NonceAndVolumeId.t.sol`](NonceAndVolumeId.t.sol) | `nextNonce` increments monotonically; the value returned from `createVolume` equals `keccak256(abi.encode(address(registry), nonce))`. |

### Invariant tests

| File | Role |
|---|---|
| [`invariants/PayerHandler.sol`](invariants/PayerHandler.sol) | Shared handler. 3 owners × 3 payers × 2 signers + 3 strangers, fixed set. Exposes `designate` / `confirm` / `revoke_` / `createVolume` / `triggerOne` / `triggerBatch` / `roll` / `transferOwnership` / `deleteVolume` / `strangerCalls` to the invariant runner. Maintains per-payer ghost sums `spentByPayer` (observed BZZ outflow) and `allowedByPayer` (formula-attributable charges observed via `Toppedup` and `createVolume` events). |
| [`invariants/NoOtherPathSpendsPayer.t.sol`](invariants/NoOtherPathSpendsPayer.t.sol) | **I8** — `invariant_spentEqualsAllowedPerPayer`: for every payer, `spentByPayer == allowedByPayer` at every step. Any code path moving BZZ without emitting a corresponding `Toppedup` / `createVolume` breaks the equality. |
| [`invariants/TransferOnlyIfGuarded.t.sol`](invariants/TransferOnlyIfGuarded.t.sol) | **I3** — `invariant_payerSpendNeverExceedsFormula`: `spentByPayer ≤ allowedByPayer`. Plus `invariant_volumeViewMatchesAccount`: `getVolume(id).{payer,accountActive}` agrees with `accounts[owner]` for every created volume. |
| [`invariants/RevokedOwnerSpendsZero.t.sol`](invariants/RevokedOwnerSpendsZero.t.sol) | **I9** — `invariant_spentMatchesAllowed`: same equality as I8, scrutinised against the handler's randomised revoke sequence. Combined with the structural fact that `allowedByPayer` only rises on the guarded path, this rules out a revoked owner spending. |

Default invariant config: 256 runs × 500 calls per run; ~20 s wall time
per suite.

### Fork tests

[`fork/ForkRegistry.t.sol`](fork/ForkRegistry.t.sol). Chain-agnostic;
configure the target via environment variables:

| Var | Required? | Purpose |
|---|---|---|
| `FORK_POSTAGE_STAMP` | yes | Live `PostageStamp` address on the forked chain. |
| `FORK_BZZ` | yes | Live `BZZ` ERC20 address on the forked chain. |
| `FORK_MULTICALL3` | optional | Defaults to the canonical `0xcA11bde05977b3631167028862bE2a173976CA11`. |
| `FORK_GRACE_BLOCKS` | optional | Registry constructor arg. Defaults to `PostageStamp.minimumValidityBlocks()` on the target chain. |

The `forkOnly` modifier skips every test when `FORK_POSTAGE_STAMP` is
unset or has no code at the resolved address — so plain `forge test`
against the hermetic EVM is a silent skip rather than a failure.

Fork-safe subset:

- `test_fork_createVolume_happy`
- `test_fork_trigger_happyTopup`
- `test_fork_trigger_zeroDeficit_noop`
- `test_fork_trigger_idempotence_sameBlock`
- `test_fork_activeSet_pagination_moderate` (N = 30)

Parity assertions at `setUp` (run on every fork test):

- Code present at `FORK_POSTAGE_STAMP`.
- Code present at `FORK_MULTICALL3` (canonical address by default).
- `FORK_GRACE_BLOCKS ≥ PostageStamp.minimumValidityBlocks()` on the target chain.
- `PostageStamp.priceOracle()` resolves to a non-zero address.

## Running

```sh
cd contracts
forge test                                # all L1 (unit + invariant)
forge test --no-match-path 'test/fork/*'  # L1 only, skip fork
FORK_POSTAGE_STAMP=0x... FORK_BZZ=0x... \
    forge test --fork-url $RPC_URL \
    --match-path test/fork/ForkRegistry.t.sol
```

See `docs/usage.md` §2 for current `FORK_POSTAGE_STAMP` / `FORK_BZZ`
values per chain.

Clean-cache L1 run: ~5 min (Solc + invariant fuzzing). Subsequent runs
cache-hit.

## Coverage gaps

Minor — flagged for honesty, not necessarily for fixing:

- The constructor's zero-address checks (`postage == 0`, `bzz == 0`)
  have no witness.
- `createVolume(chunkSigner = address(0))` and
  `transferVolumeOwnership(newOwner = address(0))` revert with
  `ZeroAddress` but neither path is exercised.
- The error `DesignationClearedOnActivate` is declared on the contract
  but never thrown by any code path. Either the check it was meant to
  guard was inlined elsewhere or it is dead. Worth either removing the
  error or restoring the check.

## Out of scope

End-to-end devnet and live-testnet exercise harnesses (keeper-side
integration, Safe Transaction Service flows, dashboards) are out of
scope for this repo. The registry contract is neutral infrastructure
and makes no assumptions about who runs a keeper; component-level tests
for any specific keeper implementation belong with that implementation.

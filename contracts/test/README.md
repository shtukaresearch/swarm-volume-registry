# Tests

This document is for two audiences:

- **Reviewer.** Verifying that the test suite covers the architecture in
  [`../../docs/DESIGN.md`](../../docs/DESIGN.md) correctly and completely.
- **Contributor.** Editing `DESIGN.md` and needing to know which tests
  must change in lockstep.

The §-references throughout this file point into `DESIGN.md`. The suite
is organised around those sections; if a section changes, find its row
in [DESIGN ↔ tests](#designmd--tests) and update accordingly.

Entries marked † are specified but not yet implemented. They cover
batch import and the separation of volume IDs from batch IDs
([ADR-0001](../../docs/adr/0001-permissionless-batch-import.md) to
[ADR-0004](../../docs/adr/0004-register-and-import-entry-points.md)),
targeted at the `v2-rc3` release.

## Strategy

Four design decisions shape the suite.

### 1. Example tests by default, fuzz only where the state space is intractable

Every named state transition, retirement edge, and public-function
precondition gets a hand-written witness with concrete inputs, exact
balance assertions, and `vm.expectEmit` checks. Witnesses are debuggable
and fail loudly when intent drifts.

Property-based / invariant testing is layered on top **only** for the
invariants whose joint state space — accounts × volumes × call
sequence — is too large to enumerate by hand:

- **I3** (payer bounded exposure),
- **I8** (charge correctness),
- **I9** (revocation atomicity),
- **I14** (nonce monotonicity) and volume-ID uniqueness †.

The first three reduce to a single fuzzable property: *every BZZ outflow
from a payer is accounted for by a `Toppedup` or `createVolume` event the
contract emitted on the guarded path*. The shared handler exposes the
contract's public surface to Foundry's invariant runner and maintains
per-payer ghost sums `spentByPayer` (observed outflow) and
`allowedByPayer` (formula-attributable charges from observed events);
the three invariant contracts each assert a relation between those sums
(strict equality for I8/I9, ≤ for I3). Charges made inside
`importVolume` surface as `Toppedup` events, and a reverted import moves
nothing, so these sums cover the import path with no new ghost state †.

I14 is fuzzed because the hazard it guards — `confirmAuth` resetting the
nonce ([ADR-0003](../../docs/adr/0003-nonce-in-account.md)) — only shows
up under interleavings of account transitions and creating calls, which
is exactly what the handler randomises. The handler keeps a per-owner
ghost nonce and a ghost set of issued IDs †.

Invariants like I1, I2, I5, I6, I7, I11, I12, I13 are *not* fuzzed —
they have a small number of concretely-namable witnesses and adding
random exploration on top would not improve coverage.

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
| §4 | Data model — `Volume`, `Account`, `volumeId` derivation, `nextNonce`, account `nonce` † | [`NonceAndVolumeId.t.sol`](NonceAndVolumeId.t.sol); struct fields exercised throughout |
| §5 | Threat model — signer / owner / payer compromise; shared batches † | I3 / I8 / I9 coverage below; signer-compromise (`PostageStamp.increaseDepth` direct) in [`TriggerSemantics.test_trigger_depthChanged_retires`](TriggerSemantics.t.sol); shared batches in [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) and [`VolumeRegister.t.sol`](VolumeRegister.t.sol) † |
| §6.1 | Volume state machine, five retirement edges | [`RetirementEdges.t.sol`](RetirementEdges.t.sol), [`VolumeLifecycle.test_deleteVolume_*`](VolumeLifecycle.t.sol), [`TriggerSemantics.test_trigger_*_retires`](TriggerSemantics.t.sol) |
| §6.2 | Account state machine, nonce preservation † | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.1 | Owner API | [`VolumeLifecycle.t.sol`](VolumeLifecycle.t.sol); `registerVolume` in [`VolumeRegister.t.sol`](VolumeRegister.t.sol) †; `importVolume` in [`VolumeImport.t.sol`](VolumeImport.t.sol) †; `designateFundingWallet` in [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.2 | Payer API (`confirmAuth`, `revoke`) | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.3 | Keeper API (`trigger`, batched `trigger`, `reap`) | [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) |
| §7.4 | Views | [`ActiveSetAndViews.t.sol`](ActiveSetAndViews.t.sol); `invariant_volumeViewMatchesAccount` in [`invariants/TransferOnlyIfGuarded.t.sol`](invariants/TransferOnlyIfGuarded.t.sol) |
| §8 | Trigger check-order; outcomes † | [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) (ordering tests pin the §8 step sequence); outcome acceptance by `importVolume` in [`VolumeImport.t.sol`](VolumeImport.t.sol) † |
| §9 | Events | Asserted via `vm.expectEmit` throughout — no dedicated file |
| §10 | Constructor checks (`graceBlocks ≥ floor`, non-zero `postage`/`bzz`) | `graceBlocks` floor: [`VolumeLifecycle.test_createVolume_graceBlocksBelowPostageFloor_constructorReverts`](VolumeLifecycle.t.sol); zero-address: not covered (see [Coverage gaps](#coverage-gaps)) |
| §10.1 | Survival-floor derivation | [`SurvivalFloor.t.sol`](SurvivalFloor.t.sol) |
| §14 | Postage constraints — `batches()` tuple layout † | Parity assertion in [`fork/ForkRegistry.t.sol`](fork/ForkRegistry.t.sol) † |
| §11 | Keeper interface (permissionless) | Same as §7.3; stranger-as-caller exercised in [`invariants/PayerHandler.sol`](invariants/PayerHandler.sol)'s `strangerCalls` action |

### By invariant

| Invariant (§5) | Example lens | Fuzz lens |
|---|---|---|
| **I1** — Volume ⇒ batch | [`VolumeLifecycle.test_createVolume_happy`](VolumeLifecycle.t.sol) asserts the batch is created with the recorded owner/depth; [`VolumeRegister.t.sol`](VolumeRegister.t.sol) asserts the recorded `batchId`/`chunkSigner`/`depth` are read from Postage †; [`RetirementEdges.t.sol`](RetirementEdges.t.sol) covers the contrapositive | — (small witness set; fuzz unnecessary) |
| **I2** — Batch immutability | [`RetirementEdges.test_i2_defensiveBatchOwnerMismatch`](RetirementEdges.t.sol) (vm.store-driven), [`TriggerSemantics.test_trigger_depthChanged_retires`](TriggerSemantics.t.sol); every retire edge re-run on a registered volume † | — |
| **I3** — Payer bounded exposure | [`PayerBoundedExposure.t.sol`](PayerBoundedExposure.t.sol) (3 witnesses) | [`invariants/TransferOnlyIfGuarded.invariant_payerSpendNeverExceedsFormula`](invariants/TransferOnlyIfGuarded.t.sol) |
| **I4** — Auth bilaterality | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) (10 tests covering the full §6.2 state machine) | — |
| **I5** — Trigger idempotence | [`TriggerSemantics.test_trigger_idempotence_sameBlock`](TriggerSemantics.t.sol), `test_trigger_zeroDeficit_noop`; batch-level: two volumes on one batch triggered in one block † | — |
| **I6** — Survival | [`SurvivalFloor.t.sol`](SurvivalFloor.t.sol) (worst-case Gnosis, short-grace, flat, falling-price); `importVolume` leaves the batch at target in [`VolumeImport.t.sol`](VolumeImport.t.sol) † | — (worst case is analytic, not random) |
| **I7** — Removal finality | [`RetirementEdges.t.sol`](RetirementEdges.t.sol) (5 tests including `test_retired_noTransferFromPayer`); re-registering a batch after retirement yields a new ID and the old one stays Retired, in [`VolumeRegister.t.sol`](VolumeRegister.t.sol) † | — |
| **I8** — Charge correctness | [`ChargeCorrectness.t.sol`](ChargeCorrectness.t.sol) (2 formula assertions; plus `importVolume` = trigger formula and `registerVolume` = 0 †) | [`invariants/NoOtherPathSpendsPayer.invariant_spentEqualsAllowedPerPayer`](invariants/NoOtherPathSpendsPayer.t.sol) |
| **I9** — Revocation atomicity | [`RevocationAtomicity.t.sol`](RevocationAtomicity.t.sol) (1 test, 5-volume pair) | [`invariants/RevokedOwnerSpendsZero.invariant_spentMatchesAllowed`](invariants/RevokedOwnerSpendsZero.t.sol) |
| **I10** — Owner immutability | [`VolumeLifecycle.test_ownerIsImmutable_legacyTransferSelectorReverts`](VolumeLifecycle.t.sol); owner = caller for `registerVolume` / `importVolume` † | — (the owner field has no write path after creation) |
| **I11** — No squatting † | [`VolumeRegister.t.sol`](VolumeRegister.t.sol): a stranger registering the same batch does not change the owner's next ID | — |
| **I12** — Non-interference † | [`VolumeRegister.t.sol`](VolumeRegister.t.sol): deleting or retiring one volume on a shared batch leaves the other's record untouched | — |
| **I13** — Import atomicity † | [`VolumeImport.t.sol`](VolumeImport.t.sol): every revert case leaves no record, no nonce consumed, no active-set entry, no event, no BZZ delta | — |
| **I14** — Nonce monotonicity † | [`NonceAndVolumeId.t.sol`](NonceAndVolumeId.t.sol); preservation across account transitions in [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) | [`invariants/VolumeIdentity.t.sol`](invariants/VolumeIdentity.t.sol) † |

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

New helpers †: `_createExternalBatch(signer, depth, balancePerChunk)`
mints BZZ to an EOA, which calls `PostageStamp.createBatch` directly, so
the batch has no registry involvement; `_registerDefault(owner, batchId)`
and `_importDefault(owner, batchId)` wrap the two import entry points;
`_expectedVolumeId(owner, nonce)` computes
`keccak256(abi.encode(owner, nonce))`.

### Example tests

| File | Coverage |
|---|---|
| [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) | The owner→payer `designate` / `confirmAuth` / `revoke` handshake. Bilateral revoke authority, atomic re-confirm overwrite, `revoke` preserves `payer` storage but re-activation requires a fresh `designate` (matching the §6.2 diagram). † Nonce preservation (ADR-0003 regression tests): after at least one creating call, re-confirming the same payer, re-designating and confirming a different payer, and revoking then re-confirming each leave `getAccount(owner).nonce` unchanged, and the next creating call produces the expected ID. |
| [`VolumeLifecycle.t.sol`](VolumeLifecycle.t.sol) | `createVolume` happy path with exact charge; reverts on inactive account, insufficient balance, insufficient allowance, and on construction below the Postage floor. `deleteVolume`, plus I10 coverage proving the legacy v1 transfer selector is absent and cannot redirect payer resolution. |
| [`ActiveSetAndViews.t.sol`](ActiveSetAndViews.t.sol) | Swap-and-pop maintenance of `activeVolumeIds`, pagination, `getVolume` payer resolution before and after `revoke`. † `VolumeView.batchId` for created and registered volumes; `getAccount` returns `nonce`. |
| [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) | Full §8 check-order: happy topup, zero-deficit no-op, same-block idempotence, NoAuth / PaymentFailed skip paths (no retire), each retire edge in isolation, ordering tests pinning that every retire edge beats the auth check, batched-`trigger` try/catch isolation, `reap`. † Trigger reads and tops up `v.batchId`. Shared batches: two owners with two payers on one batch, triggered in the same block — only the first payer is charged and the total equals one deficit (I5, batch level); a depth change retires each volume on the batch on its own trigger. Each retire edge re-run on a registered volume. The internal outcome refactor (§8) must leave `trigger`'s events and return behaviour unchanged; the existing tests pin that. |
| [`RetirementEdges.t.sol`](RetirementEdges.t.sol) | A retired volume cannot be triggered or deleted again, is absent from `activeVolumeIds`, and never causes a BZZ delta. Includes a `vm.store`-driven I2 defensive witness that forces `batches(id).owner != chunkSigner` and observes `REASON_BATCH_OWNER_MISMATCH`. † The `vm.store` slot is computed from the volume's `batchId`, not its `volumeId`. |
| [`ChargeCorrectness.t.sol`](ChargeCorrectness.t.sol) | Asserts `createVolume` and `trigger` move exactly the formula-computed BZZ amount from the payer. † `importVolume` on a thin batch moves exactly the trigger formula; `registerVolume` moves zero. The "no other path spends payer BZZ" half is in the invariant suite. |
| [`PayerBoundedExposure.t.sol`](PayerBoundedExposure.t.sol) | Corner witnesses: revoked account does not drain; retired volume does not drain; after re-designating the payer, the old payer is never touched. |
| [`SurvivalFloor.t.sol`](SurvivalFloor.t.sol) | Drives `PostageStamp.setPrice` at the worst-case `K_max`-per-`ROUND_LENGTH` schedule `PriceOracle` permits and measures observed batch-death blocks. Asserts `T ≥ ⌊f × graceBlocks⌋` with `f` computed in-test from the vendored oracle's `changeRate` / `priceBase` (Taylor expansion of `ln`), plus flat-price and falling-price control cases. |
| [`RevocationAtomicity.t.sol`](RevocationAtomicity.t.sol) | A single `revoke` call disables topups across every volume under the (owner, payer) pair in one cycle; no BZZ moves; no volume retires. |
| [`NonceAndVolumeId.t.sol`](NonceAndVolumeId.t.sol) | `nextNonce` increments monotonically; the value returned from `createVolume` equals `keccak256(abi.encode(address(registry), nonce))`. † Rewritten for ADR-0002: the created batch's ID equals `keccak256(abi.encode(address(registry), nextNonce))`; the returned `volumeId` equals `keccak256(abi.encode(owner, accountNonce))` and differs from the batch ID; the account nonce increments by one per successful `createVolume` / `registerVolume` / `importVolume`, independently per owner; a reverted `importVolume` leaves it unchanged; `getAccount(owner).nonce` predicts the next ID. |
| [`VolumeRegister.t.sol`](VolumeRegister.t.sol) † | §7.1 `registerVolume`. Happy path on an external batch whose owner is not the caller (lost-key case): record fields (`batchId`; `chunkSigner` = batch owner; `depth` from Postage; `createdAt`; `ttlExpiry`; Active; in the active set), returned ID, `VolumeImported` carrying the batch's `normalisedBalance`; no BZZ moves although the batch is below target. Reverts: inactive account → `AccountNotActive`; missing batch and expired batch → `BatchNotLive`. Registering the same batch twice gives two distinct Active IDs. After `OwnerDeleted`, `VolumeExpired` and `DepthChanged`, registering again yields a new ID with a fresh snapshot (the new depth, in the `DepthChanged` case) and the old ID stays Retired. A registry-created batch can be registered by another owner. I11: a stranger registering the batch first does not change the owner's next ID. I12: deleting or retiring the stranger's volume leaves the owner's record untouched. Registration succeeds while Postage is paused. A past `ttlExpiry` is accepted and the volume retires `VolumeExpired` on first trigger. |
| [`VolumeImport.t.sol`](VolumeImport.t.sol) † | §7.1 `importVolume`, I13. Thin batch: `VolumeImported` then `Toppedup` in the same transaction, exact formula charge, batch at target afterwards. Batch already at target: succeeds with no transfer. Revert cases — allowance too low, payer balance too low, Postage paused, past `ttlExpiry` — each assert `ImportTopupFailed` (or Postage's revert, for the pause) and that no record, nonce increment, active-set entry, event or BZZ delta remains. Shared preconditions re-asserted (inactive account, batch not live) so the two entry points cannot drift apart. |

### Invariant tests

| File | Role |
|---|---|
| [`invariants/PayerHandler.sol`](invariants/PayerHandler.sol) | Shared handler. 3 owners × 3 payers × 2 signers + 3 strangers, fixed set. Exposes `designate` / `confirm` / `revoke_` / `createVolume` / `triggerOne` / `triggerBatch` / `roll` / `deleteVolume` / `strangerCalls` to the invariant runner. Maintains per-payer ghost sums `spentByPayer` (observed BZZ outflow) and `allowedByPayer` (formula-attributable charges observed via `Toppedup` and `createVolume` events). |
| [`invariants/NoOtherPathSpendsPayer.t.sol`](invariants/NoOtherPathSpendsPayer.t.sol) | **I8** — `invariant_spentEqualsAllowedPerPayer`: for every payer, `spentByPayer == allowedByPayer` at every step. Any code path moving BZZ without emitting a corresponding `Toppedup` / `createVolume` breaks the equality. |
| [`invariants/TransferOnlyIfGuarded.t.sol`](invariants/TransferOnlyIfGuarded.t.sol) | **I3** — `invariant_payerSpendNeverExceedsFormula`: `spentByPayer ≤ allowedByPayer`. Plus `invariant_volumeViewMatchesAccount`: `getVolume(id).{payer,accountActive}` agrees with `accounts[owner]` for every created volume. |
| [`invariants/RevokedOwnerSpendsZero.t.sol`](invariants/RevokedOwnerSpendsZero.t.sol) | **I9** — `invariant_spentMatchesAllowed`: same equality as I8, scrutinised against the handler's randomised revoke sequence. Combined with the structural fact that `allowedByPayer` only rises on the guarded path, this rules out a revoked owner spending. |
| [`invariants/VolumeIdentity.t.sol`](invariants/VolumeIdentity.t.sol) † | **I14** — `invariant_nonceMatchesSuccessfulCreations`: for every owner, `getAccount(owner).nonce` equals the handler's count of that owner's successful creating calls. `invariant_volumeIdsUnique`: no ID is issued twice. The handler's `confirm` action re-confirms accounts that already have volumes, so a `confirmAuth` that resets the nonce fails the first invariant. |

Handler changes †: `PayerHandler` gains `registerVolume` and
`importVolume` actions, each taking an owner index and a batch index into
a pool that mixes external batches (created through
`_createExternalBatch`-style setup with the handler's signers) with
batches the registry created. It records a per-owner ghost nonce and a
ghost set of issued IDs. `invariant_volumeViewMatchesAccount` is
extended to registered volumes and also checks that `getVolume(id).batchId`
equals the `batchId` recorded when the volume was made.

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
| `FORK_IMPORT_BATCH_ID` † | optional | A real, pre-existing batch to register at the fork block. Unset by default, because the test then depends on that batch still being alive. |

The `forkOnly` modifier skips every test when `FORK_POSTAGE_STAMP` is
unset or has no code at the resolved address — so plain `forge test`
against the hermetic EVM is a silent skip rather than a failure.

Fork-safe subset:

- `test_fork_createVolume_happy`
- `test_fork_trigger_happyTopup`
- `test_fork_trigger_zeroDeficit_noop`
- `test_fork_trigger_idempotence_sameBlock`
- `test_fork_activeSet_pagination_moderate` (N = 30)
- `test_fork_importVolume_happy` †: an external batch created on the fork is imported, rolled forward and triggered.
- `test_fork_registerVolume_liveBatch` †: registers `FORK_IMPORT_BATCH_ID` when set; skipped otherwise.

Parity assertions at `setUp` (run on every fork test):

- Code present at `FORK_POSTAGE_STAMP`.
- Code present at `FORK_MULTICALL3` (canonical address by default).
- `FORK_GRACE_BLOCKS ≥ PostageStamp.minimumValidityBlocks()` on the target chain.
- `PostageStamp.priceOracle()` resolves to a non-zero address.
- † The live `batches()` return tuple matches `IPostageStampLike` (§14). Registration records `owner` and `depth` from a batch the registry did not create, so a layout mismatch would corrupt every registered record.

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
- `createVolume(chunkSigner = address(0))` reverts with `ZeroAddress` but the path is not
  exercised.
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

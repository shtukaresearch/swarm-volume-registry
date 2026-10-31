# Tests

The Forge suite for `VolumeRegistry`. §-references point into [`docs/DESIGN.md`](../../docs/DESIGN.md); when a section changes, the tests in its row of [DESIGN.md ↔ tests](#designmd--tests) change with it.

## Running

```sh
cd contracts
forge test                                # all L1 (unit + invariant)
forge test --no-match-path 'test/fork/*'  # L1 only, skip fork
```

A clean-cache L1 run takes about 5 minutes (compilation plus invariant fuzzing); later runs hit the cache. Fork runs are described in [`fork/README.md`](fork/README.md).

## Files

```
AccountStateMachine.t.sol       designate / confirmAuth / revoke handshake; nonce kept across account changes
ActiveSetAndViews.t.sol         active-set swap-and-pop, pagination, getVolume / getAccount views
ChargeCorrectness.t.sol         createVolume, trigger and importVolume move exactly the formula amount
NonceAndVolumeId.t.sol          batch-ID and volume-ID derivation; per-owner account nonce
PayerBoundedExposure.t.sol      revoked accounts, retired volumes and old payers are never charged
RetirementEdges.t.sol           retired volumes stay retired and inert; defensive owner-mismatch edge
RevocationAtomicity.t.sol       one revoke stops top-ups on every volume of the pair
SurvivalFloor.t.sol             worst-case price path against the graceBlocks survival bound
TriggerSemantics.t.sol          §8 check order, outcomes, skips, batched trigger, reap, shared batches
TriggerPaymentGnosisBzz.t.sol   payment precheck and bzzPermitExpiry against the real Gnosis BZZ bytecode
VolumeImport.t.sol              importVolume: top-up at import, atomic revert cases
VolumeLifecycle.t.sol           createVolume and deleteVolume; constructor floor; owner immutability
VolumeRegister.t.sol            registerVolume: snapshot from Postage, preconditions, re-registration
fixtures/                       shared base fixture and vendored token bytecode (see fixtures/README.md)
invariants/                     fuzzed I3, I8, I9, I14 through one shared handler (see invariants/README.md)
fork/                           parity checks against a live chain (see fork/README.md)
```

## Strategy

Hand-written example tests cover every named transition and precondition; fuzzing is reserved for the invariants whose state space is too large to enumerate (I3, I8, I9, I14). Tests run against the real `storage-incentives` contracts rather than mocks, and against vendored bytecode for Gnosis BZZ. Files follow DESIGN sections, not invariants. Fork tests only check parity with live chains. The reasoning is in [`docs/TEST-STRATEGY.md`](../../docs/TEST-STRATEGY.md).

## DESIGN.md ↔ tests

### By DESIGN section

| Section | Topic | Tests |
|---|---|---|
| §4 | Data model — `Volume`, `Account`, `volumeId` derivation, `nextNonce`, account `nonce` | [`NonceAndVolumeId.t.sol`](NonceAndVolumeId.t.sol); struct fields exercised throughout |
| §5 | Threat model — signer / owner / payer compromise; shared batches | I3 / I8 / I9 coverage below; signer-compromise (`PostageStamp.increaseDepth` direct) in [`TriggerSemantics.test_trigger_depthChanged_retires`](TriggerSemantics.t.sol); shared batches in [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) and [`VolumeRegister.t.sol`](VolumeRegister.t.sol) |
| §6.1 | Volume state machine, five retirement edges | [`RetirementEdges.t.sol`](RetirementEdges.t.sol), [`VolumeLifecycle.test_deleteVolume_*`](VolumeLifecycle.t.sol), [`TriggerSemantics.test_trigger_*_retires`](TriggerSemantics.t.sol) |
| §6.2 | Account state machine, nonce preservation | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.1 | Owner API | [`VolumeLifecycle.t.sol`](VolumeLifecycle.t.sol); `registerVolume` in [`VolumeRegister.t.sol`](VolumeRegister.t.sol); `importVolume` in [`VolumeImport.t.sol`](VolumeImport.t.sol); `designateFundingWallet` in [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.2 | Payer API (`confirmAuth`, `revoke`) | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) |
| §7.3 | Keeper API (`trigger`, batched `trigger`, `reap`); revert only on out-of-gas, paused Postage or a fault | [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) (`test_triggerBatch_*`); Gnosis BZZ payer states in [`TriggerPaymentGnosisBzz.t.sol`](TriggerPaymentGnosisBzz.t.sol) |
| §7.4 | Views | [`ActiveSetAndViews.t.sol`](ActiveSetAndViews.t.sol); `invariant_volumeViewMatchesAccount` in [`invariants/TransferOnlyIfGuarded.t.sol`](invariants/TransferOnlyIfGuarded.t.sol) |
| §8 | Trigger check-order; outcomes; payment precheck | [`TriggerSemantics.t.sol`](TriggerSemantics.t.sol) (ordering tests pin the §8 step sequence); outcome acceptance by `importVolume` in [`VolumeImport.t.sol`](VolumeImport.t.sol); step 8 precheck against Gnosis BZZ in [`TriggerPaymentGnosisBzz.t.sol`](TriggerPaymentGnosisBzz.t.sol) |
| §9 | Events | Asserted via `vm.expectEmit` throughout — no dedicated file |
| §10 | Constructor checks (`graceBlocks ≥ floor`, non-zero `postage`/`bzz`, `expirations` present when `bzzPermitExpiry`) | `graceBlocks` floor: [`VolumeLifecycle.test_createVolume_graceBlocksBelowPostageFloor_constructorReverts`](VolumeLifecycle.t.sol); `bzzPermitExpiry`: [`TriggerPaymentGnosisBzz.test_constructor_*`](TriggerPaymentGnosisBzz.t.sol); zero-address: not covered (see [Coverage gaps](#coverage-gaps)) |
| §10.1 | Survival-floor derivation | [`SurvivalFloor.t.sol`](SurvivalFloor.t.sol) |
| §14 | Postage constraints — `batches()` tuple layout; `topUp` refuses shallow batches | Parity assertion in [`fork/ForkRegistry.t.sol`](fork/ForkRegistry.t.sol); [`VolumeRegister.test_registerVolume_depthAtMinimumBucketDepth_reverts`](VolumeRegister.t.sol) |
| §11 | Keeper interface (permissionless) | Same as §7.3; stranger-as-caller exercised in [`invariants/PayerHandler.sol`](invariants/PayerHandler.sol)'s `strangerCalls` action |

### By invariant

| Invariant (§5) | Example lens | Fuzz lens |
|---|---|---|
| **I1** — Volume ⇒ batch | [`VolumeLifecycle.test_createVolume_happy`](VolumeLifecycle.t.sol) asserts the batch is created with the recorded owner/depth; [`VolumeRegister.t.sol`](VolumeRegister.t.sol) asserts the recorded `batchId`/`chunkSigner`/`depth` are read from Postage; [`RetirementEdges.t.sol`](RetirementEdges.t.sol) covers the contrapositive | — (small witness set; fuzz unnecessary) |
| **I2** — Batch immutability | [`RetirementEdges.test_i2_defensiveBatchOwnerMismatch`](RetirementEdges.t.sol) (vm.store-driven), [`TriggerSemantics.test_trigger_depthChanged_retires`](TriggerSemantics.t.sol); every retire edge re-run on a registered volume | — |
| **I3** — Payer bounded exposure | [`PayerBoundedExposure.t.sol`](PayerBoundedExposure.t.sol) (3 witnesses) | [`invariants/TransferOnlyIfGuarded.invariant_payerSpendNeverExceedsFormula`](invariants/TransferOnlyIfGuarded.t.sol) |
| **I4** — Auth bilaterality | [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) (10 tests covering the full §6.2 state machine) | — |
| **I5** — Trigger idempotence | [`TriggerSemantics.test_trigger_idempotence_sameBlock`](TriggerSemantics.t.sol), `test_trigger_zeroDeficit_noop`; batch-level: two volumes on one batch triggered in one block | — |
| **I6** — Survival | [`SurvivalFloor.t.sol`](SurvivalFloor.t.sol) (worst-case Gnosis, short-grace, flat, falling-price); `importVolume` leaves the batch at target in [`VolumeImport.t.sol`](VolumeImport.t.sol) | — (worst case is analytic, not random) |
| **I7** — Removal finality | [`RetirementEdges.t.sol`](RetirementEdges.t.sol) (5 tests including `test_retired_noTransferFromPayer`); re-registering a batch after retirement yields a new ID and the old one stays Retired, in [`VolumeRegister.t.sol`](VolumeRegister.t.sol) | — |
| **I8** — Charge correctness | [`ChargeCorrectness.t.sol`](ChargeCorrectness.t.sol) (2 formula assertions; plus `importVolume` = trigger formula and `registerVolume` = 0) | [`invariants/NoOtherPathSpendsPayer.invariant_spentEqualsAllowedPerPayer`](invariants/NoOtherPathSpendsPayer.t.sol) |
| **I9** — Revocation atomicity | [`RevocationAtomicity.t.sol`](RevocationAtomicity.t.sol) (1 test, 5-volume pair) | [`invariants/RevokedOwnerSpendsZero.invariant_spentMatchesAllowed`](invariants/RevokedOwnerSpendsZero.t.sol) |
| **I10** — Owner immutability | [`VolumeLifecycle.test_ownerIsImmutable_legacyTransferSelectorReverts`](VolumeLifecycle.t.sol); owner = caller for `registerVolume` / `importVolume` | — (the owner field has no write path after creation) |
| **I11** — No squatting | [`VolumeRegister.t.sol`](VolumeRegister.t.sol): a stranger registering the same batch does not change the owner's next ID | — |
| **I12** — Non-interference | [`VolumeRegister.t.sol`](VolumeRegister.t.sol): deleting or retiring one volume on a shared batch leaves the other's record untouched | — |
| **I13** — Import atomicity | [`VolumeImport.t.sol`](VolumeImport.t.sol): every revert case leaves no record, no nonce consumed, no active-set entry, no BZZ delta (events are discarded with the revert) | — |
| **I14** — Nonce monotonicity | [`NonceAndVolumeId.t.sol`](NonceAndVolumeId.t.sol); preservation across account transitions in [`AccountStateMachine.t.sol`](AccountStateMachine.t.sol) | [`invariants/VolumeIdentity.t.sol`](invariants/VolumeIdentity.t.sol) |

## Coverage gaps

- The constructor's zero-address checks (`postage == 0`, `bzz == 0`) have no witness.
- `createVolume(chunkSigner = address(0))` reverts with `ZeroAddress`, but the path is not exercised.
- The error `DesignationClearedOnActivate` is declared but never thrown. Either the check it was meant to guard was inlined elsewhere or it is dead.
- Some ADR-0007 conditions have no witness: a raised `minimumValidityBlocks` reverting `trigger` with `InsufficientBalance`, a paused Sepolia BZZ, and the fault paths (a failed `transferFrom` after a passed precheck, a failed `approve`), which real tokens cannot reach.
- The invariant handler does not assert that the batched `trigger` never reverts, so "no account state reverts a keeper call" is tested by example only.

End-to-end devnet and testnet harnesses (keeper integration, Safe flows, dashboards) are out of scope here; tests for a specific keeper belong with that keeper.

# Contract test strategy

The reasoning behind the shape of the Forge suite in [`contracts/test/`](../contracts/test/README.md). Four design decisions shape it.

## 1. Example tests by default, fuzz only where the state space is intractable

Every named state transition, retirement edge, and public-function precondition gets a hand-written witness with concrete inputs, exact balance assertions, and `vm.expectEmit` checks. Witnesses are debuggable and fail loudly when intent drifts.

Property-based / invariant testing is layered on top **only** for the invariants whose joint state space — accounts × volumes × call sequence — is too large to enumerate by hand:

- **I3** (payer bounded exposure),
- **I8** (charge correctness),
- **I9** (revocation atomicity),
- **I14** (nonce monotonicity) and volume-ID uniqueness.

The first three reduce to a single fuzzable property: *every BZZ outflow from a payer is accounted for by a `Toppedup` or `createVolume` event the contract emitted on the guarded path*. The shared handler exposes the contract's public surface to Foundry's invariant runner and maintains per-payer ghost sums `spentByPayer` (observed outflow) and `allowedByPayer` (formula-attributable charges from observed events); the three invariant contracts each assert a relation between those sums (strict equality for I8/I9, ≤ for I3). Charges made inside `importVolume` surface as `Toppedup` events, and a reverted import moves nothing, so these sums cover the import path with no new ghost state.

I14 is fuzzed because the hazard it guards — `confirmAuth` resetting the nonce ([ADR-0003](./adr/0003-nonce-in-account.md)) — only shows up under interleavings of account transitions and creating calls, which is exactly what the handler randomises. The handler keeps a per-owner ghost nonce and a ghost set of issued IDs.

Invariants like I1, I2, I5, I6, I7, I11, I12, I13 are *not* fuzzed — they have a small number of concretely-namable witnesses and adding random exploration on top would not improve coverage.

## 2. Real Postage / PriceOracle / TestToken bytecode, not mocks

Several invariants are *joint* properties of `VolumeRegistry` and `PostageStamp`:

- **I1** asserts that an Active volume corresponds to a live Postage batch at the recorded depth — only verifiable if `PostageStamp.batches` reports the real thing.
- **I2** asserts retirement on Postage-side divergence (depth changes, batch death, owner mismatch). Detecting those edges requires Postage's real state machine.
- **I6** depends on `PriceOracle.changeRate[0] / priceBase` (the `K_max` ceiling); the floor factor `f ≈ 0.9567` is *derived in-test* from the live oracle's constants, not hardcoded.

So `storage-incentives` is a real submodule, not a mock surface. The fixture pins `PostageStamp.minimumValidityBlocks` to 12 (matching the Sepolia floor) and grants the test contract `PRICE_ORACLE_ROLE` so `lastPrice` can be set directly, but everything else is the upstream contract.

Gnosis BZZ is the one token not compiled from source. Its `PermittableToken` implementation is solc 0.4.24 and cannot be compiled with the suite, so its deployed runtime bytecode is vendored as [`contracts/test/fixtures/gnosis-bzz-permittable-token.bin`](../contracts/test/fixtures/gnosis-bzz-permittable-token.bin) and etched ([ADR-0007](./adr/0007-keeper-endpoints-revert-only-on-bugs.md)). The test asserts the file's hash in `setUp`.

## 3. One file per DESIGN section, not per invariant

Invariants weave through multiple state transitions; sections of `DESIGN.md` correspond to coherent surfaces (account state machine, volume lifecycle, trigger semantics, ...). A new reader locates a test by where they remember the concept from in the design doc, then sees which invariants that file covers in its `@notice` header. Invariant-axis navigation is provided by the cross-reference table in the test README.

## 4. Fork tests are a parity check, not a correctness re-run

Correctness coverage lives in L1. The fork suite catches a different failure mode: ABI / parameter drift between the pinned `storage-incentives` submodule and the live chain bytecode. It runs a small happy-path subset plus `setUp` parity assertions.

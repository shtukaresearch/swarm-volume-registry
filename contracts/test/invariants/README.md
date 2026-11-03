# Invariant tests

```
PayerHandler.sol                  shared handler: the registry's public surface, randomised, with ghost bookkeeping
PayerHandlerFixture.sol           RegistryFixture plus deployment of the handler
NoOtherPathSpendsPayer.t.sol      I8: per payer, observed spend equals formula-attributable charges
TransferOnlyIfGuarded.t.sol       I3: observed spend never exceeds charges; views agree with accounts
RevokedOwnerSpendsZero.t.sol      I9: the I8 equality under randomised revocations
VolumeIdentity.t.sol              I14: account nonces match successful creations; IDs are unique
```

## Handler

`PayerHandler` holds a fixed set of actors (3 owners, 3 payers, 2 chunk signers, 3 strangers) and exposes `designate`, `confirm`, `revoke_`, `createVolume`, `registerVolume`, `importVolume`, `mintExternalBatch`, `triggerOne`, `triggerBatch`, `roll`, `deleteVolume` and `strangerCalls` to the invariant runner. It keeps per-payer ghost sums `spentByPayer` (observed BZZ outflow) and `allowedByPayer` (charges attributable to observed `Toppedup` and `createVolume` events).

`registerVolume` and `importVolume` draw from a batch pool that mixes external batches (one long-lived batch per signer at construction, plus up to 8 thin ones added by `mintExternalBatch`) with batches the registry created. For I14 the handler records a per-owner ghost nonce (`ghostNonce`), the `batchId` of each issued volume (`batchIdOf`), and a flag set if any ID is issued twice (`duplicateIdIssued`).

## Invariants

- **I8** — `invariant_spentEqualsAllowedPerPayer`: any path that moves BZZ without a matching `Toppedup` or `createVolume` breaks the equality.
- **I3** — `invariant_payerSpendNeverExceedsFormula`: `spentByPayer ≤ allowedByPayer`. Also `invariant_volumeViewMatchesAccount`: `getVolume(id).{payer, accountActive}` agrees with `accounts[owner]`, and `getVolume(id).batchId` is the batch recorded at creation, for every created, registered or imported volume.
- **I9** — `invariant_spentMatchesAllowed`: the I8 equality, under the handler's randomised revoke sequence. Since `allowedByPayer` only rises on the guarded path, a revoked owner cannot spend.
- **I14** — `invariant_nonceMatchesSuccessfulCreations` and `invariant_volumeIdsUnique`. The handler's `confirm` re-confirms accounts that already have volumes, so a `confirmAuth` that reset the nonce would fail the first.

Default config: 256 runs × 500 calls per run, about 20 s per suite.

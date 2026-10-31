# Fixtures

```
RegistryFixture.sol                   abstract base for every L1 test: real Postage stack, registry, actors, helpers
gnosis-bzz-permittable-token.bin      deployed runtime bytecode of the Gnosis BZZ token implementation
```

## RegistryFixture.sol

Deploys a fresh `VolumeRegistry` (`graceBlocks = 15`, `bzzPermitExpiry = false`), `PostageStamp` (`minimumValidityBlocks` coerced to 12), `PriceOracle` and `TestToken`. It grants `PRICE_ORACLE_ROLE` to the test contract and primes `lastPrice` before the registry is constructed. Actors: `OWNER`, `OWNER_B`, `PAYER`, `PAYER2`, `CHUNK_SIGNER`, `STRANGER`.

Helpers:

- Accounts and volumes: `_activateAccount`, `_createDefaultVolume`, `_createVolumeWithTtl`, `_expectedCreateCharge`, `_perChunkCharge`, `_roll`.
- Import: `_createExternalBatch(signer, depth, balancePerChunk)` has an EOA create a batch directly on Postage, with no registry involvement; `_createThinExternalBatch(signer)` does the same at Postage's `minimumInitialBalancePerChunk` (12 blocks of runway, below the 15-block target); `_registerDefault` and `_importDefault` wrap the two import entry points.
- Reads: `_expectedVolumeId(owner, nonce)`, `_batchOf(volumeId)`, `_remaining(batchId)` (per-chunk balance left).
- Postage-side: `_forceBatchOwner(batchId, owner)`, the `vm.store` overwrite behind the I2 owner-mismatch witnesses; `_increaseDepthAsSigner(batchId, signer, fromDepth)`, a top-up plus `increaseDepth` by the batch owner.

## gnosis-bzz-permittable-token.bin

The runtime bytecode returned by `eth_getCode` for `0xf8D1677c8a0c961938bf2f9aDc3F3CFDA759A9d9` on Gnosis Chain at block 49029048: the OmniBridge `PermittableToken` implementation behind the BZZ proxy `0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da` (verified source on Blockscout, solc 0.4.24). 7645 bytes, keccak256 `0x3c42cd875bf3a7c6ef70a1e3ff64377f4e9d35aa8db0695f6724a4f94e1f5c3f`. [`../TriggerPaymentGnosisBzz.t.sol`](../TriggerPaymentGnosisBzz.t.sol) reads it with `vm.readFileBinary` (allowed by `fs_permissions` in `foundry.toml`), asserts the hash and etches it. The etched token starts with empty storage: no owner, no bridge, and a zero `DOMAIN_SEPARATOR`.

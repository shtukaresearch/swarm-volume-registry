# Fork tests

```
ForkRegistry.t.sol      happy-path subset and setUp parity assertions against a live PostageStamp and BZZ
MigrateV1Gnosis.t.sol   migrates a payer's live v1 volumes into a fresh v2 on a Gnosis fork
MigrateV1Sepolia.t.sol  migrates a v1 volume into the deployed v2-rc4 on a Sepolia fork
```

The suite checks for drift between the pinned `storage-incentives` submodule and live bytecode; correctness coverage stays in the L1 suite. It is chain-agnostic and configured through environment variables:

| Var | Required? | Purpose |
|---|---|---|
| `FORK_POSTAGE_STAMP` | yes | Live `PostageStamp` address on the forked chain. |
| `FORK_BZZ` | yes | Live BZZ ERC20 address on the forked chain. |
| `FORK_MULTICALL3` | optional | Defaults to the canonical `0xcA11bde05977b3631167028862bE2a173976CA11`. |
| `FORK_GRACE_BLOCKS` | optional | Registry constructor argument. Defaults to `PostageStamp.minimumValidityBlocks()` on the target chain. |
| `FORK_BZZ_PERMIT_EXPIRY` | optional | Registry constructor argument. `true` for Gnosis BZZ; defaults to `false`. |
| `FORK_IMPORT_BATCH_ID` | optional | A real, pre-existing batch to register at the fork block. Unset by default, because the test then depends on that batch still being alive. |
| `FORK_REQUIRED` | optional | `true` makes setUp fail when `FORK_POSTAGE_STAMP` is unset. Set it in any job that is meant to run the fork suite. |

With `FORK_POSTAGE_STAMP` unset, a plain `forge test` reports every fork test as SKIPPED, never as passed. With it set but no code at the address (usually a forgotten `--fork-url`), setUp fails. The migration tests skip the same way when their chain or `MIGRATE_PAYER` is absent, and fail if `MIGRATE_PAYER` is set on the wrong chain.

```sh
cd contracts
FORK_POSTAGE_STAMP=0x... FORK_BZZ=0x... forge test --fork-url $RPC_URL --match-path test/fork/ForkRegistry.t.sol
```

Current addresses per chain are in [`docs/usage.md`](../../../docs/usage.md) §2.

Tests: `test_fork_createVolume_happy`, `test_fork_trigger_happyTopup`, `test_fork_trigger_zeroDeficit_noop`, `test_fork_trigger_idempotence_sameBlock`, `test_fork_activeSet_pagination_moderate` (N = 30), `test_fork_importVolume_happy` (an external batch created on the fork is imported, rolled forward and triggered) and `test_fork_registerVolume_liveBatch` (registers `FORK_IMPORT_BATCH_ID` when set).

Parity assertions in `setUp`, run before every test:

- code is present at `FORK_POSTAGE_STAMP` and `FORK_MULTICALL3`;
- `FORK_GRACE_BLOCKS ≥ PostageStamp.minimumValidityBlocks()`;
- the live `batches()` return tuple matches `IPostageStampLike` (DESIGN §14): a batch with known fields is created on the fork and its six return words decode to exactly those fields. Registration records `owner` and `depth` from batches the registry did not create, so a layout mismatch would corrupt every registered record.

Gnosis:

```sh
FORK_POSTAGE_STAMP=0x45a1502382541Cd610CC9068e88727426b696293 \
FORK_BZZ=0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da \
FORK_GRACE_BLOCKS=120960 FORK_BZZ_PERMIT_EXPIRY=true \
    forge test --fork-url $GNOSIS_RPC --match-path test/fork/ForkRegistry.t.sol
```

## v1 → v2 migration

Both migration tests follow the same per-volume recipe: the owner and payer complete the v2 handshake and the payer approves v2; the owner calls `v2.importVolume(batchId, ttlExpiry)` (a v1 `volumeId` is the batch ID); the owner then calls `v1.deleteVolume(batchId)`. Importing before deleting leaves no gap in funding, and the overlap is harmless: once v2 has topped a batch up to its longer target, a v1 `trigger` finds no deficit and charges nothing, which the Gnosis test asserts.

`MigrateV1Gnosis.t.sol` takes every active volume on the Gnosis v1 registry (`0x9639ae4c7a8fa9efe585738d516a3915ddd02aad`) whose payer is `MIGRATE_PAYER`, deploys v2 on the fork with `MIGRATE_GRACE_BLOCKS` (default `120960`) and `bzzPermitExpiry = true`, and migrates them using the payer's real BZZ balance, with no `deal`. It logs the charge and gas per import, then checks that one batched v2 `trigger` a day later keeps every volume active. Skipped unless `MIGRATE_PAYER` is set and the fork is chain 100.

```sh
MIGRATE_PAYER=0x... forge test --fork-url $GNOSIS_RPC --match-path test/fork/MigrateV1Gnosis.t.sol -vv
```

`MigrateV1Sepolia.t.sol` runs against the deployed Sepolia v1 (`0x3a99b4b52a4bd75760667219ea93c627051b1af8`) and v2-rc4 (`0xe491308994af391a32191a8c380ca818dad332a4`). Sepolia v1 has no live volumes, so the test creates one, migrates it, revokes the v1 account and zeroes the v1 allowance, then triggers v2 across several grace periods. Skipped unless the fork is chain 11155111.

```sh
forge test --fork-url $SEPOLIA_RPC --match-path test/fork/MigrateV1Sepolia.t.sol -vv
```

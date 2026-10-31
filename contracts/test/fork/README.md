# Fork tests

```
ForkRegistry.t.sol      happy-path subset and setUp parity assertions against a live PostageStamp and BZZ
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

Every test is skipped when `FORK_POSTAGE_STAMP` is unset or has no code, so a plain `forge test` passes over the suite silently.

```sh
cd contracts
FORK_POSTAGE_STAMP=0x... FORK_BZZ=0x... forge test --fork-url $RPC_URL --match-path test/fork/ForkRegistry.t.sol
```

Current addresses per chain are in [`docs/usage.md`](../../../docs/usage.md) §2.

Tests: `test_fork_createVolume_happy`, `test_fork_trigger_happyTopup`, `test_fork_trigger_zeroDeficit_noop`, `test_fork_trigger_idempotence_sameBlock`, `test_fork_activeSet_pagination_moderate` (N = 30), `test_fork_importVolume_happy` (an external batch created on the fork is imported, rolled forward and triggered) and `test_fork_registerVolume_liveBatch` (registers `FORK_IMPORT_BATCH_ID` when set).

Parity assertions in `setUp`, run before every test:

- code is present at `FORK_POSTAGE_STAMP` and `FORK_MULTICALL3`;
- `FORK_GRACE_BLOCKS ≥ PostageStamp.minimumValidityBlocks()`;
- `PostageStamp.priceOracle()` resolves to a non-zero address;
- the live `batches()` return tuple matches `IPostageStampLike` (DESIGN §14): a batch with known fields is created on the fork and its six return words decode to exactly those fields. Registration records `owner` and `depth` from batches the registry did not create, so a layout mismatch would corrupt every registered record.

Limitation: the Gnosis PostageStamp has no `priceOracle()` getter, so `setUp` reverts and the suite currently runs only against Sepolia.

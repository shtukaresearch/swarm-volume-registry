# swarm-volume-registry

A volume-lifecycle layer over Swarm postage-stamp batches. `VolumeRegistry` wraps each batch in a first-class on-chain *volume* with a two-role (owner / payer) ownership model and a permissionless keeper API, so storage runway can be funded by a separately-authorised wallet and kept alive by any caller.

The contract does not custody BZZ, does not sign chunks, has no admin role, and is not upgradeable.

## Deployments

| Chain | `VolumeRegistry` | `graceBlocks` |
|---|---|---|
| Gnosis (chain 100) | `0x9639ae4c7a8fa9efe585738d516a3915ddd02aad` | `17280` (≈ 24 h at 5-second blocks) |
| Sepolia (chain 11155111) | `0x3a99b4b52a4bd75760667219ea93c627051b1af8` | `12` (≈ 2.4 min at 12-second blocks) |

Companion-contract addresses (`PostageStamp`, `BZZ`, `PriceOracle`) and runtime discovery snippets are in [`docs/usage.md`](./docs/usage.md) §2. `graceBlocks` is constructor-immutable; a different runway target requires a fresh deployment.

## Role profiles

Two configurations cover the common integration cases. See [`docs/usage.md`](./docs/usage.md) §4 and §5 for full setup steps and `cast` snippets.

### Profile A — single EOA

Owner, payer, and chunk signer are the same EOA. One transaction costs one signature.

- **When to use:** small or experimental volumes, development setups.
- **Blast radius if the key is compromised:** total.

### Profile B — Safe-funded

Owner is an EOA; payer is a Safe (or any smart-contract wallet capable of `approve` + an arbitrary call). The owner EOA still signs chunks and manages the volume; the Safe holds BZZ.

- **When to use:** any volume worth protecting.
- **Blast radius if the owner key is compromised:** bounded by the Safe's current allowance to the registry. A single `revoke(owner)` call from either side kills topups across every volume under the pair.

Separate chunk-signer addresses (owner ≠ signer) are supported but considered advanced usage; see [`docs/DESIGN.md`](./docs/DESIGN.md) §5.

## Documentation

- [`docs/usage.md`](./docs/usage.md) — integration reference. Role profiles, setup commands, API reference, event catalogue, retirement and revocation semantics, cost estimation, Bee upload guide.
- [`docs/DESIGN.md`](./docs/DESIGN.md) — architecture. Data model, invariants, threat model, trigger semantics, survival-floor derivation, Postage constraints.
- [`contracts/test/README.md`](./contracts/test/README.md) — testing strategy, mapping from `DESIGN.md` sections and invariants to test files, fork-test setup, coverage notes.

## Repository layout

```
contracts/         Foundry project — VolumeRegistry contract and tests
  src/             Contract sources
  test/            Unit, fork, and invariant tests
  script/          Deployment scripts
  lib/             Submodules: forge-std, storage-incentives
docs/             Design and integration documentation
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for build, test, and deploy instructions.

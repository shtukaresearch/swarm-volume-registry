# swarm-volume-registry

A volume lifecycle layer over Swarm storage capacity leases, a.k.a. postage batches.

The `VolumeRegistry` contract creates and wraps postage batches in an on-chain *volume* with a multi-role (owner / payer) ownership model and a permissionless keeper API. Storage runway can be funded by a separately authorised wallet, which may be a smart account, and kept alive by any caller.

* *Ownerless.* The contract has no owner or admin: it cannot be upgraded, nor can any parameters be mutated. 
* *Noncustodial*. It does not custody BZZ. Funds pass through the contract atomically at topup time and cannot remain there.

## Deployments

| Chain | Release | `VolumeRegistry` | `graceBlocks` |
|---|---|---|---|
| Gnosis (chain 100) | `v1` | `0x9639ae4c7a8fa9efe585738d516a3915ddd02aad` | `17280` (≈ 24 h at 5-second blocks) |
| Sepolia (chain 11155111) | `v2-rc4` | `0xe491308994af391a32191a8c380ca818dad332a4` | `300` (≈ 1 h at 12-second blocks) |

Machine-readable deployment records live in [`contracts/deployments/`](./contracts/deployments). Release names and the release procedure are documented in [`RELEASING.md`](./RELEASING.md).

Companion-contract addresses (`PostageStamp`, `BZZ`, `PriceOracle`) and runtime discovery snippets are in [`docs/usage.md`](./docs/usage.md) §2. `graceBlocks` is constructor-immutable; a different runway target requires a fresh deployment.

## Documentation

### For integrators

- [`docs/usage.md`](./docs/usage.md) — deployed-v1 integration reference. Role profiles, setup commands, API reference, event catalogue, retirement and revocation semantics, cost estimation, Bee upload guide.
- [`docs/KEEPERS.md`](./docs/KEEPERS.md) — keeper operations guide.

### For contributors

- [`docs/DESIGN.md`](./docs/DESIGN.md) — v2 architecture. Data model, invariants, threat model, trigger semantics, survival-floor derivation, Postage constraints.
- [`docs/adr/`](./docs/adr/README.md) — decision records for contract changes: the alternatives weighed and consequences accepted behind `DESIGN.md`.
- [`contracts/test/README.md`](./contracts/test/README.md) — test files, mapping from `DESIGN.md` sections and invariants to tests, coverage gaps. The reasoning behind the suite is in [`docs/TEST-STRATEGY.md`](./docs/TEST-STRATEGY.md).
- [`services/indexer/docs/`](./services/indexer/docs/README.md) — the `ethswarm-volumes` indexer and CLI: architecture, artifact schema, versioning, decision records.
- [`RELEASING.md`](./RELEASING.md) — deploying a contract release and releasing the indexer package.

## Repository layout

```
contracts/         Foundry project — VolumeRegistry contract and tests
  src/             Contract sources
  test/            Unit, fork, and invariant tests
  script/          Deployment, export and verification scripts
  deployments/     Deployment records, one per network and release
  lib/             Submodules: forge-std, storage-incentives
services/          Off-chain services, each a standalone project
  keeper/          Cloudflare Worker keeper (pnpm, Node 24)
  indexer/         ethswarm-volumes — indexer and CLI for VolumeRegistry deployments (Python)
docs/              Design and integration documentation
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for build, test, and deploy instructions.

## Roles

Two configurations cover the common integration cases. See [`docs/usage.md`](./docs/usage.md) §4 and §5 for full setup steps and `cast` snippets.

### Profile A — single EOA

Owner, payer, and chunk signer are the same EOA. One transaction costs one signature.

- **When to use:** small or experimental volumes, development setups.
- **Blast radius if the key is compromised:** total.

### Profile B — Safe-funded

Owner is an EOA; payer is a Safe (or any smart-contract wallet capable of `approve` + an arbitrary call). The owner EOA still signs chunks and manages the volume; the Safe holds BZZ.

- **When to use:** any volume worth protecting.
- **Blast radius if the owner/chunk-signer key is compromised:** the volume itself (via a call to PostageStamp.increaseDepth), or payer funds bounded by the Safe's current allowance to the registry. A single `revoke(owner)` call from either side kills topups across every volume under the pair. 

Separate chunk-signer addresses (owner ≠ signer) are supported but considered advanced usage; see [`docs/DESIGN.md`](./docs/DESIGN.md) §5.

## Contributors

The `VolumeRegistry` contract and the L1 / L2 test suite were originally implemented by [@talentlessguy](https://github.com/talentlessguy). See the [contributors graph](https://github.com/shtukaresearch/swarm-volume-registry/graphs/contributors) for everyone who has pushed to this repo.

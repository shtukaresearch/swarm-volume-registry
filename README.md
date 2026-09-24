# swarm-volume-registry

A volume-lifecycle layer over Swarm postage-stamp batches. `VolumeRegistry` wraps each batch in a first-class on-chain *volume* with a two-role (owner / payer) ownership model and a permissionless keeper API, so storage runway can be funded by a separately-authorised wallet and kept alive by any caller.

The contract does not custody BZZ, does not sign chunks, has no admin role, and is not upgradeable.

## Deployments

v2 — which removes unilateral volume ownership transfer — is deployed on Sepolia only, as
release candidate `v2-rc1`. Gnosis is still the early-alpha v1 contract; a v2 Gnosis
address will be added after deployment, and until then [`docs/usage.md`](./docs/usage.md)
documents the deployed v1 ABI and its mitigations.

| Chain | Release | `VolumeRegistry` | `graceBlocks` |
|---|---|---|---|
| Gnosis (chain 100) | `v1` | `0x9639ae4c7a8fa9efe585738d516a3915ddd02aad` | `17280` (≈ 24 h at 5-second blocks) |
| Sepolia (chain 11155111) | `v2-rc1` | `0x33a53c79a08ed1f863905cd4c6ce036a4c493729` | `12` (≈ 2.4 min at 12-second blocks) |

Releases are named `vN` on mainnet and `vN-rcM` for testnet release candidates; each name is
a git tag. Machine-readable records live in
[`contracts/deployments/`](./contracts/deployments), one `VolumeRegistry-<release>.json` per
deployment plus a `VolumeRegistry.json` copy of the network's current one. See
[`RELEASING.md`](./RELEASING.md).

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

- [`docs/usage.md`](./docs/usage.md) — deployed-v1 integration reference. Role profiles, setup commands, API reference, event catalogue, retirement and revocation semantics, cost estimation, Bee upload guide.
- [`docs/DESIGN.md`](./docs/DESIGN.md) — v2 architecture. Data model, invariants, threat model, trigger semantics, survival-floor derivation, Postage constraints.
- [`contracts/test/README.md`](./contracts/test/README.md) — testing strategy, mapping from `DESIGN.md` sections and invariants to test files, fork-test setup, coverage notes.
- [`docs/KEEPERS.md`](./docs/KEEPERS.md) — keeper operations guide.
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
  keeper/          Cloudflare Worker keeper (Bun)
  indexer/         ethswarm-volumes — indexer and CLI for VolumeRegistry deployments (Python)
docs/              Design and integration documentation
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for build, test, and deploy instructions.

## Contributors

The `VolumeRegistry` contract and the L1 / L2 test suite were originally implemented by [@talentlessguy](https://github.com/talentlessguy). See the [contributors graph](https://github.com/shtukaresearch/swarm-volume-registry/graphs/contributors) for everyone who has pushed to this repo.

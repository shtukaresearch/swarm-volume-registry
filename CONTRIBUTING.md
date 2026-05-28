# Contributing

## Prerequisites

- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`, `anvil`).
- Git submodules initialised:
  ```sh
  git submodule update --init --recursive
  ```

## Build & test

From `contracts/`:

```sh
forge build
forge test
```

Fork tests against live Sepolia (skipped without the env var):

```sh
FOUNDRY_FORK_URL=$SEPOLIA_RPC forge test \
    --match-path test/fork/ForkRegistry.t.sol
```

Format check (also enforced in CI):

```sh
forge fmt --check
```

## Deploy

`DeployVolumeRegistry.s.sol` reads every parameter from the environment — nothing is hardcoded, because `PostageStamp` is expected to be redeployed across chains and versions and this repo must track each new deployment without a code change.

```sh
POSTAGE_STAMP=0x... \
BZZ=0x... \
GRACE_BLOCKS=17280 \
PRIVATE_KEY=0x... \
forge script script/DeployVolumeRegistry.s.sol \
    --rpc-url $RPC_URL --broadcast
```

`GRACE_BLOCKS` must be ≥ `PostageStamp.minimumValidityBlocks()` on the target chain or the constructor reverts. See [`docs/DESIGN.md`](./docs/DESIGN.md) §10 for semantics and §10.1 for the survival bound the value implies.

## Dependencies

- [`forge-std`](https://github.com/foundry-rs/forge-std) — Foundry stdlib.
- [`ethersphere/storage-incentives`](https://github.com/ethersphere/storage-incentives), pinned to the tag of the live `PostageStamp` deployment (currently `v0.9.4`). Tests import `PostageStamp`, `PriceOracle`, and `TestToken` from this submodule so the suite runs against real bytecode rather than mocks.
- [`OpenZeppelin/openzeppelin-contracts`](https://github.com/OpenZeppelin/openzeppelin-contracts), pinned to `v4.8.2`. `VolumeRegistry` itself does not depend on OpenZeppelin, but `storage-incentives` is a Hardhat project that imports `@openzeppelin/contracts/...` and resolves it from `node_modules/` at its own build time. When `forge` compiles those same sources here, it has no npm awareness, so the dependency must be supplied as a submodule with a matching remapping in `remappings.txt`. The pin tracks `storage-incentives@v0.9.4`'s `package.json`; bump it together with `storage-incentives` whenever a new PostageStamp deployment lands.

# Contributing

## Prerequisites

- [Foundry](https://book.getfoundry.sh/) v1.7.1 (`forge`, `cast`, `anvil`).
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

Fork tests against a live chain. Configured via env vars; silently
skipped when `FORK_POSTAGE_STAMP` is unset or has no code at the
configured address.

```sh
FORK_POSTAGE_STAMP=0x... FORK_BZZ=0x... \
    forge test --fork-url $RPC_URL \
    --match-path test/fork/ForkRegistry.t.sol
```

See [`contracts/test/README.md`](./contracts/test/README.md#fork-tests)
for the full env-var list (`FORK_MULTICALL3`, `FORK_GRACE_BLOCKS`) and
[`docs/usage.md`](./docs/usage.md) §2 for current addresses per chain.

See [`contracts/test/README.md`](./contracts/test/README.md) for the
testing strategy, how each section of `DESIGN.md` maps to test files,
and the file-level breakdown of the example, invariant, and fork
suites.

Format check (also enforced in CI):

```sh
forge fmt --check
```

## Deploy

Select a named constructor-input profile from
[`contracts/deployments.toml`](./contracts/deployments.toml). Profiles are independent
of chain IDs, so the file can hold multiple relevant `PostageStamp` deployments on the
same chain. The launcher verifies that the selected profile's chain ID matches the RPC.

```sh
python3 script/deploy.py sepolia-postage-v0.9.4 \
    --rpc-url "$RPC_URL" \
    --account swarm-volume-registry-deployer \
    --broadcast
```

The account must already exist in Foundry's encrypted keystore. Foundry 1.7.1 or newer
automatically uses the single named account as the script sender; the launcher rejects
older versions that require a duplicate `--sender` argument.

The configured `grace_blocks` must be at least
`PostageStamp.minimumValidityBlocks()` on the target chain or the constructor reverts.
See [`docs/DESIGN.md`](./docs/DESIGN.md) §10 for semantics and §10.1 for the survival
bound the value implies.

Exporting the deployment record, explorer verification, tagging and the indexer release
steps are in [`RELEASING.md`](./RELEASING.md).

## Dependencies

- [`forge-std`](https://github.com/foundry-rs/forge-std) — Foundry stdlib.
- [`ethersphere/storage-incentives`](https://github.com/ethersphere/storage-incentives), pinned to the tag of the live `PostageStamp` deployment (currently `v0.9.4`). Tests import `PostageStamp`, `PriceOracle`, and `TestToken` from this submodule so the suite runs against real bytecode rather than mocks.
- [`OpenZeppelin/openzeppelin-contracts`](https://github.com/OpenZeppelin/openzeppelin-contracts), pinned to `v4.8.2`. `VolumeRegistry` itself does not depend on OpenZeppelin, but `storage-incentives` is a Hardhat project that imports `@openzeppelin/contracts/...` and resolves it from `node_modules/` at its own build time. When `forge` compiles those same sources here, it has no npm awareness, so the dependency must be supplied as a submodule with a matching remapping in `remappings.txt`. The pin tracks `storage-incentives@v0.9.4`'s `package.json`; bump it together with `storage-incentives` whenever a new PostageStamp deployment lands.

## Keeper

[`services/keeper`](./services/keeper) is the keeper: one Cloudflare Worker,
deployed as `keeper-sepolia` and `keeper-gnosis`. A standalone Bun project with
its own lockfile; nothing else in the repository depends on it.

```sh
cd services/keeper
bun install
bun test
bun run typecheck
bun run check:deploy   # wrangler deploy --dry-run, both envs
```

None of this needs chain access or Cloudflare credentials. CI runs the same
steps (`.github/workflows/keeper-ci.yml`); deploys go through
`.github/workflows/keeper-deploy.yml`. Setup, configuration and local runs are
in its [README](./services/keeper/README.md).

## Indexer

[`services/indexer`](./services/indexer) is `ethswarm-volumes`: the indexer and CLI
that turn `VolumeRegistry` events into a published artifact of fee volume, capacity and
account measures. A standalone Python project managed with
[uv](https://docs.astral.sh/uv/); nothing else in the repository depends on it. Its
integration tests need `anvil` (Foundry) on `PATH`.

```sh
cd services/indexer
uv run --group dev python -m pytest
uvx ruff check . && uvx ruff format --check .
```

The suite deploys pinned per-release contract fixtures, not contracts `HEAD`, so contract
changes never break it. CI runs the same steps (`.github/workflows/indexer-ci.yml`);
publishing to PyPI goes through `.github/workflows/publish-python.yml`. Design and
decision records are in its [docs](./services/indexer/docs/README.md); releasing is in
[`RELEASING.md`](./RELEASING.md).

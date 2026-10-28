# Contracts

This directory is the Foundry project for `VolumeRegistry`.

## Deploying

Deployments use an explicitly selected constructor-input profile from
[`deployments.toml`](./deployments.toml). Each profile specifies the target chain ID,
`PostageStamp` and BZZ addresses, and `grace_blocks`. The launcher checks that the RPC
chain ID matches the selected profile before running the Foundry script.

Prerequisites:

- Python 3.11 or newer.
- Foundry 1.7.1 or newer.
- An RPC URL for the target chain.
- For a broadcast, a funded account in Foundry's encrypted keystore.

Import a deployment account if necessary:

```sh
cast wallet import volume-registry-deployer
```

From this directory, simulate a deployment without sending a transaction:

```sh
python3 script/deploy.py sepolia-postage-v0.9.4-1h --version v2-rc3 \
    --rpc-url "$RPC_URL"
```

To deploy, select the named keystore account and add `--broadcast`:

```sh
python3 script/deploy.py sepolia-postage-v0.9.4-1h --version v2-rc3 \
    --rpc-url "$RPC_URL" \
    --account volume-registry-deployer \
    --broadcast
```

Foundry prompts for the account password; with `--password-prompt` it is asked for in
a desktop dialog (`zenity`, Linux) and handed to Foundry through an in-memory file
descriptor instead. The launcher passes the selected profile's
constructor arguments and the CREATE2 salt to `script/DeployVolumeRegistry.s.sol` and lets
Foundry derive the sender from the named account.

`--version` names the release (`vN` or `vN-rcM`). The registry is deployed with CREATE2
through the deterministic deployment proxy `0x4e59b44847b379578588920ca78fbf26c0b4956c`,
with the release name, left-aligned and zero-padded to `bytes32`, as the salt, so its
address depends only on the source, the profile and the release name.

## Deployment artifacts

Foundry writes execution records beneath:

```text
broadcast/DeployVolumeRegistry.s.sol/<chain-id>/
```

A broadcast creates a timestamped `run-<timestamp>.json` and updates
`run-latest.json`. These production broadcast records are intended to be committed as
the audit trail, but they are not the stable discovery interface.

After a successful broadcast, export the deployment record:

```sh
python3 script/export_deployment.py sepolia-postage-v0.9.4-1h --version v2-rc3 [--latest]
```

The exporter validates the chain, constructor arguments, successful receipt and
deployed address before combining the broadcast with the compiled ABI. It writes a
record following the hardhat-deploy v1 layout beneath:

```text
deployments/<network>/.chainId
deployments/<network>/VolumeRegistry-<release>.json   one immutable record per release
deployments/<network>/VolumeRegistry.json             copy of the current one (--latest)
```

Commit the deployment record together with its production broadcast files. See
[`RELEASING.md`](../RELEASING.md) for the complete release procedure.

Simulations write the equivalent files beneath:

```text
broadcast/DeployVolumeRegistry.s.sol/<chain-id>/dry-run/
```

Foundry also writes matching execution caches beneath
`cache/DeployVolumeRegistry.s.sol/<chain-id>/`. Dry-run records and all cache files are
ignored by Git.

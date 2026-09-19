# Releasing

This procedure publishes a `VolumeRegistry` contract deployment. Run commands in this
document from `contracts/` unless stated otherwise.

## Prerequisites

- Python 3.11 or newer.
- Foundry 1.7.1 or newer.
- An RPC URL for the target chain.
- A funded deployment account in Foundry's encrypted keystore.
- An Etherscan API key when releasing to Sepolia. Gnosis Blockscout's instance API
  does not require a key.
- Initialised Git submodules and a clean release worktree.

Import the deployment account once if necessary:

```sh
cast wallet import volume-registry-deployer
```

## Prepare

Choose and review the constructor-input profile in `deployments.toml`. A profile name
identifies a particular PostageStamp configuration; its chain ID is also enforced
against the RPC and exported deployment record.

Build and test the release commit:

```sh
forge fmt --check
forge build --sizes
python3 -m unittest discover -s script/tests -v
forge test -vvv
```

Simulate the deployment before broadcasting it:

```sh
python3 script/deploy.py sepolia-postage-v0.9.4 \
    --rpc-url "$RPC_URL"
```

Review the simulation output, including the constructor arguments and predicted
contract address. A simulation is written below the broadcast directory's `dry-run/`
subdirectory and is not committed.

## Broadcast

Broadcast using the named keystore account:

```sh
python3 script/deploy.py sepolia-postage-v0.9.4 \
    --rpc-url "$RPC_URL" \
    --account volume-registry-deployer \
    --broadcast
```

Foundry prompts for the account password. Once the transaction is confirmed, it writes
a timestamped execution record and updates:

```text
broadcast/DeployVolumeRegistry.s.sol/<chain-id>/run-latest.json
```

Retain this broadcast output. Forge uses it as an execution journal, and it provides
the detailed audit trail for the deployment.

## Export the discovery record

The committed discovery format follows the widely used hardhat-deploy v1 layout: each
network has a decimal `.chainId` file and one JSON file per named contract. Generate
it from the successful broadcast and compiled Foundry artifact:

```sh
python3 script/export_deployment.py sepolia-postage-v0.9.4
```

This writes:

```text
deployments/sepolia/.chainId
deployments/sepolia/VolumeRegistry.json
```

The contract record contains the address and ABI required for discovery, plus its
transaction hash, receipt, constructor arguments and source-broadcast metadata. The
exporter refuses to write a record when:

- the broadcast chain differs from the selected profile;
- the constructor arguments differ from the profile;
- the compiled creation bytecode differs from the deployment transaction;
- there is not exactly one matching contract creation;
- the receipt failed or its deployed address does not match; or
- the network directory already belongs to another chain ID.

Use a stable network name. By default, applications discover the currently supported
deployment from `VolumeRegistry.json`. If applications also need to discover an older
or alternative deployment on the same network, export that deployment under a distinct
filename with `--deployment-name`, for example
`--deployment-name VolumeRegistry-v2-postage-v0.9.4`.

## Verify the source on the block explorer

Verification recompiles the contract and asks the explorer to match that output to the
deployed bytecode. Run it from the same release commit, with the same `foundry.toml`
settings used for deployment.

`script/verify_deployment.py` reads the chain, constructor arguments, verifier and
explorer URL from the selected profile. It reads the deployed address from
`deployments/<network>/VolumeRegistry.json`, checks that the record matches the
profile, ABI-encodes the constructor arguments and waits for the explorer's final
result.

### Sepolia: Etherscan

Set the Sepolia RPC URL and Etherscan API key without committing either value, then run:

```sh
export RPC_URL="https://<your-sepolia-rpc>"
export ETHERSCAN_API_KEY="<your-etherscan-api-key>"
python3 script/verify_deployment.py sepolia-postage-v0.9.4
```

Confirm that Etherscan's **Contract → Code** tab shows the verified source at:

```text
https://sepolia.etherscan.io/address/<VolumeRegistry-address>#code
```

### Gnosis: Blockscout

Set a Gnosis RPC URL and run the Gnosis profile. The Blockscout instance API does not
require an API key:

```sh
export RPC_URL="https://rpc.gnosischain.com"
python3 script/verify_deployment.py gnosis-postage-v0.9.4
```

Confirm that the Gnosis Blockscout contract page shows the verified source at:

```text
https://gnosis.blockscout.com/address/<VolumeRegistry-address>
```

The script is safe to rerun if submission or polling is interrupted. Do not mark the
release complete until it reports success and the source is visible on the intended
explorer URL it prints.

## Review and commit

Inspect all publication artifacts:

```sh
git diff -- \
    broadcast/DeployVolumeRegistry.s.sol \
    deployments
```

Verify the exported address and transaction hash against an independent RPC endpoint,
and confirm the explorer source verification above. Then commit the timestamped
broadcast, `run-latest.json`, `.chainId` and contract deployment JSON together.

Do not copy a Forge `run-latest.json` into `deployments/`. The broadcast is an
execution journal; the deployment record is the stable discovery interface generated
from that journal and the compiled ABI.

# Releasing

Operational runbook. The concepts — what a release name *is*, the two version axes, why
nothing here can break an existing indexer install — live in
[`services/indexer/docs/VERSIONING.md`](services/indexer/docs/VERSIONING.md) and ADRs
[0010](services/indexer/docs/adr/0010-extensional-contract-versions.md) and
[0012](services/indexer/docs/adr/0012-release-names-and-latest-pointers.md); this file is
the commands.

There are two tracks:

- A **contract release** deploys a `VolumeRegistry` (Part A) and, when the indexer should
  follow it, teaches the `ethswarm-volumes` package about it (Part B). Part B may follow
  Part A in the same PR or much later: until it ships, installed indexers simply do not
  see the new deployment.
- A **package-only release** ships indexer/client changes with no new contract (step B5
  alone).

## Release names

Every deployment carries a release name, used verbatim as the git tag, the
`registry_version`, the deployment-record filename and the test-fixture directory:

- **`vN-rcM`** — a testnet release candidate. Each testnet deployment gets the next `rc`
  of the upcoming release, so several can land between mainnet releases.
- **`vN`** — a mainnet release. It gets its own name even when its source is identical to
  the last release candidate.

A network holds at most one deployment per name; a redeploy is a new name. Deploying the
same release to another network reuses the name (no new tag).

A deployment is labelled `<network>-<name>` (`gnosis-v1`, `sepolia-v2-rc1`). The bare
network name is a **latest pointer**, moved only by an explicit step below (A4 on the
contracts side, B4 in the package).

## Part A — Deploy a contract release

Run commands in this part from `contracts/` unless stated otherwise.

### Prerequisites

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

### A1. Prepare

Choose the release name (above) and review the constructor-input profile in
`deployments.toml`. A profile name identifies a particular PostageStamp configuration; its
chain ID is also enforced against the RPC and exported deployment record.

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

### A2. Broadcast

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

### A3. Export the deployment record

The committed discovery format follows the widely used hardhat-deploy v1 layout: each
network has a decimal `.chainId` file and one JSON file per named deployment. Generate the
record from the successful broadcast and compiled Foundry artifact, naming the release:

```sh
python3 script/export_deployment.py sepolia-postage-v0.9.4 --version v2-rc2
```

This writes:

```text
deployments/sepolia/.chainId
deployments/sepolia/VolumeRegistry-v2-rc2.json
```

The versioned record is immutable: it contains the address and ABI required for
discovery, plus its transaction hash, receipt, constructor arguments, release name and
source-broadcast metadata. The exporter refuses to write a record when:

- the release name is not `vN` or `vN-rcM`;
- the network already records a different deployment under that name;
- the broadcast chain differs from the selected profile;
- the constructor arguments differ from the profile;
- the compiled creation bytecode differs from the deployment transaction;
- there is not exactly one matching contract creation;
- the receipt failed or its deployed address does not match; or
- the network directory already belongs to another chain ID.

### A4. Promote (optional): move the network's latest pointer

`deployments/<network>/VolumeRegistry.json` is the network's latest pointer: a
byte-identical copy of one versioned record, which tools that expect the plain
hardhat-deploy filename read. It moves only on request. Promote the new deployment by
re-running the export with `--latest`:

```sh
python3 script/export_deployment.py sepolia-postage-v0.9.4 --version v2-rc2 --latest
```

To point it back at an earlier deployment, copy that record over it
(`cp deployments/sepolia/VolumeRegistry-v2-rc1.json deployments/sepolia/VolumeRegistry.json`).
The script tests check every committed pointer is a copy of one versioned record.

### A5. Verify the source on the block explorer

Verification recompiles the contract and asks the explorer to match that output to the
deployed bytecode. Run it from the same release commit, with the same `foundry.toml`
settings used for deployment.

`script/verify_deployment.py` reads the chain, constructor arguments, verifier and
explorer URL from the selected profile. It reads the deployed address from
`deployments/<network>/VolumeRegistry-<version>.json`, checks that the record matches the
profile and release name, ABI-encodes the constructor arguments and waits for the
explorer's final result.

#### Sepolia: Etherscan

Set the Sepolia RPC URL and Etherscan API key without committing either value, then run:

```sh
export RPC_URL="https://<your-sepolia-rpc>"
export ETHERSCAN_API_KEY="<your-etherscan-api-key>"
python3 script/verify_deployment.py sepolia-postage-v0.9.4 --version v2-rc2
```

Confirm that Etherscan's **Contract → Code** tab shows the verified source at:

```text
https://sepolia.etherscan.io/address/<VolumeRegistry-address>#code
```

#### Gnosis: Blockscout

Set a Gnosis RPC URL and run the Gnosis profile. The Blockscout instance API does not
require an API key:

```sh
export RPC_URL="https://rpc.gnosischain.com"
python3 script/verify_deployment.py gnosis-postage-v0.9.4 --version v2
```

Confirm that the Gnosis Blockscout contract page shows the verified source at:

```text
https://gnosis.blockscout.com/address/<VolumeRegistry-address>
```

The script is safe to rerun if submission or polling is interrupted. Do not mark the
release complete until it reports success and the source is visible on the intended
explorer URL it prints.

### A6. Review, commit, tag

Inspect all publication artifacts:

```sh
git diff -- \
    broadcast/DeployVolumeRegistry.s.sol \
    deployments
```

Verify the exported address and transaction hash against an independent RPC endpoint,
and confirm the explorer source verification above. Then commit the timestamped
broadcast, `run-latest.json`, `.chainId`, the versioned record and (if promoted) the
latest pointer together.

Do not copy a Forge `run-latest.json` into `deployments/`. The broadcast is an
execution journal; the deployment record is the stable discovery interface generated
from that journal and the compiled ABI.

Once that commit is on `main`, tag it with the release name and push the tag — the tag
goes after the record commit, so the tag's tree contains its own deployment record:

```sh
git tag v2-rc2 <record-commit> && git push origin v2-rc2
```

A later deployment of the same release to another network (A1–A6 again) adds its record
under the existing name; it is not re-tagged.

Also update the human-facing address tables: [`README.md`](README.md#deployments) and
[`docs/usage.md`](docs/usage.md) §2.

## Part B — Add the release to `ethswarm-volumes`

Run commands in this part from the repository root. Nothing in Part B changes what is
deployed; it is the package's acknowledgement that it can index the release
([ADR-0011](services/indexer/docs/adr/0011-derived-deployment-registry.md)).

### B1. Vendor the pinned test fixture

No build is needed: the fixture comes from the deployment records committed in Part A.

```sh
python3 services/indexer/scripts/vendor_fixtures.py release v2-rc2
```

This writes `services/indexer/tests/fixtures/v2-rc2/VolumeRegistry.json` with the record's
ABI and the creation bytecode of the recorded CREATE transaction (its initcode from the
broadcast, minus the constructor arguments, which are checked against the record's
`args`), so the fixture is the deployed code by construction. It reads every network's
`VolumeRegistry-v2-rc2.json` and fails if they disagree. `provenance.json` names the
records, transactions and git tag. Commit the fixture directory; `test_fixtures.py`
re-derives it from the records on every test run.

The test-support contracts the harness deploys around the registry (`PostageStamp`,
`PriceOracle`, `TestToken`) are shared across versions in `tests/fixtures/support/`. Only
when the `storage-incentives` submodule pin moves, refresh them after `forge build` with
`vendor_fixtures.py support`.

### B2. Add the decode reference data

In `services/indexer/src/ethswarm_volumes/decode.py`, add the `_VERSIONS["v2-rc2"]` entry:

- events ABI + enum tables for the new surface, **or**
- a one-line alias of the predecessor's entry if the indexer-visible surface is unchanged
  (e.g. a gas-only release, or a mainnet `vN` identical to its last release candidate).

`test_decoder.py::test_pinned_abis_match_version_fixture` fails until this and the
fixture from B1 agree verbatim.

### B3. Handle changed semantics (only if they changed)

B2 teaches the package to *decode* the release; this step checks it still *means* the same.
Diff the contract source against the previous release tag
(`git diff <previous-tag> <tag> -- contracts/src`) and ask whether anything the indexer
relies on changed: what an event signifies, how fees flow to Postage, what adds a volume
to or removes it from the active set, how accounts are authorized or revoked, or the
wiring getters (`postage`, `bzz`, `graceBlocks`, `priceOracle`). A pure removal can need
nothing — v2-rc1 dropped ownership transfer, and without transfer events every volume
simply stays with its creator.

If something changed, update the tests and the implementation together:

- **Tests.** Run the suite first: the `chain` fixture runs every existing scenario against
  the new fixture and checks the projection against state read back from the node, so a
  changed fee flow, capacity rule or authorization rule already fails there. For
  behaviour the existing scenarios don't reach, add scenarios, and give the release its
  own `Chain` driver variant in `services/indexer/tests/harness.py` if its calls or
  signatures changed (see
  [`services/indexer/docs/TESTING.md`](services/indexer/docs/TESTING.md) §2a).
- **Implementation.** Make the projection version-aware where the meaning changed:
  `project.py` (the fold from `event_log` to the three measures; a single projector
  serves every version today, so the first semantic change introduces dispatch on
  `registry_version`) and `node.resolve_extra` (the wiring reads and the version-specific
  `extra`, documented in
  [`services/indexer/docs/SCHEMA.md`](services/indexer/docs/SCHEMA.md) §3).
- **Artifact.** The three measures and the artifact kernel stay stable across contract
  versions ([ADR-0001](services/indexer/docs/adr/0001-three-measures.md)); new
  version-specific facts go in `extra` or an additive section (a `schema_version` minor
  bump). A change the kernel cannot absorb is a `schema_version` major bump — see
  [`services/indexer/docs/VERSIONING.md`](services/indexer/docs/VERSIONING.md).

### B4. Register the deployments and latest pointers

Derive the package's registry from the committed deployment records — nothing is
hand-transcribed:

```sh
uv run --project services/indexer services/indexer/scripts/derive_deployments.py
```

This adds an entry for every versioned record whose release is in `_VERSIONS` and not
yet registered, and sets the package's `latest` pointer for each network whose
`VolumeRegistry.json` names a registered deployment. Records of unsupported releases are
reported and left alone, and so is the pointer that names one. Pass
`--exclude NETWORK-VERSION` to keep a recorded deployment out of the fleet. Review the
diff to `services/indexer/src/ethswarm_volumes/deployments.json` and commit.

### B5. Release the package

- Bump `version` in `services/indexer/pyproject.toml`.
- PR to `main`. `indexer-ci` runs on the PR; on merge, the publish workflow
  ([`.github/workflows/publish-python.yml`](.github/workflows/publish-python.yml)) reruns
  it and uploads to PyPI via trusted publishing. Uploads are idempotent
  (`skip-existing`), so only the version-raising merge publishes.

## Package-only release

Step B5 alone: bump `version` in `services/indexer/pyproject.toml`, PR to `main`, merge.

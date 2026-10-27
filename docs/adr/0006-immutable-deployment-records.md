# ADR-0006: Deployment records carry the deployed bytecode, cite an immutable run file, and never change once committed

Status: Accepted

## Context

`contracts/script/export_deployment.py` turns a Forge broadcast into a deployment record, `contracts/deployments/<network>/VolumeRegistry-<version>.json`. The record held the address, ABI, transaction hash, receipt, constructor arguments, and `linkedData`, including the path of the broadcast it was exported from. It did not hold the deployed bytecode, so a consumer that needed to redeploy the release had to recover the bytecode from the cited broadcast. The indexer's test suite did that.

The exporter took `run-latest.json` as its input and tried to cite its timestamped copy as `run-{timestamp}.json`, where `timestamp` is the field inside the broadcast. Forge names the timestamped file after the run's start, but sets `timestamp` at the run's end. The names agreed for v2-rc1 only. The v2-rc2 and v2-rc3 records therefore cited `run-latest.json`, which the next broadcast overwrites. When v2-rc3 was broadcast, the v2-rc2 record stopped pointing at its own deployment, and the indexer suite, which read the cited broadcast to recover rc2's bytecode, failed on `main` from 3959963.

Two problems lay behind this failure:

- The exporter's input was a file that the next broadcast overwrites, so the exporter had to infer which immutable file was the same run.
- Nothing checked the property the records are meant to have: once committed, a record, and the run file it cites, never change.

## Decision

1. The record carries the deployed creation bytecode as `bytecode` (hardhat-deploy's field name): the deployment's initcode without its ABI-encoded constructor arguments. The exporter requires the initcode to equal the compiled artifact's bytecode followed by `abi.encode` of the profile's constructor arguments, exactly. With this, the record is complete, and a consumer has no need to read the broadcast.
2. A record cites an immutable run file. Without `--broadcast`, the exporter reads `run-latest.json` and exports the one sibling `run-*.json` whose bytes are identical; it fails if there is none, or more than one. Forge writes both files in the same step, so exactly one sibling should match. A path given with `--broadcast` is used as given. In no case does a record cite `run-latest.json`.
3. Committed deployment facts never change, and CI tests that directly. The `Immutable deployment facts` job fails a change that modifies, deletes or changes the type of a committed file under `contracts/broadcast/` (except `run-latest.json`) or `contracts/deployments/*/*-v*.json`. Adding files is allowed. Each network's latest pointer, `VolumeRegistry.json`, is excluded because promotion moves it (indexer [ADR-0012](../../services/indexer/docs/adr/0012-release-names-and-latest-pointers.md)). A script test checks that every versioned record cites a run file, never `run-latest.json`, that holds exactly one deployment with the record's `transactionHash`, and that the record carries `bytecode`.
4. Broadcast files continue to be committed, although no consumer needs them once the record carries the bytecode. They are kept as an archive until the release process stops changing.

Alternatives weighed for choosing the run file:

- Requiring the release procedure to pass the run file explicitly. The operator has no better information than the exporter: the name encodes the run's start time, which they do not know, so in practice they would pick the newest file, which is the same guess. This moves the guess from code that fails loudly to a person who does not, and puts a placeholder into the documented command. Rejected as the default; still available through `--broadcast`.
- Searching the sibling run files for the deployment's transaction hash. A resumed or re-sent broadcast can put the same hash in more than one file, and the first file in sort order would win. Rejected because byte identity is exact.

## Consequences

The default input can pick up the wrong run: another broadcast of the same script on the same chain lands between the broadcast you meant and the export. It overwrites `run-latest.json`, and the byte-identity search then finds the twin of that other run. Every check the exporter applies runs on whichever run is exported, in `build_manifest` and then `write_manifest` (`contracts/script/export_deployment.py`). How each kind of wrong run is handled:

| Run that ends up in `run-latest.json` | Outcome |
|---|---|
| An aborted attempt with no receipt, such as `run-1792630492858.json` | Refused by `find_deployment`: the deployment must have exactly one receipt. |
| A deployment whose receipt failed, including a CREATE2 retry of a release that already deployed (same salt and initcode, so the same address, and the factory reverts) | Refused by `find_deployment`: the receipt status must be 1. |
| A broadcast that does not deploy the named contract exactly once | Refused by `find_deployment`. |
| A deployment on another chain, or with another profile's constructor arguments | Refused by `validate_profile`. |
| A CREATE2 deployment salted for another release | Refused by `deployment_initcode`: the salt must be `release_salt(version)`. |
| A deployment of another build | Refused by `validate_artifact`: the creation bytecode must equal the compiled artifact's. |
| Another successful CREATE deployment of the same build with the same profile | Accepted, unless a record for that network and version already exists, in which case `write_manifest` refuses the different address. Only CREATE deployments (releases up to v2-rc2) can reach this case; the deploy script now uses CREATE2. |

A path passed with `--broadcast` goes through the same checks. Whether it is the intended run is the operator's choice.

- The default input relies on Forge writing `run-latest.json` and `run-<ms>.json` with identical bytes. That is how Forge behaves, not a documented contract. If it changes, the export fails without writing anything, and `--broadcast` still works.
- A record found to be wrong after it is committed cannot be corrected without failing the immutability job. A correction is therefore a deliberate act, visible as a failed check on the change that makes it. The backfill that introduced `bytecode` and fixed the v2-rc2 and v2-rc3 broadcast paths was made before the job existed. In that backfill, v2-rc1's `bytecode` was taken from its broadcast, not from a full re-export: a rebuild at its source commit `f606e9a` differs from the deployed code in the CBOR metadata hash, because that commit predates the metadata pinning in `foundry.toml`.
- Consumers read the record and nothing else. The indexer's test harness deploys each release from it (indexer [ADR-0013](../../services/indexer/docs/adr/0013-harness-deploys-from-deployment-records.md)).

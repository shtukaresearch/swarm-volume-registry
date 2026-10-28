# Releasing `ethswarm-volumes`

How the package learns about a contract release, and how the package itself is released. Deploying a contract is the repository's [`RELEASING.md`](../../../RELEASING.md) Part A, which also defines release names.

A contract deployment produces facts: its deployment record in `contracts/deployments/`, its broadcast and its tag. The package acts on none of them until this procedure adds the release to it ([ADR-0011](./adr/0011-derived-deployment-registry.md)). Until the package release ships, installed indexers do not see the new deployment, so a contract release cannot break an existing install. This may follow the contract release in the same PR or much later.

The package keys everything version-specific on `registry_version`, the release name: the decode reference data (`decode._VERSIONS`), the registry entries and their labels (`<network>-<release>`, [`data-model/deployment-registry.md`](./data-model/deployment-registry.md)), and the deployment record the test harness deploys ([ADR-0013](./adr/0013-harness-deploys-from-deployment-records.md)).

Run commands from the repository root.

## B1. Add the decode reference data

In `services/indexer/src/ethswarm_volumes/decode.py`, add the `_VERSIONS["<release>"]` entry:

- events ABI + enum tables for the new surface, **or**
- a one-line alias of the predecessor's entry if the indexer-visible surface is unchanged (e.g. a gas-only release, or a mainnet `vN` identical to its last release candidate).

`test_decoder.py::test_pinned_abis_match_version_fixture` fails until this and the ABI in the release's deployment records agree verbatim. Adding the entry is also what puts the release under test: the harness deploys every supported version from its records.

## B2. Handle changed semantics (only if they changed)

B1 teaches the package to *decode* the release; this step checks it still *means* the same. Diff the contract source against the previous release tag (`git diff <previous-tag> <tag> -- contracts/src`) and ask whether anything the indexer relies on changed: what an event signifies, how fees flow to Postage, what adds a volume to or removes it from the active set, how accounts are authorized or revoked, or the wiring getters (`postage`, `bzz`, `graceBlocks`, `priceOracle`). A pure removal can need nothing: v2-rc1 dropped ownership transfer, and without transfer events every volume stays with its creator.

If something changed, update the tests and the implementation together:

- **Tests.** Run the suite first: the `chain` fixture runs every existing scenario against the new release and checks the projection against state read back from the node, so a changed fee flow, capacity rule or authorization rule already fails there. For behaviour the existing scenarios don't reach, add scenarios and the `Chain` calls they need ([`TESTING.md`](./TESTING.md) §2a).
- **Implementation.** Make the projection (`project.py`) version-aware where the meaning changed, and `node.resolve_extra` where the wiring reads or the version-specific `extra` changed ([`SCHEMA.md`](./SCHEMA.md) §3).
- **Artifact.** The three measures and the artifact kernel stay stable across contract versions ([ADR-0001](./adr/0001-three-measures.md)). New version-specific facts go in `extra` or an additive section, a `schema_version` minor bump; a change the kernel cannot absorb is a major bump ([`SCHEMA.md`](./SCHEMA.md)).

## B3. Register the deployments and latest pointers

Derive the package's registry from the committed deployment records:

```sh
uv run --project services/indexer services/indexer/scripts/derive_deployments.py
```

This adds an entry for every versioned record whose release is in `_VERSIONS` and not yet registered, and sets the package's `latest` pointer for each network whose `contracts/deployments/<network>/VolumeRegistry.json` names a registered deployment. Records of unsupported releases are reported and left alone, and so is a pointer that names one. Pass `--exclude NETWORK-VERSION` to keep a recorded deployment out of the fleet. Review the diff to `services/indexer/src/ethswarm_volumes/deployments.json` and commit.

## B4. Release the package

- Bump `version` in `services/indexer/pyproject.toml`.
- PR to `main`. `indexer-ci` runs on the PR; on merge, the publish workflow ([`publish-python.yml`](../../../.github/workflows/publish-python.yml)) reruns it and uploads to PyPI via trusted publishing. Uploads are idempotent (`skip-existing`), so only the version-raising merge publishes.

A package-only release, with indexer or client changes and no new contract, is B4 alone.

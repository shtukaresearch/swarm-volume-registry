# ADR-0013: The test harness deploys each release from its deployment record

Status: Accepted; supersedes the per-version fixture of [ADR-0010](./0010-extensional-contract-versions.md) for every version with a deployment record

## Context

ADR-0010 has the suite test each `registry_version` against the contract actually deployed under it, so the harness needs that release's ABI and creation bytecode. The deployment records in `contracts/deployments/` did not hold the bytecode. The suite therefore kept a vendored copy per release: `scripts/vendor_fixtures.py release` derived `tests/fixtures/<version>/VolumeRegistry.json` (plus a `provenance.json`) from the broadcast the record cites. The derivation took the deployment's initcode, removed the CREATE2 salt, and removed the ABI-encoded constructor arguments. `tests/test_fixtures.py` repeated the derivation on every run and compared the result with the committed copy.

This duplicated logic the contracts exporter already has, and made the indexer suite depend on the cited broadcast staying put. When the v2-rc2 record turned out to cite `run-latest.json`, which the v2-rc3 broadcast overwrote, `test_fixtures.py` failed for v2-rc2, although neither the record nor the fixture was wrong.

Contracts [ADR-0006](../../../../docs/adr/0006-immutable-deployment-records.md) makes the record carry the deployed creation bytecode, checked once by the exporter against the broadcast and the build, and makes committed records immutable.

## Decision

- `harness.load_artifact` reads `VolumeRegistry`'s `abi` and `bytecode` from `contracts/deployments/*/VolumeRegistry-<version>.json`. If several networks record a version, the records must agree. No release with a record has a vendored fixture. The indexer does not re-check a record against its broadcast; that check belongs to the exporter, and runs once, at export time.
- The versions under test are `decode.supported_versions()`, the claim site of [ADR-0011](./0011-derived-deployment-registry.md), instead of the fixture directories. A release that is recorded but not yet supported stays out of the suite, as it did before.
- v1 predates deployment records and keeps its pinned `tests/fixtures/v1/`. The shared test-support contracts stay in `tests/fixtures/support/`, refreshed by `vendor_fixtures.py support`.

Alternative weighed: keeping a vendored byte-for-byte copy of each record's `abi` and `bytecode`, without the re-derivation. This adds a vendoring step to every release and a second file that must be kept equal to the first, without telling the suite anything the record does not. Rejected.

## Consequences

- Adding a release to the package no longer involves vendoring (the former `RELEASING.md` step B1). Adding its `decode._VERSIONS` entry puts it under test, and `test_decoder.py` checks that entry's event ABIs against the record's ABI.
- The suite reads `contracts/deployments/` from the repository checkout, as it previously read the broadcast files.
- v1 remains the one version whose code comes from a fixture. That changes only if a v1 record is reconstructed.

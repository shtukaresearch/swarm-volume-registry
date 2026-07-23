# Releasing

Operational runbook. The concepts — what a `registry_version` *is*, the two version axes,
why nothing here can break an existing install — live in
[`python/docs/VERSIONING.md`](python/docs/VERSIONING.md) and
[ADR-0010](python/docs/adr/0010-extensional-contract-versions.md); this file is the
commands.

There are two release tracks. A **contract release** deploys a new `VolumeRegistry` and
teaches the Python package about it (steps 1–5 below, ending in a package release). A
**Python-only release** (step 5 alone) ships indexer/client changes with no new contract.

## Contract release: registry_version `vN`

Preconditions: contracts CI green at the release commit; a clean `contracts/src`;
`forge build` run locally.

### 1. Deploy, commit the broadcast, tag

```sh
cd contracts
BZZ=0x… POSTAGE_STAMP=0x… GRACE_BLOCKS=… PRIVATE_KEY=… \
  forge script script/DeployVolumeRegistry.s.sol --rpc-url "$GNO_RPC_URL" --broadcast
```

(Once per target chain; parameters per chain are documented in
[`docs/usage.md`](docs/usage.md) §2 — update that table with the new addresses.)

- Commit the broadcast records
  (`contracts/broadcast/DeployVolumeRegistry.s.sol/<chain_id>/run-*.json`; `.gitignore`
  keeps production records, drops dry-runs and local chains).
- Tag **that** commit — after the broadcast commit, so the tag's tree contains its own
  deployment record — and push it:

```sh
git tag vN && git push origin vN
```

The tag name is the version: it is used verbatim as `registry_version` everywhere below.

### 2. Vendor the pinned test fixture

```sh
python3 scripts/vendor_fixtures.py vN \
  --verify gnosis 0xREGISTRY "$GNO_RPC_URL" \
  --verify sepolia 0xREGISTRY "$SEP_RPC_URL"
```

This freezes slim build artifacts at `python/tests/fixtures/vN/` and writes
`provenance.json`, verifying on-chain that the frozen build **is** the deployed code
(runtime bytecode comparison, immutables masked). Fill in `source.tag` (`"vN"`) and
commit the fixture directory.

### 3. Add the decode reference data

In `python/src/ethswarm_volumes/decode.py`, add the `_VERSIONS["vN"]` entry:

- events ABI + enum tables for the new surface, **or**
- a one-line alias of the predecessor's entry if the indexer-visible surface is unchanged
  (e.g. a gas-only release).

`test_decoder.py::test_pinned_abis_match_version_fixture` fails until this and the
fixture from step 2 agree verbatim.

### 4. Extend the test suite (only if semantics changed)

A version that changes behaviour, not just bytes, gets its own `Chain` driver variant and
scenarios in `python/tests/harness.py` — the existing driver is as version-specific as
the fixture it deploys. See [`python/docs/TESTING.md`](python/docs/TESTING.md) §2a.

### 5. Register the deployments; release the package

- Add the new deployments to the registry (`python/src/ethswarm_volumes/registry.py`) —
  label, chain id, address, `registry_version: "vN"`, and `genesis_block` (the creation
  block, in the broadcast receipts).
- Bump `version` in `python/pyproject.toml`.
- PR to `main`. On merge, the publish workflow
  ([`.github/workflows/publish-python.yml`](.github/workflows/publish-python.yml)) runs
  the full suite and uploads to PyPI via trusted publishing; uploads are idempotent
  (`skip-existing`), so only the version-raising merge publishes.

Until this step ships, the new deployment does not exist for any installed indexer —
there is no intermediate state in which anything is broken.

## Python-only release

Step 5's last two bullets: bump `version` in `python/pyproject.toml`, PR to `main`, merge.

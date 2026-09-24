# Volume Registry Data API — Versioning & upgrade path

How the system evolves over time: how a new contract deployment is absorbed, how the artifact structure changes, and how clients stay compatible. See [ADR-0008](./adr/0008-version-axes.md) (the axes) and [ADR-0010](./adr/0010-extensional-contract-versions.md) (what a contract version *is*).

## Two orthogonal axes

| Axis | Versions | Cadence | Across deployments |
|---|---|---|---|
| `registry_version` | the deployed **contract** (`v1`, `v2`, …) | when a new contract is deployed | heterogeneous |
| `schema_version` | the **artifact JSON structure** | when the artifact shape changes | fleet-wide, synced |

- A new contract that projects into the existing shape flips that deployment's `registry_version` and leaves `schema_version` unchanged.
- `schema_version` is `major.minor`: **major** = breaking change to a kernel field (clients update in lockstep); **minor** = additive optional section (old clients ignore unknown keys). There is no patch level — a data schema has only these two structurally-distinguishable states; anything "non-structural" (spec wording, a corrected value) is a change to the document or the data content, not to the structure, and no client gates on it.

## What a `registry_version` is

A contract version names a **deployed release**, extensionally ([ADR-0010](./adr/0010-extensional-contract-versions.md)). One string is used everywhere, verbatim:

| Site | Role |
|---|---|
| git tag on the release commit | the release identity; its tree contains the committed deployment artifacts |
| `contracts/broadcast/…` records | the deployments the name indexes (address, chain, creation block) |
| `registry_version` in a registry entry | selects the decoder/projector for that deployment |
| `decode._VERSIONS` key | the pinned decode reference data (events ABI, enum names) |
| `tests/fixtures/<version>/` | the frozen build the harness deploys ([`TESTING.md`](./TESTING.md) §2a) |

A version covers every deployment made from its tag's source, across chains and over time: deploying the *same* source to a new chain adds a broadcast record and a registry entry under the existing name, no new version. A new release gets a new name even when the indexer-visible surface is unchanged — its `_VERSIONS` entry is then a one-line alias of the predecessor's reference data. Once assigned, a name is frozen; deployments are immutable, so it can never become wrong.

Contracts `HEAD` carries **no** version: it is the next release in development, and nothing in the Python package or its test suite binds to it.

## Releasing a new contract version

Nothing here can break an existing install: until step 5 ships, the new deployment simply does not exist for the indexer. (Operational runbook with the concrete commands: repo-root [`RELEASING.md`](../../RELEASING.md).)

1. **Deploy** from the release commit (`forge script`); **commit** the broadcast records; **tag** that commit `vN` (tag after the broadcast commit, so the tag's tree contains its own deployment record).
2. **Pin the fixture**: slim abi + creation bytecode at `tests/fixtures/vN/`, with `provenance.json` (source commit/tag, compiler settings) recording an on-chain verification — deployed runtime bytecode vs the build's, immutable references masked.
3. **Add the decode reference data**: `decode._VERSIONS["vN"]` — a new events ABI + enum tables if the surface changed, an alias of the predecessor if not. The pinning unit in `test_decoder.py` enforces that this and the fixture agree.
4. **Extend the suite** only if semantics changed: a `Chain` driver variant + scenarios for the new behaviour.
5. **Register the deployments**: run the derivation script (`scripts/derive_deployments.py`), which proposes registry entries for broadcast-recorded deployments of supported versions (label, chain, address, genesis block — all read from the facts, never hand-transcribed; [ADR-0011](./adr/0011-derived-deployment-registry.md)); review the diff, commit, and make a Python package release carrying it.

Steps 1–2 produce **facts** (safely automatable, inert until named); steps 3–5 are **claims** — the manual acknowledgements that the package understands the new version ([ADR-0011](./adr/0011-derived-deployment-registry.md)). Automatic propagation stops at step 3, the first claim.

## Sync publishing

Every publish cycle regenerates every deployment's data at the indexer's current `schema_version` (re-emission from immutable on-chain events). The fleet runs a single live schema with one client build for all deployments.

## Client compatibility

Accept equal major, ignore unknown keys (forward-compatible on minor), refuse a higher major.

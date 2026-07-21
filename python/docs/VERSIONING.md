# Volume Registry Data API — Versioning & upgrade path

How the system evolves over time: how a new contract deployment is absorbed, how the artifact structure changes, and how clients stay compatible. See [ADR-0008](./adr/0008-version-axes.md).

## Two orthogonal axes

| Axis | Versions | Cadence | Across deployments |
|---|---|---|---|
| `registry_version` | the deployed **contract** (`v1`, `v2`, …) | when a new contract is deployed | heterogeneous |
| `schema_version` | the **artifact JSON structure** | when the artifact shape changes | fleet-wide, synced |

- A new contract that projects into the existing shape flips that deployment's `registry_version` and leaves `schema_version` unchanged.
- `schema_version` is `major.minor`: **major** = breaking change to a kernel field (clients update in lockstep); **minor** = additive optional section (old clients ignore unknown keys). There is no patch level — a data schema has only these two structurally-distinguishable states; anything "non-structural" (spec wording, a corrected value) is a change to the document or the data content, not to the structure, and no client gates on it.

## Sync publishing

Every publish cycle regenerates every deployment's data at the indexer's current `schema_version` (re-emission from immutable on-chain events). The fleet runs a single live schema with one client build for all deployments.

## Client compatibility

Accept equal major, ignore unknown keys (forward-compatible on minor), refuse a higher major.

# ADR-0008: Two version axes; fleet-wide schema sync

Status: Accepted

## Context

Two kinds of change are easy to conflate: a new contract deployment (different events) and a change to the artifact's structure (different client-facing shape). Coupling them forces a client update whenever a contract changes, and invites a per-deployment compatibility matrix.

## Decision

Keep two orthogonal version axes: `registry_version` (the deployed contract; per-deployment; heterogeneous) and `schema_version` (the artifact JSON structure; `major.minor`; synced fleet-wide). Every publish cycle regenerates every deployment's data at the indexer's current `schema_version`.

## Consequences

- A new contract that projects into the existing shape flips only that deployment's `registry_version` and leaves `schema_version` untouched.
- Regeneration is re-emission from immutable on-chain events, so there is no migration step; the fleet runs a single live schema with one client build for all deployments and no compatibility matrix.
- `schema_version` is `major.minor` (major = breaking kernel change, minor = additive optional section); clients accept equal major, ignore unknown keys, and refuse a higher major. There is no patch level: a structure has only these two client-relevant states, and the fleet-wide regeneration below means no older artifacts linger to disambiguate.

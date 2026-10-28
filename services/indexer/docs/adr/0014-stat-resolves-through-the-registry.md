# ADR-0014: `stat` resolves a bare network name through the registry, not the artifact

Status: Accepted; amends the artifact-pointer clause of [ADR-0012](./0012-release-names-and-latest-pointers.md) for this package's client

## Context

ADR-0012 gives the bare network name (`sepolia`) an explicit pointer in three places: the contracts-side `VolumeRegistry.json`, the package registry's `latest` map, and the artifact's `latest` map, "so a client resolving `stat gnosis` against a published file needs nothing else". `sync` resolved through the registry and `stat` through the artifact.

The artifact's map is a copy of the registry's, taken when `sync` writes the file. When a package release moved `latest.sepolia` from `sepolia-v2-rc2` to `sepolia-v2-rc3`, an artifact written earlier still said `sepolia-v2-rc2`. `stat sepolia` showed v2-rc2 while `sync sepolia` synced v2-rc3, until the next `sync` rewrote the file. The same name selected different deployments in the two verbs, with no indication that anything was out of date.

## Decision

- `stat` resolves a bare network name through the `latest` map of the registry `sync` uses: the built-in fleet, or `--config`, which `stat` now also takes. Labels and `chain:address` resolve against the artifact's entries as before.
- If the registry's pointer names a deployment the artifact does not contain, `stat` fails (exit 2) and says which deployment the name means and to `sync` it. It does not fall back to another deployment.
- A network that only the artifact has a pointer for does not resolve; it can still be selected by label.
- The artifact keeps its `latest` map (`SCHEMA.md` §3), written by `sync` as before, for consumers of a published file that do not use this package.

Alternative weighed: keep resolving through the artifact's map and warn when it disagrees with the registry. This keeps ADR-0012 unchanged, but the name still means two things, and the warning appears only when the two maps are compared. Rejected.

## Consequences

- A bare network name selects the same deployment in `sync` and `stat`, for a given package version and `--config`.
- After a package upgrade that moves a pointer, `stat <network>` fails until `sync <network>` has run, rather than showing the previous deployment.
- `stat` of a published artifact resolves bare names by the reader's package version, not the producer's. A reader whose package points at a deployment the file lacks gets the error and can select by label.

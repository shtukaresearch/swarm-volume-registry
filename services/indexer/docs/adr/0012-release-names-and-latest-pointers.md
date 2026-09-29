# ADR-0012: Release names, `<network>-<version>` labels, explicit latest pointers

Status: Accepted

## Context

Two naming problems surfaced when the indexer met the contracts side's deployment tooling.

- **Labels.** A registry entry's `label` was the bare network name (`gnosis`, `sepolia`). A network outlives its deployments: Sepolia already hosts the v1 registry the package indexes and a newer one the package does not yet support, and Gnosis will host a second release. A label that names a network cannot name two of its deployments, and silently re-pointing it at a new deployment changes what `stat sepolia` means with no record of the decision.
- **Testnet versions.** Under ADR-0010 each deployed release gets a name, but testnets see several deployments between mainnet releases (each a candidate for the next one). Numbering them as full releases (`v2`, `v3`, …) inflates the mainnet sequence; reusing one name for several deployments breaks "a name has one referent per network".

The contracts side already had a notion of "the current deployment on a network": `deployments/<network>/VolumeRegistry.json` in the hardhat-deploy layout, with other deployments exported under distinct names.

Alternatives weighed for resolving a bare network name:

- **Computed latest** — the highest release on the network by version order. Rejected: "newest" is not "current" (an abandoned candidate would capture the name until deregistered), and the choice would be made implicitly by whoever registers a deployment.
- **No bare names** — always require the versioned label. Rejected: the common query is "the current one on Gnosis", and every client would hardcode a label that goes stale.

## Decision

**Release names.** A release name is `vN` (a mainnet release) or `vN-rcM` (a testnet release candidate for `vN`). It is the ADR-0010 version string — git tag, `registry_version`, `_VERSIONS` key, fixture directory — with one more site: the deployment-record filename. A mainnet `vN` gets its own name even when its source equals the last candidate; its `_VERSIONS` entry is then an alias. A network holds at most one deployment per name; a redeploy is a new name.

**Labels.** A deployment's label is `<network>-<release>` (`gnosis-v1`, `sepolia-v2-rc1`). Registry entries carry `network` and `registry_version` explicitly and the label is derived, never written down, so the two cannot disagree.

**Latest pointers.** The bare network name is a mutable pointer, moved only by an explicit, reviewed step, and stored with the deployment it points at:

- Contracts side: `deployments/<network>/VolumeRegistry-<release>.json` is the immutable record of each deployment; `deployments/<network>/VolumeRegistry.json` is a byte-identical copy of the promoted one, written only by `export_deployment.py --latest` (or restored by copying a record).
- Package side: the registry document's `latest` map (`{network: label}`), which `derive_deployments.py` sets from `VolumeRegistry.json` — only when the pointed-at deployment is registered, i.e. its release is supported (ADR-0011: facts may lead claims; a pointer at an unsupported release is a fact the package does not act on).
- The artifact carries the `latest` map too, so a client resolving `stat gnosis` against a published file needs nothing else.

Selectors resolve a label first, then a bare network through `latest`, then `chain:address`. A bare network with no pointer does not resolve; nothing falls back to version order.

## Consequences

- Every deployment has a stable name that says where it is and what it is; promoting a new deployment is a visible diff (the pointer file on the contracts side, the `latest` entry in the package), never a side effect of registration.
- The pointer is a copy rather than a symlink: hardhat-deploy consumers read it as a plain file, GitHub raw URLs serve it as JSON, and a test pins it to exactly one versioned record.
- The package's pointer can lag the contracts side's: while a network's current deployment is an unsupported release, the package keeps its previous pointer (or none), so a package-only release never changes what a bare name means.
- Pre-existing deployments with no committed record (Gnosis and Sepolia v1) keep hand-seeded entries; their pointers are hand-set once and thereafter follow the records.
- The derivation script needs no `--version` or `--label`: both come from the record, which the exporter wrote from the release step's explicit `--version`.
- Artifact entries keep their `label` field; its value is now the versioned label, and the top-level `latest` map is new. The schema stays `1.0`: no artifact had been published under the old labels.

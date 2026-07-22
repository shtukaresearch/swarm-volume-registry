# ADR-0010: `registry_version` names a deployed release; fixtures pinned per version

Status: Accepted

## Context

ADR-0008 made `registry_version` an axis but left its values undefined: nothing on the contracts side declared a version, and the test suite deployed from `contracts/out` — whatever contracts `HEAD` builds to — while labeling it `v1`. That structurally identifies "v1" with "`HEAD`": any event- or signature-changing contracts commit breaks the Python suite, even though the shipped indexer is untouched (a deployment it has no registry entry for is invisible to it, whatever its version). "Version" needs a definition with a concrete referent, and the suite needs to bind to it rather than to `HEAD`.

Alternatives weighed:

- **Intensional (surface) versioning** — bump `registry_version` only when the indexer-visible surface changes (events ABI + semantics, fee-leg convention, wiring getters). Rejected: it needs a second, per-release identifier anyway, and deciding "did the surface change?" becomes a judgement call embedded in a name. A one-line alias achieves the same economy without the indirection.
- **Lockstep with `HEAD`** — keep testing `HEAD` and force every surface-changing contracts PR to update the Python decoder in the same PR. Rejected: conflates *in development* with *deployed and supported*, and loses the old version's fixture the moment `HEAD` moves on.
- **Rebuild old versions from tags at test time** — no committed artifacts, but the suite then needs git + Foundry, and rebuilding old solc versions in CI is fragile.

## Decision

A contract version is **extensional**: it names a deployed release, not an abstract surface. One string is used everywhere — the git tag on the release commit, the `registry_version` in each deployment's registry entry, the key of the decode-layer reference data (`decode._VERSIONS`), and the test-fixture directory (`tests/fixtures/<version>/`). The deployment artifacts (Foundry broadcast records) are committed, and the version name indexes them: a version is a tag plus the set of deployments made from that tag's source, across chains and over time.

The suite tests each version against **the contracts actually deployed under it**: slim (abi + creation bytecode) build artifacts are frozen per version with a provenance record (source commit/tag, compiler settings, on-chain bytecode verification), and a pure unit ties the decode-layer ABI pin to the fixture pin verbatim.

## Consequences

- Releasing a new contract version can never break an existing indexer install: the new deployment does not exist for it until a package release adds the registry entry. A version is *absorbed* (new tag + broadcast records + fixture dir + `_VERSIONS` entry + registry entry, plus driver variants and scenarios if semantics changed — the procedure in [`VERSIONING.md`](../VERSIONING.md)), never *tracked*.
- Contracts `HEAD` is "the next version in development" and can drift freely; the Python suite needs no Foundry toolchain (only `anvil`), since the fixtures are committed.
- A release whose indexer surface is unchanged (e.g. a gas-only fix) still gets a new version name; its `_VERSIONS` entry is a one-line alias of the predecessor's reference data. Names stay uniform and every name keeps a concrete referent.
- Deploying the *same* source to a new chain reuses the existing version: broadcast records accumulate under the tag's script/chain layout, and only a registry entry is added.
- Once assigned, a version is frozen — deployments are immutable, so a name can never become wrong.
- The deployment artifacts, not hand-maintained code, become the source of truth for the registry's contents (address, chain, genesis block); the built-in registry can be derived from them.
- The suite no longer notices contracts `HEAD` drifting past the newest supported version; if that should be visible, it needs a separate contracts-side check.

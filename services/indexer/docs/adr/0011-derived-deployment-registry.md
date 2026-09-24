# ADR-0011: Facts vs claims; the built-in registry derived, not hand-written

Status: Accepted

## Context

ADR-0010 made deployment artifacts the source of truth for what exists on-chain, but the built-in registry (`DEFAULT_REGISTRY`) was still a hand-maintained tuple in `registry.py` — addresses, chain ids and genesis blocks transcribed by hand, which is exactly where transcription errors live. Deriving it mechanically from the committed broadcast records raises the question this ADR answers: where does automatic propagation of a new contract version into the Python package stop?

The release artifacts split into two tiers:

- **Facts** — records of what happened: the broadcast records, the git tag, the pinned fixture. Mechanically derivable, safely automatable, and *inert*: nothing in the package or suite reads a fixture dir or broadcast record until something names it.
- **Claims** — assertions that the package understands something: the `_VERSIONS` entry ("this package can faithfully index vN"), the registry entry ("index this deployment with vN's machinery"). Claims contain judgement no artifact carries — the enum tables come from reading contract constants, the alias-or-new-entry decision is a semantic judgement, and whether the existing projector still applies is not decidable from any ABI. (Austin's constative/performative distinction: adding the key doesn't describe support, it constitutes it.)

Automation must stop at the first claim. A registry derived *directly* from broadcast facts would violate that: committing a vN+1 broadcast (a fact, automatable) would propagate a deployment into the fleet with no decoder behind it — or, with a support-closure check, would break unrelated Python releases the whole time a deployed-but-unsupported version exists.

## Decision

The `registry_version` key in `decode._VERSIONS` is the **single claim site** for version support. The built-in registry is package data (`deployments.json`, the `--config` document shape) **derived** from the broadcast facts *gated on that claim*: a derivation script proposes entries for broadcast-recorded deployments whose version is supported and not yet registered, filling `chain_id` / `registry` / `genesis_block` from the receipts and the label from a chain-name table. Running the script and committing its diff is a **manually triggered action** — the human supplies the version attribution and reviews the proposal; residual judgement (excluding a botched deploy, labelling a second deployment on one chain) enters as explicit script arguments, not edits to generated data.

Two guards close the loop:

- a pure unit asserts every registry entry's `registry_version` is in `decode._VERSIONS` (support closure — loud at test time, which gates publishing, so a released package can never carry an unsupported entry);
- `sync` rejects a deployment whose version this package build does not support with a clear error, since an operator `--config` bypasses the test gate.

## Consequences

- No hand-transcribed addresses, chain ids or genesis blocks anywhere in the package; the human contribution to registration shrinks to the judgement calls (version attribution, labels, exclusions) plus a diff review.
- Facts may lead claims freely: broadcast records, tags and fixtures for a not-yet-supported version can sit in the repo indefinitely without affecting the package, tests, or interim Python-only releases.
- A forgotten registration is *invisible* (the deployment simply isn't indexed), not broken — consistent with ADR-0010's "absorbed, not tracked". The derivation script reports unregistered supported deployments, making the omission visible when it is next run.
- A persistent exclusion/override file for the residues is deferred until first needed; until then, exclusions are per-run script arguments.
- The registry document shape is shared between the package data and the operator `--config` file, so there is one loader and one schema.

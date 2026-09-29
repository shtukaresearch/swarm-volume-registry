# ADR-0001: Three semantic measures as the public contract

Status: Accepted

## Context

Consumers (a CLI and a web dashboard) want aggregate answers about a `VolumeRegistry` deployment: how much fee volume, how much storage capacity, how many accounts — each as-of a point, over a window, or as a series. Deployments run heterogeneous contract versions whose event layouts differ. The public surface could expose raw events, or a per-version schema, or a fixed set of derived measures.

## Decision

Expose exactly three measures — **fee volume** (flow), **storage capacity** (stock), **accounts authorized** (stock) — defined semantically, independent of any particular event layout. They are the stable public contract; the projector maps each contract version's events onto them.

## Consequences

- The contract holds across contract-version changes that alter the underlying events: a new version re-maps onto the same three measures in the projector, not in the client.
- All three share identical temporal access patterns (as-of / window / series); flow-vs-stock is the only structural difference, which keeps the client and artifact uniform.
- Anything outside these three (per-volume drill-down, sub-day granularity) is out of scope for v1 and would need a new measure or a different delivery path.

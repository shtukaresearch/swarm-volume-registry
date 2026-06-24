# ADR-0004: Single projection, no intermediate derived tables

Status: Accepted

## Context

Between `event_log` and the published artifact, derived entities (`volume`, `payment`, an
active set, account state) must be computed. A conventional indexer materializes these as
persisted tables and incrementally maintains them.

## Decision

Run one pure projection from `event_log` to the artifact. Per-entity results are
sub-functions of that projection, not persisted tables.

## Consequences

- The data is small and every `sync` re-projects in full, so there is nothing to amortize
  by persisting intermediate tables — they would be pure restatements of `event_log`.
- The only persisted store is `event_log` (plus the artifact output); fewer moving parts,
  no derived-table invalidation.
- Building a per-entity table is itself just a projection, available as a sub-function when
  a measure needs it.

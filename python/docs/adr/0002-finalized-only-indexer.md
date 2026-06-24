# ADR-0002: Off-chain event-sourced indexer, finalized-only

Status: Accepted

## Context

The three measures (ADR-0001) must be reconstructed from chain state. Options span a live
read against an archive node, a stateful indexer tracking the chain head with reorg
handling, or an event-sourced fold over logs up to a safe depth. Sub-hourly freshness is
not required.

## Decision

Event-source everything from logs via `eth_getLogs`, reading only to the chain's
`finalized` block. Run the indexer off-chain on an hourly schedule.

## Consequences

- No archive node is needed: all state is derived from events.
- Reading only `finalized` removes reorg handling entirely — finalized blocks do not roll
  back, so there is nothing to revert.
- The indexer is the only stateful process and is never in a user's request path.
- Freshness is bounded by the hourly cadence and by finality lag, which is acceptable for
  the aggregate snapshot.

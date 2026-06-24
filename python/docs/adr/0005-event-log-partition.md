# ADR-0005: `event_log` partitioned per `(deployment, event_type)`

Status: Accepted (supersedes the earlier single-merged-table sketch)

## Context

`event_log` could be a single merged relation keyed by `event_name`, with the projector
replaying one time-ordered stream, or it could be split into a separate log per event type.
The web3 layer already acquires each event type through its own topic-filtered `getLogs`.
No projection consumes every event type at once: capacity reads
`VolumeCreated`/`VolumeRetired`, accounts reads `AccountActivated`/`AccountRevoked`, fee
reads `Transfer`/`Toppedup`/`VolumeCreated`.

## Decision

Partition `event_log` by `(deployment, event_type)` — one log per event type, per
deployment. A fold that needs cross-type chain order reconstructs it with a k-way merge on
`(block_number, log_index)` at read time.

## Consequences

- Storage matches the acquisition shape, so the web3 layer never has to merge separately
  fetched types back into one relation and the projector never re-splits them.
- Each projection reads only the logs it needs; the merge order is a derivable read-time
  view rather than something the store persists.
- A new event type is a new log, with no change to existing logs.
- `registry_version` selects the decoder/projector and fixes the `args` shape but is a
  property of the deployment, not the partition key; deployments sharing a contract version
  still get separate logs.

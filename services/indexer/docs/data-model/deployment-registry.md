# Deployment registry (generic)

Part of the [data model](./README.md). Holds deployment identity and version pointers:

```
deployment(
  deployment_id        = (chain_id, registry_address),   -- PK
  network,             -- the contracts/deployments/<network>/ directory it is recorded under
  registry_version,    -- the release name; selects the web3 decoder + projector
  genesis_block,       -- first block to index
)                      -- label = <network>-<registry_version>, unique (derived)

latest(network -> label)   -- explicit pointer: what the bare network name means
```

A network holds at most one deployment per release, so the label is a second key. The `latest` pointer is set only by a release step, never inferred from version order ([ADR-0012](../adr/0012-release-names-and-latest-pointers.md)).

Version-specific facts (`grace_blocks`, dependency addresses) live in the artifact's `extra` ([`SCHEMA.md`](../SCHEMA.md)).

The registry is itself a **reduced artifact**: identity only. Everything else is sync output — `extra` is read back from the contract, `genesis_ts` / `as_of` from blocks, the daily series + snapshot from the [projector](./projection.md), `price_daily` from DeFiLlama.

The built-in fleet ships as package data (`deployments.json`, this document's shape) **derived** from the committed deployment artifacts rather than hand-written, gated on version support ([ADR-0011](../adr/0011-derived-deployment-registry.md)). An operator `--config` file uses the same shape and loader.

# Deployment registry (generic)

Part of the [data model](./README.md). Holds deployment identity and version pointers:

```
deployment(
  deployment_id        = (chain_id, registry_address),   -- PK
  registry_version,    -- selects the web3 decoder + projector for this deployment
  genesis_block,       -- first block to index
  label
)
```

Version-specific facts (`grace_blocks`, dependency addresses) live in the artifact's `extra` ([`SCHEMA.md`](../SCHEMA.md)).

The registry is itself a **reduced artifact**: identity only. Everything else is sync output — `extra` is read back from the contract, `genesis_ts` / `as_of` from blocks, the daily series + snapshot from the [projector](./projection.md), `price_daily` from DeFiLlama.

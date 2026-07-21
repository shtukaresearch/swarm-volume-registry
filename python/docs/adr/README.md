# Architecture Decision Records

The rationale behind the decisions that the design docs ([`../README.md`](../README.md), [`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../data-model/`](../data-model/), [`../CLIENT.md`](../CLIENT.md), [`../VERSIONING.md`](../VERSIONING.md)) state declaratively. Those docs say *what* the design is; each record here says *why*, with the alternatives weighed and the consequences accepted.

Format per record: **Context** → **Decision** → **Consequences**.

| ADR | Decision |
|---|---|
| [0001](./0001-three-measures.md) | Three semantic measures as the public contract |
| [0002](./0002-finalized-only-indexer.md) | Off-chain event-sourced indexer, finalized-only |
| [0003](./0003-web3-isolation.md) | Web3 isolation at `event_log`; trusted ABI library |
| [0004](./0004-single-projection.md) | Single projection, no intermediate derived tables |
| [0005](./0005-event-log-partition.md) | `event_log` partitioned per `(deployment, event_type)` |
| [0006](./0006-jsonlines-cache.md) | `event_log` persisted as a JSONLines cache |
| [0007](./0007-static-artifact-delivery.md) | Single static artifact via CDN; no live read-API in v1 |
| [0008](./0008-version-axes.md) | Two version axes; fleet-wide schema sync |
| [0009](./0009-client-side-folding.md) | Clients fold locally; `paid_in_window` pre-baked |

# Volume Registry Data API — Data model

The data model is **two persisted things** plus the artifact (the output):

- a generic **[deployment registry](./deployment-registry.md)** — deployment identity and version pointers, and
- a per-deployment, per-event-type **[`event_log`](./event-log.md)** — an on-disk cache of decoded, web3-free rows, the output of the web3-isolation boundary ([`ARCHITECTURE.md`](../ARCHITECTURE.md) §2).

One pure **[projection](./projection.md)** runs from `event_log` to the artifact; its per-entity sub-results (`volume`, `payment`, …) are sub-functions of that single projection, with no intermediate persisted tables ([ADR-0004](../adr/0004-single-projection.md)).

```
  deployment registry ─┐
                       ├─▶  projection (pure)  ─▶  artifact entry (+ version-specific `extra`)
  event_log  ──────────┘
```

The artifact wire format is specified separately in [`SCHEMA.md`](../SCHEMA.md).

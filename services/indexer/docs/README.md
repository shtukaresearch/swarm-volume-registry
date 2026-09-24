# Volume Registry Data API — Design

Design documents for the data API wrapping the `VolumeRegistry` contract (the contract itself: `../../docs/DESIGN.md`, `../../docs/usage.md`).

- **This file** — the goal and the three measures that define the public contract.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — components, the web3-isolation boundary, versioning, delivery, and the cross-cutting symmetries.
- [`data-model/`](./data-model/) — the persisted things and the projection: the [deployment registry](./data-model/deployment-registry.md), the [`event_log`](./data-model/event-log.md), and the [projection](./data-model/projection.md).
- [`CLIENT.md`](./CLIENT.md) — the `ethswarm-volumes` client interface (`sync` / `stat`).
- [`VERSIONING.md`](./VERSIONING.md) — the versioning axes and upgrade path.
- [`SCHEMA.md`](./SCHEMA.md) — the artifact wire format and the client `--json` view-model.
- [`TESTING.md`](./TESTING.md) — the test strategy.
- [`adr/`](./adr/) — the decision records (the *why* behind what these docs state).

## Goal

Serve three aggregate measures — **fee volume**, **storage capacity**, **accounts** — for one or more `VolumeRegistry` deployments to two clients (a local CLI and a public web dashboard), with low integration complexity, fast load times, and hourly freshness.

## The three measures

Every consumer query is a time-series view of one of three measures. Measures are either stocks or flows. Historic time series use point snapshots for stocks and bucketing across intervals for flows.

| Measure | Dimensions | Reconstructed from |
|---|---|---|
| Fee volume (BZZ → Postage) | BZZ / time | `Transfer(registry → postage)` legs + the create-time charge |
| Storage capacity | bytes | per-volume `depth` × active-set membership |
| Accounts (currently authorized) | count | `AccountActivated` / `AccountRevoked` net level |

These three are the **stable public contract**: defined semantically, independent of event layout, and stable across contract-version changes ([ADR-0001](./adr/0001-three-measures.md)).

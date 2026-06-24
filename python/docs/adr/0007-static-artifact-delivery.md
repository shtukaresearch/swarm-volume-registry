# ADR-0007: Single static artifact via CDN; no live read-API in v1

Status: Accepted

## Context

Two clients (CLI, dashboard) need the data. Delivery could be a live query API backed by a
database, or a single static file the clients fetch and process locally. The three measures
are aggregate and small, with full daily history that fits comfortably in one document.

## Decision

Publish one static JSON artifact to a static host with a CDN; clients fetch it and fold
locally. No live read-API in v1.

## Consequences

- The request path is a static fetch: no server process, no query endpoint, no database in
  the path, minimal attack surface; the CDN absorbs public traffic.
- A live API would be warranted only if the data grows large, sub-hourly freshness is
  needed, or per-volume / sub-day drill-down is required — none of which hold for the three
  aggregate measures.
- Build order is local-first: local indexer → local artifact file → client reading a local
  path, with the URL / CDN source added once the local loop works end to end.

# Projection (`event_log` → artifact)

Part of the [data model](./README.md). One pure, version-specific projector folds [`event_log`](./event-log.md) into the artifact entry (and the version-specific `extra`) through these sub-functions. There are no intermediate persisted tables; each sub-result is a sub-function of the single projection ([ADR-0004](../adr/0004-single-projection.md)).

- **Fee volume** — merges the `Transfer`, `Toppedup` and `VolumeCreated` logs into chain order; each captured `Transfer` is a fee forward, and its same-tx sibling (`VolumeCreated` → `create`, `Toppedup` → `topup`) supplies `volume_id` and `kind`. Batched `trigger(ids[])` puts several `Toppedup` + `Transfer` pairs in one tx, matched in `log_index` order. Owner-at-payment is resolved by replaying the `VolumeOwnershipTransferred` log up to the payment block.
- **Capacity** — active-set membership from the `VolumeCreated` / `VolumeRetired` logs merged in chain order, sampled at UTC day end; `depth → effective_bytes` is a fixed lookup (bucketDepth 16, unencrypted; `../../../docs/usage.md` §12), nominal bytes = `(1 << depth) × 4096`.
- **Accounts authorized** — net level of `AccountActivated` − `AccountRevoked` per owner (re-confirmation raises it again), reading those two logs.

The projector normalizes heterogeneous contract versions onto the three stable measures ([`README.md`](../README.md)).

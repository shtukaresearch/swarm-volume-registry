# ADR-0001: Permissionless import of existing Postage batches

Status: Accepted

## Context

`VolumeRegistry` only manages batches it mints through `createVolume`. Operators with existing, data-bearing batches cannot bring them under the registry's top-up and payer machinery ([issue #1](https://github.com/shtukaresearch/swarm-volume-registry/issues/1)). Two further cases need the same capability: migrating volumes to batches copied into a new `PostageStamp` deployment (`copyBatch`), which a registry bound to the new Postage did not mint; and batches whose owner key is lost, so no new uploads can be made but the existing dataset must be kept alive.

Alternatives weighed:

- **A companion contract** that tops up external batches. Rejected: it either duplicates the volume and account state machines or needs a privileged write path into `VolumeRegistry`, and it puts a cross-contract call on the hot path that §3 designs away.
- **Gate import on `msg.sender == batches(batchId).owner`.** Rejected: it excludes the lost-key case, and it requires sharing the batch owner key with whoever manages the volume. It was originally motivated by squatting (a stranger registering a batch first and then deleting it, poisoning its ID); deriving volume IDs per owner ([ADR-0002](./0002-volume-ids-from-owner-nonce.md)) removes squatting without any gate.
- **Bilateral claim** (batch owner proposes, volume owner confirms). Rejected for the same reason: some intended use cases have no batch owner able to confirm.
- **Import without an active account.** Rejected: an imported volume without a payer does nothing the registry exists for, and `createVolume` already requires an active account.

## Decision

Add an import path onto the same `_volumes` mapping, so an imported volume is indistinguishable from a minted one for `trigger`, `deleteVolume`, retirement and views. Any address with an active account may register any live batch; no relation between the caller and the batch owner is required. `chunkSigner` and `depth` are read from Postage at registration, never supplied by the caller. One batch may underlie any number of volumes. The entry points are specified in [ADR-0004](./0004-register-and-import-entry-points.md).

## Consequences

- Volume IDs can no longer equal batch IDs; the volume record stores its `batchId` ([ADR-0002](./0002-volume-ids-from-owner-nonce.md)).
- Free-riding: when several volumes share a batch, the first one triggered pays and the others hit the zero-deficit no-op. Which payer that is depends on keeper ordering. No payer is charged beyond the formula, and nothing is double-spent.
- Owner compromise now also lets the attacker register any live batch, including a large one they own, and have it topped up. The drain ceiling is unchanged: the payer's ERC20 allowance, as with `createVolume` at an attacker-chosen depth.
- No on-chain spam prevention. Registration costs only gas, and the active-account gate is no spam control (a self-designated payer with zero allowance passes it). `_activeVolumeIds` can be inflated with volumes that duplicate a batch or never fund; reads stay paginated and the cost falls on keepers.
- A lost batch owner key is harmless to the registry. A leaked one can change the batch's depth and so retire every volume on it; each owner can register again and gets a new volume at the new depth.
- `createdAt` on an imported volume is the start of tracking, not the batch's age (Postage records no creation time).
- Migration to a new Postage is a new registry deployment plus an import there. Deleting the old volume commutes with the import, because deletion never touches Postage. There is no atomic migration helper: a helper contract would be `msg.sender` and become the owner. Owners who want atomicity use a Safe MultiSend or an EIP-7702 batch.

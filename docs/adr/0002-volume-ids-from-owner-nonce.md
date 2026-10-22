# ADR-0002: Volume IDs derived from `(owner, nonce)`, decoupled from batch IDs; IDs are terminal

Status: Accepted

## Context

Until now `volumeId == batchId`, and `trigger` passes the volume ID straight to Postage. Permissionless import ([ADR-0001](./0001-permissionless-batch-import.md)) means one batch may underlie many volumes, so the two identifiers must separate and the ID must depend on more than the batch. Removal finality (I7) makes a Retired ID permanently unusable, so the scheme also decides whether an owner can track a batch again after its volume retires — which matters after a legitimate `increaseDepth` (`DepthChanged`), an expired TTL, or an accidental delete.

Alternatives weighed:

- **`keccak256(owner, batchId)`, terminal.** One volume per `(owner, batch)` forever. Rejected: an owner whose volume retired could never track that batch again.
- **`keccak256(owner, batchId)`, reusable** (a Retired ID may be registered again, adding a Retired → Active edge). Rejected: if in doubt, prefer more granular IDs. A terminal ID names exactly one lifecycle, so indexers and other consumers keyed by volume ID never see an ID come back with a different TTL, depth or `createdAt`.
- **`keccak256(owner, batchId, salt)` with a caller-chosen salt.** Terminal and granular, but makes every caller track salts when the contract can count for them.
- **A registry-global nonce.** Rejected: other owners' transactions move it, so an owner cannot predict their next ID, and the "depends only on your own calls" property (I11) is lost.

## Decision

`volumeId = keccak256(abi.encode(owner, nonce))`, where `nonce` is the owner's account nonce ([ADR-0003](./0003-nonce-in-account.md)), read before increment. Every successful volume-creating call — `createVolume`, `registerVolume`, `importVolume` — consumes one nonce. Retired stays terminal (I7 unchanged); tracking a batch again yields a new ID. The volume record stores `batchId`, and `trigger` reads and tops up `v.batchId`. The batch is not part of the hash: `(owner, nonce)` is already unique, so it would add no granularity. `createVolume` keeps the registry-global `nextNonce` as the Postage `createBatch` nonce, so minted batch IDs are derived as before.

## Consequences

- Squatting is impossible by construction: an owner's IDs depend only on that owner's own successful calls (I11).
- An owner's next ID is predictable off-chain from `getAccount(owner).nonce`, provided their transactions land in order (a Safe MultiSend executes in order). The return value and the creating event remain canonical.
- A collision check on registration is unreachable short of a hash collision; it is kept as a defensive assertion, not a documented error.
- One extra storage slot per volume (`batchId`) and one extra cold SLOAD per trigger.
- Breaking ABI change: `VolumeView` gains `batchId`, `VolumeCreated` gains an indexed `batchId` (new topic hash), `getAccount` returns the nonce. This ships as a new release (`v2-rc3` on Sepolia); the keeper and indexer absorb it as a new version.
- Created volumes also stop having `volumeId == batchId`.

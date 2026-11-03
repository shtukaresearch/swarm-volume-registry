# Swarm Volume Registry v2 — Design

This document fixes the architecture of the v2 `VolumeRegistry` contract. V2 is the
next deployment and deliberately removes v1's unilateral ownership-transfer surface.
Rationale is inline; constraints inherited from the underlying `PostageStamp` contract
are summarised in §14. The currently deployed v1 behavior remains documented in
[`usage.md`](./usage.md).

Batch import (§7.1) and the separation of volume IDs from batch IDs (§4) are specified
here ahead of implementation and are targeted at the Sepolia `v2-rc3` release; `v2-rc1`
and `v2-rc2` predate them. The rationale for contract changes is recorded in
[`adr/`](./adr/).

## 1. Goals

Bring volume-lifecycle semantics and a two-role (owner / payer) ownership model to Swarm postage-stamp batches. A volume is a first-class object the owner manages; its underlying postage batch is an implementation detail kept alive by a keeper loop funded by a separately-authorized payer. A volume may wrap a batch the registry mints or an existing batch it imports.

Non-goals:
- Per-owner multiple funding sources.
- Signer rotation, owner-level signing delegation.
- Depth/size modifications (batches are strictly immutable-shape post-creation).
- Reliability layer (keepalive timelock with claimable assets).
- Safe `AllowanceModule` payment path (ERC20 approve only).
- Owner-initiated EIP-712 auth flows.
- Volume ownership transfer. The v2 owner is permanent; any future transfer mechanism
  must require explicit recipient acceptance.

## 2. Actors

| Actor | Type | Role |
|---|---|---|
| Owner | EOA or contract | Creates, imports and deletes volumes and designates a payer. Permanently bound to each volume it creates or imports. |
| Chunk signer | EOA | Signs chunks; identical to the underlying Postage batch owner. May equal the volume owner, or differ. The registry never needs its signature, so for an imported batch it need not be reachable. |
| Payer ("funding wallet") | EOA or Safe | Holds BZZ. Authorizes an owner as a permitted spender, revokes. |
| Keeper ("gas boy") | Anyone | Off-chain service that calls `trigger(volumeId)` on a schedule. Pays xDAI for gas. |
| Upload client | Off-chain | Submits chunks signed by the chunk signer to Swarm nodes. Out of scope for this registry. |

## 3. Components

A single contract, `VolumeRegistry`, organised into two logical components:

- **Registry component.** Holds volume records, account records, and the active-volume index. Exposes owner-facing and view APIs.
- **Paymaster component.** Exposes `trigger`, computes topup amounts, pulls BZZ from payer, forwards to `PostageStamp`. Retires volumes when invariants are violated.

They share storage in one contract to avoid cross-contract calls on the hot path.

External dependencies (unmodified):
- `PostageStamp` — Swarm's existing stamp contract. Used through: `createBatch`, `topUp`, `batches`, `currentTotalOutPayment`, `minimumBucketDepth`, `minimumValidityBlocks`, price oracle view.
- `BZZ` — ERC20 token. Used through: `balanceOf`, `allowance`, `transferFrom`, `approve`, and `expirations` when `bzzPermitExpiry` is set (§10).

## 4. Data model

```
struct Volume {
    address owner;          // msg.sender of the creating call; immutable for the volume's lifetime
    address chunkSigner;    // Postage batch owner, recorded at creation; immutable
    bytes32 batchId;        // underlying Postage batch; immutable
    uint64  createdAt;      // block.timestamp of the creating call (start of tracking, not batch age)
    uint64  ttlExpiry;      // 0 = no expiry
    uint8   depth;          // batch depth, recorded at creation; any divergence on Postage retires the volume
    Status  status;         // None | Active | Retired
    uint32  activeIndex;    // position in activeVolumeIds (for O(1) removal)
}

struct Account {
    address payer;
    bool    active;
    uint64  nonce;          // volume-creating calls this owner has made; never reset
}

mapping(bytes32 volumeId => Volume) volumes;
mapping(address owner => address)   designated; // owner's chosen payer (pre-confirmation)
mapping(address owner => Account)   accounts;

bytes32[] activeVolumeIds;                      // swap-and-pop; enumerated by keepers
uint256   nextNonce;                            // monotonic counter passed to Postage.createBatch

enum Status       { None, Active, Retired }
enum RetireReason { None, OwnerDeleted, VolumeExpired, BatchDied, DepthChanged, BatchOwnerMismatch }
enum SkipReason   { None, NoAuth, PaymentFailed, NotFound, NotActive }
```

Status and reason codes are enums ([ADR-0005](./adr/0005-codes-as-enums.md)). Each leading `None` is the zero value: `Status.None` is what an unknown volume ID reads as, and the two reason `None`s are never emitted. They keep every other code at its pre-enum value; on the wire all three are `uint8`.

"Creating call" means any of the three volume-creating entry points of §7.1: `createVolume`, `registerVolume`, `importVolume`.

**Volume identifier**: `volumeId = keccak256(abi.encode(owner, accounts[owner].nonce))`, using the nonce before it is incremented. Every successful creating call consumes one nonce. IDs are terminal: a Retired volume's ID is never reused (I7), and tracking the same batch again yields a new ID. A volume is bound to one batch (`batchId`) forever; one batch may underlie any number of volumes, of different owners or of the same owner. Rationale: [ADR-0002](./adr/0002-volume-ids-from-owner-nonce.md), [ADR-0003](./adr/0003-nonce-in-account.md).

**Batch identifier**: for a minted batch, Postage derives `batchId = keccak256(abi.encode(address(this), nonce))` from the registry-global `nextNonce` that `createVolume` passes to `createBatch`. An imported batch carries the ID Postage assigned when it was created.

**Account identifier**: the owner address. At most one active account per owner. Changing payer = re-designate + re-confirm, which overwrites `payer` and `active` but preserves `nonce`.

## 5. Invariants

**Threat model.** Key-compromise probability is assumed to rank **signer ≫ owner > payer**: the chunk signer is a hot EOA used to sign uploads continuously, the owner is a management key touched rarely (create/delete/designate), and the payer is typically a vault or Safe touched even less often. The design aims to run blast radius in the opposite direction:

- **Signer compromise.** Attacker can call `PostageStamp.increaseDepth(batchId, …)` directly on the batch (Postage checks `msg.sender == batch.owner == v.chunkSigner`). The next `trigger` of each volume on that batch observes `b.depth != v.depth` and retires it `DepthChanged`; no further topups flow. Payer is not drained via the registry. Blast radius: every volume on that batch, in every registry. Each affected owner can register the batch again and gets a new volume at the new depth.
- **Signer loss.** Harmless to the registry: nothing needs the batch owner's signature once the batch exists, and a lost key cannot change depth. Batches whose key is lost can still be imported (§7.1).
- **Owner compromise.** While the account is active, the attacker can create arbitrary high-depth volumes, register or import any live batch (including a large one they own), and force topups on existing ones. The effective drain ceiling is whatever ERC20 allowance the payer has granted the registry — **this contract adds no further aggregate cap**. I8 is a per-call charge-correctness property, not an attacker-facing bound. Mitigations are detection + I9 (a single `revoke(owner)` disables the entire (owner, payer) pair in one tx) and payer hygiene (bounded periodic approvals rather than `approve(max_uint256)`).
- **Payer compromise.** Outside the registry's protection boundary; if the payer's key is taken, funds are already under attacker control.

**No inbound-transfer exposure.** A volume's owner is fixed when the volume is created,
and is always the caller of the creating call. No caller can attach an existing volume
to another owner's account, create a volume under another owner, or redirect payer
resolution to an address that did not consent. This deliberately removes v1's
unilateral ownership-transfer behavior.

**Shared batches.** Any address with an active account may register any live batch (§7.1), so one batch can underlie volumes of several owners. Topups are idempotent at the batch level (I5): the first volume triggered pays and the others hit the zero-deficit no-op, so which payer pays depends on keeper ordering. No payer is charged beyond the formula. Registration costs only gas, so `activeVolumeIds` can be inflated with volumes that duplicate a batch or will never fund. On-chain reads stay paginated, and the cost falls on keepers that trigger such volumes. There is no on-chain prevention (§13). Rationale: [ADR-0001](./adr/0001-permissionless-batch-import.md).

The common profile owner == chunk-signer inherits the signer's threat class: the owner key is then also continuously hot. Users who want strong key isolation should keep owner and chunk-signer separate.

Invariants:

- **I1 — Volume ⇒ batch.** Every `Active` volume corresponds to the live Postage batch `volume.batchId`, whose owner is `volume.chunkSigner` and whose depth is `volume.depth`. A batch may correspond to many volumes.
- **I2 — Batch immutability.** A volume is `Retired` if Postage reports its batch as expired, at a different depth than `volume.depth`, or at a different owner than `volume.chunkSigner`. (The last condition is defensive; current Postage does not mutate batch owner.)
- **I3 — Payer bounded exposure.** BZZ can only leave `payer` via paymaster if: `accounts[owner].active == true`, `accounts[owner].payer == payer`, volume is `Active`, amount is bounded by (target balance − current balance) × chunks.
- **I4 — Auth bilaterality.** An account is `Active` only after both `designateFundingWallet(payer)` by owner and `confirmAuth(owner)` by payer have been executed.
- **I5 — Trigger idempotence.** Two consecutive `trigger(volumeId)` calls with no intervening block production topped-up zero. Computed target balance is the single source of truth; no timestamp-based rate limits. The property holds at the batch level: within one block and at one price, the total topped up across all `Active` volumes sharing a batch equals what a single trigger would top up. (Across blocks the batch balance drains, so this is strictly a same-block / same-price property; it does *not* claim that repeated calls across a round boundary net to the same drain as a single call.)
- **I6 — Survival.** A volume whose last successful create, import or topup was at block `t0` is guaranteed to survive at least `f × graceBlocks` blocks from `t0` before its batch dies, where `f` is the realization floor derived in §10.1 (`f ≈ 0.9567` for the Gnosis default `graceBlocks = 17280`). Under flat or falling prices the bound is achieved with equality / exceeded. A volume made by `registerVolume` has no such guarantee until its first successful topup.
- **I7 — Removal finality.** A `Retired` volume cannot be revived, receives no further topups, and is removed from `activeVolumeIds`. Corollary: if no other volume uses the same `(owner, payer)` pair, no subsequent `trigger` or batched `trigger(ids[])` call can transfer BZZ from that payer on behalf of the retired volume.
- **I8 — Charge correctness.** Every BZZ transfer the paymaster pulls from `accounts[owner].payer` equals the formula-computed amount and no more: exactly `max(0, graceBlocks × currentPrice − (b.normalisedBalance − currentTotalOutPayment)) × (1 << v.depth)` per `trigger`, exactly `graceBlocks × currentPrice × (1 << depth)` per `createVolume`, exactly the `trigger` amount per `importVolume`, zero per `registerVolume`, and zero in any other code path. This is a mechanical-honesty property of the paymaster — the registry does not overcharge relative to the topup delivered to Postage. It is **not** an attacker-facing bound: an adversarial owner picks `depth` and call count, so aggregate exposure under owner compromise collapses to the payer's outstanding ERC20 allowance (see threat-model block above).
- **I9 — Revocation atomicity.** A single `revoke(owner)` call causes every subsequent `trigger` on every volume owned by `owner` to take the `TopupSkipped(NoAuth)` branch (§8 step 6). Payer is resolved via `accounts[owner]` at trigger time rather than stored per-volume precisely so that revocation cost stays O(1) regardless of how many volumes the (owner, payer) pair manages.
- **I10 — Owner immutability.** A volume's `owner` is the address that made its creating
  call (`createVolume`, `registerVolume` or `importVolume`), and no public or internal
  transition can change it. Consequently, no existing volume can begin charging a
  different owner's payer account.
- **I11 — No squatting.** The ID of owner A's next volume is a function of A's own successful creating calls only. No other address can take, block or change it.
- **I12 — Non-interference.** Creating, registering, importing, deleting or retiring a volume never changes any other volume's record. The only effect any registry path has on a Postage batch is `topUp`, which can only add balance.
- **I13 — Import atomicity.** `importVolume` either leaves an `Active` volume whose batch holds at least the `graceBlocks` target, or changes no state: no record, no nonce consumed, no active-set entry, no BZZ moved.
- **I14 — Nonce monotonicity.** `accounts[owner].nonce` only increases, by exactly one per successful creating call. No account transition (`confirmAuth`, `revoke`, `designateFundingWallet`) resets or changes it.

## 6. State machines

### 6.1 Volume

```
    (createVolume | registerVolume | importVolume)
         │
         ▼
    ┌────────┐    deleteVolume / TTL pass / batch dead / depth mismatch
    │ Active ├──────────────────────────────────────────────────────▶ Retired
    └────────┘                                                         (terminal)
```

Entry edges to `Retired`:
- `Retired.OwnerDeleted` — owner calls `deleteVolume`.
- `Retired.VolumeExpired` — `ttlExpiry != 0 && now >= ttlExpiry`; detected by next trigger or by anyone calling `reap(volumeId)`.
- `Retired.BatchDied` — Postage reports batch no longer existing (balance exhausted or never existed).
- `Retired.DepthChanged` — Postage reports depth ≠ `volume.depth`.
- `Retired.BatchOwnerMismatch` — Postage reports `batches(id).owner != volume.chunkSigner`. Defensive branch; current PostageStamp does not mutate batch owner, but the paymaster checks it to keep I2 tight against future upstream changes.

### 6.2 Account

Designation and activation are separate pieces of state in v1:

```
designation:  None ── designate(payer) ──▶ Payer designated
               ▲                              │
               └──── designate(0) ────────────┘

account:      Inactive ── confirmAuth(owner) ─▶ Active
                ▲                                  │
                └──── revoke(owner) ───────────────┘
```

`confirmAuth` requires the caller to be the currently designated payer. Clearing the
designation does not deactivate an already-active account, and revoking the account
does not clear its designation.

`designateFundingWallet(p)` by owner sets `designated[owner] = p`. Calling with `p = address(0)` clears designation.

`confirmAuth(owner)` by payer requires `designated[owner] == msg.sender`, then sets `accounts[owner].payer = msg.sender` and `accounts[owner].active = true`. This overwrites the payer of any prior account but preserves `accounts[owner].nonce` (I14); resetting the nonce would make the owner's next volume ID collide with one already issued ([ADR-0003](./adr/0003-nonce-in-account.md)).

`revoke(owner)` callable by `msg.sender == owner || msg.sender == accounts[owner].payer`. Sets `accounts[owner].active = false`. It does not clear `designated[owner]`, so the designated payer can call `confirmAuth(owner)` again without a fresh owner transaction. An owner who wants permanent severance must also call `designateFundingWallet(address(0))`. Revocation does **not** retire any volumes; volumes coast on remaining batch balance until `BatchDied`.

## 7. API

Signatures only. No implementation.

The surface is declared per actor in `contracts/src/interfaces/`: `IVolumeRegistryOwner` (§7.1), `IVolumeRegistryPayer` (§7.2) and `IVolumeRegistryKeeper` (§7.3) carry only write functions; `IVolumeRegistryViews` carries the public types, the status and reason enums (§4), every event and error (§9), the wiring getters (§10) and the views (§7.4). `IVolumeRegistry` aggregates them and `VolumeRegistry` implements it. An integration for one actor needs that actor's interface plus `IVolumeRegistryViews`, and its client ABI can be generated from those two artifacts. `revoke` appears in both the owner and payer interfaces.

### 7.1 Owner API

```
function createVolume(
    address chunkSigner,
    uint8   depth,
    uint8   bucketDepth,
    uint64  ttlExpiry,          // 0 = no expiry
    bool    immutableBatch
) external returns (bytes32 volumeId);

function registerVolume(
    bytes32 batchId,
    uint64  ttlExpiry           // 0 = no expiry
) external returns (bytes32 volumeId);

function importVolume(
    bytes32 batchId,
    uint64  ttlExpiry           // 0 = no expiry
) external returns (bytes32 volumeId);

function deleteVolume(bytes32 volumeId) external;

function designateFundingWallet(address payer) external;  // payer = 0 to clear
```

- `createVolume` requires `accounts[msg.sender].active == true`. Initial per-chunk balance is not user-chosen: the registry computes `perChunk = currentPrice × graceBlocks` so the volume is born with exactly the runway described in §10.1. Total BZZ charge `= perChunk × (1 << depth)` is pulled from `accounts[msg.sender].payer` via ERC20 `transferFrom` (payer must have approved at least this amount). Registry then calls `PostageStamp.createBatch(chunkSigner, perChunk, depth, bucketDepth, nonce, immutableBatch)`, passing the internally-managed `nextNonce` (§4) and incrementing. It records the returned `batchId = keccak256(abi.encode(address(this), nonce))`, derives `volumeId` from the owner's account nonce and increments it (§4), and inserts into `activeVolumeIds`. Callers discover `volumeId` via the return value or the `VolumeCreated` event. Postage's `minimumInitialBalancePerChunk` floor is guaranteed by the constructor check in §10.
- `registerVolume` brings an existing batch under management without moving BZZ. Preconditions, checked in order: `accounts[msg.sender].active == true`, else `AccountNotActive`; the batch exists and `normalisedBalance > currentTotalOutPayment()`, else `BatchNotLive`; the batch's depth exceeds `PostageStamp.minimumBucketDepth()`, else `BatchDepthTooSmall` (§14). No relation between the caller and the batch owner is required ([ADR-0001](./adr/0001-permissionless-batch-import.md)). Effects: `chunkSigner` and `depth` are read from `PostageStamp.batches(batchId)`, never supplied by the caller; `owner = msg.sender`; `createdAt = block.timestamp`, which for an imported batch is the start of tracking rather than the batch's age; `volumeId` is derived from the owner's account nonce, which is incremented; the volume is inserted into `activeVolumeIds`; `VolumeImported` is emitted with the batch's `normalisedBalance` as read. A `ttlExpiry` already in the past is accepted, as in `createVolume`; the volume retires `VolumeExpired` on its first trigger.
- `importVolume` performs `registerVolume` and then runs §8 on the new volume in the same transaction. It succeeds only if §8 ends in a topup (step 9) or the zero-deficit no-op (step 7). Any other outcome reverts the whole call with `ImportTopupFailed`: in practice `TopupSkipped(PaymentFailed)`, or a retirement edge, of which only `VolumeExpired` (a past `ttlExpiry`) is reachable on a batch that was live a moment earlier. A revert in `PostageStamp.topUp` propagates. `NoAuth` is unreachable because the account check has already passed in the same transaction. On revert nothing persists (I13). Rationale: [ADR-0004](./adr/0004-register-and-import-entry-points.md).
- `deleteVolume` requires `msg.sender == volume.owner && volume.status == Active`. Transitions to `Retired.OwnerDeleted`, swap-and-pop from active list. No on-chain refund (Postage has no reclaim).
- `designateFundingWallet` is unilateral owner action. Does not require any account state.

### 7.2 Payer API

```
function confirmAuth(address owner) external;

function revoke(address owner) external;
```

- `confirmAuth` requires `designated[owner] == msg.sender`. Overwrites any prior `accounts[owner]`.
- `revoke` callable by either owner or current payer.

### 7.3 Keeper API

```
function trigger(bytes32 volumeId) external;
function trigger(bytes32[] calldata volumeIds) external;
function reap(bytes32 volumeId) external;
```

- `trigger(id)` — see §8.
- `trigger(ids[])` — runs §8 on each id in order. It reverts wherever §8 would, so it either processes every id or changes nothing.
- `reap(id)` — retires an `Active` volume whose TTL has passed and otherwise does nothing. It does not inspect Postage batch death, owner, or depth; `trigger` handles those edges.

No state of a volume, account or payer makes a keeper function revert; each ends in an event or a no-op. They revert only on out-of-gas, a paused PostageStamp, or a fault in the registry or Postage. Payer state is read before acting rather than detected by catching a revert, and no keeper path contains a `try/catch`. Rationale and the enumerated conditions: [ADR-0007](./adr/0007-keeper-endpoints-revert-only-on-bugs.md).

### 7.4 Views

```
struct VolumeView {
    bytes32 volumeId;
    bytes32 batchId;
    address owner;
    address payer;          // resolved from accounts[owner]
    address chunkSigner;
    uint64  createdAt;
    uint64  ttlExpiry;
    uint8   depth;
    Status  status;
    bool    accountActive;
}

function getVolume(bytes32 volumeId) external view returns (VolumeView memory);

function getActiveVolumes(uint256 offset, uint256 limit)
    external view returns (VolumeView[] memory);

function getActiveVolumeCount() external view returns (uint256);

function getAccount(address owner) external view returns (Account memory);
```

`getAccount` returns the full `Account`, including `nonce`, so an owner can compute the ID their next creating call will produce, provided their transactions land in order.

`getActiveVolumes` is the keeper's primary read; returns enough data for off-chain policy filters (depth threshold, minimum TTL window, `accountActive`) without a second RPC round-trip per volume.

## 8. Trigger semantics

`trigger(volumeId)`:

1. Load `v = volumes[volumeId]`. If `v.status == None` → emit `TopupSkipped(NotFound)`, return. If `v.status == Retired` → emit `TopupSkipped(NotActive)`, return.
2. Load Postage batch `b = PostageStamp.batches[v.batchId]`. If `b` does not exist or is expired → retire `BatchDied`, emit `VolumeRetired`, return.
3. If `b.owner != v.chunkSigner` → retire `BatchOwnerMismatch`, emit, return.
4. If `b.depth != v.depth` → retire `DepthChanged`, emit, return.
5. If `v.ttlExpiry != 0 && block.timestamp >= v.ttlExpiry` → retire `VolumeExpired`, emit, return.
6. `acct = accounts[v.owner]`. If `!acct.active` → emit `TopupSkipped(NoAuth)`, return. **No retire.**
7. Compute `target = currentPrice × graceBlocks`.
   Compute `remaining = b.normalisedBalance − PostageStamp.currentTotalOutPayment()`, the batch's unspent per-chunk balance (strictly positive, since step 2 retired dead batches). `normalisedBalance` is cumulative and is not itself the remaining balance.
   Compute `deficit = target > remaining ? target - remaining : 0`.
   If `deficit == 0` → return (idempotent no-op).
8. `amount = deficit × (1 << v.depth)`.
   Unless `BZZ.balanceOf(acct.payer) ≥ amount`, `BZZ.allowance(acct.payer, this) ≥ amount`, and, when `bzzPermitExpiry` is set and the allowance is `type(uint256).max`, `BZZ.expirations(acct.payer, this)` is 0 or at least `block.timestamp` → emit `TopupSkipped(PaymentFailed)`, return. **No retire.**
   `BZZ.transferFrom(acct.payer, this, amount)`.
9. `BZZ.approve(postage, amount); PostageStamp.topUp(v.batchId, deficit);` emit `Toppedup`.

The check order matters: batch/depth/TTL retire-edges are evaluated before auth/payment, so a lapsed auth does not mask an expired batch.

Every run of these steps ends in one of four outcomes: Retired (steps 2–5), Skipped (steps 1, 6, 8), NoDeficit (step 7) or ToppedUp (step 9). `trigger` treats all four as success, with the events above. `importVolume` accepts only NoDeficit and ToppedUp (§7.1).

## 9. Events

```
event VolumeCreated(bytes32 indexed volumeId, address indexed owner, bytes32 indexed batchId, address chunkSigner, uint8 depth, uint64 ttlExpiry);
event VolumeImported(bytes32 indexed volumeId, address indexed owner, bytes32 indexed batchId, address chunkSigner, uint8 depth, uint64 ttlExpiry, uint256 normalisedBalance);  // balance as read at registration, before any topup
event VolumeRetired(bytes32 indexed volumeId, RetireReason reason);

event PayerDesignated(address indexed owner, address payer);
event AccountActivated(address indexed owner, address indexed payer);
event AccountRevoked(address indexed owner, address indexed payer, address revoker);

event Toppedup(bytes32 indexed volumeId, uint256 amount, uint256 newNormalisedBalance);
event TopupSkipped(bytes32 indexed volumeId, SkipReason reason);
```

## 10. Deployment parameters

Set once at construction; all four are immutable thereafter:

| Param | Type | Description |
|---|---|---|
| `postage` | address | PostageStamp contract |
| `bzz` | address | BZZ ERC20 |
| `graceBlocks` | uint64 | Target runway per topup cycle, in blocks. Drives both the initial charge at `createVolume` and the topup target in `trigger`. Set per deployment: **17280** (≈ 24 h on Gnosis Chain's 5 s blocks) for Gnosis v1, **120960** (7 d) planned for Gnosis v2, **300** (≈ 1 h at 12 s) for Sepolia `v2-rc2`. See §10.1 for the bound each implies. |
| `bzzPermitExpiry` | bool | Whether `bzz` is the OmniBridge `PermittableToken`, whose legacy `permit` can give an unlimited allowance an expiry that only `expirations(owner, spender)` reveals. Enables that check in §8 step 8. `true` for Gnosis BZZ, `false` for Sepolia BZZ. |

**Constructor checks.**
- `graceBlocks ≥ PostageStamp(postage).minimumValidityBlocks()`. Otherwise `createBatch` would revert with `InsufficientBalance` on every `createVolume` (Postage's own floor is `minimumValidityBlocks × lastPrice` per chunk). Verified at deploy; contract refuses to instantiate if violated.
- `postage` and `bzz` are non-zero.
- If `bzzPermitExpiry` is set, `bzz.expirations(address(0), address(0))` succeeds, so a deployment against a token without it fails here rather than in every topup.

The first check is deployment-time only. `PostageStamp.minimumValidityBlocks()` is
mutable while this registry's `graceBlocks` is immutable. If the Postage administrator
later raises the floor above `graceBlocks`, v1 topups revert; a new compatible registry
deployment is required.

No admin role, no upgradeability. Fresh deploy per chain. Target chain: **Gnosis Chain only**.

### 10.1 Deviation bound for `graceBlocks = 17280`

`graceBlocks` is the runway, in Postage per-chunk-balance-at-current-price units, that the registry charges up front and tops up to. If price stayed flat, a freshly-topped-up volume would survive exactly `graceBlocks` more blocks before its batch dies. Under a rising price, the realised runway is shorter. This section bounds the worst-case shortfall.

**Guarantee we document to users.** If no keeper ever calls `trigger` again after a top-up, the batch dies at block `t0 + T`, where `T / graceBlocks ≥ f` in the worst case permitted by Swarm's `PriceOracle`.

This is conditional on the PriceOracle's rate-limited adjustment path and Postage
availability. A holder of `PRICE_ORACLE_ROLE` can call `setPrice` directly with an
arbitrary value, bypassing the derived rate ceiling, and a paused Postage contract
prevents topups while volumes continue consuming their existing balances.

**Derivation.** At top-up, per-chunk balance is `graceBlocks × p0`, where `p0` is the oracle price at that moment. Drain to time `T` is `∫_0^T p(s) ds`. Swarm's `PriceOracle` (`ethersphere/storage-incentives/src/PriceOracle.sol`) raises price by at most factor `K_max` per round of `U` blocks; skipped rounds apply `K_max` retroactively to each skipped round, so the compound ceiling is genuine. Bounding the drain by a continuous exponential `p(t) ≤ p0 × e^(λt)` with `λ = ln(K_max)/U`:

```
budget = graceBlocks × p0
drain(T) ≤ p0 × (e^(λT) − 1) / λ
setting drain = budget:    e^(λT) = 1 + λ × graceBlocks
=>   f = T / graceBlocks = ln(1 + λ × graceBlocks) / (λ × graceBlocks)
```

**Constants (Swarm PriceOracle on Gnosis Chain).**

| Symbol | Value | Source |
|---|---|---|
| `U` | 152 blocks | `ROUND_LENGTH` |
| `K_max` | 1 049 417 / 1 048 576 ≈ 1.000 802 | `changeRate[0] / priceBase` (also applied to every skipped round via the catchup loop in `adjustPrice`) |
| `λ` | `ln(K_max) / U ≈ 5.27 × 10⁻⁶` per block | derived |

**Computation for `graceBlocks = 17280`.**

```
λ × graceBlocks  ≈ 5.27e−6 × 17280 ≈ 0.09106
f  = ln(1.09106) / 0.09106 ≈ 0.08712 / 0.09106 ≈ 0.9567
```

So the registry guarantees that a volume whose last successful top-up was at block `t0` lives **at least `0.9567 × 17280 ≈ 16532` blocks** after `t0` before its batch dies, even in the pessimistic scenario where the oracle raises price at the maximum permitted rate for every round throughout the grace period. In wall-clock terms on Gnosis (5 s blocks): promised ~24 h, worst-case ~22.95 h.

**Other deployed and planned values.** The same formula, with the same `λ` (the oracle's round length and rate ceiling are in blocks):

| Deployment | `graceBlocks` | `λ × graceBlocks` | `f` | Worst-case runway |
|---|---|---|---|---|
| Gnosis v1 | 17280 (24 h at 5 s) | 0.0911 | 0.9567 | ≈ 16532 blocks ≈ 22.95 h |
| Gnosis v2 (planned) | 120960 (7 d at 5 s) | 0.6375 | 0.7736 | ≈ 93576 blocks ≈ 5.42 d |
| Sepolia `v2-rc2` | 300 (1 h at 12 s) | 0.00158 | 0.9992 | ≈ 299.8 blocks ≈ 59.95 min |

`f` falls as `λ × graceBlocks` grows: the longer the runway, the more of it a sustained maximum-rate price rise can consume. `test/SurvivalFloor.t.sol` runs the worst-case schedule for each of these values and checks the observed death block against `⌊f × graceBlocks⌋`; for 120960 it additionally checks at least 86400 blocks (5 d at 5 s).

**Pessimism.** This is the *floor*, not the expectation. `K_max` only applies when redundancy is reported below target; `PriceOracle` can also *decrease* price (down to a minimum floor), and the neutral `changeRate[4]` leaves price unchanged. Typical realization is at or near 100 %. The 95.67 % figure is the contract-level guarantee we document; normal operation is expected to do much better.

**Changing `graceBlocks` later.** `graceBlocks` is constructor-immutable. A different runway target requires a redeploy. The invariant above is a property of the deployed value only.

## 11. Keeper interface

The registry exposes a permissionless keeper surface (see §7.3): `trigger(volumeId)`, `trigger(bytes32[])`, `reap(volumeId)`, plus the `getActiveVolumes` view for enumeration. Any caller may drive it; the contract makes no assumptions about who runs a keeper, how often, or what policy they apply.

Specific keeper implementations (cron schedule, chain and filter policy, alerting) are out of scope for this document. The registry is neutral infrastructure and is designed to support many concurrent keepers without coordination.

## 12. Symmetries captured

- Account lifecycle: `designate ↔ confirm`; `owner-revoke ↔ payer-revoke`.
- Volume lifecycle: `create | register | import ↔ delete (OwnerDeleted)`.
- Volume entry: `createVolume` = mint batch + register; `importVolume` = register + trigger. One record-writing path and one ID derivation serve all three.
- Retirement edges: five parallel reasons, one terminal state.
- Registry / Paymaster: identical-signature write paths for state, read paths for views.

## 13. Deferred

- Per-volume payer override (multiple funding sources per owner).
- Depth increase (coordinated signer + registry flow).
- Signer rotation (requires Postage extension or off-chain re-keying convention).
- Safe AllowanceModule payment path.
- On-chain EIP-712 auth.
- Operator roles with restricted management capabilities.
- Reliability layer (timelock-gated claimable xDAI stash for keeper upkeep).
- Ownership transfer with explicit recipient acceptance.
- On-chain spam prevention for `registerVolume` / `importVolume` (§5, shared batches).
- An atomic helper for migrating a volume between registry deployments. A helper contract would be `msg.sender` and so become the owner; owners who need atomicity can use a Safe MultiSend or an EIP-7702 batch, and the two steps commute anyway because `deleteVolume` never touches Postage.
- A `volumesByBatch` view. Both creating events index `batchId`, so off-chain consumers can build it.
- **Implicit self-designation** for the single-key profile (owner == payer). Nice-to-have: short-circuit the designate + confirm handshake when `msg.sender` is both owner and payer of the account being opened. Dropped from this version to keep one uniform auth path; can be layered on later without touching any existing invariant.

## 14. Postage constraints

Properties of `PostageStamp` (source: `ethersphere/storage-incentives`) that this design relies on. Verified against the contract; see §3 for the call surface actually used.

- **Batch ownership is immutable.** There is no `transferBatchOwnership` function and there never has been. The only owner-related admin is `copyBatch` (DEFAULT_ADMIN_ROLE, migration-only, cannot overwrite an existing batch). A batch copied into a new Postage deployment is reached by a registry deployed against that Postage, through `registerVolume` / `importVolume`.
- **`batches(id)`** — returns `(owner, depth, bucketDepth, immutableFlag, normalisedBalance, lastUpdatedBlockNumber)`; a non-existent batch has `owner == address(0)`. Registration records `owner` and `depth` from this tuple, so its layout is part of the registry's dependency surface. Consequently, a volume's `chunkSigner`, which the registry asserts equals `batches(id).owner` at creation, cannot rotate during the volume's lifetime — `chunkSigner` is recorded immutably and signer rotation is in §13.
- **`topUp` refuses shallow batches.** It reverts `BatchTooSmall` on a batch with `depth ≤ minimumBucketDepth`. `createBatch` cannot produce one; `copyBatch` can, which is why `registerVolume` rejects them (§7.1).
- **No reclaim or refund.** A batch cannot be destroyed by its owner; funds can only be spent on storage. This is why `deleteVolume` is registry-local bookkeeping only (§7.1) — there is no on-chain refund path to wire up.
- **`createBatch(owner, …)`** — caller pays; the `owner` parameter becomes the batch's owner (and the chunk-signing identity that Bee will recognise). `batchId = keccak256(abi.encode(msg.sender, nonce))`, salted by the caller — hence minted batches have `batchId = keccak256(abi.encode(address(this), nonce))` (§4).
- **`topUp(batchId, increaseInBalancePerChunk)`** — anyone can call; pulls `increaseInBalancePerChunk × (1 << depth)` BZZ from `msg.sender`. The paymaster's trigger path approves PostageStamp for exactly the topup amount and calls this; nothing else can transfer BZZ on the registry's behalf.
- **`increaseDepth(batchId, newDepth)`** — requires `msg.sender == batch.owner`. The registry never calls this; depth changes can only originate from the chunk-signer EOA, and any depth divergence is detected and retired (§6.1 `DepthChanged`).

Implications already woven into the design above:

- Registry cannot own batches (contracts cannot sign chunks off-chain), so the chunk-signer EOA is passed as `_owner` to `createBatch` (§4, §7.1).
- Registry cannot mediate `increaseDepth` (the `msg.sender` check excludes it); depth changes happen directly on Postage and are detected-and-retired by the next trigger (§6.1, threat model in §5).
- "Delete volume" is registry-local bookkeeping; no on-chain reclaim path exists (§7.1).

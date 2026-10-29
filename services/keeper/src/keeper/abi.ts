// The VolumeRegistry surface a keeper cycle touches, and nothing more.
// Kept `as const` so viem can infer per-function argument and return types.
//
// Deliberately partial on the call side: enumeration, the batched write, the
// events that explain what the write did, and the two immutables that check a
// volume the write was silent about. The contract's full error set is here
// regardless, because decoding a failure costs nothing and is worth having when
// there is one.
//
// `trigger(bytes32)` is absent: the keeper sends `trigger(bytes32[])` only.
// That overload runs every id as `try this._triggerExt(id) {} catch {}`, so
// a volume that reverts inside it, out of gas or otherwise, leaves no trace in
// the receipt. The receipt alone cannot tell such a volume from one that
// needed nothing. `runKeeperCycle` checks every volume the receipt is silent
// about against PostageStamp state, through `postage()` and `graceBlocks()`
// below and `postageAbi`. Leaving the single-volume overload out also keeps
// viem's overload inference simple.

export const registryAbi = [
  {
    type: "function",
    name: "getActiveVolumeCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getActiveVolumes",
    stateMutability: "view",
    inputs: [
      { type: "uint256", name: "offset" },
      { type: "uint256", name: "limit" },
    ],
    outputs: [
      {
        type: "tuple[]",
        name: "",
        components: [
          { name: "volumeId", type: "bytes32" },
          { name: "batchId", type: "bytes32" },
          { name: "owner", type: "address" },
          { name: "payer", type: "address" },
          { name: "chunkSigner", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "ttlExpiry", type: "uint64" },
          { name: "depth", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "accountActive", type: "bool" },
        ],
      },
    ],
  },
  // Selected mode only: the ids a caller names are status-checked so the
  // result can report which of them are not Active volumes.
  {
    type: "function",
    name: "getVolume",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "volumeId" }],
    outputs: [
      {
        type: "tuple",
        name: "",
        components: [
          { name: "volumeId", type: "bytes32" },
          { name: "batchId", type: "bytes32" },
          { name: "owner", type: "address" },
          { name: "payer", type: "address" },
          { name: "chunkSigner", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "ttlExpiry", type: "uint64" },
          { name: "depth", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "accountActive", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "trigger",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32[]", name: "volumeIds" }],
    outputs: [],
  },
  // Immutables, read once a cycle to check volumes a receipt is silent about.
  {
    type: "function",
    name: "postage",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "graceBlocks",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  // Events decoded off the trigger receipt to explain per-volume outcomes.
  {
    type: "event",
    name: "Toppedup",
    inputs: [
      { indexed: true, type: "bytes32", name: "volumeId" },
      { indexed: false, type: "uint256", name: "amount" },
      { indexed: false, type: "uint256", name: "newNormalisedBalance" },
    ],
  },
  {
    type: "event",
    name: "TopupSkipped",
    inputs: [
      { indexed: true, type: "bytes32", name: "volumeId" },
      { indexed: false, type: "uint8", name: "reason" },
    ],
  },
  {
    type: "event",
    name: "VolumeRetired",
    inputs: [
      { indexed: true, type: "bytes32", name: "volumeId" },
      { indexed: false, type: "uint8", name: "reason" },
    ],
  },
  // Custom errors, so a revert prints a name instead of a 4-byte blob. These
  // are a decode table like RETIRE_REASONS below, not call surface: viem
  // matches revert data against them by selector, and they add no way to drive
  // the registry. The batched trigger swallows every per-volume revert, so
  // these earn their place when the configured address is not the registry you
  // think it is — a stale deployment, a wrong chain — which is exactly when a
  // keeper's logs are all you have.
  { type: "error", name: "AccountNotActive", inputs: [] },
  { type: "error", name: "BatchNotLive", inputs: [] },
  { type: "error", name: "DesignationClearedOnActivate", inputs: [] },
  {
    type: "error",
    name: "GraceBlocksBelowFloor",
    inputs: [
      { type: "uint64", name: "grace" },
      { type: "uint64", name: "floor_" },
    ],
  },
  { type: "error", name: "ImportTopupFailed", inputs: [] },
  { type: "error", name: "NotAuthorizedToRevoke", inputs: [] },
  { type: "error", name: "NotDesignated", inputs: [] },
  { type: "error", name: "NotVolumeOwner", inputs: [] },
  { type: "error", name: "VolumeNotActive", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

/** `Status` enum values (IVolumeRegistryViews.sol). */
export const VOLUME_STATUS = { active: 1, retired: 2 } as const;

/** `RetireReason` enum values, carried by `VolumeRetired(volumeId, reason)`. */
export const RETIRE_REASONS: Record<number, string> = {
  1: "OwnerDeleted",
  2: "VolumeExpired",
  3: "BatchDied",
  4: "DepthChanged",
  5: "BatchOwnerMismatch",
};

/** `SkipReason` enum values, carried by `TopupSkipped(volumeId, reason)`. */
export const SKIP_REASONS: Record<number, string> = {
  1: "NoAuth",
  2: "PaymentFailed",
};

/**
 * The PostageStamp reads that check a volume the batch receipt says nothing
 * about: its batch's balance against the registry's top-up target, computed
 * the way step 6 of `_triggerOne` computes it.
 */
export const postageAbi = [
  {
    type: "function",
    name: "batches",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "id" }],
    outputs: [
      { type: "address", name: "owner" },
      { type: "uint8", name: "depth" },
      { type: "uint8", name: "bucketDepth" },
      { type: "bool", name: "immutableFlag" },
      { type: "uint256", name: "normalisedBalance" },
      { type: "uint256", name: "lastUpdatedBlockNumber" },
    ],
  },
  {
    type: "function",
    name: "currentTotalOutPayment",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lastPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
] as const;

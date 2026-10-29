// The VolumeRegistry surface a keeper cycle touches, and nothing more.
// Kept `as const` so viem can infer per-function argument and return types.
//
// Deliberately partial on the call side: enumeration, the two trigger
// overloads, and the events that explain what a trigger did. The contract's
// full error set is here regardless, because decoding a failure costs nothing
// and is worth having when there is one.
//
// The keeper sends `trigger(bytes32[])`, which runs every id as
// `try this._triggerExt(id) {} catch {}`: a volume that reverts inside it leaves
// no trace in the receipt. `trigger(bytes32)` is never sent. `runKeeperCycle`
// only simulates it, for a volume the batch receipt is silent about, to
// reproduce that volume's revert and its reason. viem tells the overloads
// apart by their arguments: an array of ids, or one id.

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
  {
    type: "function",
    name: "trigger",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32", name: "volumeId" }],
    outputs: [],
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
  // the registry. A simulated `trigger(bytes32)` reverts with them, which is
  // how a volume the batch swallowed gets a named reason; `VolumeNotActive`
  // there means it retired before the batch reached it. The rest earn their
  // place when the configured address is not the registry you think it is — a
  // stale deployment, a wrong chain — which is exactly when a keeper's logs are
  // all you have.
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


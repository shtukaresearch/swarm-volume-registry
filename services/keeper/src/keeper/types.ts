import type { Hex, ReadContractReturnType } from "viem";
import type { registryAbi } from "./abi.js";

/** One row of `getActiveVolumes` / `getVolume`, inferred straight from the ABI. */
export type VolumeView = ReadContractReturnType<
  typeof registryAbi,
  "getActiveVolumes"
>[number];

/**
 * Which volumes a keeper maintains.
 *
 * - `all` — every volume in the registry's active index.
 * - `selected` — only the listed ids. Ids that are not `Active` (never
 *   created, already retired) are reported and ignored, never fatal.
 */
export type KeeperMode =
  | { type: "all" }
  | { type: "selected"; volumeIds: readonly Hex[] };

/**
 * What the contract did to a volume, decoded from its event in the batch
 * receipt. Discriminated on `outcome`, so `amount` and `reason` are present
 * exactly where they apply.
 *
 * `noop` is a real answer, not an absence of one: step 6 of `_triggerOne`
 * returns silently when the batch already holds at least `graceBlocks` of
 * runway. That is the healthy steady state. Because a volume that reverted
 * inside the batch is just as silent, `noop` is only reported once chain state
 * at the receipt's block confirms the runway.
 */
export type VolumeSummary =
  | { outcome: "toppedUp"; amount: bigint }
  | { outcome: "retired"; reason: string }
  | { outcome: "topupSkipped"; reason: string }
  | { outcome: "noop" };

export type VolumeOutcomeKind = VolumeSummary["outcome"];

export interface VolumeResult {
  volumeId: Hex;
  /**
   * The transaction's fate:
   *
   * - `success` / `reverted` — mined, per the receipt.
   * - `simulated` — dry run; nothing was sent.
   * - `failed` — never mined (the send failed, or the receipt wait timed
   *   out), or mined but the batch skipped this volume: no event, and its
   *   postage batch still short of the top-up target.
   */
  status: "success" | "reverted" | "simulated" | "failed";
  /** What the contract did. Present only when `status` is `success`. */
  outcome?: VolumeOutcomeKind;
  /** BZZ pulled from the payer, when `outcome` is `toppedUp`. */
  amount?: bigint;
  /** Named reason, when `outcome` is `retired` or `topupSkipped`. */
  reason?: string;
  hash?: Hex;
  blockNumber?: bigint;
  /** The whole batch transaction's, shared by every volume in it. */
  gasUsed?: bigint;
  error?: string;
}

/**
 * Something an operator should see: what happened, and — when there is one —
 * the volume it happened to and the transaction that shows it.
 */
export interface KeeperIssue {
  message: string;
  volumeId?: Hex;
  hash?: Hex;
}

export interface VolumeOutcome {
  volumeId: Hex;
  reason: string;
}

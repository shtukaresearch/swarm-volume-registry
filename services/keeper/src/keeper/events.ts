import { parseEventLogs, type Address, type Hex, type Log } from "viem";
import { RETIRE_REASONS, SKIP_REASONS, registryAbi } from "./abi.js";
import type { VolumeOutcome, VolumeSummary } from "./types.js";

export interface DecodedEvents {
  toppedUp: Array<{ volumeId: Hex; amount: bigint }>;
  retired: VolumeOutcome[];
  topupSkipped: VolumeOutcome[];
}

const name = (table: Record<number, string>, reason: number): string =>
  table[reason] ?? `Unknown(${reason})`;

/**
 * Turn a `trigger` receipt into per-volume outcomes.
 *
 * A successful transaction says nothing on its own about whether a volume was
 * funded — the contract emits nothing at all when a volume needed nothing.
 * These events are the only place it explains itself, and a `TopupSkipped`
 * reason distinguishes "the payer revoked authorization" from "the payer is out
 * of BZZ", which is exactly what an operator needs to see.
 */
export function decodeCycleEvents(
  logs: readonly Log[],
  registry: Address,
): DecodedEvents {
  const decoded: DecodedEvents = { toppedUp: [], retired: [], topupSkipped: [] };
  const fromRegistry = logs.filter(
    (log) => log.address.toLowerCase() === registry.toLowerCase(),
  );

  for (const log of parseEventLogs({ abi: registryAbi, logs: fromRegistry })) {
    switch (log.eventName) {
      case "Toppedup":
        decoded.toppedUp.push({
          volumeId: log.args.volumeId,
          amount: log.args.amount,
        });
        break;
      case "VolumeRetired":
        decoded.retired.push({
          volumeId: log.args.volumeId,
          reason: name(RETIRE_REASONS, log.args.reason),
        });
        break;
      case "TopupSkipped":
        decoded.topupSkipped.push({
          volumeId: log.args.volumeId,
          reason: name(SKIP_REASONS, log.args.reason),
        });
        break;
    }
  }

  return decoded;
}

/**
 * One volume's outcome, from a successful batch receipt's decoded events, or
 * `undefined` when the receipt carries none for it.
 *
 * Every branch of `_triggerOne` returns as soon as it emits, so a volume has
 * at most one event. No event is ambiguous in a batch: either the deficit was
 * zero and the contract did nothing, or the volume reverted inside the batch's
 * try/catch. `runKeeperCycle` settles which one from chain state.
 *
 * The receipt holds every volume in the batch, so the `volumeId` filter is what
 * keeps one volume's event from being attributed to another.
 */
export function summarizeVolume(
  decoded: DecodedEvents,
  volumeId: Hex,
): Exclude<VolumeSummary, { outcome: "noop" }> | undefined {
  const mine = (id: Hex) => id.toLowerCase() === volumeId.toLowerCase();

  const toppedUp = decoded.toppedUp.find((e) => mine(e.volumeId));
  if (toppedUp) return { outcome: "toppedUp", amount: toppedUp.amount };

  const retired = decoded.retired.find((e) => mine(e.volumeId));
  if (retired) return { outcome: "retired", reason: retired.reason };

  const skipped = decoded.topupSkipped.find((e) => mine(e.volumeId));
  if (skipped) return { outcome: "topupSkipped", reason: skipped.reason };

  return undefined;
}

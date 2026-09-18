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
 * Reduce a successful single-volume `trigger` receipt to one outcome.
 *
 * `trigger(bytes32)` touches exactly one volume and every branch of
 * `_triggerOne` returns immediately, so at most one of the three events can be
 * present. None of them means `noop` — the deficit was zero and the contract
 * did nothing, which is what a healthy volume looks like.
 *
 * The `volumeId` filter is belt-and-braces: the receipt should carry only this
 * volume's logs, but attributing someone else's event to it would be a silent
 * lie, and the check is free.
 */
export function summarizeVolume(
  decoded: DecodedEvents,
  volumeId: Hex,
): VolumeSummary {
  const mine = (id: Hex) => id.toLowerCase() === volumeId.toLowerCase();

  const toppedUp = decoded.toppedUp.find((e) => mine(e.volumeId));
  if (toppedUp) return { outcome: "toppedUp", amount: toppedUp.amount };

  const retired = decoded.retired.find((e) => mine(e.volumeId));
  if (retired) return { outcome: "retired", reason: retired.reason };

  const skipped = decoded.topupSkipped.find((e) => mine(e.volumeId));
  if (skipped) return { outcome: "topupSkipped", reason: skipped.reason };

  return { outcome: "noop" };
}

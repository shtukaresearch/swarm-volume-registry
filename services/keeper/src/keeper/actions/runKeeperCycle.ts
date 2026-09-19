import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import {
  getBlockNumber,
  multicall,
  simulateContract,
  waitForTransactionReceipt,
} from "viem/actions";
import { getAction } from "viem/utils";
import { VOLUME_STATUS, registryAbi } from "../abi.js";
import { decodeCycleEvents, summarizeVolume } from "../events.js";
import type {
  KeeperIssue,
  KeeperMode,
  VolumeOutcome,
  VolumeResult,
} from "../types.js";
import { collectActiveVolumes } from "./collectActiveVolumes.js";
import { trigger } from "./trigger.js";

export type RunKeeperCycleParameters = {
  registry: Address;
  /** Default `{ type: 'all' }`. */
  mode?: KeeperMode;
  /** Volumes per page in `all` mode. Default 100. */
  pageSize?: number;
  /** Volumes attempted per cycle. Default 50; the rest defers to the next. */
  maxVolumesPerCycle?: number;
  /** Headroom over the gas estimate. Default 1.2 — see {@link trigger}. */
  gasMultiplier?: number;
  /** Lower bound on the scaled estimate. Default 300_000 — see {@link trigger}. */
  gasFloor?: bigint;
  /** Default 1. */
  confirmations?: number;
  /** Per-transaction receipt wait, in ms. Default 60_000. */
  receiptTimeout?: number;
  /** Soft deadline in ms; no *new* transaction starts past it. Default 120_000. */
  cycleTimeout?: number;
  /** Simulate everything, send nothing. */
  dryRun?: boolean;
};

export type RunKeeperCycleReturnType = {
  /** False if any volume's transaction did not confirm. The cycle still ran on. */
  ok: boolean;
  mode: KeeperMode["type"];
  /** The block the volume list was read at. */
  blockNumber?: bigint;
  /** Active volumes found. `warnings` says so if not all of them were attempted. */
  volumeCount: number;
  /** Set when the cycle deliberately did no work. */
  skipped?: string;
  /** One entry per volume attempted, in order. */
  volumes: VolumeResult[];
  /** Decoded from receipts — what actually happened on chain. */
  toppedUp: Array<{ volumeId: Hex; amount: bigint }>;
  retired: VolumeOutcome[];
  /** Volumes the contract declined to fund, with its own reason. */
  topupSkipped: VolumeOutcome[];
  /** Volumes that needed nothing. The healthy majority. */
  noop: Hex[];
  /** Volumes whose transaction reverted, was never mined, or never confirmed. */
  failed: Hex[];
  /** `selected` mode: requested ids that are not Active volumes. */
  notActive: Hex[];
  /**
   * Worth an operator's attention but not a failure (docs/KEEPERS.md): deferred
   * work, retirements, `TopupSkipped`, named ids that are gone. Each names its
   * volume and transaction when it has one, so an alert can too.
   */
  warnings: KeeperIssue[];
  error?: string;
  durationMs: number;
};

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * One full keeper cycle: read the registry's active volumes and trigger each
 * one.
 *
 * **One transaction per volume**, per the v2 keeper convention in
 * docs/KEEPERS.md. The batched `trigger(bytes32[])` is cheaper but runs each id
 * inside the contract's own try/catch, where a gas shortfall is swallowed and
 * the transaction still succeeds — so a batched receipt cannot distinguish a
 * volume that needed nothing from one that was silently starved. Paying for N
 * transactions buys N unambiguous receipts, which is the thing a keeper exists
 * to produce.
 *
 * **No client-side filtering.** Every Active volume is triggered and the
 * contract decides what each one needs. `_triggerOne` tops up only a real
 * deficit, retires a dead batch, and answers `TopupSkipped` when the payer
 * can't or won't pay — so a volume that needs nothing is a no-op costing about
 * 28k gas. Deciding that off-chain would only be saving gas, at the price of a
 * second opinion that can disagree with the chain.
 *
 * **Volumes are processed sequentially**, and every one is attempted even after
 * an earlier one fails; `ok` then reports the run as failed and `failed` names
 * the volumes. Sequential is what keeps nonces safe without the keeper
 * managing them, and it is what bounds a cycle: `cycleTimeout` stops new
 * transactions rather than truncating one in flight, and anything left over is
 * warned about and picked up next cycle. A cycle therefore handles roughly
 * `cycleTimeout / confirmation time` volumes — size the schedule for that
 * against `graceBlocks`.
 *
 * **Never throws.** Every failure is folded into the returned result, because
 * one volume failing must not stop the rest from being attempted, and a run
 * that fails part-way still owes a report of what it did. Check `ok` — the
 * Worker turns a failed cycle into a failed invocation.
 *
 * Stateless and self-healing: nothing is remembered between cycles. If a
 * transaction does not mine, the result reports it (with its hash) and the next
 * cycle re-reads the chain. `trigger` is idempotent, so a late-mining
 * transaction tops up zero — which also makes it safe to run two keepers
 * concurrently for redundancy.
 *
 * The client must be able to both read and write — a wallet client extended
 * with `publicActions`.
 *
 * @example
 * const result = await runKeeperCycle(client, { registry: '0x…' })
 */
export async function runKeeperCycle<
  chain extends Chain | undefined,
  account extends Account | undefined,
>(
  client: Client<Transport, chain, account>,
  parameters: RunKeeperCycleParameters,
): Promise<RunKeeperCycleReturnType> {
  const {
    registry,
    mode = { type: "all" },
    maxVolumesPerCycle = 50,
    confirmations = 1,
    receiptTimeout = 60_000,
    cycleTimeout = 120_000,
    dryRun = false,
  } = parameters;

  const startedAt = Date.now();
  const result: RunKeeperCycleReturnType = {
    ok: true,
    mode: mode.type,
    volumeCount: 0,
    volumes: [],
    toppedUp: [],
    retired: [],
    topupSkipped: [],
    noop: [],
    failed: [],
    notActive: [],
    warnings: [],
    durationMs: 0,
  };

  try {
    // Pin the enumeration to one block: the active index is a swap-and-pop
    // array, so indices shift as volumes retire and paging it across two block
    // heights can silently skip a volume.
    const blockNumber = await getAction(
      client,
      getBlockNumber,
      "getBlockNumber",
    )({});
    result.blockNumber = blockNumber;

    const volumeIds = await collectIds(blockNumber);
    result.volumeCount = volumeIds.length;
    if (volumeIds.length === 0) {
      result.skipped = "no active volumes";
      return result;
    }

    const attempting = volumeIds.slice(0, maxVolumesPerCycle);
    if (attempting.length < volumeIds.length) {
      result.warnings.push({
        message: `maxVolumesPerCycle (${maxVolumesPerCycle}) reached: ${
          volumeIds.length - attempting.length
        } volume(s) deferred to the next cycle`,
      });
    }

    const deadline = startedAt + cycleTimeout;
    for (const [i, volumeId] of attempting.entries()) {
      if (i > 0 && Date.now() > deadline) {
        result.warnings.push({
          message: `cycle deadline reached after ${i} volume(s); ${
            attempting.length - i
          } deferred to the next cycle`,
        });
        break;
      }

      const volume = await sendOne(volumeId);
      result.volumes.push(volume);
      if (volume.status === "failed" || volume.status === "reverted") {
        result.ok = false;
        result.failed.push(volumeId);
      }
    }
  } catch (err) {
    result.ok = false;
    result.error = message(err);
  } finally {
    // Runs before either return hands `result` back, and mutates the same
    // object both of them reference.
    result.durationMs = Date.now() - startedAt;
  }

  return result;

  async function collectIds(blockNumber: bigint): Promise<Hex[]> {
    if (mode.type === "all") {
      const volumes = await collectActiveVolumes(client, {
        registry,
        pageSize: parameters.pageSize,
        blockNumber,
      });
      return volumes.map((v) => v.volumeId);
    }

    // Selected mode still checks status, so a caller who named an id is owed an
    // answer about it. Skipping the check would also spend a gas estimate per
    // dead id only to have it revert `VolumeNotActive` — the same conclusion,
    // one round trip later, reported as a failure rather than as the expected
    // end of a volume's life.
    const views = await getAction(
      client,
      multicall,
      "multicall",
    )({
      allowFailure: false,
      blockNumber,
      contracts: mode.volumeIds.map((volumeId) => ({
        address: registry,
        abi: registryAbi,
        functionName: "getVolume" as const,
        args: [volumeId] as const,
      })),
    });

    const active: Hex[] = [];
    views.forEach((view, i) => {
      if (view.status === VOLUME_STATUS.active) {
        active.push(view.volumeId);
        return;
      }
      const volumeId = mode.volumeIds[i]!;
      result.notActive.push(volumeId);
      result.warnings.push({ volumeId, message: "requested volume is not Active" });
    });
    return active;
  }

  async function sendOne(volumeId: Hex): Promise<VolumeResult> {
    let hash: Hex | undefined;
    try {
      if (dryRun) {
        // `as never`: simulateContract derives its parameter type through the
        // chain formatter, which viem cannot resolve against a generic client.
        await getAction(
          client,
          simulateContract,
          "simulateContract",
        )({
          address: registry,
          abi: registryAbi,
          functionName: "trigger",
          args: [volumeId],
          account: client.account,
          chain: client.chain,
        } as never);
        return { volumeId, status: "simulated" };
      }

      hash = await trigger(client, {
        registry,
        volumeId,
        gasMultiplier: parameters.gasMultiplier,
        gasFloor: parameters.gasFloor,
      });

      const receipt = await getAction(
        client,
        waitForTransactionReceipt,
        "waitForTransactionReceipt",
      )({ hash, confirmations, timeout: receiptTimeout });

      const mined = {
        volumeId,
        hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
      if (receipt.status !== "success") {
        return { ...mined, status: "reverted" as const };
      }

      const summary = summarizeVolume(
        decodeCycleEvents(receipt.logs, registry),
        volumeId,
      );
      switch (summary.outcome) {
        case "toppedUp":
          result.toppedUp.push({ volumeId, amount: summary.amount });
          break;
        case "retired":
          result.retired.push({ volumeId, reason: summary.reason });
          result.warnings.push({
            volumeId,
            hash,
            message: `retired: ${summary.reason}`,
          });
          break;
        case "topupSkipped":
          result.topupSkipped.push({ volumeId, reason: summary.reason });
          result.warnings.push({
            volumeId,
            hash,
            message: `not funded: ${summary.reason}`,
          });
          break;
        case "noop":
          result.noop.push(volumeId);
          break;
      }

      return { ...mined, status: "success" as const, ...summary };
    } catch (err) {
      // A sent-but-unconfirmed transaction still reports its hash so it can be
      // followed up; the next cycle re-decides from chain state regardless.
      return {
        volumeId,
        status: "failed",
        ...(hash ? { hash } : {}),
        error: message(err),
      };
    }
  }
}

import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import {
  BaseError,
  ContractFunctionRevertedError,
  hexToBigInt,
  keccak256,
  numberToHex,
} from "viem";
import {
  estimateMaxPriorityFeePerGas,
  getBlock,
  getBlockNumber,
  getTransactionCount,
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
  VolumeSummary,
  VolumeView,
} from "../types.js";
import { collectActiveVolumes } from "./collectActiveVolumes.js";
import { BATCH_SIZE, TRIGGER_GAS, trigger } from "./trigger.js";

export type RunKeeperCycleParameters = {
  registry: Address;
  /** Default `{ type: 'all' }`. */
  mode?: KeeperMode;
  /** Volumes per page in `all` mode. Default 100. */
  pageSize?: number;
  /** Volumes attempted per cycle. Default 50; the rest defers to the next. */
  maxVolumesPerCycle?: number;
  /** Volumes per transaction. Default {@link BATCH_SIZE}. */
  batchSize?: number;
  /** Each transaction's gas limit. Default {@link TRIGGER_GAS} — see {@link trigger}. */
  gas?: bigint;
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
  /**
   * Volumes whose transaction reverted, was never mined, or never confirmed,
   * and volumes that reverted inside a mined batch.
   */
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

/** What every transaction in a cycle shares, read once — see {@link runKeeperCycle}. */
type Sending = { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };


/**
 * `ids`, rotated to start at a position derived from `blockNumber`.
 *
 * A cycle that hits `cycleTimeout` or `maxVolumesPerCycle` defers the tail of
 * its list. Without rotation that is the same tail every cycle: those volumes
 * are never triggered and die while the head is topped up every time. Starting
 * each cycle at a different place moves the deferred set around, with nothing
 * remembered between cycles.
 *
 * The start comes from a hash of the block, not the block itself: runs on a
 * fixed cron are a near-constant number of blocks apart, and a step that shares
 * a factor with the volume count would revisit the same few starts forever.
 *
 * This spreads a shortfall; it does not remove one. The cycle limits still have
 * to cover every Active volume well within `graceBlocks`.
 */
export function rotateVolumes<T>(ids: readonly T[], blockNumber: bigint): T[] {
  if (ids.length < 2) return [...ids];
  const hash = keccak256(numberToHex(blockNumber, { size: 32 }));
  const start = Number(hexToBigInt(hash) % BigInt(ids.length));
  return [...ids.slice(start), ...ids.slice(0, start)];
}

/**
 * One full keeper cycle: read the registry's active volumes and trigger them,
 * several to a transaction.
 *
 * **Batched**, through `trigger(bytes32[])`: one transaction, nonce and receipt
 * wait per batch rather than per volume, so a cycle reaches several times as
 * many volumes in the same time. Every batch carries the same fixed gas
 * limit; {@link trigger} explains why. The
 * cost is that the contract runs each volume in its own try/catch. A volume
 * that reverts there, whether out of gas, on a PostageStamp revert, or retired
 * since enumeration, leaves no event, the same as a volume that needed nothing.
 * So every volume the receipt is silent about is replayed: `trigger(bytes32)`
 * is simulated for it at the receipt's block, in one multicall. A revert there
 * is the volume's revert in the batch, and it is `failed`, with its reason;
 * `VolumeNotActive` means it retired first, and is reported as retired. No
 * revert is a `noop`. That covers a volume starved of gas inside the batch too,
 * which goes unreported: the next cycle tops it up. Every trigger after the
 * first tops up the deficit since, so a healthy volume almost always has an
 * event, and the replay runs mainly when something reverted.
 *
 * **No client-side filtering.** Every Active volume is triggered and the
 * contract decides what each one needs. `_triggerOne` tops up only a real
 * deficit, retires a dead batch, and answers `TopupSkipped` when the payer
 * can't or won't pay. A volume that needs nothing costs about 30k gas.
 *
 * **Batches are sent sequentially**, and every one is attempted even after an
 * earlier one fails; `ok` then reports the run as failed and `failed` names the
 * volumes. Sequential is what keeps nonces safe without the keeper managing
 * them, and it is what bounds a cycle: `cycleTimeout` stops new transactions
 * rather than truncating one in flight, and anything left over is warned about
 * and picked up next cycle. Each cycle starts somewhere different in the list
 * ({@link rotateVolumes}), so what one cycle defers, a later one reaches.
 *
 * **Nonce and fees are read once per cycle**, not once per transaction: every
 * RPC request is a subrequest, and a platform's per-invocation cap on those
 * bounds a cycle as surely as `cycleTimeout` does. The nonce is counted up
 * locally, which is safe for the same reason sequential sending is: nothing
 * else spends from this wallet mid-cycle. Any failure discards both, and the
 * next send reads them fresh.
 *
 * **Never throws.** Every failure is folded into the returned result, because
 * one batch failing must not stop the rest from being attempted, and a run
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
    batchSize = BATCH_SIZE,
    confirmations = 1,
    receiptTimeout = 60_000,
    cycleTimeout = 120_000,
    dryRun = false,
  } = parameters;

  const startedAt = Date.now();
  let sending: Sending | undefined;
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
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
    }

    // Pin the enumeration to one block: the active index is a swap-and-pop
    // array, so indices shift as volumes retire and paging it across two block
    // heights can silently skip a volume.
    const blockNumber = await getAction(
      client,
      getBlockNumber,
      "getBlockNumber",
    )({});
    result.blockNumber = blockNumber;

    const volumes = await collectViews(blockNumber);
    result.volumeCount = volumes.length;
    if (volumes.length === 0) {
      result.skipped = "no active volumes";
      return result;
    }

    const attempting = rotateVolumes(volumes, blockNumber).slice(0, maxVolumesPerCycle);
    if (attempting.length < volumes.length) {
      result.warnings.push({
        message: `maxVolumesPerCycle (${maxVolumesPerCycle}) reached: ${
          volumes.length - attempting.length
        } volume(s) deferred to the next cycle`,
      });
    }

    const deadline = startedAt + cycleTimeout;
    let done = 0;
    while (done < attempting.length) {
      if (done > 0 && Date.now() > deadline) {
        result.warnings.push({
          message: `cycle deadline reached after ${done} volume(s); ${
            attempting.length - done
          } deferred to the next cycle`,
        });
        break;
      }

      const batch = await sendBatch(attempting.slice(done));
      done += batch.length;
      for (const volume of batch) {
        result.volumes.push(volume);
        if (volume.status === "failed" || volume.status === "reverted") {
          result.ok = false;
          result.failed.push(volume.volumeId);
        }
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

  async function collectViews(blockNumber: bigint): Promise<VolumeView[]> {
    if (mode.type === "all") {
      return collectActiveVolumes(client, {
        registry,
        pageSize: parameters.pageSize,
        blockNumber,
      });
    }

    // Selected mode still checks status, so a caller who named an id is owed an
    // answer about it. Sending a dead id would get no answer at all: the batch
    // swallows its `VolumeNotActive`.
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

    const active: VolumeView[] = [];
    views.forEach((view, i) => {
      if (view.status === VOLUME_STATUS.active) {
        active.push(view);
        return;
      }
      const volumeId = mode.volumeIds[i]!;
      result.notActive.push(volumeId);
      result.warnings.push({ volumeId, message: "requested volume is not Active" });
    });
    return active;
  }

  /**
   * The fee cap is fixed for the whole cycle, so it carries twice the current
   * base fee: enough for about six consecutive full blocks of increases. Only
   * the base fee actually due, plus the tip, is paid.
   */
  async function readSending(): Promise<Sending> {
    const address = client.account!.address;
    const [nonce, block, maxPriorityFeePerGas] = await Promise.all([
      getAction(client, getTransactionCount, "getTransactionCount")({
        address,
        blockTag: "pending",
      }),
      getAction(client, getBlock, "getBlock")({}),
      getAction(
        client,
        estimateMaxPriorityFeePerGas,
        "estimateMaxPriorityFeePerGas",
      )({ chain: client.chain }),
    ]);
    const baseFee = block.baseFeePerGas ?? 0n;
    return { nonce, maxFeePerGas: baseFee * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas };
  }

  /** Trigger the head of `pending`, as many as one transaction takes. */
  async function sendBatch(pending: VolumeView[]): Promise<VolumeResult[]> {
    const batch = pending.slice(0, batchSize);
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
          args: [batch.map((v) => v.volumeId)],
          account: client.account,
          chain: client.chain,
        } as never);
        return batch.map((v) => ({ volumeId: v.volumeId, status: "simulated" as const }));
      }

      sending ??= await readSending();
      hash = await trigger(client, {
        registry,
        volumeIds: batch.map((v) => v.volumeId),
        gas: parameters.gas,
        nonce: sending.nonce,
        maxFeePerGas: sending.maxFeePerGas,
        maxPriorityFeePerGas: sending.maxPriorityFeePerGas,
      });
      sending.nonce++;

      const receipt = await getAction(
        client,
        waitForTransactionReceipt,
        "waitForTransactionReceipt",
      )({ hash, confirmations, timeout: receiptTimeout });

      // gasUsed is the whole transaction's, shared by every volume in it.
      const mined = {
        hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
      if (receipt.status !== "success") {
        return batch.map((v) => ({ volumeId: v.volumeId, ...mined, status: "reverted" as const }));
      }

      const decoded = decodeCycleEvents(receipt.logs, registry);
      const summaries = batch.map((v) => summarizeVolume(decoded, v.volumeId));
      const silent = batch.filter((_, i) => !summaries[i]);
      const replayed = await replaySilent(silent, receipt.blockNumber);

      return batch.map((v, i) => {
        const summary = summaries[i] ?? replayed.get(v.volumeId)!;
        if (summary instanceof Error) {
          return { volumeId: v.volumeId, ...mined, status: "failed" as const, error: summary.message };
        }
        record(v.volumeId, hash!, summary);
        return { volumeId: v.volumeId, ...mined, status: "success" as const, ...summary };
      });
    } catch (err) {
      // Whether a failed send used its nonce is unknowable from here, and a
      // stuck transaction may mean the fees went stale: read them again.
      sending = undefined;
      // A sent-but-unconfirmed transaction still reports its hash so it can be
      // followed up; the next cycle re-decides from chain state regardless.
      return batch.map((v) => ({
        volumeId: v.volumeId,
        status: "failed" as const,
        ...(hash ? { hash } : {}),
        error: message(err),
      }));
    }
  }

  /**
   * What happened to each volume a mined batch emitted nothing for, found by
   * simulating `trigger(bytes32)` for it at the batch's block, all in one
   * multicall. A volume that reverted inside the batch reverts the same way
   * here, with its reason: an Error carrying it, or a retirement when the
   * reason is `VolumeNotActive`. One that does not revert is a `noop`: it
   * needed nothing, or it ran out of gas inside the batch, which the next cycle
   * makes up for. An Error for every volume when the simulation itself failed.
   */
  async function replaySilent(
    silent: VolumeView[],
    blockNumber: bigint,
  ): Promise<Map<Hex, VolumeSummary | Error>> {
    const replayed = new Map<Hex, VolumeSummary | Error>();
    if (silent.length === 0) return replayed;

    try {
      const results = await getAction(
        client,
        multicall,
        "multicall",
      )({
        allowFailure: true,
        blockNumber,
        contracts: silent.map((v) => ({
          address: registry,
          abi: registryAbi,
          functionName: "trigger" as const,
          args: [v.volumeId] as const,
        })),
      });

      results.forEach((outcome, i) => {
        const { volumeId } = silent[i]!;
        if (outcome.status === "success") {
          replayed.set(volumeId, { outcome: "noop" });
          return;
        }
        const reason = revertReason(outcome.error);
        replayed.set(
          volumeId,
          reason === "VolumeNotActive"
            ? { outcome: "retired", reason: "before this batch reached it" }
            : new Error(`reverted inside the batch: ${reason}`),
        );
      });
    } catch (err) {
      const error = new Error(
        `the batch emitted nothing for this volume, and simulating it failed: ${message(err)}`,
      );
      for (const v of silent) replayed.set(v.volumeId, error);
    }
    return replayed;
  }

  /** File a volume's outcome under the result's lists, and warn where it warrants. */
  function record(volumeId: Hex, hash: Hex, summary: VolumeSummary): void {
    switch (summary.outcome) {
      case "toppedUp":
        result.toppedUp.push({ volumeId, amount: summary.amount });
        break;
      case "retired":
        result.retired.push({ volumeId, reason: summary.reason });
        result.warnings.push({ volumeId, hash, message: `retired: ${summary.reason}` });
        break;
      case "topupSkipped":
        result.topupSkipped.push({ volumeId, reason: summary.reason });
        result.warnings.push({ volumeId, hash, message: `not funded: ${summary.reason}` });
        break;
      case "noop":
        result.noop.push(volumeId);
        break;
    }
  }
}

/**
 * A simulated call's revert, as its reason: the registry's error name, a
 * PostageStamp `require` message, or the first line of viem's message when
 * there is no revert data to decode.
 */
function revertReason(err: Error): string {
  const reverted =
    err instanceof BaseError
      ? err.walk((e) => e instanceof ContractFunctionRevertedError)
      : null;
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.data && reverted.data.errorName !== "Error") return reverted.data.errorName;
    if (reverted.reason) return reverted.reason;
  }
  return err instanceof BaseError ? err.shortMessage : message(err);
}

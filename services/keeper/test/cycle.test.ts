import { describe, expect, test } from "vitest";
import { collectActiveVolumes } from "../src/keeper/actions/collectActiveVolumes.js";
import { getActiveVolumeCount } from "../src/keeper/actions/getActiveVolumeCount.js";
import { rotateVolumes, runKeeperCycle } from "../src/keeper/actions/runKeeperCycle.js";
import { batchGas, trigger } from "../src/keeper/actions/trigger.js";
import { REGISTRY, mockChain, volumeId, type MockVolume } from "./mock-chain.js";

const GRACE = 17_280n;
const PRICE = 44_445n;
const OUT = 1_000_000n;
const TARGET = GRACE * PRICE;

/** The mock's block, and so the order a cycle against it triggers in. */
const BLOCK = 8_000_000n;
const inCycleOrder = (ns: number[]) => rotateVolumes(ns.map(volumeId), BLOCK);

// The mock serves real PostageStamp state for these fixtures. The keeper sends
// both alike, and reads that state only to check a volume the receipt is silent
// about.
const funded = (n: number): MockVolume => ({
  volumeId: volumeId(n),
  batch: { normalisedBalance: OUT + TARGET * 2n },
});

const due = (n: number): MockVolume => ({
  volumeId: volumeId(n),
  batch: { normalisedBalance: OUT + 1n },
});

describe("read actions", () => {
  test("getActiveVolumeCount counts the index", async () => {
    const { client } = mockChain({ volumes: [funded(1), funded(2)] });
    expect(await getActiveVolumeCount(client, { registry: REGISTRY })).toBe(2n);
  });

  test("collectActiveVolumes pages 150 volumes through multicall", async () => {
    const volumes = Array.from({ length: 150 }, (_, i) => funded(i + 1));
    const chain = mockChain({ volumes });
    const { client } = chain;

    const collected = await collectActiveVolumes(client, { registry: REGISTRY });
    expect(collected).toHaveLength(150);
    expect(chain.multicallCount).toBeGreaterThan(0);
  });

  test("collectActiveVolumes on an empty registry does no page reads", async () => {
    const { client } = mockChain({ volumes: [] });
    expect(await collectActiveVolumes(client, { registry: REGISTRY })).toEqual([]);
  });
});

describe("trigger", () => {
  test("sends every id it was given, in one transaction", async () => {
    const chain = mockChain({ volumes: [due(1), due(2)] });
    const hash = await trigger(chain.client, {
      registry: REGISTRY,
      volumeIds: [volumeId(1), volumeId(2)],
    });

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.batches).toEqual([[volumeId(1), volumeId(2)]]);
  });

  // The batch swallows an inner out-of-gas, so an estimate would find a limit
  // that starves volumes. Each gets its share of a fixed limit instead.
  test("sets aside gas for every volume, without estimating", async () => {
    const chain = mockChain({ volumes: [due(1), due(2), due(3)] });
    await trigger(chain.client, {
      registry: REGISTRY,
      volumeIds: [volumeId(1), volumeId(2), volumeId(3)],
    });

    expect(chain.sentGas).toEqual([100_000n + 3n * 2_000_000n]);
    expect(chain.calls).not.toContain("eth_estimateGas");
    expect(chain.calls).not.toContain("eth_call");
  });

  test("gasPerVolume changes each volume's share", async () => {
    const chain = mockChain({ volumes: [due(1), due(2)] });
    await trigger(chain.client, {
      registry: REGISTRY,
      volumeIds: [volumeId(1), volumeId(2)],
      gasPerVolume: 500_000n,
    });
    expect(chain.sentGas).toEqual([batchGas(2, 500_000n)]);
  });

  // EIP-7825: a node rejects a gas limit above 2^24 outright.
  test("refuses more volumes than fit under the transaction gas cap", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => volumeId(i + 1));
    const chain = mockChain({ volumes: ids.map((_, i) => due(i + 1)) });
    await expect(
      trigger(chain.client, { registry: REGISTRY, volumeIds: ids }),
    ).rejects.toThrow(/send at most 8/);
    expect(chain.batches).toHaveLength(0);
  });

  test("refuses an empty batch", async () => {
    const chain = mockChain({ volumes: [] });
    await expect(
      trigger(chain.client, { registry: REGISTRY, volumeIds: [] }),
    ).rejects.toThrow(/at least one volume/);
  });
});

describe("rotateVolumes", () => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8].map(volumeId);

  test("is a rotation of its input, the same for the same block", () => {
    const rotated = rotateVolumes(ids, BLOCK);
    const start = ids.indexOf(rotated[0]!);
    expect(rotated).toEqual([...ids.slice(start), ...ids.slice(0, start)]);
    expect(rotateVolumes(ids, BLOCK)).toEqual(rotated);
  });

  // A cron's step between runs can share a factor with the volume count: with
  // 10 volumes and 50 blocks a run, rotating by the raw block number would
  // start every run at the same place.
  test("does not follow a constant block step", () => {
    const tenIds = Array.from({ length: 10 }, (_, i) => volumeId(i + 1));
    const starts = new Set(
      Array.from({ length: 12 }, (_, run) => rotateVolumes(tenIds, BLOCK + BigInt(run * 50))[0]),
    );
    expect(starts.size).toBeGreaterThan(1);
  });

  test("leaves empty and single-volume lists alone", () => {
    expect(rotateVolumes([], BLOCK)).toEqual([]);
    expect(rotateVolumes([volumeId(1)], BLOCK)).toEqual([volumeId(1)]);
  });
});

describe("runKeeperCycle", () => {
  test("an empty registry sends nothing", async () => {
    const chain = mockChain({ volumes: [] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("no active volumes");
    expect(chain.triggerCalls).toHaveLength(0);
  });

  // No client-side filtering: the contract decides what each id needs, and a
  // fully-funded volume is a no-op on chain.
  test("a fully-funded registry still triggers every volume, in one tx", async () => {
    const chain = mockChain({ volumes: [funded(1), funded(2)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.volumeCount).toBe(2);
    expect(chain.batches).toEqual([inCycleOrder([1, 2])]);
  });

  test("every active volume is triggered, due or not", async () => {
    const chain = mockChain({ volumes: [funded(1), due(2), funded(3)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.volumeCount).toBe(3);
    expect(chain.triggerCalls).toEqual(inCycleOrder([1, 2, 3]));
    expect(result.volumes.map((v) => v.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
  });

  // PostageStamp state checks what a mined batch did; it never picks what to
  // send. A receipt with an event for every volume leaves nothing to check.
  test("reads PostageStamp state only for volumes the receipt is silent about", async () => {
    const busy = mockChain({ volumes: [due(1), due(2)] });
    await runKeeperCycle(busy.client, { registry: REGISTRY });
    expect(busy.postageReads).toBe(0);

    const quiet = mockChain({ volumes: [funded(1), due(2)] });
    await runKeeperCycle(quiet.client, { registry: REGISTRY });
    // currentTotalOutPayment, lastPrice, and volume 1's batch.
    expect(quiet.postageReads).toBe(3);
  });

  test("splits the attempted volumes into transactions of batchSize", async () => {
    const chain = mockChain({ volumes: Array.from({ length: 5 }, (_, i) => due(i + 1)) });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY, batchSize: 2 });

    expect(result.ok).toBe(true);
    expect(chain.batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(chain.triggerCalls).toEqual(inCycleOrder([1, 2, 3, 4, 5]));
  });

  test("by default, as many volumes as fit under the transaction gas cap", async () => {
    const chain = mockChain({ volumes: Array.from({ length: 10 }, (_, i) => funded(i + 1)) });
    await runKeeperCycle(chain.client, { registry: REGISTRY, maxVolumesPerCycle: 10 });

    expect(chain.batches.map((b) => b.length)).toEqual([8, 2]);
  });

  test("a batchSize that cannot fit is a failed cycle, not a rejected send", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY, batchSize: 9 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/batchSize must be between 1 and 8/);
    expect(chain.batches).toHaveLength(0);
  });

  // The node wants the whole limit × fee cap covered up front. Fee cap here:
  // twice the mock's 1 gwei base fee plus its 0.001 gwei tip.
  test("a wallet that cannot reserve a full batch sends smaller ones, and warns", async () => {
    const chain = mockChain({
      volumes: Array.from({ length: 5 }, (_, i) => due(i + 1)),
      balance: 5_000_000n * 2_001_000_000n, // gas for 2 volumes, not 3
    });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(chain.batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(result.warnings).toEqual([
      {
        message:
          "keeper balance covers the gas for 2 volume(s) per transaction at the current fee cap, below the batch size of 8",
      },
    ]);
  });
});

// A batch receipt carries every volume's event, each attributed to its own
// volume. A volume without one is checked against chain state, since the batch
// swallows a reverting volume as silently as a healthy one.
describe("per-volume outcomes", () => {
  test("a funded volume needing nothing reports noop, not silence", async () => {
    const chain = mockChain({ volumes: [funded(1)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.noop).toEqual([volumeId(1)]);
    expect(result.volumes[0]).toMatchObject({
      volumeId: volumeId(1),
      status: "success",
      outcome: "noop",
    });
    expect(result.warnings).toEqual([]);
  });

  test("a topped-up volume carries its amount", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    const expected = (TARGET - 1n) << 20n;
    expect(result.toppedUp).toEqual([{ volumeId: volumeId(1), amount: expected }]);
    expect(result.volumes[0]).toMatchObject({
      outcome: "toppedUp",
      amount: expected,
    });
  });

  test("a revoked payer reads back as NoAuth and warns", async () => {
    const chain = mockChain({ volumes: [{ ...due(1), accountActive: false }] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    // Not a failure: only the user or payer can fix this, never the keeper.
    expect(result.ok).toBe(true);
    expect(result.topupSkipped).toEqual([
      { volumeId: volumeId(1), reason: "NoAuth" },
    ]);
    // Named volume and transaction, so the alert can point at both.
    expect(result.warnings).toEqual([
      {
        volumeId: volumeId(1),
        hash: result.volumes[0]!.hash!,
        message: "not funded: NoAuth",
      },
    ]);
  });

  test("a payer out of BZZ reads back as PaymentFailed", async () => {
    const chain = mockChain({ volumes: [{ ...due(1), payerBroke: true }] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.topupSkipped).toEqual([
      { volumeId: volumeId(1), reason: "PaymentFailed" },
    ]);
  });

  test("a volume with no batch is triggered so the contract can retire it", async () => {
    const chain = mockChain({ volumes: [{ volumeId: volumeId(1) }] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(chain.triggerCalls).toEqual([volumeId(1)]);
    expect(result.retired).toEqual([{ volumeId: volumeId(1), reason: "BatchDied" }]);
    expect(result.warnings).toEqual([
      {
        volumeId: volumeId(1),
        hash: result.volumes[0]!.hash!,
        message: "retired: BatchDied",
      },
    ]);
  });

  test("an expired volume retires with its own reason", async () => {
    const chain = mockChain({
      volumes: [{ ...due(1), ttlExpiry: 1_600_000_000n }],
      timestamp: 1_700_000_000n,
    });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.retired).toEqual([
      { volumeId: volumeId(1), reason: "VolumeExpired" },
    ]);
  });

  test("outcomes are attributed per volume across a mixed registry", async () => {
    const chain = mockChain({
      volumes: [
        funded(1),
        due(2),
        { ...due(3), accountActive: false },
        { volumeId: volumeId(4) },
      ],
    });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    const outcomes = Object.fromEntries(result.volumes.map((v) => [v.volumeId, v.outcome]));
    expect(outcomes).toEqual({
      [volumeId(1)]: "noop",
      [volumeId(2)]: "toppedUp",
      [volumeId(3)]: "topupSkipped",
      [volumeId(4)]: "retired",
    });
    expect(result.noop).toEqual([volumeId(1)]);
    expect(result.toppedUp.map((t) => t.volumeId)).toEqual([volumeId(2)]);
    expect(result.topupSkipped.map((t) => t.volumeId)).toEqual([volumeId(3)]);
    expect(result.retired.map((r) => r.volumeId)).toEqual([volumeId(4)]);
    // One transaction, so every volume shares its hash.
    expect(new Set(result.volumes.map((v) => v.hash)).size).toBe(1);
  });

  // The failure the batch hides: the transaction succeeds, the volume's inner
  // call ran out of gas and was swallowed, and it is still due.
  test("a volume the batch skipped fails, though its transaction succeeded", async () => {
    const chain = mockChain({ volumes: [due(1), { ...due(2), starve: true }, funded(3)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([volumeId(2)]);
    const byId = Object.fromEntries(result.volumes.map((v) => [v.volumeId, v]));
    expect(byId[volumeId(2)]).toMatchObject({ status: "failed", hash: byId[volumeId(1)]!.hash });
    expect(byId[volumeId(2)]?.error).toContain("reverted inside the batch");
    expect(byId[volumeId(1)]).toMatchObject({ status: "success", outcome: "toppedUp" });
    expect(byId[volumeId(3)]).toMatchObject({ status: "success", outcome: "noop" });
  });

  // Swallowed or not, a volume with its full runway is what a keeper is for.
  test("a skipped volume that needed nothing is still a noop", async () => {
    const chain = mockChain({ volumes: [{ ...funded(1), starve: true }] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.noop).toEqual([volumeId(1)]);
  });

  // The race a keeper hits when a volume retires between the pinned block and
  // the batch: its `VolumeNotActive` is swallowed, and the check finds it gone.
  test("a volume retired before the batch reached it is reported retired", async () => {
    // The mock's active index still lists it; getVolume says Retired.
    const chain = mockChain({ volumes: [due(1), { ...due(2), status: 2 }] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.retired).toEqual([
      { volumeId: volumeId(2), reason: "before this batch reached it" },
    ]);
    expect(result.warnings.map((w) => w.message)).toContain(
      "retired: before this batch reached it",
    );
  });
});

describe("bounds and failures", () => {
  test("hitting maxVolumesPerCycle defers the rest and says so", async () => {
    const volumes = Array.from({ length: 5 }, (_, i) => due(i + 1));
    const chain = mockChain({ volumes });
    const result = await runKeeperCycle(chain.client, {
      registry: REGISTRY,
      maxVolumesPerCycle: 2,
    });

    expect(chain.triggerCalls).toEqual(inCycleOrder([1, 2, 3, 4, 5]).slice(0, 2));
    expect(result.volumeCount).toBe(5);
    expect(result.warnings.map((w) => w.message).join(" ")).toContain(
      "3 volume(s) deferred",
    );
  });

  // The incident this guards against: 8 volumes, room for 2 a run, and the same
  // 2 triggered every run while the other 6 ran down to death.
  test("what one cycle defers, later cycles reach", async () => {
    const volumes = Array.from({ length: 8 }, (_, i) => due(i + 1));
    const reached = new Set<string>();
    // Ten-minute cron at 12 s blocks: runs about 50 blocks apart.
    for (let run = 0; run < 12; run++) {
      const chain = mockChain({ volumes, blockNumber: BLOCK + BigInt(run * 50) });
      await runKeeperCycle(chain.client, { registry: REGISTRY, maxVolumesPerCycle: 2 });
      for (const id of chain.triggerCalls) reached.add(id);
    }
    expect(reached.size).toBe(8);
  });

  test("a reverted transaction fails every volume in it, without throwing", async () => {
    const chain = mockChain({ volumes: [due(1), due(2)], revertTx: true });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(false);
    expect(result.volumes.map((v) => v.status)).toEqual(["reverted", "reverted"]);
    expect(result.volumes[0]?.hash).toBeDefined();
    expect(result.failed).toEqual(inCycleOrder([1, 2]));
  });

  // KEEPERS.md: process every configured volume even if an earlier one fails,
  // then report the run as failed and name the volumes affected.
  test("one failing batch does not stop the ones after it", async () => {
    const chain = mockChain({ volumes: [due(1), due(2), due(3)], rejectSends: [1] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY, batchSize: 1 });

    const [first, ...rest] = inCycleOrder([1, 2, 3]);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([first]);
    expect(result.volumes[0]?.error).toContain("underpriced");
    expect(result.volumes.slice(1).map((v) => v.status)).toEqual(["success", "success"]);
    expect(chain.triggerCalls).toEqual(rest);
  });

  test("a dead RPC produces an error result, not a throw", async () => {
    const chain = mockChain({ volumes: [due(1)], failWith: "socket hang up" });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("socket hang up");
  });

  test("a stuck transaction keeps its hash for follow-up, on every volume in it", async () => {
    const chain = mockChain({ volumes: [due(1), due(2)], dropReceipts: true });
    const result = await runKeeperCycle(chain.client, {
      registry: REGISTRY,
      receiptTimeout: 300,
    });

    expect(result.ok).toBe(false);
    expect(result.volumes.map((v) => v.status)).toEqual(["failed", "failed"]);
    expect(result.volumes[0]?.hash).toBeDefined();
    expect(result.volumes[1]?.hash).toBe(result.volumes[0]?.hash);
  });

  test("dryRun simulates and sends nothing", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const result = await runKeeperCycle(chain.client, {
      registry: REGISTRY,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.volumeCount).toBe(1);
    expect(result.volumes[0]?.status).toBe("simulated");
    expect(chain.triggerCalls).toHaveLength(0);
    expect(chain.calls).not.toContain("eth_sendRawTransaction");
  });
});

// Every RPC request is a subrequest, and Workers Free allows 50 an invocation.
describe("RPC budget", () => {
  const count = (calls: string[], method: string) => calls.filter((c) => c === method).length;

  test("nonce, fees and balance are read once a cycle, not once a batch", async () => {
    const volumes = Array.from({ length: 5 }, (_, i) => due(i + 1));
    const chain = mockChain({ volumes });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY, batchSize: 2 });

    expect(result.ok).toBe(true);
    expect(chain.batches).toHaveLength(3);
    expect(count(chain.calls, "eth_getTransactionCount")).toBe(1);
    expect(count(chain.calls, "eth_maxPriorityFeePerGas")).toBe(1);
    expect(count(chain.calls, "eth_getBlockByNumber")).toBe(1);
    expect(count(chain.calls, "eth_getBalance")).toBe(1);
    // Nothing left to fill, so viem never asks the node to fill it.
    expect(count(chain.calls, "eth_fillTransaction")).toBe(0);
  });

  // Enumeration, then the registry's immutables once, then one check per
  // batch with a silent volume in it.
  test("one multicall a batch checks its silent volumes", async () => {
    const volumes = Array.from({ length: 5 }, (_, i) => funded(i + 1));
    const chain = mockChain({ volumes });
    await runKeeperCycle(chain.client, { registry: REGISTRY, batchSize: 2 });

    expect(chain.multicallCount).toBe(1 + 1 + 3);
  });

  test("consecutive sends carry consecutive nonces", async () => {
    const chain = mockChain({ volumes: [due(1), due(2), due(3)] });
    await runKeeperCycle(chain.client, { registry: REGISTRY, batchSize: 1 });

    expect(chain.sentNonces).toEqual([0, 1, 2]);
  });

  test("a failed send makes the next one read nonce and fees again", async () => {
    const chain = mockChain({ volumes: [due(1), due(2), due(3)], rejectSends: [2] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY, batchSize: 1 });

    expect(result.failed).toHaveLength(1);
    expect(chain.batches).toHaveLength(2);
    expect(count(chain.calls, "eth_getTransactionCount")).toBe(2);
  });

  // The batch's own `trigger` is spent on chain; a silent volume is not a
  // reason to re-read anything.
  test("a volume the batch skipped does not reset nonce and fees", async () => {
    const chain = mockChain({
      volumes: [due(1), { ...due(2), starve: true }, due(3)],
    });
    await runKeeperCycle(chain.client, { registry: REGISTRY, batchSize: 1 });

    expect(chain.sentNonces).toEqual([0, 1, 2]);
    expect(count(chain.calls, "eth_getTransactionCount")).toBe(1);
  });
});

describe("selected mode", () => {
  test("leaves other people's due volumes alone", async () => {
    const chain = mockChain({ volumes: [due(1), due(2)] });
    const result = await runKeeperCycle(chain.client, {
      registry: REGISTRY,
      mode: { type: "selected", volumeIds: [volumeId(1)] },
    });

    expect(result.mode).toBe("selected");
    expect(chain.triggerCalls).toEqual([volumeId(1)]);
  });

  // A named id that has disappeared is a warning, not a failure — and catching
  // it in the status read costs nothing, where sending it would get no answer:
  // the batch swallows its `VolumeNotActive`.
  test("flags ids that are not Active volumes, and warns", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const result = await runKeeperCycle(chain.client, {
      registry: REGISTRY,
      mode: { type: "selected", volumeIds: [volumeId(1), volumeId(99)] },
    });

    expect(result.ok).toBe(true);
    expect(result.notActive).toEqual([volumeId(99)]);
    // No transaction was spent on it, so there is no hash to name.
    expect(result.warnings).toEqual([
      { volumeId: volumeId(99), message: "requested volume is not Active" },
    ]);
    expect(chain.triggerCalls).toEqual([volumeId(1)]);
  });
});

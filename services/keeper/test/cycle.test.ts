import { describe, expect, test } from "bun:test";
import { collectActiveVolumes } from "../src/keeper/actions/collectActiveVolumes.js";
import { getActiveVolumeCount } from "../src/keeper/actions/getActiveVolumeCount.js";
import { runKeeperCycle } from "../src/keeper/actions/runKeeperCycle.js";
import { trigger } from "../src/keeper/actions/trigger.js";
import { REGISTRY, mockChain, volumeId, type MockVolume } from "./mock-chain.js";

const GRACE = 17_280n;
const PRICE = 44_445n;
const OUT = 1_000_000n;
const TARGET = GRACE * PRICE;

// The mock serves real PostageStamp state for these fixtures. The keeper never
// reads it — that is the point of `funded` and `due` looking different here and
// producing identical transactions below.
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
  test("sends the one id it was given", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const hash = await trigger(chain.client, {
      registry: REGISTRY,
      volumeId: volumeId(1),
    });

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.triggerCalls).toEqual([volumeId(1)]);
  });

  test("an explicit gas limit skips estimation", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    await trigger(chain.client, {
      registry: REGISTRY,
      volumeId: volumeId(1),
      gas: 1_000_000n,
    });
    expect(chain.calls).not.toContain("eth_estimateGas");
    expect(chain.sentGas[0]).toBe(1_000_000n);
  });

  // Estimation reverts exactly as the call would, so a separate simulate pass
  // would only cost a round trip.
  test("does not spend an eth_call simulating first", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    await trigger(chain.client, { registry: REGISTRY, volumeId: volumeId(1) });

    expect(chain.calls).toContain("eth_estimateGas");
    expect(chain.calls).not.toContain("eth_call");
  });

  test("scales the estimate by gasMultiplier", async () => {
    const chain = mockChain({ volumes: [due(1)], estimateGas: 500_000n });
    await trigger(chain.client, { registry: REGISTRY, volumeId: volumeId(1) });
    expect(chain.sentGas[0]).toBe(600_000n); // 500k × 1.2

    const custom = mockChain({ volumes: [due(1)], estimateGas: 500_000n });
    await trigger(custom.client, {
      registry: REGISTRY,
      volumeId: volumeId(1),
      gasMultiplier: 2,
    });
    expect(custom.sentGas[0]).toBe(1_000_000n);
  });

  // A volume that estimates as a ~28k no-op can need the whole transferFrom →
  // approve → topUp path by the time it is included. Scaling alone would not
  // cover that; the floor does.
  test("a no-op estimate is raised to the gas floor", async () => {
    const chain = mockChain({ volumes: [funded(1)], estimateGas: 28_000n });
    await trigger(chain.client, { registry: REGISTRY, volumeId: volumeId(1) });
    expect(chain.sentGas[0]).toBe(300_000n);

    const custom = mockChain({ volumes: [funded(1)], estimateGas: 28_000n });
    await trigger(custom.client, {
      registry: REGISTRY,
      volumeId: volumeId(1),
      gasFloor: 500_000n,
    });
    expect(custom.sentGas[0]).toBe(500_000n);
  });

  test("a scaled estimate above the floor is not clamped down to it", async () => {
    const chain = mockChain({ volumes: [due(1)], estimateGas: 40_000_000n });
    await trigger(chain.client, { registry: REGISTRY, volumeId: volumeId(1) });
    expect(chain.sentGas[0]).toBe(48_000_000n);
  });

  // No batching try/catch stands between `_triggerOne`'s status check and the
  // caller any more, so a dead id fails at estimation and no gas is spent.
  test("a volume that is not Active reverts before anything is sent", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    await expect(
      trigger(chain.client, { registry: REGISTRY, volumeId: volumeId(99) }),
    ).rejects.toThrow(/VolumeNotActive/);
    expect(chain.triggerCalls).toHaveLength(0);
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

  // One transaction per volume, per docs/KEEPERS.md. No client-side filtering:
  // the contract decides what each id needs, and a fully-funded volume is a
  // no-op on chain.
  test("a fully-funded registry still triggers every volume, one tx each", async () => {
    const chain = mockChain({ volumes: [funded(1), funded(2)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.volumeCount).toBe(2);
    expect(chain.triggerCalls).toEqual([volumeId(1), volumeId(2)]);
  });

  test("every active volume is triggered, due or not", async () => {
    const chain = mockChain({ volumes: [funded(1), due(2), funded(3)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.volumeCount).toBe(3);
    expect(chain.triggerCalls).toEqual([volumeId(1), volumeId(2), volumeId(3)]);
    expect(result.volumes.map((v) => v.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
  });

  // The keeper carries no PostageStamp ABI at all, and this is why: nothing on
  // the cycle path may form a second opinion about what a volume needs.
  test("reads no PostageStamp state — the contract does that itself", async () => {
    const chain = mockChain({ volumes: [funded(1), due(2)] });
    await runKeeperCycle(chain.client, { registry: REGISTRY });

    // Enumeration only: no batches()/lastPrice()/graceBlocks() round trips.
    expect(chain.postageReads).toBe(0);
  });
});

// The point of one transaction per volume: every volume's receipt describes
// only that volume, so each outcome is attributable — including the absence of
// an event, which the batched overload could not tell apart from gas
// starvation.
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

    expect(result.volumes.map((v) => v.outcome)).toEqual([
      "noop",
      "toppedUp",
      "topupSkipped",
      "retired",
    ]);
    expect(result.noop).toEqual([volumeId(1)]);
    expect(result.toppedUp.map((t) => t.volumeId)).toEqual([volumeId(2)]);
    expect(result.topupSkipped.map((t) => t.volumeId)).toEqual([volumeId(3)]);
    expect(result.retired.map((r) => r.volumeId)).toEqual([volumeId(4)]);
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

    expect(chain.triggerCalls).toEqual([volumeId(1), volumeId(2)]);
    expect(result.volumeCount).toBe(5);
    expect(result.warnings.map((w) => w.message).join(" ")).toContain(
      "3 volume(s) deferred",
    );
  });

  test("a reverted transaction fails the cycle without throwing", async () => {
    const chain = mockChain({ volumes: [due(1)], revertTx: true });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(false);
    expect(result.volumes[0]?.status).toBe("reverted");
    expect(result.volumes[0]?.hash).toBeDefined();
    expect(result.failed).toEqual([volumeId(1)]);
  });

  // KEEPERS.md: process every configured volume even if an earlier one fails,
  // then report the run as failed and name the volumes affected.
  test("one failing volume does not stop the ones after it", async () => {
    const chain = mockChain({
      volumes: [due(1), { ...due(2), status: 2 }, due(3)],
    });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    // The retired volume is still in the mock's active index, so enumeration
    // hands it over and its trigger reverts at estimation — the race a keeper
    // hits when a volume retires between the pinned block and the send.
    expect(result.ok).toBe(false);
    expect(result.volumes.map((v) => v.status)).toEqual([
      "success",
      "failed",
      "success",
    ]);
    expect(result.failed).toEqual([volumeId(2)]);
    expect(result.volumes[1]?.error).toContain("VolumeNotActive");
    expect(chain.triggerCalls).toEqual([volumeId(1), volumeId(3)]);
  });

  test("a dead RPC produces an error result, not a throw", async () => {
    const chain = mockChain({ volumes: [due(1)], failWith: "socket hang up" });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("socket hang up");
  });

  test("a stuck transaction keeps its hash for follow-up", async () => {
    const chain = mockChain({ volumes: [due(1)], dropReceipts: true });
    const result = await runKeeperCycle(chain.client, {
      registry: REGISTRY,
      receiptTimeout: 300,
    });

    expect(result.ok).toBe(false);
    expect(result.volumes[0]?.status).toBe("failed");
    expect(result.volumes[0]?.hash).toBeDefined();
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
  // it in the status read costs nothing, where letting it through would burn a
  // gas estimate to reach the same conclusion.
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

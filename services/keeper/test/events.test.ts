import { describe, expect, test } from "bun:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { registryAbi } from "../src/keeper/abi.js";
import { decodeCycleEvents, summarizeVolume } from "../src/keeper/events.js";
import { REGISTRY, volumeId } from "./mock-chain.js";

const OTHER_CONTRACT = "0x9999999999999999999999999999999999999999" as Address;

const log = (
  eventName: "Toppedup" | "TopupSkipped" | "VolumeRetired",
  volume: Hex,
  data: Hex,
  address: Address = REGISTRY,
): Log =>
  ({
    address,
    topics: encodeEventTopics({
      abi: registryAbi,
      eventName,
      args: { volumeId: volume },
    }),
    data,
    blockNumber: 1n,
    blockHash: keccak256(toHex("b")),
    transactionHash: keccak256(toHex("t")),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  }) as Log;

const uint8 = (n: number) => encodeAbiParameters([{ type: "uint8" }], [n]);
const topup = (amount: bigint) =>
  encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [amount, 42n]);

describe("decodeCycleEvents", () => {
  test("a successful top-up reports its amount", () => {
    const decoded = decodeCycleEvents(
      [log("Toppedup", volumeId(1), topup(5000n))],
      REGISTRY,
    );
    expect(decoded.toppedUp).toEqual([{ volumeId: volumeId(1), amount: 5000n }]);
  });

  test("skip reasons are named, not left as numbers", () => {
    const decoded = decodeCycleEvents(
      [
        log("TopupSkipped", volumeId(1), uint8(1)),
        log("TopupSkipped", volumeId(2), uint8(2)),
      ],
      REGISTRY,
    );
    expect(decoded.topupSkipped).toEqual([
      { volumeId: volumeId(1), reason: "NoAuth" },
      { volumeId: volumeId(2), reason: "PaymentFailed" },
    ]);
  });

  test("every retire reason the contract can emit is named", () => {
    const decoded = decodeCycleEvents(
      [1, 2, 3, 4, 5].map((reason) =>
        log("VolumeRetired", volumeId(reason), uint8(reason)),
      ),
      REGISTRY,
    );
    expect(decoded.retired.map((r) => r.reason)).toEqual([
      "OwnerDeleted",
      "VolumeExpired",
      "BatchDied",
      "DepthChanged",
      "BatchOwnerMismatch",
    ]);
  });

  test("an unrecognised reason code survives as-is", () => {
    const decoded = decodeCycleEvents(
      [log("VolumeRetired", volumeId(1), uint8(9))],
      REGISTRY,
    );
    expect(decoded.retired[0]?.reason).toBe("Unknown(9)");
  });

  test("logs from other contracts are ignored", () => {
    const decoded = decodeCycleEvents(
      [log("Toppedup", volumeId(1), topup(1n), OTHER_CONTRACT)],
      REGISTRY,
    );
    expect(decoded.toppedUp).toEqual([]);
  });

  test("the registry address is matched case-insensitively", () => {
    const decoded = decodeCycleEvents(
      [log("Toppedup", volumeId(1), topup(1n), REGISTRY.toUpperCase() as Address)],
      REGISTRY,
    );
    expect(decoded.toppedUp).toHaveLength(1);
  });

  test("a mixed receipt is split by outcome", () => {
    const decoded = decodeCycleEvents(
      [
        log("Toppedup", volumeId(1), topup(100n)),
        log("TopupSkipped", volumeId(2), uint8(1)),
        log("VolumeRetired", volumeId(3), uint8(2)),
      ],
      REGISTRY,
    );
    expect(decoded.toppedUp).toHaveLength(1);
    expect(decoded.topupSkipped).toHaveLength(1);
    expect(decoded.retired).toHaveLength(1);
  });

  test("an empty receipt decodes to nothing", () => {
    expect(decodeCycleEvents([], REGISTRY)).toEqual({
      toppedUp: [],
      retired: [],
      topupSkipped: [],
    });
  });
});

const decode = (logs: Log[]) => decodeCycleEvents(logs, REGISTRY);

describe("summarizeVolume", () => {
  // The whole reason a v2 keeper spends a transaction per volume: an empty
  // receipt is an answer, not a gap. Batched, this was indistinguishable from
  // an inner call that ran out of gas and got swallowed.
  test("no events means the volume needed nothing", () => {
    expect(summarizeVolume(decode([]), volumeId(1))).toEqual({ outcome: "noop" });
  });

  test("a top-up carries its amount", () => {
    const summary = summarizeVolume(
      decode([log("Toppedup", volumeId(1), topup(5000n))]),
      volumeId(1),
    );
    expect(summary).toEqual({ outcome: "toppedUp", amount: 5000n });
  });

  test("a retirement carries its named reason", () => {
    const summary = summarizeVolume(
      decode([log("VolumeRetired", volumeId(1), uint8(3))]),
      volumeId(1),
    );
    expect(summary).toEqual({ outcome: "retired", reason: "BatchDied" });
  });

  test("a skip carries its named reason", () => {
    const summary = summarizeVolume(
      decode([log("TopupSkipped", volumeId(1), uint8(2))]),
      volumeId(1),
    );
    expect(summary).toEqual({ outcome: "topupSkipped", reason: "PaymentFailed" });
  });

  test("another volume's event is never attributed to this one", () => {
    const summary = summarizeVolume(
      decode([log("Toppedup", volumeId(2), topup(5000n))]),
      volumeId(1),
    );
    expect(summary).toEqual({ outcome: "noop" });
  });

  test("the volume id is matched case-insensitively", () => {
    const summary = summarizeVolume(
      decode([log("Toppedup", volumeId(0xab), topup(1n))]),
      volumeId(0xab).toUpperCase().replace("0X", "0x") as Hex,
    );
    expect(summary.outcome).toBe("toppedUp");
  });
});

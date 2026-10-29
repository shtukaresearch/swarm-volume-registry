import { describe, expect, test } from "vitest";
import { decodeErrorResult, encodeErrorResult, encodeFunctionData } from "viem";
import { postageAbi, registryAbi } from "../src/keeper/abi.js";

// `forge inspect VolumeRegistry methodIdentifiers`, run against
// contracts/src/VolumeRegistry.sol. The hand-written ABI has to encode the same
// calls the deployed contract answers to.
const METHODS = {
  "getActiveVolumeCount()": "0xe7b4ed6a",
  "getActiveVolumes(uint256,uint256)": "0x68abda20",
  "getVolume(bytes32)": "0x92650fb3",
  "trigger(bytes32[])": "0x5ef6eac9",
  "postage()": "0x6af20da1",
  "graceBlocks()": "0x9ee0a21e",
} as const;

const ID = `0x${"11".repeat(32)}` as const;

describe("registry call ABI", () => {
  const encoded = {
    "getActiveVolumeCount()": encodeFunctionData({
      abi: registryAbi,
      functionName: "getActiveVolumeCount",
    }),
    "getActiveVolumes(uint256,uint256)": encodeFunctionData({
      abi: registryAbi,
      functionName: "getActiveVolumes",
      args: [0n, 100n],
    }),
    "getVolume(bytes32)": encodeFunctionData({
      abi: registryAbi,
      functionName: "getVolume",
      args: [ID],
    }),
    "trigger(bytes32[])": encodeFunctionData({
      abi: registryAbi,
      functionName: "trigger",
      args: [[ID, ID]],
    }),
    "postage()": encodeFunctionData({ abi: registryAbi, functionName: "postage" }),
    "graceBlocks()": encodeFunctionData({ abi: registryAbi, functionName: "graceBlocks" }),
  } as const;

  for (const [signature, selector] of Object.entries(METHODS)) {
    test(`${signature} encodes to ${selector}`, () => {
      expect(encoded[signature as keyof typeof METHODS].slice(0, 10)).toBe(selector);
    });
  }

  // The keeper sends the batched overload only. With both overloads in the
  // ABI, viem picks one by its arguments, and a single id would quietly go
  // out as `trigger(bytes32)`.
  test("carries the batched trigger and no other", () => {
    const triggers = registryAbi.filter(
      (item) => item.type === "function" && item.name === "trigger",
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      inputs: [{ type: "bytes32[]", name: "volumeIds" }],
    });
  });
});

// The subset of Swarm's PostageStamp in contracts/src/interfaces/IPostageStampLike.sol.
describe("postage call ABI", () => {
  const cases = [
    ["batches(bytes32)", "0xc81e25ab", encodeFunctionData({ abi: postageAbi, functionName: "batches", args: [ID] })],
    ["currentTotalOutPayment()", "0x51b17cd0", encodeFunctionData({ abi: postageAbi, functionName: "currentTotalOutPayment" })],
    ["lastPrice()", "0x053f14da", encodeFunctionData({ abi: postageAbi, functionName: "lastPrice" })],
  ] as const;

  for (const [signature, selector, data] of cases) {
    test(`${signature} encodes to ${selector}`, () => {
      expect(data.slice(0, 10)).toBe(selector);
    });
  }
});

// Selectors as the compiler computes them: `forge inspect VolumeRegistry
// errors`, run against contracts/src/VolumeRegistry.sol. A mismatch means the
// hand-written ABI has drifted from the contract — a renamed error or a
// changed argument type — and revert data would silently stop decoding.
type ErrorName = Extract<(typeof registryAbi)[number], { type: "error" }>["name"];

// Exhaustive by construction: adding an error to the ABI without pinning its
// selector here is a type error, not a test that quietly stops covering it.
const SELECTORS: Record<ErrorName, `0x${string}`> = {
  AccountNotActive: "0x4d571464",
  BatchNotLive: "0xe004958b",
  DesignationClearedOnActivate: "0x2b8cb86b",
  GraceBlocksBelowFloor: "0xa728cabc",
  ImportTopupFailed: "0xf60090aa",
  NotAuthorizedToRevoke: "0xb4a8529c",
  NotDesignated: "0x69f3dfcd",
  NotVolumeOwner: "0x431be6b7",
  VolumeNotActive: "0x2f607c28",
  ZeroAddress: "0xd92e233d",
};

const ARGS: Partial<Record<ErrorName, readonly unknown[]>> = {
  GraceBlocksBelowFloor: [1n, 17_280n],
};

describe("registry error ABI", () => {
  const errors = registryAbi.filter((item) => item.type === "error");

  test("carries the contract's whole error set, and nothing invented", () => {
    const names: string[] = errors.map((e) => e.name);
    expect(names.sort()).toEqual(Object.keys(SELECTORS).sort());
  });

  for (const [name, selector] of Object.entries(SELECTORS)) {
    test(`${name} encodes to ${selector}`, () => {
      const args = ARGS[name as ErrorName];
      const data = encodeErrorResult({
        abi: registryAbi,
        errorName: name,
        ...(args ? { args } : {}),
      } as never);
      expect(data.slice(0, 10)).toBe(selector);
    });
  }

  test("revert data decodes to a name, not a blob", () => {
    // What viem hands back off a failed eth_call against the registry.
    expect(decodeErrorResult({ abi: registryAbi, data: "0x2f607c28" })).toMatchObject({
      errorName: "VolumeNotActive",
    });
  });

  test("an error with arguments decodes them too", () => {
    const data = encodeErrorResult({
      abi: registryAbi,
      errorName: "GraceBlocksBelowFloor",
      args: [1n, 17_280n],
    });
    expect(decodeErrorResult({ abi: registryAbi, data })).toMatchObject({
      errorName: "GraceBlocksBelowFloor",
      args: [1n, 17_280n],
    });
  });
});

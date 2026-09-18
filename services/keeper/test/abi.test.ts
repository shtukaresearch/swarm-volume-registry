import { describe, expect, test } from "bun:test";
import { decodeErrorResult, encodeErrorResult, encodeFunctionData } from "viem";
import { registryAbi } from "../src/keeper/abi.js";

// `forge inspect VolumeRegistry methodIdentifiers`, run against
// contracts/src/VolumeRegistry.sol. The hand-written ABI has to encode the same
// calls the deployed contract answers to.
const METHODS = {
  "getActiveVolumeCount()": "0xe7b4ed6a",
  "getActiveVolumes(uint256,uint256)": "0x68abda20",
  "getVolume(bytes32)": "0x92650fb3",
  "trigger(bytes32)": "0x4c097cb4",
} as const;

/** The overload a v2 keeper must not call. Present on chain, absent from this ABI. */
const BATCHED_TRIGGER = "0x5ef6eac9";

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
      args: [`0x${"11".repeat(32)}`],
    }),
    "trigger(bytes32)": encodeFunctionData({
      abi: registryAbi,
      functionName: "trigger",
      args: [`0x${"11".repeat(32)}`],
    }),
  } as const;

  for (const [signature, selector] of Object.entries(METHODS)) {
    test(`${signature} encodes to ${selector}`, () => {
      expect(encoded[signature as keyof typeof METHODS].slice(0, 10)).toBe(selector);
    });
  }

  // docs/KEEPERS.md: a v2 keeper calls trigger(bytes32) per volume. The batched
  // overload swallows per-item reverts, so a gas-starved volume is
  // indistinguishable from a healthy one. Leaving it out of this ABI is what
  // makes that unbypassable — put it back and the keeper can silently regress.
  test("carries no batched trigger to fall back to", () => {
    expect(encoded["trigger(bytes32)"].slice(0, 10)).not.toBe(BATCHED_TRIGGER);

    const triggers = registryAbi.filter(
      (item) => item.type === "function" && item.name === "trigger",
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      inputs: [{ type: "bytes32", name: "volumeId" }],
    });
  });
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
  DesignationClearedOnActivate: "0x2b8cb86b",
  GraceBlocksBelowFloor: "0xa728cabc",
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

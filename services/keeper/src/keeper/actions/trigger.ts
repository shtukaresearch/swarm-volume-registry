import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { estimateContractGas, writeContract } from "viem/actions";
import { getAction } from "viem/utils";
import { registryAbi } from "../abi.js";

export type TriggerParameters = {
  registry: Address;
  volumeId: Hex;
  /** Defaults to the client's account. */
  account?: Account | Address;
  chain?: Chain | null;
  /** Explicit gas limit, skipping estimation entirely. */
  gas?: bigint;
  /** Headroom over the estimate. Default 1.2 — see below for why it matters. */
  gasMultiplier?: number;
  /** Lower bound on the scaled estimate. Default 3_000_000 — see below. */
  gasFloor?: bigint;
  /** Fetched by viem when omitted. */
  nonce?: number;
  /** EIP-1559 fees, fetched by viem when either is omitted. */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type TriggerReturnType = Hex;

const scaleGas = (gas: bigint, multiplier: number): bigint =>
  (gas * BigInt(Math.round(multiplier * 100))) / 100n;

/**
 * Top up (or retire) one volume.
 *
 * Idempotent: the contract tops up to a target, so a second call in the same
 * block transfers nothing.
 *
 * One volume per call is the v2 keeper convention (docs/KEEPERS.md). The
 * batched `trigger(bytes32[])` swallows per-item reverts, which makes a
 * gas-starved volume indistinguishable from a healthy one; here the volume owns
 * the whole transaction, so it reverts when it fails and its receipt describes
 * only itself.
 *
 * **The gas limit still needs headroom, for a different reason than batching
 * did.** `_triggerOne` branches on state read at execution time: a volume that
 * estimates as a ~28k no-op today needs the full `transferFrom` → `approve` →
 * `topUp` path — several times that — if the postage price moves, or its batch
 * is consumed further, between estimation and inclusion. An estimate taken on
 * the cheap branch and spent on the expensive one is an out-of-gas revert. So
 * the estimate is scaled by `gasMultiplier` *and* floored at `gasFloor`, which
 * covers the top-up path outright. Unused gas is refunded, so the floor costs
 * nothing on the no-op path it usually lands on.
 *
 * The top-up path itself varies with PostageStamp state: on Sepolia it has
 * cost from ~480k to ~1.5M, and a trigger estimated at ~680k one block ran out
 * of gas inside `topUp` the next. Hence a floor well above anything observed,
 * not just above a typical top-up.
 *
 * Estimation doubles as the pre-flight check: `_triggerOne` reverts
 * `VolumeNotActive` on a volume retired since enumeration, and that revert
 * surfaces here — named, before a transaction is paid for.
 *
 * @example
 * const hash = await trigger(walletClient, {
 *   registry: '0x…',
 *   volumeId: '0x…',
 * })
 */
export async function trigger<
  chain extends Chain | undefined,
  account extends Account | undefined,
>(
  client: Client<Transport, chain, account>,
  parameters: TriggerParameters,
): Promise<TriggerReturnType> {
  const {
    registry,
    volumeId,
    account = client.account,
    chain = client.chain,
    gasMultiplier = 1.2,
    gasFloor = 3_000_000n,
  } = parameters;

  const call = {
    address: registry,
    abi: registryAbi,
    functionName: "trigger",
    args: [volumeId],
    account,
    chain,
  } as const;

  // No separate simulate pass: estimation runs the same call and reverts the
  // same way, so an eth_call first would only cost a round trip. `prepare:
  // false`, because the node needs only from, to and data to estimate, and
  // for a local account viem would otherwise fetch a nonce, a block and a tip
  // for every estimate — round trips the send then repeats.
  let gas = parameters.gas;
  if (gas === undefined) {
    const estimate = await getAction(
      client,
      estimateContractGas,
      "estimateContractGas",
    )({ ...call, prepare: false } as never);
    gas = scaleGas(estimate, gasMultiplier);
    if (gas < gasFloor) gas = gasFloor;
  }

  // With chainId, nonce and fees all supplied, viem has nothing left to fill
  // and sends without first trying `eth_fillTransaction`.
  const { nonce, maxFeePerGas, maxPriorityFeePerGas } = parameters;
  return getAction(
    client,
    writeContract,
    "writeContract",
  )({ ...call, gas, chainId: chain?.id, nonce, maxFeePerGas, maxPriorityFeePerGas } as never);
}

import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { estimateContractGas, writeContract } from "viem/actions";
import { getAction } from "viem/utils";
import { registryAbi } from "../abi.js";

export type EstimateTriggerGasParameters = {
  registry: Address;
  volumeIds: readonly Hex[];
  /** Defaults to the client's account. */
  account?: Account | Address;
};

export type TriggerParameters = EstimateTriggerGasParameters & {
  chain?: Chain | null;
  /** The transaction's gas limit. Default {@link estimateTriggerGas}. */
  gas?: bigint;
  /** Fetched by viem when omitted. */
  nonce?: number;
  /** EIP-1559 fees, fetched by viem when either is omitted. */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type TriggerReturnType = Hex;

/** EIP-7825: no transaction may carry a gas limit above 2^24. */
export const TX_GAS_LIMIT_CAP = 16_777_216n;

/**
 * Percent added to a batch's `pending` estimate, for PostageStamp writes by
 * others between estimate and inclusion. Replaying 300 Gnosis registry
 * transactions (2026-11), the estimate only ever fell short across the
 * sender's own earlier write, which this keeper waits out; across others'
 * writes it never did.
 */
export const GAS_HEADROOM_PERCENT = 5n;

/**
 * Gas limit a batch is shrunk to fit, so one keeper transaction never claims
 * a large share of a block. A single volume above it is still sent.
 */
export const MAX_BATCH_GAS = 4_000_000n;

/** Most volumes per transaction; {@link MAX_BATCH_GAS} usually binds first. */
export const BATCH_SIZE = 8;

/**
 * The gas limit to send `trigger(volumeIds)` with: its `eth_estimateGas` at the
 * `pending` block plus {@link GAS_HEADROOM_PERCENT}, capped at
 * {@link TX_GAS_LIMIT_CAP}.
 *
 * From v2-rc4 the estimate is meaningful (ADR-0007): nothing in the batch
 * swallows out-of-gas any more, so it measures the work actually done. What
 * that work is depends on the block: a volume topped up in the latest block
 * is at target there and takes the cheap path, ~22–50k, but every block
 * drains its batch, so one block later it needs a top-up. Geth and reth both
 * estimate `pending` on an empty block after the latest, so every volume
 * that will need a top-up at inclusion already takes that path in the
 * estimate. Blocks further ahead estimate the same. The keeper estimates
 * only after its previous batch's receipt, so its own writes are already in
 * the state. Unused gas is not charged, and the receipt's `gasUsed` stays
 * ~15% below the estimate: storage refunds are deducted only after
 * execution, and each external call holds back 1/64 of the gas left.
 *
 * The estimate doubles as the batch's simulation. It throws in the same cases
 * the transaction would revert: out of gas, a paused PostageStamp, or a fault.
 * viem decodes the revert against the registry's errors.
 */
export async function estimateTriggerGas<
  chain extends Chain | undefined,
  account extends Account | undefined,
>(
  client: Client<Transport, chain, account>,
  parameters: EstimateTriggerGasParameters,
): Promise<bigint> {
  const { registry, volumeIds, account = client.account } = parameters;
  // `as never`: estimateContractGas derives its parameter type through the
  // chain formatter, which viem cannot resolve against a generic client.
  // `prepare: false`, or viem first fetches nonce and fees for a local account,
  // which the estimate does not need and each costs a subrequest.
  const estimate = await getAction(
    client,
    estimateContractGas,
    "estimateContractGas",
  )({
    address: registry,
    abi: registryAbi,
    functionName: "trigger",
    args: [volumeIds],
    account,
    blockTag: "pending",
    prepare: false,
  } as never);
  const limit = estimate + (estimate * GAS_HEADROOM_PERCENT + 99n) / 100n;
  return limit < TX_GAS_LIMIT_CAP ? limit : TX_GAS_LIMIT_CAP;
}

/**
 * Top up (or retire) several volumes in one transaction, through the batched
 * `trigger(bytes32[])`.
 *
 * Idempotent: the contract tops up to a target, so a second call in the same
 * block transfers nothing.
 *
 * Without `gas`, the limit comes from {@link estimateTriggerGas}, which throws
 * rather than sending a batch that would revert.
 *
 * @example
 * const hash = await trigger(walletClient, {
 *   registry: '0x…',
 *   volumeIds: ['0x…', '0x…'],
 * })
 */
export async function trigger<
  chain extends Chain | undefined,
  account extends Account | undefined,
>(
  client: Client<Transport, chain, account>,
  parameters: TriggerParameters,
): Promise<TriggerReturnType> {
  const { registry, volumeIds, account = client.account, chain = client.chain } = parameters;

  if (volumeIds.length === 0) throw new Error("trigger needs at least one volume");
  const gas =
    parameters.gas ?? (await estimateTriggerGas(client, { registry, volumeIds, account }));
  if (gas > TX_GAS_LIMIT_CAP) {
    throw new Error(`gas ${gas} is above the ${TX_GAS_LIMIT_CAP} transaction cap`);
  }

  // With chainId, gas, nonce and fees all supplied, viem has nothing left to
  // fill and sends without first trying `eth_fillTransaction`.
  const { nonce, maxFeePerGas, maxPriorityFeePerGas } = parameters;
  return getAction(
    client,
    writeContract,
    "writeContract",
  )({
    address: registry,
    abi: registryAbi,
    functionName: "trigger",
    args: [volumeIds],
    account,
    chain,
    gas,
    chainId: chain?.id,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
  } as never);
}

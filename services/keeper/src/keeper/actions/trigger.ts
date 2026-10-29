import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { writeContract } from "viem/actions";
import { getAction } from "viem/utils";
import { registryAbi } from "../abi.js";

export type TriggerParameters = {
  registry: Address;
  volumeIds: readonly Hex[];
  /** Defaults to the client's account. */
  account?: Account | Address;
  chain?: Chain | null;
  /** Gas set aside for each volume. Default 2_000_000 — see below. */
  gasPerVolume?: bigint;
  /** Fetched by viem when omitted. */
  nonce?: number;
  /** EIP-1559 fees, fetched by viem when either is omitted. */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type TriggerReturnType = Hex;

/** EIP-7825: no transaction may carry a gas limit above 2^24. */
export const TX_GAS_LIMIT_CAP = 16_777_216n;

/** The transaction's own share of the limit: intrinsic gas, calldata, the loop. */
export const BATCH_OVERHEAD_GAS = 100_000n;

/** Default gas set aside per volume — see {@link trigger}. */
export const GAS_PER_VOLUME = 2_000_000n;

/** The gas limit {@link trigger} sends `count` volumes with. */
export const batchGas = (count: number, gasPerVolume = GAS_PER_VOLUME): bigint =>
  BATCH_OVERHEAD_GAS + BigInt(count) * gasPerVolume;

/** The most volumes one transaction can carry at `gasPerVolume` each. */
export const maxBatchSize = (gasPerVolume = GAS_PER_VOLUME): number =>
  Number((TX_GAS_LIMIT_CAP - BATCH_OVERHEAD_GAS) / gasPerVolume);

/**
 * Top up (or retire) several volumes in one transaction, through the batched
 * `trigger(bytes32[])`.
 *
 * Idempotent: the contract tops up to a target, so a second call in the same
 * block transfers nothing.
 *
 * **The gas limit is fixed, never estimated.** The contract runs each id as
 * `try this._triggerExt(id) {} catch {}`, and an inner call that runs out of
 * gas is caught like any other revert, so the batch succeeds at almost any
 * limit. An estimate is the lowest limit at which the transaction succeeds, so
 * it would be a limit at which volumes run out of gas and are skipped. Instead
 * every volume gets `gasPerVolume`, enough for the whole `transferFrom` →
 * `approve` → `topUp` path. On Sepolia that path has cost from ~480k to ~1.5M,
 * depending on PostageStamp state. Unused gas is refunded, and the healthy
 * majority of volumes need about 30k, so the actual cost stays small. Each inner
 * call is offered 63/64 of the gas left, not just its share, so one expensive
 * volume draws on the room the cheap ones left.
 *
 * Even a mined batch can still have skipped a volume. A volume that reverted
 * inside the batch leaves no event, the same as a volume that needed nothing.
 * The caller tells the two apart — see `runKeeperCycle`.
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
  const {
    registry,
    volumeIds,
    account = client.account,
    chain = client.chain,
    gasPerVolume = GAS_PER_VOLUME,
  } = parameters;

  if (volumeIds.length === 0) throw new Error("trigger needs at least one volume");
  const gas = batchGas(volumeIds.length, gasPerVolume);
  if (gas > TX_GAS_LIMIT_CAP) {
    throw new Error(
      `${volumeIds.length} volumes need ${gas} gas, above the ${TX_GAS_LIMIT_CAP} transaction cap: send at most ${maxBatchSize(gasPerVolume)}`,
    );
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

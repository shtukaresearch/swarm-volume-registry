import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  publicActions,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis, sepolia } from "viem/chains";

/**
 * Chains a deployment can point at. Add one here to support it — its viem
 * `Chain` must carry `contracts.multicall3`, which is how every read is
 * batched.
 */
export const CHAINS: Readonly<Record<number, Chain>> = {
  [gnosis.id]: gnosis,
  [sepolia.id]: sepolia,
};

/**
 * Per-endpoint budget for the pre-flight probe. Part of every run's time
 * budget, which test/config.test.ts holds under each deployment's cron
 * interval.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/** Per-request budget once the cycle is running. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface EndpointHealth {
  url: string;
  ok: boolean;
  chainId?: number;
  blockNumber?: bigint;
  latencyMs: number;
  error?: string;
}

/**
 * Check every endpoint before the cycle starts, and report what was found.
 *
 * One round trip each, in parallel, every run. That is what makes failover
 * observable (docs/KEEPERS.md: warn whenever a fallback RPC was required) — a
 * transport that quietly skips a dead primary looks exactly like a healthy
 * one. It also re-checks the chain id every run rather than once per isolate:
 * an endpoint on the wrong network answers reads confidently and wrongly,
 * which looks exactly like an empty registry, so it counts as unusable.
 */
export async function probeEndpoints(
  endpoints: readonly string[],
  chain: Chain,
  timeout = PROBE_TIMEOUT_MS,
): Promise<EndpointHealth[]> {
  return Promise.all(
    endpoints.map(async (url): Promise<EndpointHealth> => {
      const startedAt = Date.now();
      try {
        const client = createPublicClient({
          chain,
          transport: http(url, { retryCount: 0, timeout }),
        });
        const [chainId, blockNumber] = await Promise.all([
          client.getChainId(),
          client.getBlockNumber({ cacheTime: 0 }),
        ]);
        const latencyMs = Date.now() - startedAt;
        if (chainId !== chain.id) {
          return {
            url,
            ok: false,
            chainId,
            latencyMs,
            error: `reports chain id ${chainId}, expected ${chain.id}`,
          };
        }
        return { url, ok: true, chainId, blockNumber, latencyMs };
      } catch (err) {
        return {
          url,
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * A wallet client with public actions — what `runKeeperCycle` expects.
 *
 * `endpoints` should be the healthy ones from {@link probeEndpoints}, still in
 * configured order. Each gets `retryCount: 0` so a dead one is abandoned
 * immediately and `fallback` owns the retry budget as it walks the list.
 *
 * No `rank`: ranking learns across ticks by sampling on an interval, which is
 * not worth a timer in an isolate the runtime may discard at any point, and the
 * per-run probe already puts the working endpoints first.
 */
export function buildClient(
  chain: Chain,
  privateKey: Hex,
  endpoints: readonly string[],
) {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain,
    transport: fallback(
      endpoints.map((url) => http(url, { retryCount: 0, timeout: REQUEST_TIMEOUT_MS })),
      { retryCount: 2 },
    ),
  }).extend(publicActions);
}

export type KeeperClient = ReturnType<typeof buildClient>;

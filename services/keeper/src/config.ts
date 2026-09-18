import { isAddress, type Address, type Chain, type Hex } from "viem";
import { CHAINS } from "./client.js";
import type { KeeperMode } from "./keeper/types.js";

/**
 * The Worker's bindings, as `wrangler types` generates them from
 * wrangler.jsonc, plus the optional overrides that no committed deployment
 * sets — pass them with `wrangler dev --var NAME:value`.
 */
export type KeeperEnv = Env &
  Partial<Record<"DRY_RUN" | "VOLUME_IDS" | "PAGE_SIZE", string>>;

export interface TelegramConfig {
  botToken: string;
  /** A numeric chat id (groups are negative) or an `@channel` username. */
  chatId: string;
}

export interface CycleLimits {
  maxVolumesPerCycle: number;
  pageSize: number;
  cycleTimeoutMs: number;
  receiptTimeoutMs: number;
  confirmations: number;
}

export interface Config {
  /** Which Worker this is — `keeper-sepolia`, `keeper-gnosis`. Leads every report. */
  deployment: string;
  chain: Chain;
  registry: Address;
  privateKey: Hex;
  /** Tried in order; the first is the primary. */
  endpoints: string[];
  telegram: TelegramConfig;
  /** Failures always notify; warnings only when this is set. */
  notifyWarnings: boolean;
  /** Warn when the keeper wallet's native balance is below this. 0 disables. */
  minBalanceWei: bigint;
  mode: KeeperMode;
  dryRun: boolean;
  limits: CycleLimits;
}

/**
 * Every problem with a deployment's configuration, not just the first — a
 * redeploy per typo is a slow way to find out there were three.
 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** What a deployment says it is, straight from its vars — valid or not. */
export interface DeploymentIdentity {
  deployment: string;
  chainId?: number;
  chainName?: string;
  registry?: string;
}

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const VOLUME_ID = /^0x[0-9a-fA-F]{64}$/;
const DIGITS = /^\d+$/;
// `<bot id>:<secret>`, as BotFather issues it.
const BOT_TOKEN = /^\d+:[\w-]+$/;
const CHAT_ID = /^(-?\d+|@[A-Za-z]\w{3,})$/;

const text = (env: KeeperEnv, key: keyof KeeperEnv): string => {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
};

const list = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Enough of the configuration to say which deployment is speaking. */
export function readIdentity(env: KeeperEnv): DeploymentIdentity {
  const chainId = Number(text(env, "CHAIN_ID"));
  const registry = text(env, "REGISTRY_ADDRESS");
  return {
    deployment: text(env, "DEPLOYMENT_NAME") || "keeper (DEPLOYMENT_NAME unset)",
    ...(Number.isInteger(chainId) && chainId > 0 ? { chainId } : {}),
    ...(CHAINS[chainId] ? { chainName: CHAINS[chainId]!.name } : {}),
    ...(registry ? { registry } : {}),
  };
}

/**
 * The alert channel alone, read leniently: a deployment whose wallet or RPC
 * config is broken can still say so, as long as this much is right.
 */
export function readTelegramConfig(env: KeeperEnv): TelegramConfig | undefined {
  const botToken = text(env, "TELEGRAM_BOT_TOKEN");
  const chatId = text(env, "TELEGRAM_CHAT_ID");
  return BOT_TOKEN.test(botToken) && CHAT_ID.test(chatId)
    ? { botToken, chatId }
    : undefined;
}

/**
 * Validate the Worker's bindings into a {@link Config}, or throw a
 * {@link ConfigError} naming every problem.
 *
 * Secrets are checked for shape and never echoed: an error message ends up in
 * Workers Logs and in Telegram. `wrangler deploy` already refuses to ship a
 * deployment with a secret *unset* (`secrets.required`); this catches one set
 * to the wrong thing, before it can pass for an idle keeper.
 */
export function readConfig(env: KeeperEnv): Config {
  const problems: string[] = [];

  const deployment = text(env, "DEPLOYMENT_NAME");
  if (!deployment) problems.push("DEPLOYMENT_NAME is required");

  const rawChainId = text(env, "CHAIN_ID");
  const chain = CHAINS[Number(rawChainId)];
  if (!chain) {
    problems.push(
      `CHAIN_ID ${rawChainId ? `${rawChainId} is not supported` : "is required"} (supported: ${Object.keys(CHAINS).join(", ")})`,
    );
  }

  const registry = text(env, "REGISTRY_ADDRESS");
  if (!isAddress(registry)) {
    problems.push(
      registry
        ? `REGISTRY_ADDRESS is not a valid address: ${registry}`
        : "REGISTRY_ADDRESS is required",
    );
  }

  const privateKey = text(env, "PRIVATE_KEY");
  if (!privateKey) problems.push("PRIVATE_KEY is required");
  else if (!PRIVATE_KEY.test(privateKey)) {
    problems.push("PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  }

  const endpoints = list(text(env, "RPC_URL"));
  if (endpoints.length === 0) problems.push("RPC_URL is required");
  endpoints.forEach((url, i) => {
    // Position, not value: the path of an RPC URL is usually its API key.
    if (!isHttpUrl(url)) problems.push(`RPC_URL entry ${i + 1} is not an http(s) URL`);
  });

  const botToken = text(env, "TELEGRAM_BOT_TOKEN");
  if (!botToken) problems.push("TELEGRAM_BOT_TOKEN is required");
  else if (!BOT_TOKEN.test(botToken)) {
    problems.push("TELEGRAM_BOT_TOKEN does not look like a bot token (<id>:<secret>)");
  }

  const chatId = text(env, "TELEGRAM_CHAT_ID");
  if (!chatId) problems.push("TELEGRAM_CHAT_ID is required");
  else if (!CHAT_ID.test(chatId)) {
    problems.push(`TELEGRAM_CHAT_ID must be a numeric chat id or @channel: ${chatId}`);
  }

  const volumeIds = list(text(env, "VOLUME_IDS"));
  for (const id of volumeIds) {
    if (!VOLUME_ID.test(id)) problems.push(`VOLUME_IDS entry is not a 32-byte hex string: ${id}`);
  }

  const flag = (key: keyof KeeperEnv): boolean => {
    const raw = text(env, key).toLowerCase();
    if (raw === "" || raw === "false") return false;
    if (raw === "true") return true;
    problems.push(`${key} must be "true" or "false", got "${raw}"`);
    return false;
  };

  const count = (key: keyof KeeperEnv, fallback?: number): number => {
    const raw = text(env, key);
    if (!raw && fallback !== undefined) return fallback;
    if (!raw) {
      problems.push(`${key} is required`);
      return 0;
    }
    if (!DIGITS.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
      problems.push(`${key} must be a positive integer, got "${raw}"`);
      return 0;
    }
    return Number(raw);
  };

  const rawBalance = text(env, "MIN_BALANCE_WEI");
  if (!rawBalance) problems.push("MIN_BALANCE_WEI is required (0 disables the warning)");
  else if (!DIGITS.test(rawBalance)) {
    problems.push(`MIN_BALANCE_WEI must be a whole number of wei, got "${rawBalance}"`);
  }

  const config = {
    deployment,
    chain: chain!,
    registry: registry as Address,
    privateKey: privateKey as Hex,
    endpoints,
    telegram: { botToken, chatId },
    notifyWarnings: flag("NOTIFY_WARNINGS"),
    minBalanceWei: DIGITS.test(rawBalance) ? BigInt(rawBalance) : 0n,
    mode: volumeIds.length
      ? { type: "selected" as const, volumeIds: volumeIds as Hex[] }
      : { type: "all" as const },
    dryRun: flag("DRY_RUN"),
    limits: {
      maxVolumesPerCycle: count("MAX_VOLUMES_PER_CYCLE"),
      pageSize: count("PAGE_SIZE", 100),
      cycleTimeoutMs: count("CYCLE_TIMEOUT_MS"),
      receiptTimeoutMs: count("RECEIPT_TIMEOUT_MS"),
      confirmations: count("CONFIRMATIONS", 1),
    },
  } satisfies Config;

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

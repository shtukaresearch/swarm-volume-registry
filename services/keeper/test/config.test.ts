import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import { PROBE_TIMEOUT_MS } from "../src/client.js";
import {
  ConfigError,
  readConfig,
  readIdentity,
  readTelegramConfig,
  type KeeperEnv,
} from "../src/config.js";

/** anvil account #1 — a well-known throwaway key, test fixtures only. */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN = "123456789:AAtest-token_for-fixtures-only-0123456";
const REGISTRY = "0x33a53c79a08ed1f863905cd4c6ce036a4c493729";

const env = (overrides: Record<string, string | undefined> = {}): KeeperEnv =>
  ({
    DEPLOYMENT_NAME: "keeper-test",
    CHAIN_ID: "11155111",
    REGISTRY_ADDRESS: REGISTRY,
    TELEGRAM_CHAT_ID: "-1001234567890",
    NOTIFY_WARNINGS: "false",
    MIN_BALANCE_WEI: "0",
    MAX_VOLUMES_PER_CYCLE: "10",
    CYCLE_TIMEOUT_MS: "20000",
    RECEIPT_TIMEOUT_MS: "30000",
    CONFIRMATIONS: "1",
    PRIVATE_KEY: KEY,
    RPC_URL: "https://rpc.example/v3/APIKEY",
    TELEGRAM_BOT_TOKEN: TOKEN,
    ...overrides,
  }) as KeeperEnv;

const problems = (e: KeeperEnv): string[] => {
  try {
    readConfig(e);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
};

describe("readConfig", () => {
  test("accepts a complete deployment", () => {
    const config = readConfig(env());
    expect(config.deployment).toBe("keeper-test");
    expect(config.chain.id).toBe(11155111);
    expect(config.registry).toBe(REGISTRY);
    expect(config.telegram).toEqual({ botToken: TOKEN, chatId: "-1001234567890" });
    expect(config.mode).toEqual({ type: "all" });
    expect(config.dryRun).toBe(false);
    expect(config.limits).toEqual({
      maxVolumesPerCycle: 10,
      pageSize: 100,
      cycleTimeoutMs: 20000,
      receiptTimeoutMs: 30000,
      confirmations: 1,
    });
  });

  // The reviewer's case: a deployment missing its wallet or RPC must fail
  // validation, not run and look idle.
  test("a deployment without its wallet or RPC is rejected, naming both", () => {
    expect(problems(env({ PRIVATE_KEY: "", RPC_URL: "" }))).toEqual([
      "PRIVATE_KEY is required",
      "RPC_URL is required",
    ]);
    expect(problems(env({ PRIVATE_KEY: undefined, RPC_URL: undefined }))).toEqual([
      "PRIVATE_KEY is required",
      "RPC_URL is required",
    ]);
  });

  test("every problem is reported, not just the first", () => {
    const found = problems(
      env({ DEPLOYMENT_NAME: "", CHAIN_ID: "", TELEGRAM_CHAT_ID: "", MAX_VOLUMES_PER_CYCLE: "" }),
    );
    expect(found).toHaveLength(4);
  });

  // Problems land in Workers Logs, Telegram and /health.
  test("a malformed secret is named, never echoed", () => {
    const found = problems(
      env({
        PRIVATE_KEY: "0xSECRETdeadbeef",
        RPC_URL: "https://ok.example, ftp://host/SECRETKEY",
        TELEGRAM_BOT_TOKEN: "SECRET-not-a-token",
      }),
    ).join("\n");
    expect(found).toContain("PRIVATE_KEY");
    expect(found).toContain("RPC_URL entry 2");
    expect(found).toContain("TELEGRAM_BOT_TOKEN");
    expect(found).not.toContain("SECRET");
  });

  test.each([
    ["CHAIN_ID", { CHAIN_ID: "1" }, /CHAIN_ID 1 is not supported/],
    ["REGISTRY_ADDRESS", { REGISTRY_ADDRESS: "nope" }, /not a valid address/],
    ["TELEGRAM_CHAT_ID", { TELEGRAM_CHAT_ID: "ops group" }, /numeric chat id/],
    ["a zero limit", { MAX_VOLUMES_PER_CYCLE: "0" }, /positive integer/],
    ["a fractional limit", { CYCLE_TIMEOUT_MS: "1.5" }, /positive integer/],
    ["a non-numeric limit", { RECEIPT_TIMEOUT_MS: "thirty" }, /positive integer/],
    ["a balance in ether", { MIN_BALANCE_WEI: "0.5" }, /whole number of wei/],
    ["a missing balance", { MIN_BALANCE_WEI: "" }, /MIN_BALANCE_WEI is required/],
    // "yes" is not a typo for "true" we should guess at.
    ["a fuzzy flag", { NOTIFY_WARNINGS: "yes" }, /"true" or "false"/],
    ["a short volume id", { VOLUME_IDS: "0x1234" }, /not a 32-byte hex string/],
  ])("rejects %s", (_name, overrides, message) => {
    expect(problems(env(overrides)).join("\n")).toMatch(message);
  });

  test("optional overrides", () => {
    const a = `0x${"11".repeat(32)}` as const;
    const b = `0x${"22".repeat(32)}` as const;
    const config = readConfig(
      env({ DRY_RUN: "true", VOLUME_IDS: `${a}, ${b}`, PAGE_SIZE: "25", NOTIFY_WARNINGS: "TRUE" }),
    );
    expect(config.dryRun).toBe(true);
    expect(config.notifyWarnings).toBe(true);
    expect(config.mode).toEqual({ type: "selected", volumeIds: [a, b] });
    expect(config.limits.pageSize).toBe(25);
  });

  test("several RPC endpoints are kept in order", () => {
    const config = readConfig(env({ RPC_URL: "https://a.example, https://b.example" }));
    expect(config.endpoints).toEqual(["https://a.example", "https://b.example"]);
  });

  test("MIN_BALANCE_WEI of 0 disables the warning", () => {
    expect(readConfig(env({ MIN_BALANCE_WEI: "0" })).minBalanceWei).toBe(0n);
  });
});

// A broken deployment still has to be able to say so.
describe("reading around a broken config", () => {
  const broken = env({ PRIVATE_KEY: "", RPC_URL: "", CHAIN_ID: "999" });

  test("the alert channel is read independently", () => {
    expect(readTelegramConfig(broken)).toEqual({ botToken: TOKEN, chatId: "-1001234567890" });
  });

  test("a malformed channel reads as none, rather than a doomed send", () => {
    expect(readTelegramConfig(env({ TELEGRAM_CHAT_ID: "" }))).toBeUndefined();
    expect(readTelegramConfig(env({ TELEGRAM_BOT_TOKEN: "x" }))).toBeUndefined();
  });

  test("identity keeps whatever it can", () => {
    expect(readIdentity(broken)).toEqual({
      deployment: "keeper-test",
      chainId: 999,
      registry: REGISTRY,
    });
    expect(readIdentity(env()).chainName).toBe("Sepolia");
  });
});

// ---------------------------------------------------------------------------
// The committed deployments, resolved by wrangler itself — the same config
// `wrangler deploy --env <name>` would ship, env inheritance and all.
// `wrangler deploy --dry-run` bundles but does not check any of this: it
// accepts a misspelled key and cannot see secrets.
// ---------------------------------------------------------------------------

const WRANGLER = join(import.meta.dir, "..", "wrangler.jsonc");
const DEPLOYMENTS = ["sepolia", "gnosis"] as const;
const SECRETS = ["PRIVATE_KEY", "RPC_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].sort();

/** Cron Triggers stop a run at 15 minutes regardless of schedule. */
const CRON_WALL_CLOCK_MS = 15 * 60_000;
/** Everything around the cycle: reads, the balance check, the alert. */
const SLACK_MS = 5_000;

/**
 * Seconds between runs, for the cron shapes this repo uses. Anything else
 * fails loudly so the budget check below cannot be skipped by accident.
 */
function cronIntervalSeconds(expr: string): number {
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/);
  if ([dom, month, dow].some((f) => f !== "*")) throw new Error(`unsupported cron: ${expr}`);
  if (hour === "*" && minute === "*") return 60;
  if (hour === "*" && /^\*\/\d+$/.test(minute!)) return Number(minute!.slice(2)) * 60;
  if (hour === "*" && /^\d+$/.test(minute!)) return 3600;
  throw new Error(`unsupported cron: ${expr} — teach cronIntervalSeconds about it`);
}

describe("committed deployments (wrangler.jsonc)", () => {
  for (const name of DEPLOYMENTS) {
    const deployment = unstable_readConfig({ config: WRANGLER, env: name });
    const vars = deployment.vars as Record<string, string>;

    describe(name, () => {
      test(`deploys as keeper-${name}, and says so in DEPLOYMENT_NAME`, () => {
        expect(deployment.name).toBe(`keeper-${name}`);
        expect(vars.DEPLOYMENT_NAME).toBe(deployment.name);
      });

      test("passes the Worker's own validation", () => {
        const withSecrets = {
          ...vars,
          PRIVATE_KEY: KEY,
          RPC_URL: "https://rpc.example",
          TELEGRAM_BOT_TOKEN: TOKEN,
          TELEGRAM_CHAT_ID: "-1001234567890",
        } as KeeperEnv;
        expect(problems(withSecrets)).toEqual([]);
      });

      test("requires its own wallet, RPC and Telegram secrets to deploy", () => {
        expect([...(deployment.secrets?.required ?? [])].sort()).toEqual(SECRETS);
        expect(vars).not.toHaveProperty("TELEGRAM_CHAT_ID");
      });

      // KEEPERS.md: prevent overlapping invocations that share a wallet. Two
      // runs cannot overlap if each fits inside the interval between them.
      test("a whole run fits inside one cron interval", () => {
        expect(deployment.triggers.crons).toHaveLength(1);
        const intervalMs = cronIntervalSeconds(deployment.triggers.crons[0]!) * 1000;
        const budgetMs =
          PROBE_TIMEOUT_MS +
          Number(vars.CYCLE_TIMEOUT_MS) +
          Number(vars.RECEIPT_TIMEOUT_MS) +
          SLACK_MS;
        expect(budgetMs).toBeLessThanOrEqual(intervalMs);
        expect(budgetMs).toBeLessThanOrEqual(CRON_WALL_CLOCK_MS);
      });

      test("has Workers Logs and Traces enabled", () => {
        expect(deployment.observability?.enabled).toBe(true);
        expect(deployment.observability?.logs?.enabled).toBe(true);
        expect(deployment.observability?.traces?.enabled).toBe(true);
      });
    });
  }

  test("the deployments are distinct workers on distinct chains", () => {
    const [a, b] = DEPLOYMENTS.map((env) => unstable_readConfig({ config: WRANGLER, env }));
    expect(a!.name).not.toBe(b!.name);
    expect((a!.vars as Record<string, string>).CHAIN_ID).not.toBe(
      (b!.vars as Record<string, string>).CHAIN_ID,
    );
  });

  // The root is not a deployment. With no cron it could never run, and the
  // required secrets make a bare `wrangler deploy` fail instead of creating it.
  test("the root config is not deployable by accident", () => {
    const root = unstable_readConfig({ config: WRANGLER });
    expect(root.triggers.crons ?? []).toEqual([]);
    expect([...(root.secrets?.required ?? [])].sort()).toEqual(SECRETS);
  });
});

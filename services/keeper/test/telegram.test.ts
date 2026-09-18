import { describe, expect, test } from "bun:test";
import {
  TELEGRAM_MAX_LENGTH,
  formatTelegramMessage,
  sendTelegram,
  shouldNotify,
} from "../src/notifications/telegram.js";
import type { KeeperReport } from "../src/reporting.js";

const VOLUME = `0x${"ab".repeat(32)}` as const;
const TX = `0x${"cd".repeat(32)}` as const;
const REGISTRY = "0x9639ae4c7a8fa9efe585738d516a3915ddd02aad";
const CHANNEL = { botToken: "123:SECRET-bot-token", chatId: "-1001234567890" };

const report = (overrides: Partial<KeeperReport> = {}): KeeperReport => ({
  kind: "keeper/run",
  status: "failure",
  summary: "keeper-gnosis: 1 volume failed",
  deployment: "keeper-gnosis",
  chainId: 100,
  chainName: "Gnosis",
  registry: REGISTRY,
  failures: [{ volumeId: VOLUME, hash: TX, message: "transaction reverted" }],
  warnings: [],
  durationMs: 1,
  ...overrides,
});

describe("formatTelegramMessage", () => {
  // Both deployments may share one group; every message has to say which one
  // it is about and point at the exact volume and transaction.
  test("names the deployment, chain, registry, reason, volume and tx", () => {
    const text = formatTelegramMessage(report());
    expect(text).toContain("keeper-gnosis");
    expect(text).toContain("Gnosis (100)");
    expect(text).toContain(REGISTRY);
    expect(text).toContain("transaction reverted");
    expect(text).toContain(VOLUME);
    expect(text).toContain(TX);
  });

  test("leads with the status at a glance", () => {
    expect(formatTelegramMessage(report())).toStartWith("🔴 keeper-gnosis: 1 volume failed");
    expect(formatTelegramMessage(report({ status: "warning", summary: "s" }))).toStartWith("🟡");
  });

  test("an issue without a volume or tx is still a line of its own", () => {
    const text = formatTelegramMessage(
      report({ failures: [{ message: "no usable RPC endpoint" }] }),
    );
    expect(text).toContain("• no usable RPC endpoint");
    expect(text).not.toContain("\n  volume ");
    expect(text).not.toContain("\n  tx ");
  });

  test("failures come before warnings", () => {
    const text = formatTelegramMessage(
      report({ warnings: [{ message: "keeper balance is low" }] }),
    );
    expect(text.indexOf("Failures")).toBeLessThan(text.indexOf("Warnings"));
    expect(text).toContain("• keeper balance is low");
  });

  // A misconfigured deployment reports before its chain is known to be valid.
  test("a deployment whose chain could not be read still says so", () => {
    const text = formatTelegramMessage(
      report({ chainId: undefined, chainName: undefined, registry: undefined }),
    );
    expect(text).toContain("Chain: unknown");
    expect(text).toContain("Registry: unset");
  });

  test("an unsupported chain id is shown as given", () => {
    expect(formatTelegramMessage(report({ chainId: 999, chainName: undefined }))).toContain(
      "unsupported chain (999)",
    );
  });

  test("a long report is cut between issues, and says how many were left out", () => {
    const failures = Array.from({ length: 60 }, () => ({
      volumeId: VOLUME,
      hash: TX,
      message: "transaction reverted",
    }));
    const text = formatTelegramMessage(report({ failures }));
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
    expect(text).toMatch(/… and \d+ more — see Workers Logs$/);
    // Never mid-hash: every tx line that made it in is whole.
    for (const line of text.split("\n").filter((l) => l.startsWith("  tx "))) {
      expect(line).toBe(`  tx ${TX}`);
    }
  });
});

describe("shouldNotify", () => {
  test("failures always notify", () => {
    expect(shouldNotify(report(), false)).toBe(true);
  });

  test("warnings notify only where the deployment opts in", () => {
    const warning = report({ status: "warning", failures: [] });
    expect(shouldNotify(warning, false)).toBe(false);
    expect(shouldNotify(warning, true)).toBe(true);
  });

  test("a clean run never notifies", () => {
    expect(shouldNotify(report({ status: "ok", failures: [] }), true)).toBe(false);
  });
});

describe("sendTelegram", () => {
  test("posts the text to the configured chat", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await sendTelegram(CHANNEL, "hello", {
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, body: JSON.parse(String(init.body)) });
        return new Response('{"ok":true}');
      }) as unknown as typeof fetch,
    });

    expect(result).toEqual({ sent: true });
    expect(seen[0]!.url).toBe("https://api.telegram.org/bot123:SECRET-bot-token/sendMessage");
    expect(seen[0]!.body).toMatchObject({ chat_id: "-1001234567890", text: "hello" });
  });

  test("a rejection comes back with Telegram's own reason", async () => {
    const result = await sendTelegram(CHANNEL, "hello", {
      fetch: (async () =>
        new Response('{"ok":false,"description":"Bad Request: chat not found"}', {
          status: 400,
        })) as unknown as typeof fetch,
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("400");
    expect(result.reason).toContain("chat not found");
  });

  // A notifier that throws would replace the run's own outcome with its own.
  test("a network failure comes back as a value, without the token", async () => {
    const result = await sendTelegram(CHANNEL, "hello", {
      fetch: (async () => {
        throw new Error("network connection lost");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ sent: false, reason: "network connection lost" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test("a hung request is abandoned at the timeout", async () => {
    const result = await sendTelegram(CHANNEL, "hello", {
      timeoutMs: 20,
      fetch: ((_: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        )) as unknown as typeof fetch,
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

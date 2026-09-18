/**
 * Whole scheduled runs, through the Worker's own default export.
 *
 * The mock chain is served over a stubbed `fetch`, so what runs is the real
 * path: bindings → config → endpoint probe → viem `http` transports → cycle →
 * report → log → Telegram. Nothing is injected past the network boundary.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import worker, { KeeperRunFailed } from "../src/index.js";
import type { KeeperEnv } from "../src/config.js";
import type { KeeperReport } from "../src/reporting.js";
import { REGISTRY, mockChain, volumeId, type MockVolume } from "./mock-chain.js";

/** anvil account #1 — a well-known throwaway key, test fixtures only. */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN = "123456789:AAtest-BOTSECRET-fixtures-only";
const LIVE = "https://live.example/v3/LIVESECRET";
const DEAD = "https://dead.example/v3/DEADSECRET";
const SECRETS = ["LIVESECRET", "DEADSECRET", "BOTSECRET", KEY.slice(2)];

const due = (n: number): MockVolume => ({
  volumeId: volumeId(n),
  batch: { normalisedBalance: 1_000_000n + 1n },
});

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
    RECEIPT_TIMEOUT_MS: "2000",
    CONFIRMATIONS: "1",
    PRIVATE_KEY: KEY,
    RPC_URL: LIVE,
    TELEGRAM_BOT_TOKEN: TOKEN,
    ...overrides,
  }) as KeeperEnv;

// --- the network ------------------------------------------------------------

type Chain = ReturnType<typeof mockChain>;
/** A chain; an endpoint that is down; or one that fails only certain methods. */
type Route = Chain | "down" | { chain: Chain; httpErrorOn: string[] };
let rpc: Map<string, Route>;
let telegram: { status: number; sent: string[] };
let rpcRequests: string[];

function serve(url: string, init?: RequestInit): Promise<Response> | Response {
  if (url.startsWith("https://api.telegram.org/")) {
    telegram.sent.push(JSON.parse(String(init?.body)).text);
    return new Response(telegram.status === 200 ? '{"ok":true}' : '{"ok":false}', {
      status: telegram.status,
    });
  }
  const route = rpc.get(url);
  if (!route) throw new Error(`no route for ${url}`);
  rpcRequests.push(url);
  if (route === "down") return new Response("bad gateway", { status: 502 });

  const { id, method, params } = JSON.parse(String(init?.body));
  if ("httpErrorOn" in route && route.httpErrorOn.includes(method)) {
    return new Response("service unavailable", { status: 503 });
  }
  const chain = "httpErrorOn" in route ? route.chain : route;
  return chain.request({ method, params }).then(
    (result) => Response.json({ jsonrpc: "2.0", id, result }),
    (err: Error & { code?: number }) =>
      Response.json({ jsonrpc: "2.0", id, error: { code: err.code ?? -32000, message: err.message } }),
  );
}

// --- the runtime ------------------------------------------------------------

const logs: Record<"log" | "warn" | "error", string[]> = { log: [], warn: [], error: [] };
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  rpc = new Map();
  telegram = { status: 200, sent: [] };
  rpcRequests = [];
  for (const level of ["log", "warn", "error"] as const) {
    logs[level] = [];
    spies.push(
      spyOn(console, level).mockImplementation((line: unknown) => {
        logs[level].push(String(line));
      }),
    );
  }
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) =>
      serve(String(input), init)) as typeof fetch),
  );
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

/** The run's report, as the Worker logged it. */
function logged(): KeeperReport {
  const reports = [...logs.log, ...logs.warn, ...logs.error]
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === "keeper/run");
  expect(reports).toHaveLength(1);
  return reports[0];
}

const everything = () => [...logs.log, ...logs.warn, ...logs.error, ...telegram.sent].join("\n");

async function scheduled(bindings: KeeperEnv) {
  const noRetry = mock(() => {});
  const controller = { cron: "* * * * *", scheduledTime: Date.now(), type: "scheduled", noRetry };
  const outcome = await worker
    .scheduled(controller as unknown as ScheduledController, bindings)
    .then(
      () => undefined,
      (err: unknown) => err,
    );
  return { outcome, noRetry };
}

// --- runs -------------------------------------------------------------------

describe("scheduled", () => {
  test("a healthy run succeeds quietly", async () => {
    const chain = mockChain({ volumes: [due(1), due(2)] });
    rpc.set(LIVE, chain);

    const { outcome } = await scheduled(env());

    expect(outcome).toBeUndefined();
    expect(chain.triggerCalls).toEqual([volumeId(1), volumeId(2)]);
    expect(logged()).toMatchObject({ status: "ok", deployment: "keeper-test", cron: "* * * * *" });
    expect(logs.log).toHaveLength(1);
    expect(telegram.sent).toEqual([]);
  });

  // KEEPERS.md: never report a successful invocation for a run that failed.
  test("a failed volume fails the invocation, and pages with where and what", async () => {
    rpc.set(LIVE, mockChain({ volumes: [due(1)], revertTx: true }));

    const { outcome, noRetry } = await scheduled(env());

    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    expect((outcome as Error).message).toBe("keeper-test: 1 volume failed");
    // The next tick is the retry; a platform retry could overlap it.
    expect(noRetry).toHaveBeenCalled();

    const report = logged();
    expect(report.status).toBe("failure");
    expect(logs.error).toHaveLength(1);

    const hash = report.volumes![0]!.hash!;
    expect(telegram.sent).toHaveLength(1);
    const alert = telegram.sent[0]!;
    for (const expected of ["keeper-test", "Sepolia (11155111)", REGISTRY, "transaction reverted", volumeId(1), hash]) {
      expect(alert).toContain(expected);
    }
  });

  // The reviewer's case: no wallet or RPC must not pass for an idle keeper.
  test("a deployment without its wallet or RPC fails, pages, and touches no RPC", async () => {
    const { outcome } = await scheduled(env({ PRIVATE_KEY: "", RPC_URL: "" }));

    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    expect(rpcRequests).toEqual([]);
    expect(logged().failures.map((f) => f.message)).toEqual([
      "PRIVATE_KEY is required",
      "RPC_URL is required",
    ]);
    expect(telegram.sent[0]).toContain("PRIVATE_KEY is required");
    expect(telegram.sent[0]).toContain("keeper-test");
  });

  test("a broken alert channel still fails the run, and the log says why", async () => {
    const { outcome } = await scheduled(env({ PRIVATE_KEY: "", TELEGRAM_CHAT_ID: "" }));
    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    expect(telegram.sent).toEqual([]);
    expect(logged().failures.map((f) => f.message)).toContain("TELEGRAM_CHAT_ID is required");
  });

  // An endpoint on the wrong network answers confidently and wrongly, which
  // looks exactly like an empty registry.
  test("an RPC on the wrong chain is never used", async () => {
    const wrong = mockChain({ volumes: [due(1)], chainId: 1 });
    rpc.set(LIVE, wrong);

    const { outcome } = await scheduled(env());

    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    expect(wrong.triggerCalls).toEqual([]);
    expect(logged().failures.map((f) => f.message).join("\n")).toContain(
      "reports chain id 1, expected 11155111",
    );
  });

  test("failing over is a warning: the run succeeds, and pages only where wanted", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    rpc.set(DEAD, "down");
    rpc.set(LIVE, chain);

    const quiet = await scheduled(env({ RPC_URL: `${DEAD},${LIVE}` }));
    expect(quiet.outcome).toBeUndefined();
    expect(chain.triggerCalls).toEqual([volumeId(1)]);
    expect(logged().status).toBe("warning");
    expect(logs.warn).toHaveLength(1);
    expect(telegram.sent).toEqual([]);

    logs.warn = [];
    const loud = await scheduled(env({ RPC_URL: `${DEAD},${LIVE}`, NOTIFY_WARNINGS: "true" }));
    expect(loud.outcome).toBeUndefined();
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]).toContain("primary RPC https://dead.example/… is down");
  });

  test("no usable endpoint at all is a failure", async () => {
    rpc.set(DEAD, "down");
    const { outcome } = await scheduled(env({ RPC_URL: DEAD }));
    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    expect(logged().failures[0]!.message).toBe(
      "no usable RPC endpoint: all 1 failed the pre-flight check",
    );
  });

  // viem puts the full endpoint URL in its errors, and a dead endpoint's error
  // goes straight into the report and the alert.
  test("no secret reaches the log or the group", async () => {
    rpc.set(DEAD, "down");
    await scheduled(env({ RPC_URL: DEAD }));
    expect(telegram.sent).toHaveLength(1);
    const output = everything();
    expect(output).toContain("dead.example");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  // The dangerous path: an endpoint that passes the probe and then fails
  // mid-cycle. viem's full error — "URL: https://…/<key>" — is kept whole in the
  // per-volume log detail, so only the scrubber stands between it and the log.
  test("a mid-cycle RPC failure is logged in full, with the key scrubbed", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    rpc.set(LIVE, { chain, httpErrorOn: ["eth_estimateGas"] });

    const { outcome } = await scheduled(env());

    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    const volume = logged().volumes![0]!;
    expect(volume.status).toBe("failed");
    expect(volume.error).toContain("URL: https://live.example/…");
    const output = everything();
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  test("a Telegram outage is logged without changing the run's outcome", async () => {
    rpc.set(LIVE, mockChain({ volumes: [due(1)], revertTx: true }));
    telegram.status = 500;

    const { outcome } = await scheduled(env());

    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    const notify = logs.error.map((l) => JSON.parse(l)).find((e) => e.kind === "keeper/notify-failed");
    expect(notify).toMatchObject({ deployment: "keeper-test", status: "failure" });
    expect(notify.reason).toContain("500");
  });

  test("DRY_RUN sends nothing, and says so rather than looking healthy", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    rpc.set(LIVE, chain);

    const { outcome } = await scheduled(env({ DRY_RUN: "true" }));

    expect(outcome).toBeUndefined();
    expect(chain.calls).not.toContain("eth_sendRawTransaction");
    expect(logged()).toMatchObject({ status: "warning", dryRun: true });
  });
});

describe("GET /health", () => {
  const get = (path: string, bindings = env()) =>
    worker.fetch(
      new Request(`https://keeper-test.example.workers.dev${path}`) as unknown as Parameters<
        typeof worker.fetch
      >[0],
      bindings,
    );

  test("a valid deployment reports which wallet to fund", async () => {
    const response = await get("/health");
    expect(response.status).toBe(200);
    expect(await response.json<Record<string, unknown>>()).toEqual({
      status: "configured",
      deployment: "keeper-test",
      chainId: 11155111,
      chainName: "Sepolia",
      registry: REGISTRY,
      keeper: privateKeyToAccount(KEY).address,
      dryRun: false,
    });
  });

  test("a broken one says what is wrong, without secrets", async () => {
    const response = await get("/health", env({ RPC_URL: "", PRIVATE_KEY: "0xBOTSECRET" }));
    expect(response.status).toBe(503);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ status: "misconfigured", deployment: "keeper-test" });
    expect(JSON.stringify(body)).not.toContain("BOTSECRET");
  });

  // A public URL must not be a way to spend the deployment's RPC quota.
  test("makes no RPC calls", async () => {
    await get("/health");
    expect(rpcRequests).toEqual([]);
  });

  test("anything else is a 404", async () => {
    expect((await get("/")).status).toBe(404);
  });
});

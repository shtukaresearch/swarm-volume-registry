import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sepolia } from "viem/chains";
import type { EndpointHealth } from "../src/client.js";
import { runKeeperCycle } from "../src/keeper/actions/runKeeperCycle.js";
import {
  abortedReport,
  brief,
  cycleReport,
  endpointWarnings,
  logReport,
  makeScrubber,
  redact,
  scrubReport,
  type KeeperReport,
} from "../src/reporting.js";
import { REGISTRY, mockChain, volumeId, type MockVolume } from "./mock-chain.js";

const OUT = 1_000_000n;
const due = (n: number): MockVolume => ({
  volumeId: volumeId(n),
  batch: { normalisedBalance: OUT + 1n },
});

const healthy: EndpointHealth = { url: "https://a.example/KEY", ok: true, latencyMs: 5 };
const dead: EndpointHealth = {
  url: "https://b.example/KEY",
  ok: false,
  latencyMs: 5,
  error: "HTTP request failed.\n\nURL: https://b.example/KEY",
};

const run = {
  identity: { deployment: "keeper-sepolia", chainId: 11155111, chainName: "Sepolia", registry: REGISTRY },
  cron: "* * * * *",
  scheduledTime: 1_700_000_000_000,
  startedAt: Date.now(),
};

/** A real cycle against the mock chain, reported the way the Worker does. */
async function reportFor(
  volumes: MockVolume[],
  extra: { chain?: Parameters<typeof mockChain>[0]; balanceWei?: bigint; minBalanceWei?: bigint; endpoints?: EndpointHealth[]; dryRun?: boolean } = {},
): Promise<KeeperReport> {
  const chain = mockChain({ volumes, ...extra.chain });
  const result = await runKeeperCycle(chain.client, {
    registry: REGISTRY,
    dryRun: extra.dryRun,
    receiptTimeout: 300,
  });
  return cycleReport({
    ...run,
    chain: sepolia,
    keeper: chain.client.account.address,
    dryRun: extra.dryRun ?? false,
    endpoints: extra.endpoints ?? [healthy],
    result,
    balanceWei: "balanceWei" in extra ? extra.balanceWei : 10n ** 18n,
    minBalanceWei: extra.minBalanceWei ?? 0n,
  });
}

describe("cycleReport", () => {
  test("a clean run is ok, and counts what happened", async () => {
    const report = await reportFor([due(1), due(2)]);
    expect(report.status).toBe("ok");
    expect(report.summary).toBe("keeper-sepolia: 2 volumes of 2 triggered");
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.outcomes).toEqual({ toppedUp: 2 });
  });

  test("identity leads, so a shared log or group can tell deployments apart", async () => {
    const report = await reportFor([due(1)]);
    expect(report).toMatchObject({
      kind: "keeper/run",
      deployment: "keeper-sepolia",
      chainId: 11155111,
      chainName: "Sepolia",
      registry: REGISTRY,
      cron: "* * * * *",
    });
  });

  test("a reverted volume is a failure naming the volume and its tx", async () => {
    const report = await reportFor([due(1)], { chain: { revertTx: true } });
    expect(report.status).toBe("failure");
    expect(report.summary).toBe("keeper-sepolia: 1 volume failed");
    expect(report.failures).toEqual([
      { volumeId: volumeId(1), hash: report.volumes![0]!.hash!, message: "transaction reverted" },
    ]);
  });

  test("a volume that fails before sending names it, without a tx", async () => {
    const report = await reportFor([due(1), { ...due(2), status: 2 }]);
    expect(report.status).toBe("failure");
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ volumeId: volumeId(2) });
    expect(report.failures[0]!.hash).toBeUndefined();
    expect(report.failures[0]!.message).toContain("VolumeNotActive");
  });

  test("a cycle that could not read the registry is a failure", async () => {
    const report = await reportFor([due(1)], { chain: { failWith: "socket hang up" } });
    expect(report.status).toBe("failure");
    expect(report.failures[0]!.message).toContain("socket hang up");
  });

  test("a payer who stopped paying is a warning with volume and tx", async () => {
    const report = await reportFor([{ ...due(1), accountActive: false }]);
    expect(report.status).toBe("warning");
    expect(report.warnings).toEqual([
      { volumeId: volumeId(1), hash: report.volumes![0]!.hash!, message: "not funded: NoAuth" },
    ]);
  });

  test("a low wallet balance warns in the chain's own units", async () => {
    const report = await reportFor([due(1)], {
      balanceWei: 10n ** 16n,
      minBalanceWei: 5n * 10n ** 16n,
    });
    expect(report.status).toBe("warning");
    expect(report.warnings.map((w) => w.message)).toEqual([
      "keeper balance 0.01 ETH is below the floor of 0.05 ETH",
    ]);
    expect(report.balanceWei).toBe("10000000000000000");
  });

  test("an unreadable balance is a warning, not silence", async () => {
    const report = await reportFor([due(1)], { balanceWei: undefined, minBalanceWei: 1n });
    expect(report.warnings.map((w) => w.message)).toContain(
      "could not read the keeper wallet balance",
    );
  });

  test("failing over to a secondary RPC is a warning", async () => {
    const report = await reportFor([due(1)], { endpoints: [dead, healthy] });
    expect(report.status).toBe("warning");
    expect(report.warnings.map((w) => w.message)).toEqual([
      "RPC https://b.example/… is unusable: HTTP request failed.",
      "primary RPC https://b.example/… is down; failed over to https://a.example/…",
    ]);
  });

  // A deployment left in dry-run mode maintains nothing; that must not look
  // like a quiet, healthy keeper.
  test("dry run is always a warning", async () => {
    const report = await reportFor([due(1)], { dryRun: true });
    expect(report.status).toBe("warning");
    expect(report.summary).toContain("1 volume of 1 simulated");
    expect(report.warnings.map((w) => w.message)).toContain("dry run: nothing was sent");
  });

  test("the report is plain JSON — no bigints", async () => {
    const report = await reportFor([due(1)]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("abortedReport", () => {
  test("is a failure listing every problem", () => {
    const report = abortedReport(run, ["PRIVATE_KEY is required", "RPC_URL is required"]);
    expect(report.status).toBe("failure");
    expect(report.summary).toBe("keeper-sepolia: run failed — PRIVATE_KEY is required");
    expect(report.failures.map((f) => f.message)).toEqual([
      "PRIVATE_KEY is required",
      "RPC_URL is required",
    ]);
  });

  test("keeps the endpoint table when that is why it stopped", () => {
    const report = abortedReport(run, ["no usable RPC endpoint"], [dead]);
    expect(report.endpoints).toEqual([
      { endpoint: "https://b.example/…", ok: false, latencyMs: 5, error: "HTTP request failed." },
    ]);
  });
});

describe("endpointWarnings", () => {
  test("all healthy says nothing", () => {
    expect(endpointWarnings([healthy])).toEqual([]);
  });

  test("a dead secondary is named, but is not a failover", () => {
    expect(endpointWarnings([healthy, dead]).map((w) => w.message)).toEqual([
      "RPC https://b.example/… is unusable: HTTP request failed.",
    ]);
  });
});

describe("redact", () => {
  test("keeps the host and drops the path, which is usually the key", () => {
    expect(redact("https://eth.example.com/v3/SECRET")).toBe("https://eth.example.com/…");
  });

  test("a bare origin has nothing to hide", () => {
    expect(redact("https://rpc.gnosischain.com")).toBe("https://rpc.gnosischain.com");
  });

  test("a key in the query string is dropped too", () => {
    expect(redact("https://eth.example.com/?apikey=SECRET")).toBe("https://eth.example.com/…");
  });

  test("something unparseable is not echoed back", () => {
    expect(redact("not a url")).toBe("<malformed url>");
  });
});

// What stands between an API key and a shared Telegram group — and most of
// what it cleans is text viem wrote, not us.
describe("makeScrubber", () => {
  const url = "https://eth.example.com/v3/SUPERSECRET";
  const scrub = makeScrubber({ rpcUrls: [url], others: ["123456:BOT-TOKEN-SECRET"] });

  test("masks the endpoint inside a viem error message", () => {
    const scrubbed = scrub(`HTTP request failed.\n\nURL: ${url}\nRequest body: {}`);
    expect(scrubbed).not.toContain("SUPERSECRET");
    expect(scrubbed).toContain("https://eth.example.com/…");
  });

  test("masks the trailing-slash form viem normalises to", () => {
    expect(scrub(`URL: ${url}/`)).not.toContain("SUPERSECRET");
  });

  test("masks every occurrence, not just the first", () => {
    const twice = scrub(`${url} and again ${url}`);
    expect(twice).not.toContain("SUPERSECRET");
    expect(twice.split("https://eth.example.com/…")).toHaveLength(3);
  });

  test("masks other secrets outright", () => {
    expect(scrub("token 123456:BOT-TOKEN-SECRET leaked")).toBe("token <redacted> leaked");
  });

  test("a longer endpoint is not partly masked by a shorter prefix", () => {
    const both = makeScrubber({
      rpcUrls: ["https://eth.example.com", "https://eth.example.com/v3/SUPERSECRET"],
    });
    expect(both(`URL: ${url}`)).not.toContain("SUPERSECRET");
  });

  // An unset secret must not turn into "replace every empty string".
  test("empty and tiny secrets are ignored rather than shredding the text", () => {
    expect(makeScrubber({ others: ["", "ab"] })("nothing to see")).toBe("nothing to see");
  });
});

describe("scrubReport", () => {
  test("reaches every string, however deep", () => {
    const report = abortedReport(run, ["RPC https://x.example/SECRET failed"]);
    report.volumes = [{ volumeId: volumeId(1), status: "failed", error: "at https://x.example/SECRET" }];
    const clean = scrubReport(report, makeScrubber({ rpcUrls: ["https://x.example/SECRET"] }));
    expect(JSON.stringify(clean)).not.toContain("SECRET");
    expect(clean.failures[0]!.message).toBe("RPC https://x.example/… failed");
  });
});

describe("brief", () => {
  test("takes the headline off a multi-line viem error", () => {
    expect(brief("HTTP request failed.\n\nURL: x\nRequest body: {}")).toBe("HTTP request failed.");
  });

  test("keeps viem's Details line, where the actual cause is", () => {
    expect(brief("An unknown RPC error occurred.\n\nDetails: socket hang up\nVersion: viem@2")).toBe(
      "An unknown RPC error occurred: socket hang up",
    );
  });

  test("does not repeat details the headline already carries", () => {
    expect(brief("socket hang up\n\nDetails: socket hang up")).toBe("socket hang up");
  });

  test("truncates a long single line", () => {
    expect(brief("x".repeat(300))).toHaveLength(200);
  });
});

describe("logReport", () => {
  const spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
  afterEach(() => spies.forEach((s) => s.mockClear()));

  // Workers Logs files each line under its console level, so the dashboard's
  // level filter and a query on `status` have to agree.
  test.each([
    ["ok", 0],
    ["warning", 1],
    ["failure", 2],
  ] as const)("a %s run logs at its own level, as one JSON object", (status, index) => {
    const report = { ...abortedReport(run, ["x"]), status };
    logReport(report);
    expect(spies[index]!).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spies[index]!.mock.calls[0]![0] as string)).toEqual(report);
    spies.filter((_, i) => i !== index).forEach((s) => expect(s).not.toHaveBeenCalled());
  });
});

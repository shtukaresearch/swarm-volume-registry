import { formatEther, type Address, type Chain } from "viem";
import type { EndpointHealth } from "./client.js";
import type { DeploymentIdentity } from "./config.js";
import type { RunKeeperCycleReturnType } from "./keeper/actions/runKeeperCycle.js";
import type { KeeperIssue, VolumeResult } from "./keeper/types.js";

/**
 * One scheduled run, as both Workers Logs and Telegram see it.
 *
 * There is exactly one of these per run, and everything downstream is a
 * rendering of it: the log line is this object as JSON, the alert is
 * `notifications/telegram.ts` formatting it. So the two can never disagree
 * about what happened, and anything worth alerting on is also searchable in
 * the logs.
 *
 * JSON-safe by construction — wei amounts and block numbers are decimal
 * strings — so it serialises without a replacer and reads back unchanged.
 */
export interface KeeperReport {
  kind: "keeper/run";
  status: RunStatus;
  /** One line for a human: what the log search and the alert title show. */
  summary: string;
  deployment: string;
  chainId?: number;
  chainName?: string;
  registry?: string;
  keeper?: Address;
  cron?: string;
  scheduledTime?: number;
  dryRun?: boolean;
  /** Block the volume list was read at. */
  blockNumber?: string;
  /** Keeper wallet's native balance, in wei. */
  balanceWei?: string;
  /** Active volumes found; `volumes` holds the ones attempted. */
  volumeCount?: number;
  outcomes?: Record<string, number>;
  endpoints?: Array<{ endpoint: string; ok: boolean; latencyMs: number; error?: string }>;
  /** Present iff `status` is `failure`. */
  failures: KeeperIssue[];
  warnings: KeeperIssue[];
  volumes?: ReportedVolume[];
  durationMs: number;
}

export type RunStatus = "ok" | "warning" | "failure";

export type ReportedVolume = Omit<VolumeResult, "amount" | "blockNumber" | "gasUsed"> & {
  amount?: string;
  blockNumber?: string;
  gasUsed?: string;
};

// --- building ---------------------------------------------------------------

const statusOf = (failures: unknown[], warnings: unknown[]): RunStatus =>
  failures.length > 0 ? "failure" : warnings.length > 0 ? "warning" : "ok";

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function summarize(deployment: string, status: RunStatus, failures: KeeperIssue[], warnings: KeeperIssue[], detail: string): string {
  if (status === "failure") {
    const volumes = failures.filter((f) => f.volumeId).length;
    return volumes > 0
      ? `${deployment}: ${plural(volumes, "volume")} failed`
      : `${deployment}: run failed — ${failures[0]!.message}`;
  }
  if (status === "warning") return `${deployment}: ${detail}, ${plural(warnings.length, "warning")}`;
  return `${deployment}: ${detail}`;
}

export interface RunInput {
  identity: DeploymentIdentity;
  cron?: string;
  scheduledTime?: number;
  startedAt: number;
}

/**
 * A run that stopped before the cycle: invalid configuration, or no RPC
 * endpoint able to serve it. Always a failure — KEEPERS.md is explicit that
 * neither may pass for a quiet run.
 */
export function abortedReport(
  run: RunInput,
  problems: string[],
  endpoints?: EndpointHealth[],
): KeeperReport {
  const failures = problems.map((message) => ({ message }));
  return {
    kind: "keeper/run",
    status: "failure",
    summary: summarize(run.identity.deployment, "failure", failures, [], ""),
    ...identityFields(run),
    ...(endpoints ? { endpoints: endpoints.map(reportEndpoint) } : {}),
    failures,
    warnings: [],
    durationMs: Date.now() - run.startedAt,
  };
}

export interface CycleReportInput extends RunInput {
  chain: Chain;
  keeper: Address;
  dryRun: boolean;
  endpoints: EndpointHealth[];
  result: RunKeeperCycleReturnType;
  /** Undefined if the balance read itself failed; that is warned about. */
  balanceWei?: bigint;
  minBalanceWei: bigint;
}

/**
 * A run that reached the cycle. Its `ok` and warnings carry over as they are;
 * this adds what only the Worker can see — endpoint failover, the wallet
 * balance, a deployment left in dry-run mode.
 */
export function cycleReport(input: CycleReportInput): KeeperReport {
  const { result, chain } = input;
  const symbol = chain.nativeCurrency.symbol;

  const failures: KeeperIssue[] = [];
  if (result.error) failures.push({ message: brief(result.error) });
  for (const volume of result.volumes) {
    if (volume.status !== "failed" && volume.status !== "reverted") continue;
    failures.push({
      volumeId: volume.volumeId,
      ...(volume.hash ? { hash: volume.hash } : {}),
      message:
        volume.status === "reverted"
          ? "transaction reverted"
          : brief(volume.error ?? "transaction failed"),
    });
  }

  const warnings: KeeperIssue[] = [...endpointWarnings(input.endpoints)];
  if (input.dryRun) warnings.push({ message: "dry run: nothing was sent" });
  if (input.balanceWei === undefined) {
    warnings.push({ message: "could not read the keeper wallet balance" });
  } else if (input.minBalanceWei > 0n && input.balanceWei < input.minBalanceWei) {
    warnings.push({
      message: `keeper balance ${formatEther(input.balanceWei)} ${symbol} is below the floor of ${formatEther(input.minBalanceWei)} ${symbol}`,
    });
  }
  warnings.push(...result.warnings);

  const outcomes: Record<string, number> = {};
  for (const volume of result.volumes) {
    const key = volume.outcome ?? volume.status;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }

  const status = statusOf(failures, warnings);
  const detail = result.skipped
    ? result.skipped
    : `${plural(result.volumes.length, "volume")} of ${result.volumeCount} ${input.dryRun ? "simulated" : "triggered"}`;

  return {
    kind: "keeper/run",
    status,
    summary: summarize(input.identity.deployment, status, failures, warnings, detail),
    ...identityFields(input),
    keeper: input.keeper,
    dryRun: input.dryRun,
    ...(result.blockNumber !== undefined ? { blockNumber: result.blockNumber.toString() } : {}),
    ...(input.balanceWei !== undefined ? { balanceWei: input.balanceWei.toString() } : {}),
    volumeCount: result.volumeCount,
    outcomes,
    endpoints: input.endpoints.map(reportEndpoint),
    failures,
    warnings,
    volumes: result.volumes.map(reportVolume),
    durationMs: Date.now() - input.startedAt,
  };
}

/**
 * docs/KEEPERS.md: warn whenever a fallback RPC was required. A dead primary is
 * survivable and invisible unless something says so.
 */
export function endpointWarnings(endpoints: EndpointHealth[]): KeeperIssue[] {
  const warnings: KeeperIssue[] = endpoints
    .filter((e) => !e.ok)
    .map((e) => ({
      message: `RPC ${redact(e.url)} is unusable: ${brief(e.error ?? "unknown error")}`,
    }));
  const usable = endpoints.find((e) => e.ok);
  if (usable && endpoints[0] && !endpoints[0].ok) {
    warnings.push({
      message: `primary RPC ${redact(endpoints[0].url)} is down; failed over to ${redact(usable.url)}`,
    });
  }
  return warnings;
}

function identityFields(run: RunInput) {
  const { deployment, chainId, chainName, registry } = run.identity;
  return {
    deployment,
    ...(chainId !== undefined ? { chainId } : {}),
    ...(chainName ? { chainName } : {}),
    ...(registry ? { registry } : {}),
    ...(run.cron ? { cron: run.cron } : {}),
    ...(run.scheduledTime !== undefined ? { scheduledTime: run.scheduledTime } : {}),
  };
}

const reportEndpoint = (e: EndpointHealth) => ({
  endpoint: redact(e.url),
  ok: e.ok,
  latencyMs: e.latencyMs,
  ...(e.error ? { error: brief(e.error) } : {}),
});

function reportVolume(v: VolumeResult): ReportedVolume {
  const { amount, blockNumber, gasUsed, error, ...rest } = v;
  return {
    ...rest,
    ...(amount !== undefined ? { amount: amount.toString() } : {}),
    ...(blockNumber !== undefined ? { blockNumber: blockNumber.toString() } : {}),
    ...(gasUsed !== undefined ? { gasUsed: gasUsed.toString() } : {}),
    // Whole, not `brief`: the log is where someone debugs this, and viem's
    // full text carries the call it was making.
    ...(error ? { error: error.slice(0, MAX_LOGGED_ERROR) } : {}),
  };
}

// --- secrets out ------------------------------------------------------------

/**
 * Hide the path and query of an RPC URL, which is usually where the API key
 * is. Scheme and host stay, so an operator can still tell endpoints apart.
 */
export const redact = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname === "/" && !u.search
      ? `${u.protocol}//${u.host}`
      : `${u.protocol}//${u.host}/…`;
  } catch {
    return "<malformed url>";
  }
};

/**
 * Replace every configured secret wherever it appears in a string.
 *
 * Redacting where *we* print a URL is not enough: viem embeds the full endpoint
 * in its error messages ("URL: https://…/<api key>"), and those messages end up
 * in failures, the log line and the Telegram group. So scrubbing happens once,
 * over the finished report, over text nobody here composed.
 */
export function makeScrubber(secrets: {
  rpcUrls?: readonly string[];
  others?: readonly string[];
}): (text: string) => string {
  const pairs: Array<[string, string]> = [];
  for (const url of secrets.rpcUrls ?? []) {
    const variants = new Set([url, url.replace(/\/+$/, "")]);
    try {
      variants.add(new URL(url).href);
    } catch {
      // Unparseable: the raw form is still worth masking.
    }
    for (const variant of variants) pairs.push([variant, redact(url)]);
  }
  for (const secret of secrets.others ?? []) pairs.push([secret, "<redacted>"]);

  // A short "secret" would shred unrelated text; nothing real is that short.
  const usable = pairs.filter(([from]) => from.length >= 8);
  // Longest first, so a shorter variant never masks part of a longer match.
  usable.sort((a, b) => b[0].length - a[0].length);
  return (text) => usable.reduce((acc, [from, to]) => acc.split(from).join(to), text);
}

/** Apply `scrub` to every string in the report, however deep. */
export function scrubReport(report: KeeperReport, scrub: (text: string) => string): KeeperReport {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(report) as KeeperReport;
}

/**
 * viem errors run to many lines; a report wants one. That is the headline plus
 * viem's `Details:` line when there is one, because the headline alone is
 * often generic ("An unknown RPC error occurred.") and the cause is below it.
 */
export const brief = (message: string, max = 200): string => {
  const lines = message
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const head = lines[0] ?? message;
  const details = lines.find((l) => l.startsWith("Details:"))?.slice(8).trim();
  const text =
    details && !head.includes(details) ? `${head.replace(/\.$/, "")}: ${details}` : head;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Full error text for the log, bounded so one bad run cannot flood it. */
const MAX_LOGGED_ERROR = 2_000;

// --- out --------------------------------------------------------------------

/**
 * Write the report to Workers Logs as one JSON object, at the level matching
 * its status, so the dashboard's level filter and a query on `status` agree.
 */
export function logReport(report: KeeperReport): void {
  const line = JSON.stringify(report);
  if (report.status === "failure") console.error(line);
  else if (report.status === "warning") console.warn(line);
  else console.log(line);
}

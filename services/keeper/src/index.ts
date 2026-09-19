/**
 * The keeper Worker. One implementation, deployed once per chain — see the
 * envs in wrangler.jsonc. Cloudflare Cron Triggers are the only scheduler.
 *
 * Each scheduled run: validate the configuration, probe the RPC endpoints,
 * run one keeper cycle, and turn what happened into a single report. That
 * report is logged, and alerted on when it warrants it — then a failed run
 * fails the invocation, so Cron Events and Workers Logs show it as one.
 */
import { privateKeyToAccount } from "viem/accounts";
import { buildClient, probeEndpoints } from "./client.js";
import {
  ConfigError,
  readConfig,
  readIdentity,
  readTelegramConfig,
  type Config,
  type KeeperEnv,
} from "./config.js";
import { runKeeperCycle } from "./keeper/actions/runKeeperCycle.js";
import {
  formatTelegramMessage,
  sendTelegram,
  shouldNotify,
} from "./notifications/telegram.js";
import {
  abortedReport,
  cycleReport,
  endpointWarnings,
  logReport,
  makeScrubber,
  scrubReport,
  type KeeperReport,
  type RunInput,
} from "./reporting.js";

/** Thrown out of `scheduled()` when a run failed, so the invocation does too. */
export class KeeperRunFailed extends Error {
  override name = "KeeperRunFailed";
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * One scheduled run, start to finish. Never throws: every outcome, including
 * invalid configuration, comes back as a report that has already been logged
 * and, where it warrants one, sent as an alert.
 */
export async function runScheduled(
  env: KeeperEnv,
  event: { cron?: string; scheduledTime?: number } = {},
): Promise<KeeperReport> {
  const run: RunInput = { identity: readIdentity(env), ...event, startedAt: Date.now() };

  // Armed from the raw bindings before anything is validated, so even a
  // report about a malformed secret cannot leak a well-formed one.
  const scrub = makeScrubber({
    rpcUrls: (env.RPC_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    others: [env.TELEGRAM_BOT_TOKEN ?? "", env.PRIVATE_KEY ?? ""],
  });

  let notifyWarnings = false;
  let report: KeeperReport;
  try {
    const config = readConfig(env);
    notifyWarnings = config.notifyWarnings;
    report = await runCycle(config, run);
  } catch (err) {
    // Invalid configuration is a failure, never a quiet skip (KEEPERS.md).
    report = abortedReport(
      run,
      err instanceof ConfigError ? err.problems : [`unexpected error: ${message(err)}`],
    );
  }

  report = scrubReport(report, scrub);
  logReport(report);

  // Read leniently and separately, so a deployment whose wallet or RPC config
  // is broken can still report that it is.
  const telegram = readTelegramConfig(env);
  if (telegram && shouldNotify(report, notifyWarnings)) {
    const { sent, reason } = await sendTelegram(telegram, formatTelegramMessage(report));
    if (!sent) {
      console.error(
        JSON.stringify({
          kind: "keeper/notify-failed",
          deployment: report.deployment,
          status: report.status,
          reason: scrub(reason ?? "unknown"),
        }),
      );
    }
  }

  return report;
}

async function runCycle(config: Config, run: RunInput): Promise<KeeperReport> {
  const endpoints = await probeEndpoints(config.endpoints, config.chain);
  const usable = endpoints.filter((e) => e.ok).map((e) => e.url);
  if (usable.length === 0) {
    return abortedReport(
      run,
      [
        `no usable RPC endpoint: all ${endpoints.length} failed the pre-flight check`,
        ...endpointWarnings(endpoints).map((w) => w.message),
      ],
      endpoints,
    );
  }

  const client = buildClient(config.chain, config.privateKey, usable);
  const result = await runKeeperCycle(client, {
    registry: config.registry,
    mode: config.mode,
    dryRun: config.dryRun,
    maxVolumesPerCycle: config.limits.maxVolumesPerCycle,
    pageSize: config.limits.pageSize,
    cycleTimeout: config.limits.cycleTimeoutMs,
    receiptTimeout: config.limits.receiptTimeoutMs,
    confirmations: config.limits.confirmations,
  });

  // After the cycle, so it reflects what this run spent.
  const balanceWei = await client
    .getBalance({ address: client.account.address })
    .catch(() => undefined);

  return cycleReport({
    ...run,
    chain: config.chain,
    keeper: client.account.address,
    dryRun: config.dryRun,
    endpoints,
    result,
    balanceWei,
    minBalanceWei: config.minBalanceWei,
  });
}

export default {
  async scheduled(controller, env) {
    // The next tick is the retry. A platform retry could overlap it on the
    // same wallet, which KEEPERS.md rules out, and `trigger` is idempotent,
    // so nothing is lost by waiting for the schedule.
    controller.noRetry();

    const report = await runScheduled(env, {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
    if (report.status === "failure") throw new KeeperRunFailed(report.summary);
  },

  /**
   * `GET /health` — whether this deployment's configuration is valid, and
   * which wallet it runs as, so it can be funded. Makes no RPC calls: a public
   * URL must not be a way to spend the deployment's RPC quota. Whether the
   * *last run* worked is in Workers Logs and Telegram, not here.
   */
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/health") {
      return new Response("not found\n", { status: 404 });
    }
    try {
      const config = readConfig(env);
      return Response.json({
        status: "configured",
        deployment: config.deployment,
        chainId: config.chain.id,
        chainName: config.chain.name,
        registry: config.registry,
        keeper: privateKeyToAccount(config.privateKey).address,
        dryRun: config.dryRun,
      });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      // Problems name variables and never echo a secret's value.
      return Response.json(
        { status: "misconfigured", ...readIdentity(env), problems: err.problems },
        { status: 503 },
      );
    }
  },
} satisfies ExportedHandler<KeeperEnv>;

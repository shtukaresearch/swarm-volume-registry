/**
 * The keeper on AWS Lambda: the Worker in src/index.ts, unchanged, behind a
 * thin adapter. EventBridge Scheduler stands in for Cron Triggers, SSM
 * Parameter Store for Worker secrets, and a Function URL for `fetch`.
 *
 * Nothing about a deployment is configured here. scripts/aws.ts reads it from
 * wrangler.jsonc — vars, secret names, cron — and template.yaml hands it to
 * the function as environment variables:
 *
 *   KEEPER_VARS          the env's `vars`, as JSON
 *   KEEPER_SECRETS       the env's `secrets.required`, comma-separated
 *   KEEPER_SECRETS_PATH  the SSM path they live under, `/<worker name>/`
 */
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import type { KeeperEnv } from "../config.js";
import worker from "../index.js";

/** What the schedule sends: the wrangler cron it runs, and this tick's time. */
export interface ScheduleEvent {
  cron?: string;
  /** ISO 8601, from `<aws.scheduler.scheduled-time>`. */
  scheduledTime?: string;
}

/** Secrets by name. A name it cannot find is left out, never thrown on. */
export type SecretSource = (names: readonly string[]) => Promise<Record<string, string>>;

/** GetParameters takes at most this many names per call. */
const SSM_BATCH = 10;

/**
 * Secrets from SSM Parameter Store, read on every call so a rotated value is
 * used from the next run on, as `wrangler secret put` is.
 *
 * A missing parameter is left for config validation, which names it in the
 * run's report and alert like any other unset secret. Only SSM itself being
 * unreachable throws — and with it, the alert channel is unreadable too, so
 * that failure surfaces as a Lambda error and its CloudWatch alarm.
 */
export function ssmSecrets(path: string, client: Pick<SSMClient, "send"> = new SSMClient({})): SecretSource {
  return async (names) => {
    const found: Record<string, string> = {};
    for (let i = 0; i < names.length; i += SSM_BATCH) {
      const { Parameters = [] } = await client.send(
        new GetParametersCommand({
          Names: names.slice(i, i + SSM_BATCH).map((name) => path + name),
          WithDecryption: true,
        }),
      );
      for (const { Name, Value } of Parameters) {
        if (Name?.startsWith(path) && Value !== undefined) found[Name.slice(path.length)] = Value;
      }
    }
    return found;
  };
}

/**
 * How long `health` reuses the secrets it read. The URL is public: without
 * this, anyone could spend the SSM throughput the scheduled run reads from.
 */
export const HEALTH_SECRETS_TTL_MS = 60_000;

const list = (raw = ""): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The Lambda handlers, over a given secret source and process environment.
 * The exported `scheduled` and `health` use SSM and `process.env`.
 */
export function createHandlers(
  secrets?: SecretSource,
  processEnv: Record<string, string | undefined> = process.env,
) {
  /** The same bindings the Worker gets: its vars, plus its secrets. */
  async function bindings(): Promise<KeeperEnv> {
    let vars: Record<string, string>;
    try {
      vars = JSON.parse(processEnv.KEEPER_VARS ?? "{}");
    } catch {
      throw new Error("KEEPER_VARS is not valid JSON — redeploy with `pnpm aws deploy`");
    }
    secrets ??= ssmSecrets(processEnv.KEEPER_SECRETS_PATH ?? "/");
    // Unchecked, as a Worker's bindings are: readConfig validates every value.
    return { ...vars, ...(await secrets(list(processEnv.KEEPER_SECRETS))) } as unknown as KeeperEnv;
  }

  let cached: { env: Promise<KeeperEnv>; at: number } | undefined;
  function cachedBindings(): Promise<KeeperEnv> {
    if (!cached || Date.now() - cached.at >= HEALTH_SECRETS_TTL_MS) {
      const env = bindings();
      cached = { env, at: Date.now() };
      // A failed read is not kept: the next request tries again.
      env.catch(() => (cached = undefined));
    }
    return cached.env;
  }

  return {
    /**
     * One scheduled run. Throws when the run failed, so the invocation fails
     * and Lambda's Errors metric counts it. Retries are switched off in
     * template.yaml, which is what `noRetry()` would have done.
     */
    async scheduled(event: ScheduleEvent = {}): Promise<void> {
      const scheduledTime = Date.parse(event.scheduledTime ?? "");
      const controller = {
        type: "scheduled",
        cron: event.cron ?? "",
        scheduledTime: Number.isNaN(scheduledTime) ? Date.now() : scheduledTime,
        noRetry() {},
      };
      await worker.scheduled(controller as unknown as ScheduledController, await bindings());
    },

    /**
     * The Worker's `fetch` — `GET /health` — behind a Function URL. Secrets
     * are reused for {@link HEALTH_SECRETS_TTL_MS}, so a rotation shows here
     * up to a minute after it reaches the scheduled run.
     */
    async health(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
      const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
      const request = new Request(`https://${event.requestContext.domainName}${event.rawPath}${query}`, {
        method: event.requestContext.http.method,
      });
      const response = await worker.fetch(
        request as unknown as Parameters<typeof worker.fetch>[0],
        await cachedBindings(),
      );
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    },
  };
}

export const { scheduled, health } = createHandlers();

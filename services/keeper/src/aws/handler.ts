/**
 * The keeper on AWS Lambda: the Worker in src/index.ts, unchanged, behind a
 * thin adapter. An EventBridge rule stands in for Cron Triggers, and a
 * Function URL for `fetch`.
 *
 * The Worker's bindings are the function's environment variables, under the
 * same names: the env's `vars` and `secrets.required`, set by scripts/aws.ts.
 */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import type { KeeperEnv } from "../config.js";
import worker from "../index.js";
import { AWS_START_DELAY_MS } from "../schedule.js";

/** What the schedule sends: the wrangler cron it runs, and this tick's time. */
export interface ScheduleEvent {
  cron?: string;
  /** ISO 8601: the rule event's `time`. */
  scheduledTime?: string;
}

export interface HandlerOptions {
  /** Ms to wait before each scheduled run. Default: random in {@link AWS_START_DELAY_MS}. */
  startDelay?: () => number;
}

/** A uniform wait in [min, max], inclusive. */
export const randomStartDelay = () =>
  AWS_START_DELAY_MS.min + Math.floor(Math.random() * (AWS_START_DELAY_MS.max - AWS_START_DELAY_MS.min + 1));

/**
 * The Lambda handlers, over the given bindings. The exported `scheduled` and
 * `health` bind the function's environment.
 */
export function createHandlers(env: KeeperEnv, { startDelay = randomStartDelay }: HandlerOptions = {}) {
  return {
    /**
     * One scheduled run, after {@link AWS_START_DELAY_MS}. Throws when the run
     * failed, so the invocation fails and Lambda's Errors metric counts it.
     * The deploy switches retries off, which is what `noRetry()` would have
     * done.
     */
    async scheduled(event: ScheduleEvent = {}): Promise<void> {
      const delay = startDelay();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const scheduledTime = Date.parse(event.scheduledTime ?? "");
      const controller = {
        type: "scheduled",
        cron: event.cron ?? "",
        scheduledTime: Number.isNaN(scheduledTime) ? Date.now() : scheduledTime,
        noRetry() {},
      };
      await worker.scheduled(controller as unknown as ScheduledController, env);
    },

    /** The Worker's `fetch` — `GET /health` — behind a Function URL. */
    async health(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
      const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
      const request = new Request(`https://${event.requestContext.domainName}${event.rawPath}${query}`, {
        method: event.requestContext.http.method,
      });
      const response = await worker.fetch(request as unknown as Parameters<typeof worker.fetch>[0], env);
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    },
  };
}

// Unchecked, as a Worker's bindings are: readConfig validates every value.
export const { scheduled, health } = createHandlers(process.env as unknown as KeeperEnv);

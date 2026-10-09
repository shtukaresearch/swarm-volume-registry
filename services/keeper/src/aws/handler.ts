/**
 * The keeper on AWS Lambda: the Worker in src/index.ts, unchanged, behind a
 * thin adapter. EventBridge Scheduler stands in for Cron Triggers, and a
 * Function URL for `fetch`.
 *
 * The Worker's bindings are the function's environment variables, under the
 * same names: the env's `vars` and `secrets.required`, which scripts/aws.ts
 * sets on both functions from wrangler.jsonc and the stack's secrets.
 */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import type { KeeperEnv } from "../config.js";
import worker from "../index.js";

/** What the schedule sends: the wrangler cron it runs, and this tick's time. */
export interface ScheduleEvent {
  cron?: string;
  /** ISO 8601, from `<aws.scheduler.scheduled-time>`. */
  scheduledTime?: string;
}

/**
 * The Lambda handlers, over the given bindings. The exported `scheduled` and
 * `health` bind the function's environment.
 */
export function createHandlers(env: KeeperEnv) {
  return {
    /**
     * One scheduled run. Throws when the run failed, so the invocation fails
     * and Lambda's Errors metric counts it. Retries are switched off in the
     * stack, which is what `noRetry()` would have done.
     */
    async scheduled(event: ScheduleEvent = {}): Promise<void> {
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

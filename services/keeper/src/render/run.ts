/**
 * The keeper as a one-shot Node process: one scheduled run, then exit. A
 * Render Cron Job runs it (`node dist/render/run.mjs`, built by
 * `pnpm build:render`) on the env's cron, and never starts a run while the
 * previous one is still active.
 *
 * The Worker's bindings are the job's environment variables, under the same
 * names: the env's `vars` and `secrets.required` from wrangler.jsonc.
 */
import type { KeeperEnv } from "../config.js";
import { runScheduled } from "../index.js";

// Unchecked, as a Worker's bindings are: readConfig validates every value.
const report = await runScheduled(process.env as unknown as KeeperEnv, {
  scheduledTime: Date.now(),
});

// A failed run fails the job run, so Render's run history shows it as one.
// No retry: the next tick is the retry, as on Cloudflare.
process.exitCode = report.status === "failure" ? 1 : 0;

/**
 * The cron shapes the deployments use, read the same way by the budget check
 * in test/config.test.ts and by the AWS deploy (scripts/aws.ts), so the
 * schedule both platforms run is the one the budget was checked against.
 */

/** Both platforms stop a scheduled run at 15 minutes. */
export const MAX_RUN_SECONDS = 15 * 60;

/**
 * Seconds between runs. Anything other than the shapes below fails loudly, so
 * neither the budget check nor the AWS translation can be skipped by accident.
 */
export function cronIntervalSeconds(expr: string): number {
  const [minute, hour] = fields(expr);
  if (hour === "*" && minute === "*") return 60;
  if (hour === "*" && /^\*\/\d+$/.test(minute)) return Number(minute.slice(2)) * 60;
  if (hour === "*" && /^\d+$/.test(minute)) return 3600;
  throw new Error(`unsupported cron: ${expr} — teach cronIntervalSeconds about it`);
}

/**
 * The same schedule as an EventBridge Scheduler expression: six fields, a
 * year, and `?` for day-of-week. Only for the shapes {@link cronIntervalSeconds}
 * accepts, where every day field is `*`.
 */
export function toEventBridgeCron(expr: string): string {
  cronIntervalSeconds(expr);
  const [minute, hour] = fields(expr);
  return `cron(${minute} ${hour} * * ? *)`;
}

function fields(expr: string): [string, string] {
  const parts = expr.trim().split(/\s+/);
  const [minute, hour, dom, month, dow] = parts;
  if (parts.length !== 5 || [dom, month, dow].some((f) => f !== "*")) {
    throw new Error(`unsupported cron: ${expr}`);
  }
  return [minute!, hour!];
}

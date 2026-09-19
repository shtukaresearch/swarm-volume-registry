/**
 * Telegram alerts, rendered from the same {@link KeeperReport} that goes to
 * Workers Logs — never composed separately, so an alert cannot say something
 * the log does not.
 *
 * Both deployments may post to one group, so every message leads with which
 * deployment, chain and registry it is about, and every issue names its volume
 * and transaction when it has them.
 */
import type { TelegramConfig } from "../config.js";
import type { KeeperReport } from "../reporting.js";
import type { KeeperIssue } from "../keeper/types.js";

/** Telegram's hard limit on one message's text. */
export const TELEGRAM_MAX_LENGTH = 4096;

const ICON = { failure: "🔴", warning: "🟡", ok: "🟢" } as const;

/**
 * Failures always page. Warnings page only where the deployment opts in:
 * on a one-minute schedule a standing warning — a payer who revoked, a
 * wallet running low — would repeat every run.
 */
export function shouldNotify(report: KeeperReport, notifyWarnings: boolean): boolean {
  return report.status === "failure" || (report.status === "warning" && notifyWarnings);
}

export function formatTelegramMessage(report: KeeperReport): string {
  const chain =
    report.chainId === undefined
      ? "unknown (CHAIN_ID unset or invalid)"
      : `${report.chainName ?? "unsupported chain"} (${report.chainId})`;

  const header = [
    `${ICON[report.status]} ${report.summary}`,
    `Deployment: ${report.deployment}`,
    `Chain: ${chain}`,
    `Registry: ${report.registry ?? "unset"}`,
    ...(report.keeper ? [`Keeper: ${report.keeper}`] : []),
  ];

  const sections: Array<[string, KeeperIssue[]]> = [
    ["Failures", report.failures],
    ["Warnings", report.warnings],
  ];
  const blocks: string[] = [];
  for (const [title, issues] of sections) {
    if (issues.length === 0) continue;
    blocks.push(`\n${title}`);
    for (const issue of issues) blocks.push(formatIssue(issue));
  }

  return fit(header.join("\n"), blocks);
}

function formatIssue(issue: KeeperIssue): string {
  return [
    `• ${issue.message}`,
    ...(issue.volumeId ? [`  volume ${issue.volumeId}`] : []),
    ...(issue.hash ? [`  tx ${issue.hash}`] : []),
  ].join("\n");
}

/**
 * Keep whole issues until the next would overflow, then say how many were
 * left out and where the rest are. A message cut mid-hash is worse than one
 * that admits it is incomplete.
 */
function fit(header: string, blocks: string[]): string {
  let text = header;
  for (const [i, block] of blocks.entries()) {
    const rest = blocks.slice(i).filter((b) => b.startsWith("•")).length;
    const tail = `\n… and ${rest} more — see Workers Logs`;
    if (text.length + 1 + block.length + tail.length > TELEGRAM_MAX_LENGTH) {
      return text + tail;
    }
    text += `\n${block}`;
  }
  return text;
}

export interface SendResult {
  sent: boolean;
  /** Why not, when `sent` is false. Never contains the bot token. */
  reason?: string;
}

/**
 * Post `text` to the configured chat.
 *
 * Never throws: a notifier that throws would replace the run's own outcome
 * with its own. A failed send comes back as a reason, and the caller logs it.
 */
export async function sendTelegram(
  config: TelegramConfig,
  text: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SendResult> {
  const { fetch: doFetch = fetch, timeoutMs = 10_000 } = options;
  try {
    const response = await doFetch(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      // Telegram explains itself in the body; the status alone rarely tells a
      // bad token from a bad chat id.
      const body = await response.text().catch(() => "");
      return {
        sent: false,
        reason: `telegram returned ${response.status}: ${body.slice(0, 200)}`,
      };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The Telegram webhook: `/verbosity` and nothing else.
 *
 * Telegram allows one webhook per bot, so whichever Worker registers it owns
 * the command: only one deployment per bot may set `TELEGRAM_WEBHOOK_URL`. Updates are accepted only with the secret Telegram echoes back
 * (`X-Telegram-Bot-Api-Secret-Token`) and only from the configured chat.
 */
import type { KeeperEnv, TelegramConfig } from "../config.js";
import { readTelegramConfig, readWebhookSecret, readWebhookUrl } from "../config.js";
import { describeVerbosity, helpText, parseCommand } from "./commands.js";
import {
  defaultVerbosity,
  readVerbosity,
  setVerbosity,
  type Verbosity,
} from "./preferences.js";
import { sendTelegram } from "./telegram.js";

interface TelegramChat {
  id: number;
  username?: string;
}

interface TelegramMessage {
  text?: string;
  chat: TelegramChat;
  from?: { id: number; is_bot?: boolean };
}

interface TelegramUpdate {
  message?: TelegramMessage;
}

export interface WebhookOptions {
  fetch?: typeof fetch;
}

/** Telegram's header carrying the `secret_token` passed to `setWebhook`. */
export const WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/**
 * Handle one webhook request. Returns 2xx for a well-authenticated update,
 * even one it ignores: Telegram retries anything else, and a command the bot
 * is not interested in is not an error.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: KeeperEnv,
  options: WebhookOptions = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed\n", { status: 405 });
  }

  const secret = readWebhookSecret(env);
  if (!secret) {
    // Commands are optional: a deployment without a webhook still alerts.
    return new Response("telegram commands are not configured\n", { status: 404 });
  }
  if (request.headers.get(WEBHOOK_SECRET_HEADER) !== secret) {
    return new Response("forbidden\n", { status: 403 });
  }

  const config = readTelegramConfig(env);
  if (!config) {
    return new Response("telegram is not configured\n", { status: 503 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return ok();
  }

  const message = update.message;
  if (!message?.text || message.from?.is_bot) return ok();
  if (!isConfiguredChat(message.chat, config.chatId)) return ok();

  const command = parseCommand(message.text);
  if (!command) return ok();
  // In a group, `/verbosity@SomeBot` reaches every bot in it. Only the bot
  // named in the suffix acts; an unaddressed command is ours.
  if (command.address && !(await isThisBot(command.address, config, options.fetch))) {
    return ok();
  }

  const reply = await runCommand(command.name, command.args, config, env);
  if (reply) await sendReply(config, reply, options);
  return ok();
}

async function runCommand(
  name: string,
  args: string[],
  config: TelegramConfig,
  env: KeeperEnv,
): Promise<string | undefined> {
  if (name === "help" || name === "start") return helpText();
  if (name !== "verbosity") return undefined;

  if (args.length === 0) {
    const level = await readVerbosity(env.KEEPER_PREFS, config.chatId, fallback(env));
    return `Verbosity: ${describeVerbosity(level)}.`;
  }

  if (args.length === 1 && (args[0] === "error" || args[0] === "warn")) {
    const level: Verbosity = args[0];
    if (!env.KEEPER_PREFS) {
      return "Cannot save the setting: this deployment has no preference store.";
    }
    try {
      await setVerbosity(env.KEEPER_PREFS, config.chatId, level);
      return `Verbosity set to ${describeVerbosity(level)}.`;
    } catch (err) {
      console.error(
        JSON.stringify({
          kind: "keeper/telegram-command-failed",
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      return "Could not save the setting; the previous level is unchanged.";
    }
  }

  return `Unknown verbosity. Use /verbosity error or /verbosity warn.\n\n${helpText()}`;
}

const ok = () => new Response("ok\n");

/** The deployment's level when the group has not chosen one. */
const fallback = (env: KeeperEnv): Verbosity =>
  defaultVerbosity(env.NOTIFY_WARNINGS?.trim().toLowerCase() === "true");

/**
 * True when `configured` is this update's chat: either the numeric id, or an
 * `@username` for a public channel.
 */
export function isConfiguredChat(
  chat: { id: number; username?: string },
  configured: string,
): boolean {
  if (String(chat.id) === configured) return true;
  return (
    configured.startsWith("@") &&
    !!chat.username &&
    `@${chat.username}`.toLowerCase() === configured.toLowerCase()
  );
}

const usernames = new Map<string, string>();

/** This bot's username, for `/command@bot` in a group. Cached per isolate. */
async function isThisBot(
  address: string,
  config: TelegramConfig,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  const cached = usernames.get(config.botToken);
  if (cached) return cached.toLowerCase() === address.toLowerCase();
  try {
    const response = await doFetch(`https://api.telegram.org/bot${config.botToken}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { result?: { username?: string } };
    const username = body.result?.username;
    if (!username) return false;
    usernames.set(config.botToken, username);
    return username.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

export type WebhookRegistration =
  | { status: "unchanged" | "registered" }
  | { status: "failed"; reason: string };

/**
 * Point Telegram at this Worker's `/telegram`, unless it already is. Run from
 * every scheduled run, so `wrangler deploy` is the only step and a webhook
 * pointed elsewhere is taken back by the next tick.
 *
 * Telegram does not report which secret a webhook was registered with, so a
 * rotated `TELEGRAM_WEBHOOK_SECRET` shows only as updates being refused: a 403
 * as the webhook's last error re-registers it too. Never throws.
 */
export async function ensureWebhook(
  env: KeeperEnv,
  options: WebhookOptions = {},
): Promise<WebhookRegistration | undefined> {
  const url = readWebhookUrl(env);
  const secret = readWebhookSecret(env);
  const config = readTelegramConfig(env);
  if (!url || !secret || !config) return undefined;

  const doFetch = options.fetch ?? fetch;
  const api = (method: string) => `https://api.telegram.org/bot${config.botToken}/${method}`;
  try {
    const info = await doFetch(api("getWebhookInfo"), { signal: AbortSignal.timeout(10_000) });
    if (!info.ok) return failed(`getWebhookInfo returned ${info.status}`, config);
    const { result } = (await info.json()) as {
      result?: { url?: string; last_error_message?: string };
    };
    if (result?.url === url && !result.last_error_message?.includes("403")) {
      return { status: "unchanged" };
    }

    const response = await doFetch(api("setWebhook"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return failed(`setWebhook returned ${response.status}: ${body.slice(0, 200)}`, config);
    }
    return { status: "registered" };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err), config);
  }
}

// A fetch error can carry the request URL, and the URL carries the token.
const failed = (reason: string, config: TelegramConfig): WebhookRegistration => ({
  status: "failed",
  reason: reason.replaceAll(config.botToken, "…"),
});

async function sendReply(
  config: TelegramConfig,
  text: string,
  options: WebhookOptions,
): Promise<void> {
  const { sent, reason } = await sendTelegram(config, text, { fetch: options.fetch });
  if (!sent) {
    console.error(
      JSON.stringify({ kind: "keeper/telegram-reply-failed", reason: reason ?? "unknown" }),
    );
  }
}

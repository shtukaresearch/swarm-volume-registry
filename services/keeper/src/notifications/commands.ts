/** Telegram command parsing, kept separate from the transport. */
import type { Verbosity } from "./preferences.js";

export interface Command {
  /** Lowercased command name, without the slash or any `@bot` suffix. */
  name: string;
  /** The `@bot` suffix of `/cmd@bot`, when the command is addressed. */
  address?: string;
  args: string[];
}

/**
 * `/verbosity@KeeperBot error` becomes
 * `{ name: "verbosity", address: "KeeperBot", args: ["error"] }`.
 * Anything that does not start with a command is not a command.
 */
export function parseCommand(text: string): Command | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [head, ...args] = trimmed.split(/\s+/);
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/.exec(head ?? "");
  if (!match) return undefined;
  return {
    name: match[1]!.toLowerCase(),
    ...(match[2] ? { address: match[2] } : {}),
    args,
  };
}

export const describeVerbosity = (level: Verbosity): string =>
  level === "warn" ? "warn (failures and warnings)" : "error (failures only)";

export const helpText = (): string =>
  [
    "Keeper alert verbosity:",
    "/verbosity warn — failures and warnings",
    "/verbosity error — failures only",
    "/verbosity — show the current setting",
  ].join("\n");

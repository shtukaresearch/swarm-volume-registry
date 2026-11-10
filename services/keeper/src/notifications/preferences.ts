/**
 * The Telegram group's alert verbosity, stored in a Durable Object.
 *
 * One setting per chat: `error` posts only failed runs, `warn` posts failed and
 * warning runs. Failures always post, whatever the setting.
 *
 * A Durable Object rather than KV because a DO binding is created with the
 * Worker itself and needs no account-level KV namespace; the account hosting
 * this deployment does not grant KV creation to its members.
 */
export type Verbosity = "error" | "warn";

export const isVerbosity = (value: unknown): value is Verbosity =>
  value === "error" || value === "warn";

/** What a deployment posts when its group has never run `/verbosity`. */
export const defaultVerbosity = (notifyWarnings: boolean): Verbosity =>
  notifyWarnings ? "warn" : "error";

const LEVEL_KEY = "level";

/**
 * The Durable Object behind `KEEPER_PREFS`. One instance per chat id, so a
 * deployment that changes groups does not inherit the old group's setting.
 */
export class PreferenceStore implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/level") return new Response("not found\n", { status: 404 });

    if (request.method === "GET") {
      const level = await this.state.storage.get<Verbosity>(LEVEL_KEY);
      return Response.json({ level: isVerbosity(level) ? level : null });
    }

    if (request.method === "PUT") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "expected a JSON body" }, { status: 400 });
      }
      const level = (body as { level?: unknown } | null)?.level;
      if (!isVerbosity(level)) {
        return Response.json({ error: "level must be error or warn" }, { status: 400 });
      }
      await this.state.storage.put(LEVEL_KEY, level);
      return Response.json({ level });
    }

    return new Response("method not allowed\n", { status: 405 });
  }
}

/**
 * As much of the `KEEPER_PREFS` binding as is used here. Structural, because
 * `DurableObjectNamespace<PreferenceStore>` wants the class to extend the
 * `cloudflare:workers` base, which Node-run tests cannot import.
 */
export interface PreferenceNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** The chat's saved level, or `fallback` when it has none or cannot be read. */
export async function readVerbosity(
  prefs: PreferenceNamespace | undefined,
  chatId: string,
  fallback: Verbosity,
): Promise<Verbosity> {
  if (!prefs) return fallback;
  try {
    const stub = prefs.get(prefs.idFromName(chatId));
    const response = await stub.fetch("https://prefs/level");
    if (!response.ok) return fallback;
    const body = (await response.json()) as { level?: unknown };
    return isVerbosity(body.level) ? body.level : fallback;
  } catch {
    // A preference store that is down must not fail the keeper run; the
    // deployment default is still a safe answer.
    return fallback;
  }
}

/** Save the chat's level. Throws when the store cannot be reached. */
export async function setVerbosity(
  prefs: PreferenceNamespace,
  chatId: string,
  level: Verbosity,
): Promise<void> {
  const stub = prefs.get(prefs.idFromName(chatId));
  const response = await stub.fetch("https://prefs/level", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`preference store returned ${response.status}: ${detail.slice(0, 100)}`);
  }
}

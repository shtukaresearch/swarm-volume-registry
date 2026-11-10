import type { PreferenceNamespace, Verbosity } from "../src/notifications/preferences.js";

/**
 * A `KEEPER_PREFS` stand-in: the same `idFromName`/`get().fetch()` shape as a
 * Durable Object namespace, backed by a map so tests can inspect it.
 */
export type MemoryPrefs = PreferenceNamespace & { levels: Map<string, Verbosity> };

export function memoryPrefs(initial: Record<string, Verbosity> = {}): MemoryPrefs {
  const levels = new Map(Object.entries(initial));
  return {
    levels,
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const name = id as unknown as string;
        if ((init?.method ?? "GET") === "PUT") {
          const body = JSON.parse(String(init?.body)) as { level: Verbosity };
          levels.set(name, body.level);
          return Response.json({ ok: true });
        }
        return Response.json({ level: levels.get(name) ?? null });
      },
    }),
  } as unknown as MemoryPrefs;
}

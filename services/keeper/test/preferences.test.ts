import { describe, expect, test } from "vitest";
import {
  PreferenceStore,
  defaultVerbosity,
  readVerbosity,
  setVerbosity,
  type PreferenceNamespace,
} from "../src/notifications/preferences.js";
import { memoryPrefs } from "./mock-prefs.js";

/** The part of `DurableObjectState` the store uses. */
function state() {
  const values = new Map<string, unknown>();
  return {
    values,
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    },
  } as unknown as DurableObjectState & { values: Map<string, unknown> };
}

const request = (method: string, body?: unknown) =>
  new Request("https://prefs/level", {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

describe("PreferenceStore", () => {
  test("starts empty", async () => {
    const store = new PreferenceStore(state());
    expect(await (await store.fetch(request("GET"))).json()).toEqual({ level: null });
  });

  test("stores and returns a level", async () => {
    const s = state();
    const store = new PreferenceStore(s);
    expect((await store.fetch(request("PUT", { level: "warn" }))).status).toBe(200);
    expect(await (await store.fetch(request("GET"))).json()).toEqual({ level: "warn" });
    expect(s.values.get("level")).toBe("warn");
  });

  test("rejects an unknown or missing level", async () => {
    const store = new PreferenceStore(state());
    expect((await store.fetch(request("PUT", { level: "debug" }))).status).toBe(400);
    expect((await store.fetch(request("PUT", {}))).status).toBe(400);
    expect((await store.fetch(request("PUT"))).status).toBe(400);
  });

  test("rejects an unknown path and method", async () => {
    const store = new PreferenceStore(state());
    expect((await store.fetch(new Request("https://prefs/other"))).status).toBe(404);
    expect((await store.fetch(request("DELETE"))).status).toBe(405);
  });
});

describe("defaultVerbosity", () => {
  test("NOTIFY_WARNINGS=true means warn, otherwise error", () => {
    expect(defaultVerbosity(true)).toBe("warn");
    expect(defaultVerbosity(false)).toBe("error");
  });
});

describe("readVerbosity / setVerbosity", () => {
  test("a chat with no setting uses the fallback", async () => {
    expect(await readVerbosity(memoryPrefs(), "-100", "warn")).toBe("warn");
  });

  test("a saved setting overrides the fallback", async () => {
    const prefs = memoryPrefs();
    await setVerbosity(prefs, "-100", "error");
    expect(await readVerbosity(prefs, "-100", "warn")).toBe("error");
  });

  test("settings are per chat", async () => {
    const prefs = memoryPrefs();
    await setVerbosity(prefs, "-100", "error");
    expect(await readVerbosity(prefs, "-200", "warn")).toBe("warn");
  });

  test("a missing store falls back instead of failing the run", async () => {
    expect(await readVerbosity(undefined, "-100", "warn")).toBe("warn");
  });

  test("a store that throws falls back", async () => {
    const broken = {
      idFromName: () => "x",
      get: () => ({
        fetch: async () => {
          throw new Error("down");
        },
      }),
    } as unknown as PreferenceNamespace;
    expect(await readVerbosity(broken, "-100", "warn")).toBe("warn");
  });

  test("setVerbosity throws when the store rejects the write", async () => {
    const broken = {
      idFromName: () => "x",
      get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }),
    } as unknown as PreferenceNamespace;
    await expect(setVerbosity(broken, "-100", "error")).rejects.toThrow("500");
  });
});

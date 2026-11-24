import { beforeEach, describe, expect, test } from "vitest";
import type { KeeperEnv } from "../src/config.js";
import { ensureWebhook, handleTelegramWebhook } from "../src/notifications/webhook.js";
import { memoryPrefs } from "./mock-prefs.js";

const TOKEN = "123456789:AAtest-BOTSECRET-fixtures-only";
const CHAT = "-1001234567890";
const SECRET = "test-webhook-secret-0123456789";

const env = (overrides: Record<string, unknown> = {}): KeeperEnv =>
  ({
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_ID: CHAT,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    NOTIFY_WARNINGS: "true",
    ...overrides,
  }) as KeeperEnv;

let sent: Array<{ url: string; body: Record<string, unknown> }> = [];

const fetchStub = (async (url: string, init?: RequestInit) => {
  if (String(url).endsWith("/getMe")) {
    return Response.json({ ok: true, result: { username: "keeper_test_bot" } });
  }
  sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  return new Response('{"ok":true}');
}) as unknown as typeof fetch;

const post = (
  body: unknown,
  options: { secret?: string | null; env?: KeeperEnv } = {},
) =>
  handleTelegramWebhook(
    new Request("https://keeper.example/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.secret === null
          ? {}
          : { "X-Telegram-Bot-Api-Secret-Token": options.secret ?? SECRET }),
      },
      body: JSON.stringify(body),
    }),
    options.env ?? env(),
    { fetch: fetchStub },
  );

const update = ({
  text,
  chatId = Number(CHAT),
  username,
  fromBot = false,
}: {
  text: string;
  chatId?: number;
  username?: string;
  fromBot?: boolean;
}) => ({
  update_id: 1,
  message: {
    text,
    chat: { id: chatId, ...(username ? { username } : {}) },
    from: { id: 1, is_bot: fromBot },
  },
});

beforeEach(() => {
  sent = [];
});

describe("handleTelegramWebhook", () => {
  test("rejects a missing or wrong secret", async () => {
    expect((await post(update({ text: "/verbosity error" }), { secret: null })).status).toBe(403);
    expect((await post(update({ text: "/verbosity error" }), { secret: "wrong" })).status).toBe(403);
  });

  test("returns 404 when no webhook secret is configured", async () => {
    const response = await post(update({ text: "/verbosity error" }), {
      env: env({ TELEGRAM_WEBHOOK_SECRET: "" }),
    });
    expect(response.status).toBe(404);
  });

  test("only accepts POST", async () => {
    const response = await handleTelegramWebhook(new Request("https://keeper.example/telegram"), env());
    expect(response.status).toBe(405);
  });

  test("ignores commands from another chat", async () => {
    const store = memoryPrefs();
    await post(update({ text: "/verbosity error", chatId: -100999 }), {
      env: env({ KEEPER_PREFS: store }),
    });
    expect(store.levels.size).toBe(0);
    expect(sent).toEqual([]);
  });

  test("sets the level and confirms it", async () => {
    const store = memoryPrefs();
    await post(update({ text: "/verbosity error" }), { env: env({ KEEPER_PREFS: store }) });
    expect(store.levels.get(CHAT)).toBe("error");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text).toContain("Verbosity set to error");
  });

  test("warn enables warnings", async () => {
    const store = memoryPrefs();
    await post(update({ text: "/verbosity warn" }), { env: env({ KEEPER_PREFS: store }) });
    expect(store.levels.get(CHAT)).toBe("warn");
    expect(sent[0]!.body.text).toContain("failures and warnings");
  });

  test("shows the saved level, or the deployment default", async () => {
    await post(update({ text: "/verbosity" }), { env: env({ KEEPER_PREFS: memoryPrefs({ [CHAT]: "error" }) }) });
    expect(sent[0]!.body.text).toContain("Verbosity: error");

    sent = [];
    await post(update({ text: "/verbosity" }), {
      env: env({ KEEPER_PREFS: memoryPrefs(), NOTIFY_WARNINGS: "true" }),
    });
    expect(sent[0]!.body.text).toContain("Verbosity: warn");
  });

  test("rejects an unknown level", async () => {
    const store = memoryPrefs();
    await post(update({ text: "/verbosity debug" }), { env: env({ KEEPER_PREFS: store }) });
    expect(store.levels.size).toBe(0);
    expect(sent[0]!.body.text).toContain("Unknown verbosity");
  });

  test("answers /help and /start", async () => {
    await post(update({ text: "/help" }), { env: env({ KEEPER_PREFS: memoryPrefs() }) });
    expect(sent[0]!.body.text).toContain("/verbosity warn");

    sent = [];
    await post(update({ text: "/start" }), { env: env({ KEEPER_PREFS: memoryPrefs() }) });
    expect(sent[0]!.body.text).toContain("/verbosity error");
  });

  test("ignores ordinary text, other commands, and bots", async () => {
    await post(update({ text: "hello" }), { env: env({ KEEPER_PREFS: memoryPrefs() }) });
    await post(update({ text: "/other" }), { env: env({ KEEPER_PREFS: memoryPrefs() }) });
    await post(update({ text: "/verbosity error", fromBot: true }), {
      env: env({ KEEPER_PREFS: memoryPrefs() }),
    });
    expect(sent).toEqual([]);
  });

  test("a /verbosity@bot command is acted on only by the named bot", async () => {
    const store = memoryPrefs();
    await post(update({ text: "/verbosity@keeper_test_bot error" }), {
      env: env({ KEEPER_PREFS: store }),
    });
    expect(store.levels.get(CHAT)).toBe("error");

    store.levels.clear();
    await post(update({ text: "/verbosity@another_bot error" }), {
      env: env({ KEEPER_PREFS: store }),
    });
    expect(store.levels.size).toBe(0);
  });

  test("with no level saved, NOTIFY_WARNINGS decides what /verbosity shows", async () => {
    await post(update({ text: "/verbosity" }), {
      env: env({ KEEPER_PREFS: memoryPrefs(), NOTIFY_WARNINGS: "false" }),
    });
    expect(sent[0]!.body.text).toContain("Verbosity: error");
  });

  test("an @channel chat id is matched by username", async () => {
    const store = memoryPrefs();
    await post(update({ text: "/verbosity warn", chatId: -100999, username: "opsgroup" }), {
      env: env({ KEEPER_PREFS: store, TELEGRAM_CHAT_ID: "@opsgroup" }),
    });
    expect(store.levels.get("@opsgroup")).toBe("warn");
  });
});

describe("ensureWebhook", () => {
  const URL_ = "https://keeper.example/telegram";
  let calls: Array<{ method: string; body?: Record<string, unknown> }>;

  /** Telegram, holding `current` as the registered webhook. */
  const telegram =
    (current: { url?: string; last_error_message?: string }, setStatus = 200) =>
    (async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      calls.push({ method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (method === "getWebhookInfo") return Response.json({ ok: true, result: current });
      return new Response('{"ok":true}', { status: setStatus });
    }) as unknown as typeof fetch;

  beforeEach(() => {
    calls = [];
  });

  test("registers this Worker, with the secret, when the webhook points elsewhere", async () => {
    const result = await ensureWebhook(env({ TELEGRAM_WEBHOOK_URL: URL_ }), {
      fetch: telegram({ url: "" }),
    });
    expect(result).toEqual({ status: "registered" });
    expect(calls.map((c) => c.method)).toEqual(["getWebhookInfo", "setWebhook"]);
    expect(calls[1]!.body).toEqual({
      url: URL_,
      secret_token: SECRET,
      allowed_updates: ["message"],
    });
  });

  test("leaves a webhook already in place alone", async () => {
    const result = await ensureWebhook(env({ TELEGRAM_WEBHOOK_URL: URL_ }), {
      fetch: telegram({ url: URL_, last_error_message: "Read timeout expired" }),
    });
    expect(result).toEqual({ status: "unchanged" });
    expect(calls.map((c) => c.method)).toEqual(["getWebhookInfo"]);
  });

  // A rotated secret shows up only as the Worker refusing Telegram's updates.
  test("re-registers when Telegram's updates are being refused", async () => {
    const result = await ensureWebhook(env({ TELEGRAM_WEBHOOK_URL: URL_ }), {
      fetch: telegram({ url: URL_, last_error_message: "Wrong response from the webhook: 403 Forbidden" }),
    });
    expect(result).toEqual({ status: "registered" });
  });

  test("does nothing without a URL or a secret", async () => {
    expect(await ensureWebhook(env(), { fetch: telegram({}) })).toBeUndefined();
    expect(
      await ensureWebhook(env({ TELEGRAM_WEBHOOK_URL: URL_, TELEGRAM_WEBHOOK_SECRET: "" }), {
        fetch: telegram({}),
      }),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("a failure comes back as a value, without the token", async () => {
    const rejected = await ensureWebhook(env({ TELEGRAM_WEBHOOK_URL: URL_ }), {
      fetch: telegram({ url: "" }, 400),
    });
    expect(rejected).toMatchObject({ status: "failed" });

    const thrown = await ensureWebhook(env({ TELEGRAM_WEBHOOK_URL: URL_ }), {
      fetch: (async (url: string) => {
        throw new Error(`fetch failed: ${url}`);
      }) as unknown as typeof fetch,
    });
    expect(thrown).toMatchObject({ status: "failed" });
    expect(JSON.stringify(thrown)).not.toContain("BOTSECRET");
  });
});

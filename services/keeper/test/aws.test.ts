/**
 * What the AWS deployment adds around the Worker: deriving it from
 * wrangler.jsonc, the API calls that deploy it, and the Lambda event shapes.
 * Whole runs through the Lambda handlers are in worker.test.ts.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import type { Aws } from "../scripts/aws-api.js";
import {
  awsDeployment,
  configurations,
  deploy,
  environment,
  missingSecrets,
  parseSecretsFile,
  schedule,
} from "../scripts/aws.js";
import { createHandlers, health, randomStartDelay } from "../src/aws/handler.js";
import type { KeeperEnv } from "../src/config.js";
import { KeeperRunFailed } from "../src/index.js";
import { AWS_START_DELAY_MS, cronIntervalSeconds, toEventBridgeCron } from "../src/schedule.js";

const DEPLOYMENTS = ["sepolia-v2-rc4"] as const;
const NAME = "keeper-aws-sepolia-v2-rc4";

const SECRETS = {
  PRIVATE_KEY: "0xkey",
  RPC_URL: "https://a.example/k,https://b.example/k",
  TELEGRAM_BOT_TOKEN: "1:token",
  TELEGRAM_CHAT_ID: "-100123",
};

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("schedule", () => {
  test.each([
    ["* * * * *", 60, "cron(* * * * ? *)"],
    ["*/5 * * * *", 300, "cron(*/5 * * * ? *)"],
    ["0 * * * *", 3600, "cron(0 * * * ? *)"],
  ])("%s runs every %i s, as %s", (cron, seconds, eventBridge) => {
    expect(cronIntervalSeconds(cron)).toBe(seconds);
    expect(toEventBridgeCron(cron)).toBe(eventBridge);
  });

  // Day-of-week numbering differs between the two cron dialects; a shape the
  // budget check cannot read must not be translated either.
  test.each(["0 0 * * 1", "0 0 1 * *", "0 */2 * * *", "* * * *"])("rejects %s", (cron) => {
    expect(() => toEventBridgeCron(cron)).toThrow("unsupported cron");
  });

  test("each run gets the wrangler cron and the tick's time", () => {
    const { rule, input } = schedule(awsDeployment("sepolia-v2-rc4"));
    expect(rule).toMatchObject({
      Name: NAME,
      ScheduleExpression: "cron(*/10 * * * ? *)",
      State: "ENABLED",
    });
    expect(input.InputPathsMap).toEqual({ time: "$.time" });
    // EventBridge substitutes a string variable quoted.
    const event = input.InputTemplate.replace("<time>", JSON.stringify("2026-10-21T12:00:00Z"));
    expect(JSON.parse(event)).toEqual({ cron: "*/10 * * * *", scheduledTime: "2026-10-21T12:00:00Z" });
  });

  test("--paused deploys the rule disabled", () => {
    expect(schedule(awsDeployment("sepolia-v2-rc4", {}, { paused: true })).rule.State).toBe("DISABLED");
  });
});

describe("awsDeployment", () => {
  for (const env of DEPLOYMENTS) {
    test(`${env}: everything comes from wrangler.jsonc`, () => {
      const worker = unstable_readConfig({ config: join(import.meta.dirname, "..", "wrangler.jsonc"), env });
      const cron = worker.triggers.crons![0]!;

      expect(awsDeployment(env)).toEqual({
        name: NAME,
        vars: {
          ...worker.vars,
          DEPLOYMENT_NAME: NAME,
          CYCLE_TIMEOUT_MS: String(Number(worker.vars!.CYCLE_TIMEOUT_MS) - AWS_START_DELAY_MS.max),
        },
        secrets: worker.secrets!.required,
        cron,
        interval: cronIntervalSeconds(cron),
        paused: false,
      });
    });
  }

  test("--var overrides a var for one deploy", () => {
    const { vars } = awsDeployment("sepolia-v2-rc4", { DRY_RUN: "true", CYCLE_TIMEOUT_MS: "300000" });
    expect(vars.DRY_RUN).toBe("true");
    // Shortened like the env's own value: the start delay still comes out.
    expect(vars.CYCLE_TIMEOUT_MS).toBe(String(300_000 - AWS_START_DELAY_MS.max));
    expect(vars.DEPLOYMENT_NAME).toBe(NAME);
  });

  // The root is not a deployment on AWS either.
  test("the root config has no cron, so no deployment", () => {
    expect(() => awsDeployment("")).toThrow("expected exactly one cron trigger");
  });

  test("CYCLE_TIMEOUT_MS leaves time after the longest start delay", () => {
    expect(() => awsDeployment("sepolia-v2-rc4", { CYCLE_TIMEOUT_MS: String(AWS_START_DELAY_MS.max) })).toThrow(
      "leaves no time after the start delay",
    );
  });
});

describe("environment", () => {
  const deployment = awsDeployment("sepolia-v2-rc4");

  test("is the env's vars and its secrets, under their own names", () => {
    expect(environment(deployment, {}, SECRETS)).toEqual({
      ...deployment.vars,
      ...SECRETS,
      NODE_OPTIONS: "--enable-source-maps",
    });
  });

  test("keeps deployed secrets unless given new ones, and drops anything else deployed", () => {
    const env = environment(
      deployment,
      { ...SECRETS, CHAIN_ID: "1", DRY_RUN: "true" },
      { TELEGRAM_BOT_TOKEN: "2:rotated" },
    );
    expect(env).toMatchObject({ PRIVATE_KEY: "0xkey", TELEGRAM_BOT_TOKEN: "2:rotated", CHAIN_ID: "11155111" });
    expect(env).not.toHaveProperty("DRY_RUN");
  });

  test("names the secrets it would lack", () => {
    const env = environment(deployment, {}, { PRIVATE_KEY: "0xkey", RPC_URL: "" });
    expect(missingSecrets(deployment, env)).toEqual(["RPC_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  });
});

describe("configurations", () => {
  test("a run cannot outlast its interval, nor Lambda's 15 minutes", () => {
    // Every ten minutes, so the interval binds before 15 minutes.
    expect(configurations(awsDeployment("sepolia-v2-rc4"), "role", {}).keeper.Timeout).toBe(600);
  });

  test("both functions run the same bundle and environment, on the given role", () => {
    const env = { CHAIN_ID: "11155111" };
    const { keeper, health } = configurations(awsDeployment("sepolia-v2-rc4"), "arn:role", env);
    expect(keeper).toMatchObject({ FunctionName: NAME, Handler: "index.scheduled" });
    expect(health).toMatchObject({ FunctionName: `${NAME}-health`, Handler: "index.health", Timeout: 10 });
    for (const fn of [keeper, health]) {
      expect(fn).toMatchObject({
        Role: "arn:role",
        Runtime: "nodejs24.x",
        Environment: { Variables: env },
        LoggingConfig: { LogFormat: "JSON" },
      });
    }
  });
});

describe("parseSecretsFile", () => {
  test("reads the --secrets-file format", () => {
    const file = [
      "# comment",
      "",
      "PRIVATE_KEY=0xabc",
      'RPC_URL="https://a.example/k,https://b.example/k"',
      "TELEGRAM_BOT_TOKEN='1:a=b'",
      "TELEGRAM_CHAT_ID = -100123 ",
    ].join("\n");
    expect(parseSecretsFile(file)).toEqual({
      PRIVATE_KEY: "0xabc",
      RPC_URL: "https://a.example/k,https://b.example/k",
      TELEGRAM_BOT_TOKEN: "1:a=b",
      TELEGRAM_CHAT_ID: "-100123",
    });
  });

  // The error must not echo the line: it would be a secret.
  test.each(["0xdeadbeef", "=0xdeadbeef"])("rejects %s without printing it", (line) => {
    const error = (() => {
      try {
        parseSecretsFile(`# keeper\n${line}`);
      } catch (err) {
        return String(err);
      }
    })();
    expect(error).toContain("line 2 is not a KEY=value line");
    expect(error).not.toContain("deadbeef");
  });
});

describe("deploy", () => {
  const ZIP = new Uint8Array([1, 2, 3]);
  const ROLE = "arn:aws:iam::123456789012:role/lambda-cron-exec";
  const URL = "https://abc.lambda-url.eu-central-1.on.aws/";
  const RULE = `arn:aws:events:eu-central-1:123456789012:rule/${NAME}`;
  const arn = (name: string) => `arn:aws:lambda:eu-central-1:123456789012:function:${name}`;
  const fail = (name: string, message = name) => {
    throw Object.assign(new Error(message), { name });
  };

  type Fake = Aws;
  // Any return: the fake stands in for every method, and `any` lets one shape
  // serve the promise of each.
  type Answer = (...args: any[]) => any;

  /** The client, answering each call and recording it. */
  function fakeAws(answers: Partial<Record<keyof Fake, Answer>> = {}) {
    const calls: Array<{ method: keyof Fake; args: unknown[] }> = [];
    const all: Record<keyof Fake, Answer> = {
      executionRole: async () => ROLE,
      functionConfiguration: async () => undefined,
      createFunction: async (config: { FunctionName: string }) => arn(config.FunctionName),
      updateFunctionCode: async () => {},
      updateFunctionConfiguration: async () => {},
      putEventInvokeConfig: async () => {},
      putFunctionConcurrency: async () => {},
      functionUrl: async () => URL,
      addPermission: async () => {},
      putRule: async () => RULE,
      putTargets: async () => {},
      waitUntilActive: async () => {},
      waitUntilUpdated: async () => {},
      ...answers,
    };
    const aws = new Proxy({} as Fake, {
      get(_, method: string) {
        return async (...args: unknown[]) => {
          calls.push({ method: method as keyof Fake, args });
          return (all as any)[method](...args);
        };
      },
    });
    const sent = (method: keyof Fake) => calls.filter((call) => call.method === method).map((call) => call.args);
    return { aws, calls, sent };
  }

  test("a first deploy creates both functions on the account's role, the URL, and the schedule", async () => {
    const deployment = awsDeployment("sepolia-v2-rc4", {}, { paused: true });
    const { aws, sent } = fakeAws();

    expect(await deploy(deployment, SECRETS, ZIP, aws)).toBe(URL);

    const created = sent("createFunction").map(([config]) => config as any);
    expect(created.map((fn) => fn.FunctionName)).toEqual([NAME, `${NAME}-health`]);
    for (const fn of created) {
      expect(fn).toMatchObject({
        Role: ROLE,
        Architectures: ["arm64"],
        Code: { ZipFile: ZIP },
        Environment: { Variables: environment(deployment, {}, SECRETS) },
      });
    }
    // The Worker's noRetry(), and one run at a time.
    expect(sent("putEventInvokeConfig")).toEqual([[NAME]]);
    expect(sent("putFunctionConcurrency")).toEqual([
      [NAME, 1],
      [`${NAME}-health`, 1],
    ]);

    const grants = sent("addPermission").map(([fn, statement]) => [fn, statement] as const);
    expect(grants).toContainEqual([
      NAME,
      expect.objectContaining({ Principal: "events.amazonaws.com", SourceArn: RULE }),
    ]);
    expect(grants.filter(([, statement]) => (statement as any).Principal === "*")).toEqual([
      [`${NAME}-health`, expect.objectContaining({ Action: "lambda:InvokeFunctionUrl" })],
      [`${NAME}-health`, expect.objectContaining({ Action: "lambda:InvokeFunction" })],
    ]);

    expect(sent("putRule")).toEqual([[schedule(deployment).rule]]);
    expect(sent("putTargets")).toEqual([
      [
        NAME,
        [
          {
            Id: "keeper",
            Arn: arn(NAME),
            InputTransformer: schedule(deployment).input,
            RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
          },
        ],
      ],
    ]);
  });

  // As `secrets.required` does for wrangler deploy.
  test("deploys nothing without every secret", async () => {
    const { aws, sent } = fakeAws();
    await expect(deploy(awsDeployment("sepolia-v2-rc4"), { PRIVATE_KEY: "0xkey" }, ZIP, aws)).rejects.toThrow(
      `${NAME}: no value for RPC_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID`,
    );
    expect(sent("createFunction")).toEqual([]);
  });

  test("a redeploy keeps the deployed secrets, and skips unchanged code", async () => {
    const deployment = awsDeployment("sepolia-v2-rc4");
    const { aws, sent } = fakeAws({
      functionConfiguration: async (name) => ({
        FunctionName: name,
        FunctionArn: arn(name),
        Role: ROLE,
        Runtime: "nodejs24.x",
        MemorySize: 256,
        Handler: "index.scheduled",
        Timeout: 600,
        CodeSha256: createHash("sha256").update(ZIP).digest("base64"),
        Environment: { Variables: { ...SECRETS, DRY_RUN: "true" } },
      }),
    });

    expect(await deploy(deployment, { TELEGRAM_BOT_TOKEN: "2:rotated" }, ZIP, aws)).toBe(URL);

    expect(sent("createFunction")).toEqual([]);
    expect(sent("updateFunctionCode")).toEqual([]);
    const updated = sent("updateFunctionConfiguration").map(([config]) => config as any);
    expect(updated).toHaveLength(2);
    expect(updated[0].Environment.Variables).toEqual(
      environment(deployment, {}, { ...SECRETS, TELEGRAM_BOT_TOKEN: "2:rotated" }),
    );
  });

  test("ships changed code before the configuration, and waits for each", async () => {
    const { aws, calls } = fakeAws({
      functionConfiguration: async (name) => ({
        FunctionName: name,
        FunctionArn: arn(name),
        Role: ROLE,
        Runtime: "nodejs24.x",
        MemorySize: 256,
        Handler: "index.scheduled",
        Timeout: 600,
        CodeSha256: "older",
        Environment: { Variables: SECRETS },
      }),
    });

    await deploy(awsDeployment("sepolia-v2-rc4"), {}, ZIP, aws);

    const order = calls
      .map((call) => String(call.method))
      .filter((method) => method.startsWith("updateFunction") || method === "waitUntilUpdated");
    expect(order).toEqual([
      "updateFunctionCode",
      "waitUntilUpdated",
      "updateFunctionConfiguration",
      "waitUntilUpdated",
      "updateFunctionCode",
      "waitUntilUpdated",
      "updateFunctionConfiguration",
      "waitUntilUpdated",
    ]);
  });

  // A new account's limit of 10 leaves nothing to reserve.
  describe("on an account that can't reserve concurrency", () => {
    const tooLow = () =>
      fail(
        "InvalidParameterValueException",
        "Specified ReservedConcurrentExecutions for function decreases account's UnreservedConcurrentExecution below its minimum value of [10].",
      );

    test("a paused deploy goes ahead, and says what to fix", async () => {
      const log = vi.fn();
      const { aws, sent } = fakeAws({ putFunctionConcurrency: tooLow });
      await deploy(awsDeployment("sepolia-v2-rc4", {}, { paused: true }), SECRETS, ZIP, aws, log);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("L-B99A9384"));
      expect((sent("putRule")[0]![0] as any).State).toBe("DISABLED");
    });

    test("a live deploy goes ahead on schedule, and says what to fix", async () => {
      const log = vi.fn();
      const { aws, sent } = fakeAws({ putFunctionConcurrency: tooLow });
      await deploy(awsDeployment("sepolia-v2-rc4"), SECRETS, ZIP, aws, log);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("L-B99A9384"));
      expect((sent("putRule")[0]![0] as any).State).toBe("ENABLED");
    });
  });

  test("names the missing execution role", async () => {
    const { aws } = fakeAws({ executionRole: async () => fail("NoSuchEntity") });
    await expect(deploy(awsDeployment("sepolia-v2-rc4"), SECRETS, ZIP, aws)).rejects.toThrow(
      "no lambda-cron-exec role",
    );
  });
});

describe("Lambda handlers", () => {
  const env = { DEPLOYMENT_NAME: "keeper-test" } as KeeperEnv;
  const noDelay = { startDelay: () => 0 };

  test("a run reports the schedule's cron and tick time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(error);
    const { scheduled } = createHandlers(env, noDelay);

    const outcome = await scheduled({ cron: "0 * * * *", scheduledTime: "2026-10-07T12:00:00Z" }).catch(
      (err: unknown) => err,
    );

    // Unconfigured, so the run fails — and the invocation with it.
    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    const [line] = error.mock.calls[0]!;
    expect(JSON.parse(line as string)).toMatchObject({
      kind: "keeper/run",
      deployment: "keeper-test",
      cron: "0 * * * *",
      scheduledTime: Date.parse("2026-10-07T12:00:00Z"),
    });
  });

  // Two keepers on one schedule would otherwise reach the same volumes in the
  // same second, one of them paying for a top-up the other already did.
  test("waits for the start delay before the run", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(error);
    const { scheduled } = createHandlers(env, { startDelay: () => 120_000 });

    const run = scheduled({ cron: "*/10 * * * *" }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBeInstanceOf(KeeperRunFailed);
    expect(error).toHaveBeenCalled();
  });

  test.each([
    [0, AWS_START_DELAY_MS.min],
    [0.5, 120_000],
    [0.999_999, AWS_START_DELAY_MS.max],
  ])("Math.random() %f waits %i ms", (random, delay) => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(random);
    spies.push(spy);
    expect(randomStartDelay()).toBe(delay);
  });

  const request = (rawPath: string, rawQueryString = "") =>
    ({
      rawPath,
      rawQueryString,
      requestContext: { domainName: "abc.lambda-url.eu-central-1.on.aws", http: { method: "GET" } },
    }) as Parameters<ReturnType<typeof createHandlers>["health"]>[0];

  test("health answers as a Function URL result", async () => {
    const result = await createHandlers(env).health(request("/health", "verbose=1"));
    expect(result).toMatchObject({ statusCode: 503 });
    if (typeof result === "string") throw new Error("expected a structured result");
    expect(result.headers?.["content-type"]).toContain("application/json");
    expect(JSON.parse(result.body!)).toMatchObject({ status: "misconfigured", deployment: "keeper-test" });
    expect(await createHandlers(env).health(request("/"))).toMatchObject({ statusCode: 404 });
  });

  // What Lambda runs: the exported handlers, over the function's own
  // environment variables.
  test("the exported handlers read the function's environment", async () => {
    vi.stubEnv("DEPLOYMENT_NAME", "keeper-from-env");
    const result = await health(request("/health"));
    if (typeof result === "string") throw new Error("expected a structured result");
    expect(JSON.parse(result.body!)).toMatchObject({ deployment: "keeper-from-env" });
  });
});

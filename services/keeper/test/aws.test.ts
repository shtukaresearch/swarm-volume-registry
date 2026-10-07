/**
 * What the AWS deployment adds around the Worker: deriving each stack from
 * wrangler.jsonc, reading secrets from SSM, and the Lambda event shapes.
 * Whole runs through the Lambda handlers are in worker.test.ts, alongside the
 * Worker's.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { unstable_readConfig } from "wrangler";
import {
  TEMPLATE,
  awsDeployment,
  missingSecrets,
  parseSecretsFile,
  samParameter,
} from "../scripts/aws.js";
import { HEALTH_SECRETS_TTL_MS, createHandlers, ssmSecrets } from "../src/aws/handler.js";
import { KeeperRunFailed } from "../src/index.js";
import { cronIntervalSeconds, toEventBridgeCron } from "../src/schedule.js";

const DEPLOYMENTS = ["sepolia", "gnosis"] as const;

/** An SSM client that answers each command with `respond(input)`. */
function fakeSsm(respond: (input: Record<string, unknown>) => unknown) {
  const send = vi.fn(async (command: { input: Record<string, unknown> }) => respond(command.input));
  return { client: { send } as unknown as Pick<SSMClient, "send">, send };
}

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
});

describe("awsDeployment", () => {
  for (const env of DEPLOYMENTS) {
    test(`${env}: everything comes from wrangler.jsonc`, () => {
      const worker = unstable_readConfig({ config: join(import.meta.dirname, "..", "wrangler.jsonc"), env });
      const aws = awsDeployment(env);
      const cron = worker.triggers.crons![0]!;

      expect(aws.name).toBe(`keeper-${env}`);
      expect(aws.secretsPath).toBe(`/keeper-${env}/`);
      expect(aws.secrets).toEqual(worker.secrets!.required!);
      expect(JSON.parse(aws.parameters.KeeperVars!)).toEqual(worker.vars);
      expect(aws.parameters).toMatchObject({
        DeploymentName: worker.name,
        KeeperSecrets: worker.secrets!.required!.join(","),
        Cron: cron,
        ScheduleExpression: toEventBridgeCron(cron),
        IntervalSeconds: String(cronIntervalSeconds(cron)),
      });
      // Every parameter must survive SAM CLI's --parameter-overrides parsing.
      for (const [key, value] of Object.entries(aws.parameters)) samParameter(key, value);
    });
  }

  test("a run cannot outlast its interval, nor Lambda's 15 minutes", () => {
    expect(awsDeployment("sepolia").parameters.TimeoutSeconds).toBe("60");
    expect(awsDeployment("gnosis").parameters.TimeoutSeconds).toBe("900");
  });

  // Every deploy states it, so no deploy can leave the schedule as it found it.
  test("--paused deploys with the schedule off; anything else turns it on", () => {
    expect(awsDeployment("sepolia").parameters.ScheduleState).toBe("ENABLED");
    expect(awsDeployment("sepolia", {}, { paused: true }).parameters.ScheduleState).toBe("DISABLED");
  });

  test("--var overrides a var for one deploy", () => {
    const vars = JSON.parse(awsDeployment("sepolia", { DRY_RUN: "true" }).parameters.KeeperVars!);
    expect(vars.DRY_RUN).toBe("true");
    expect(vars.DEPLOYMENT_NAME).toBe("keeper-sepolia");
  });

  // The root is not a deployment on AWS either.
  test("the root config has no cron, so no stack", () => {
    expect(() => awsDeployment("")).toThrow("expected exactly one cron trigger");
  });

  test("passes exactly the parameters template.yaml requires", () => {
    const template = readFileSync(TEMPLATE, "utf8");
    const section = template.slice(template.indexOf("\nParameters:\n"), template.indexOf("\nConditions:\n"));
    const declared = [...section.matchAll(/^ {2}(\w+):\n((?: {4}.*\n)*)/gm)];
    const required = declared.filter(([, , body]) => !/^ {4}Default:/m.test(body!)).map(([, name]) => name!);
    const all = declared.map(([, name]) => name!);

    const passed = Object.keys(awsDeployment("sepolia").parameters);
    expect(passed.sort()).toEqual(required.sort());
    for (const name of passed) expect(all).toContain(name);
  });
});

describe("samParameter", () => {
  test("quotes the value and escapes its quotes", () => {
    expect(samParameter("KeeperVars", '{"A":"1"}')).toBe('KeeperVars="{\\"A\\":\\"1\\"}"');
    expect(samParameter("Cron", "* * * * *")).toBe('Cron="* * * * *"');
  });

  // SAM CLI unescapes \" and nothing else.
  test("refuses a backslash, which cannot round-trip", () => {
    expect(() => samParameter("KeeperVars", '{"A":"\\""}')).toThrow("backslash");
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

describe("missingSecrets", () => {
  test("names what SSM lacks, across pages, without reading values", async () => {
    const deployment = awsDeployment("sepolia");
    const pages = [
      { Parameters: [{ Name: "/keeper-sepolia/PRIVATE_KEY" }], NextToken: "next" },
      { Parameters: [{ Name: "/keeper-sepolia/RPC_URL" }] },
    ];
    const { client, send } = fakeSsm(() => pages.shift());

    expect(await missingSecrets(deployment, client)).toEqual([
      "/keeper-sepolia/TELEGRAM_BOT_TOKEN",
      "/keeper-sepolia/TELEGRAM_CHAT_ID",
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].input).toMatchObject({ NextToken: "next" });
    expect(send.mock.calls[0]![0].constructor.name).toBe("DescribeParametersCommand");
  });
});

describe("ssmSecrets", () => {
  test("reads each name under the path, decrypted, and strips the path", async () => {
    const { client, send } = fakeSsm((input) => ({
      Parameters: (input.Names as string[])
        .filter((name) => !name.endsWith("MISSING"))
        .map((Name) => ({ Name, Value: `value of ${Name}` })),
    }));
    const names = Array.from({ length: 12 }, (_, i) => `S${i}`).concat("MISSING");

    const found = await ssmSecrets("/keeper-test/", client)(names);

    expect(Object.keys(found)).toHaveLength(12);
    expect(found.S0).toBe("value of /keeper-test/S0");
    expect(found).not.toHaveProperty("MISSING");
    // GetParameters takes at most ten names.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].input).toMatchObject({ WithDecryption: true });
    expect((send.mock.calls[0]![0].input.Names as string[])[0]).toBe("/keeper-test/S0");
  });
});

describe("Lambda handlers", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  const processEnv = {
    KEEPER_VARS: JSON.stringify({ DEPLOYMENT_NAME: "keeper-test" }),
    KEEPER_SECRETS: "PRIVATE_KEY,RPC_URL",
    KEEPER_SECRETS_PATH: "/keeper-test/",
  };

  test("a run reports the schedule's cron and tick time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(error);
    const { scheduled } = createHandlers(async () => ({}), processEnv);

    const outcome = await scheduled({ cron: "0 * * * *", scheduledTime: "2026-10-07T12:00:00Z" }).catch(
      (err: unknown) => err,
    );

    // Unconfigured, so the run fails — and the invocation with it.
    expect(outcome).toBeInstanceOf(KeeperRunFailed);
    expect(error.mock.calls[0]![0]).toMatchObject({
      kind: "keeper/run",
      deployment: "keeper-test",
      cron: "0 * * * *",
      scheduledTime: Date.parse("2026-10-07T12:00:00Z"),
    });
  });

  test("asks for exactly the deployment's secrets", async () => {
    spies.push(vi.spyOn(console, "error").mockImplementation(() => {}));
    const source = vi.fn(async () => ({}));
    await createHandlers(source, processEnv).scheduled({}).catch(() => {});
    expect(source).toHaveBeenCalledWith(["PRIVATE_KEY", "RPC_URL"]);
  });

  test("an undeployable KEEPER_VARS throws, naming the fix", async () => {
    const { scheduled } = createHandlers(async () => ({}), { ...processEnv, KEEPER_VARS: "{" });
    await expect(scheduled({})).rejects.toThrow("KEEPER_VARS is not valid JSON");
  });

  const request = (rawPath: string, rawQueryString = "") =>
    ({
      rawPath,
      rawQueryString,
      requestContext: { domainName: "abc.lambda-url.eu-central-1.on.aws", http: { method: "GET" } },
    }) as Parameters<ReturnType<typeof createHandlers>["health"]>[0];

  test("health answers as a Function URL result", async () => {
    const { health } = createHandlers(async () => ({}), processEnv);
    const result = await health(request("/health", "verbose=1"));
    expect(result).toMatchObject({ statusCode: 503 });
    if (typeof result === "string") throw new Error("expected a structured result");
    expect(result.headers?.["content-type"]).toContain("application/json");
    expect(JSON.parse(result.body!)).toMatchObject({ status: "misconfigured", deployment: "keeper-test" });
    expect(await health(request("/"))).toMatchObject({ statusCode: 404 });
  });

  // The URL is public; SSM throughput is the scheduled run's.
  test("health reuses its secrets for a minute, but never a failed read", async () => {
    let now = 1_000_000;
    spies.push(vi.spyOn(Date, "now").mockImplementation(() => now));
    let fail = true;
    const source = vi.fn(async () => {
      if (fail) throw new Error("ssm down");
      return {};
    });
    const { health } = createHandlers(source, processEnv);

    await expect(health(request("/health"))).rejects.toThrow("ssm down");
    fail = false;
    await health(request("/health"));
    await health(request("/health"));
    expect(source).toHaveBeenCalledTimes(2);

    now += HEALTH_SECRETS_TTL_MS;
    await health(request("/health"));
    expect(source).toHaveBeenCalledTimes(3);
  });
});

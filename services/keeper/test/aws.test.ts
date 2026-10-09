/**
 * What the AWS deployment adds around the Worker: deriving each stack from
 * wrangler.jsonc, and the Lambda event shapes. Whole runs through the Lambda
 * handlers are in worker.test.ts, alongside the Worker's.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import {
  PERMISSIONS_BOUNDARY,
  awsDeployment,
  missingSecrets,
  parseSecretsFile,
  secretOverrides,
  secretParameter,
  template,
} from "../scripts/aws.js";
import { createHandlers, health } from "../src/aws/handler.js";
import type { KeeperEnv } from "../src/config.js";
import { KeeperRunFailed } from "../src/index.js";
import { cronIntervalSeconds, toEventBridgeCron } from "../src/schedule.js";

const DEPLOYMENTS = ["sepolia", "gnosis"] as const;

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  vi.unstubAllEnvs();
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
});

describe("awsDeployment", () => {
  for (const env of DEPLOYMENTS) {
    test(`${env}: everything comes from wrangler.jsonc`, () => {
      const worker = unstable_readConfig({ config: join(import.meta.dirname, "..", "wrangler.jsonc"), env });
      const cron = worker.triggers.crons![0]!;

      expect(awsDeployment(env)).toEqual({
        name: `keeper-${env}`,
        vars: worker.vars,
        secrets: worker.secrets!.required,
        cron,
        interval: cronIntervalSeconds(cron),
        paused: false,
      });
    });
  }

  test("--var overrides a var for one deploy", () => {
    const { vars } = awsDeployment("sepolia", { DRY_RUN: "true" });
    expect(vars.DRY_RUN).toBe("true");
    expect(vars.DEPLOYMENT_NAME).toBe("keeper-sepolia");
  });

  // The root is not a deployment on AWS either.
  test("the root config has no cron, so no stack", () => {
    expect(() => awsDeployment("")).toThrow("expected exactly one cron trigger");
  });
});

describe("template", () => {
  type Resource = { Type: string; Properties: Record<string, unknown> };
  const resources = (deployment = awsDeployment("sepolia")) =>
    Object.values(template(deployment).Resources) as Resource[];

  for (const env of DEPLOYMENTS) {
    // The Worker's bindings, under the same names: vars as they are, secrets
    // from the stack's parameters.
    test(`${env}: both functions get the Worker's bindings as environment variables`, () => {
      const deployment = awsDeployment(env);
      const { KeeperFunction, HealthFunction } = template(deployment).Resources;
      const expected = {
        ...deployment.vars,
        PRIVATE_KEY: { Ref: "PrivateKey" },
        RPC_URL: { Ref: "RpcUrl" },
        TELEGRAM_BOT_TOKEN: { Ref: "TelegramBotToken" },
        TELEGRAM_CHAT_ID: { Ref: "TelegramChatId" },
        NODE_OPTIONS: "--enable-source-maps",
      };
      expect(KeeperFunction.Properties.Environment.Variables).toEqual(expected);
      expect(HealthFunction.Properties.Environment.Variables).toEqual(expected);
    });
  }

  test("--var reaches the functions' environment", () => {
    const { KeeperFunction } = template(awsDeployment("sepolia", { DRY_RUN: "true" })).Resources;
    expect(KeeperFunction.Properties.Environment.Variables).toMatchObject({ DRY_RUN: "true" });
  });

  // NoEcho keeps a value out of every description of the stack, and a deploy
  // that does not pass one keeps the stack's.
  test("the secrets are its only parameters: NoEcho, and never empty", () => {
    const { Parameters } = template(awsDeployment("sepolia"));
    expect(Object.keys(Parameters)).toEqual(["PrivateKey", "RpcUrl", "TelegramBotToken", "TelegramChatId"]);
    for (const parameter of Object.values(Parameters)) {
      expect(parameter).toMatchObject({ Type: "String", NoEcho: true, MinLength: 1 });
    }
  });

  test("the schedule runs the env's cron, and tells each run which", () => {
    const { Schedule } = template(awsDeployment("gnosis")).Resources;
    expect(Schedule.Properties).toMatchObject({
      Name: "keeper-gnosis",
      ScheduleExpression: "cron(0 * * * ? *)",
      ScheduleExpressionTimezone: "UTC",
    });
    expect(JSON.parse(Schedule.Properties.Target.Input)).toEqual({
      cron: "0 * * * *",
      scheduledTime: "<aws.scheduler.scheduled-time>",
    });
  });

  test("a run cannot outlast its interval, nor Lambda's 15 minutes", () => {
    expect(template(awsDeployment("sepolia")).Resources.KeeperFunction.Properties.Timeout).toBe(60);
    expect(template(awsDeployment("gnosis")).Resources.KeeperFunction.Properties.Timeout).toBe(900);
  });

  // The Worker's noRetry(), and docs/KEEPERS.md's one run at a time.
  test("one keeper run at a time, never retried", () => {
    const { KeeperFunction, KeeperInvokeConfig, Schedule } = template(awsDeployment("sepolia")).Resources;
    expect(KeeperFunction.Properties.ReservedConcurrentExecutions).toBe(1);
    expect(KeeperInvokeConfig.Properties.MaximumRetryAttempts).toBe(0);
    expect(Schedule.Properties.Target.RetryPolicy.MaximumRetryAttempts).toBe(0);
  });

  // Every deploy states it, so no deploy can leave the schedule as it found it.
  test("--paused deploys with the schedule and its alarm off; anything else turns them on", () => {
    const live = template(awsDeployment("sepolia")).Resources;
    const paused = template(awsDeployment("sepolia", {}, { paused: true })).Resources;
    expect(live.Schedule.Properties.State).toBe("ENABLED");
    expect(live.NotRunningAlarm.Properties.ActionsEnabled).toBe(true);
    expect(paused.Schedule.Properties.State).toBe("DISABLED");
    expect(paused.NotRunningAlarm.Properties.ActionsEnabled).toBe(false);
  });

  test("the not-running alarm counts in the env's own intervals", () => {
    const { NotRunningAlarm } = template(awsDeployment("gnosis")).Resources;
    expect(NotRunningAlarm.Properties).toMatchObject({ Period: 3600, EvaluationPeriods: 3 });
  });

  // The deploy role creates roles only under it (infra/github-oidc.yaml).
  test("every role carries the permissions boundary", () => {
    const roles = resources().filter((r) => r.Type === "AWS::IAM::Role");
    expect(roles).toHaveLength(2);
    for (const role of roles) expect(role.Properties.PermissionsBoundary).toEqual(PERMISSIONS_BOUNDARY);
  });

  // The deploy role manages keeper-* resources only.
  test("names everything after the deployment", () => {
    const names = resources().flatMap((r) =>
      ["FunctionName", "Name", "LogGroupName", "TopicName", "AlarmName"]
        .map((key) => r.Properties[key])
        .filter((name) => typeof name === "string"),
    );
    expect(names).toHaveLength(9);
    for (const name of names) expect(name).toMatch(/^(\/aws\/lambda\/)?keeper-sepolia(-|$)/);
  });

  test("the public URL reaches the health function only", () => {
    const { HealthUrl } = template(awsDeployment("sepolia")).Resources;
    expect(HealthUrl.Properties).toEqual({ TargetFunctionArn: { "Fn::GetAtt": ["HealthFunction", "Arn"] }, AuthType: "NONE" });
    const grants = resources().filter((r) => r.Type === "AWS::Lambda::Permission");
    expect(grants).toHaveLength(2);
    for (const grant of grants) expect(grant.Properties.FunctionName).toEqual({ Ref: "HealthFunction" });
  });
});

describe("secret parameters", () => {
  test.each([
    ["PRIVATE_KEY", "PrivateKey"],
    ["RPC_URL", "RpcUrl"],
    ["TELEGRAM_BOT_TOKEN", "TelegramBotToken"],
    ["TELEGRAM_CHAT_ID", "TelegramChatId"],
  ])("%s is set through %s", (name, parameter) => {
    expect(secretParameter(name)).toBe(parameter);
  });

  // AWS CLI v2 also takes CloudFormation's {ParameterKey, ParameterValue}
  // objects from a file; v1 rejects them.
  test("are passed as Key=Value strings, each value as it is", () => {
    expect(secretOverrides({ PRIVATE_KEY: "0xabc", RPC_URL: "https://a.example/k?x=1,https://b.example" })).toEqual([
      "PrivateKey=0xabc",
      "RpcUrl=https://a.example/k?x=1,https://b.example",
    ]);
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
  const deployment = awsDeployment("sepolia");
  const everySecret = ["PrivateKey", "RpcUrl", "TelegramBotToken", "TelegramChatId"];

  test("a new stack needs every secret given", () => {
    expect(missingSecrets(deployment, ["PRIVATE_KEY"], [])).toEqual([
      "RPC_URL",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
    ]);
  });

  test("an existing stack keeps the secrets it has", () => {
    expect(missingSecrets(deployment, [], everySecret)).toEqual([]);
    expect(missingSecrets(deployment, ["RPC_URL"], everySecret)).toEqual([]);
  });

  // As `secrets.required` does for a Worker deployed before the name was added.
  test("a secret the stack has never had must be given", () => {
    expect(missingSecrets(deployment, [], everySecret.slice(1))).toEqual(["PRIVATE_KEY"]);
  });
});

describe("Lambda handlers", () => {
  const env = { DEPLOYMENT_NAME: "keeper-test" } as KeeperEnv;

  test("a run reports the schedule's cron and tick time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(error);
    const { scheduled } = createHandlers(env);

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

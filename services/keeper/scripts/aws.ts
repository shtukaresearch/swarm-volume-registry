/**
 * The keeper's AWS deployments, derived from wrangler.jsonc so both platforms
 * run one configuration. Each wrangler env becomes a CloudFormation stack of
 * the same name — plain CloudFormation, rendered by {@link template}:
 *
 *   vars              → environment variables of both functions, by name
 *   secrets.required  → environment variables too, set from NoEcho parameters
 *   triggers.crons    → the EventBridge schedule, and the function timeout
 *
 * Usage (from services/keeper; `pnpm aws` runs this file on Node 24, which
 * strips its types itself):
 *
 *   pnpm aws build [<env>...]
 *   pnpm aws deploy <env> [--var NAME:value]... [--paused] [--secrets-file <file>]
 *                         [-- <aws cloudformation deploy args>]
 *
 * `build` bundles the Lambda and renders each env's template beside it, in
 * dist/aws/. `deploy` builds one env and ships it with the AWS CLI:
 * `aws cloudformation package` uploads the bundle to the artifacts bucket
 * from infra/github-oidc.yaml, and `aws cloudformation deploy` creates or
 * updates the stack.
 *
 * `--var` overrides a var for this deploy only, as with `wrangler dev`: e.g.
 * `--var DRY_RUN:true` for a first deploy. `--paused` deploys with the
 * schedule off; the next deploy without it turns it back on. `--secrets-file`
 * reads the KEY=value file `wrangler deploy --secrets-file` does: a stack's
 * first deploy needs every secret, later ones only those that change — a
 * secret left out keeps the value the stack has.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";
import { unstable_readConfig } from "wrangler";
import { MAX_RUN_SECONDS, cronIntervalSeconds, toEventBridgeCron } from "../src/schedule.ts";

const ROOT = join(import.meta.dirname, "..");
const WRANGLER = join(ROOT, "wrangler.jsonc");
const OUTDIR = join(ROOT, "dist", "aws");
/** infra/github-oidc.yaml, deployed once per account and region under this name. */
const BOOTSTRAP_STACK = "keeper-bootstrap";

export interface AwsDeployment {
  /** The Worker's name, reused for the stack and both functions. */
  name: string;
  /** The env's `vars`, with any `--var` overrides. */
  vars: Record<string, string>;
  /** The env's `secrets.required`. */
  secrets: string[];
  /** The env's one cron trigger. */
  cron: string;
  /** Seconds between its runs. */
  interval: number;
  /** The schedule is off, and the not-running alarm with it. */
  paused: boolean;
}

/**
 * One wrangler env, as the AWS stack that runs it. `paused` deploys it with
 * its schedule disabled, and the not-running alarm with it.
 */
export function awsDeployment(
  env: string,
  overrides: Record<string, string> = {},
  { paused = false } = {},
): AwsDeployment {
  const config = unstable_readConfig({ config: WRANGLER, env });
  const crons = config.triggers.crons ?? [];
  if (crons.length !== 1) {
    throw new Error(`${env}: expected exactly one cron trigger in wrangler.jsonc, found ${crons.length}`);
  }
  const cron = crons[0]!;
  return {
    name: config.name,
    vars: { ...(config.vars as Record<string, string>), ...overrides },
    secrets: [...(config.secrets?.required ?? [])],
    cron,
    interval: cronIntervalSeconds(cron),
    paused,
  };
}

/**
 * The stack parameter a secret is set through. CloudFormation's names are
 * alphanumeric: PRIVATE_KEY is PrivateKey.
 */
export function secretParameter(name: string): string {
  return name.toLowerCase().replace(/(?:^|_)([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

// CloudFormation's intrinsic functions, in their JSON form.
const ref = (name: string) => ({ Ref: name });
const sub = (text: string) => ({ "Fn::Sub": text });
const arn = (resource: string) => ({ "Fn::GetAtt": [resource, "Arn"] });

/**
 * From infra/github-oidc.yaml, which must be deployed first. The deploy role
 * can create roles only under it, so every role here carries it.
 */
export const PERMISSIONS_BOUNDARY = sub(
  "arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/keeper-permissions-boundary",
);

/**
 * The deployment's stack, as a CloudFormation template. Every value in it is
 * literal, from wrangler.jsonc, but the secrets: those are NoEcho parameters,
 * so no template holds them, and a deploy that does not set one keeps the
 * value the stack has. The code is the Worker's, behind src/aws/handler.ts:
 *
 *   keeper-<env>         EventBridge Scheduler → index.scheduled → worker.scheduled
 *   keeper-<env>-health  Function URL          → index.health    → worker.fetch
 */
export function template({ name, vars, secrets, cron, interval, paused }: AwsDeployment) {
  // The Worker's bindings, under the same names, on both functions.
  const environment = {
    ...vars,
    ...Object.fromEntries(secrets.map((secret) => [secret, ref(secretParameter(secret))])),
    NODE_OPTIONS: "--enable-source-maps",
  };
  const lambda = <P extends object>(properties: P) => ({
    Type: "AWS::Lambda::Function",
    Properties: {
      // dist/aws/lambda, beside the template: `aws cloudformation package`
      // uploads it and puts its S3 location here.
      Code: "lambda",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      MemorySize: 256,
      Role: arn("FunctionRole"),
      Environment: { Variables: environment },
      ...properties,
    },
  });
  const logGroup = (logGroupName: string) => ({
    Type: "AWS::Logs::LogGroup",
    Properties: { LogGroupName: logGroupName, RetentionInDays: 30 },
  });
  const alarm = <P extends object>(properties: P) => ({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      Namespace: "AWS/Lambda",
      Dimensions: [{ Name: "FunctionName", Value: ref("KeeperFunction") }],
      Statistic: "Sum",
      AlarmActions: [ref("AlarmTopic")],
      ...properties,
    },
  });

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Swarm VolumeRegistry keeper",
    Parameters: Object.fromEntries(
      secrets.map((secret) => [
        secretParameter(secret),
        { Type: "String", NoEcho: true, MinLength: 1, Description: `${secret}, from secrets.required` },
      ]),
    ),
    Resources: {
      // --- the keeper ---------------------------------------------------------

      // Both functions': their logs, and nothing else.
      FunctionRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
            ],
          },
          ManagedPolicyArns: [sub("arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole")],
          PermissionsBoundary: PERMISSIONS_BOUNDARY,
        },
      },

      KeeperLogGroup: logGroup(`/aws/lambda/${name}`),

      KeeperFunction: lambda({
        FunctionName: name,
        Description: `${name}: one keeper cycle per scheduled run`,
        Handler: "index.scheduled",
        // A run cannot outlast its interval, so two never share the wallet.
        Timeout: Math.min(interval, MAX_RUN_SECONDS),
        // One run at a time: runs share the wallet, and an overlapping run
        // would race it for nonces (docs/KEEPERS.md).
        ReservedConcurrentExecutions: 1,
        LoggingConfig: { LogFormat: "JSON", LogGroup: ref("KeeperLogGroup") },
      }),

      // The Worker's noRetry(): the next tick is the retry. A queued tick that
      // cannot start within a minute — its predecessor still running — is
      // dropped rather than run late.
      KeeperInvokeConfig: {
        Type: "AWS::Lambda::EventInvokeConfig",
        Properties: {
          FunctionName: ref("KeeperFunction"),
          Qualifier: "$LATEST",
          MaximumRetryAttempts: 0,
          MaximumEventAgeInSeconds: 60,
        },
      },

      // The schedule's, to invoke the keeper and nothing else — and only for
      // this account's schedules.
      ScheduleRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "scheduler.amazonaws.com" },
                Action: "sts:AssumeRole",
                Condition: { StringEquals: { "aws:SourceAccount": ref("AWS::AccountId") } },
              },
            ],
          },
          Policies: [
            {
              PolicyName: "invoke-keeper",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: arn("KeeperFunction") }],
              },
            },
          ],
          PermissionsBoundary: PERMISSIONS_BOUNDARY,
        },
      },

      Schedule: {
        Type: "AWS::Scheduler::Schedule",
        Properties: {
          Name: name,
          ScheduleExpression: toEventBridgeCron(cron),
          ScheduleExpressionTimezone: "UTC",
          State: paused ? "DISABLED" : "ENABLED",
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: arn("KeeperFunction"),
            RoleArn: arn("ScheduleRole"),
            // What each run reports: the wrangler cron, and this tick's time.
            Input: JSON.stringify({ cron, scheduledTime: "<aws.scheduler.scheduled-time>" }),
            RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
          },
        },
      },

      // --- GET /health --------------------------------------------------------

      HealthLogGroup: logGroup(`/aws/lambda/${name}-health`),

      // Its own function, so traffic on the public URL can never take the
      // keeper's one concurrent run.
      HealthFunction: lambda({
        FunctionName: `${name}-health`,
        Description: `${name}: GET /health, the wallet to fund`,
        Handler: "index.health",
        Timeout: 10,
        ReservedConcurrentExecutions: 1,
        LoggingConfig: { LogFormat: "JSON", LogGroup: ref("HealthLogGroup") },
      }),

      HealthUrl: {
        Type: "AWS::Lambda::Url",
        Properties: { TargetFunctionArn: arn("HealthFunction"), AuthType: "NONE" },
      },

      // A public URL needs both: lambda:InvokeFunctionUrl, and — since October
      // 2025 — lambda:InvokeFunction, here only through the URL.
      HealthUrlPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: ref("HealthFunction"),
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
        },
      },
      HealthInvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: ref("HealthFunction"),
          Action: "lambda:InvokeFunction",
          Principal: "*",
          InvokedViaFunctionUrl: true,
        },
      },

      // --- alarms -------------------------------------------------------------
      //
      // For what Telegram cannot report: a run that never got as far as
      // reading its alert channel, or a schedule that stopped firing.
      // Subscribe to the topic once (README); subscriptions are not part of
      // the stack, so a redeploy keeps them.

      AlarmTopic: {
        Type: "AWS::SNS::Topic",
        Properties: { TopicName: `${name}-alarms` },
      },

      // Every failed run, including those Telegram already reported.
      RunFailedAlarm: alarm({
        AlarmName: `${name}-run-failed`,
        AlarmDescription: `${name}: a keeper run failed. Its report is in /aws/lambda/${name}.`,
        MetricName: "Errors",
        Period: 60,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
      }),

      // A tick that found the previous run still going. Should never happen
      // while each run fits inside its interval.
      RunOverlapAlarm: alarm({
        AlarmName: `${name}-run-overlap`,
        AlarmDescription: `${name}: a scheduled run was throttled behind the previous one.`,
        MetricName: "Throttles",
        Period: 60,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
      }),

      // Three intervals without a single run: the schedule is not firing.
      NotRunningAlarm: alarm({
        AlarmName: `${name}-not-running`,
        AlarmDescription: `${name}: no keeper run in three scheduled intervals.`,
        ActionsEnabled: !paused,
        MetricName: "Invocations",
        Period: interval,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 3,
        Threshold: 1,
        ComparisonOperator: "LessThanThreshold",
        TreatMissingData: "breaching",
        OKActions: [ref("AlarmTopic")],
      }),
    },
    Outputs: {
      HealthUrl: {
        Description: "GET <url>health returns the wallet to fund.",
        Value: { "Fn::GetAtt": ["HealthUrl", "FunctionUrl"] },
      },
      KeeperFunction: { Value: ref("KeeperFunction") },
      AlarmTopic: {
        Description: "Subscribe to this for the CloudWatch alarms.",
        Value: ref("AlarmTopic"),
      },
    },
  };
}

const templateFile = ({ name }: AwsDeployment) => join(OUTDIR, `${name}.json`);

/**
 * Bundle src/aws/handler.ts and viem into dist/aws/lambda/index.mjs — ESM
 * only, failing if any CommonJS module would be bundled — and render each
 * deployment's template beside it, as dist/aws/<name>.json.
 */
export async function build(deployments: readonly AwsDeployment[] = []): Promise<void> {
  await rm(OUTDIR, { recursive: true, force: true });
  const { metafile } = await esbuild({
    entryPoints: [join(ROOT, "src", "aws", "handler.ts")],
    outfile: join(OUTDIR, "lambda", "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    alias: { isows: join(ROOT, "src", "aws", "websocket.ts") },
    minify: true,
    sourcemap: "linked",
    metafile: true,
    logLevel: "warning",
  });
  const commonjs = Object.entries(metafile.inputs)
    .filter(([, input]) => input.format === "cjs")
    .map(([path]) => path);
  if (commonjs.length) {
    throw new Error(`the Lambda bundle must be ESM only, but would include:\n  ${commonjs.join("\n  ")}`);
  }
  for (const deployment of deployments) {
    await writeFile(templateFile(deployment), `${JSON.stringify(template(deployment), null, 2)}\n`);
  }
}

/** KEY=value lines, as `wrangler deploy --secrets-file` and .dev.vars take them. */
export function parseSecretsFile(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    // By number: the line itself may well be a secret.
    if (eq < 1) throw new Error(`line ${i + 1} is not a KEY=value line`);
    const value = line.slice(eq + 1).trim();
    entries[line.slice(0, eq).trim()] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return entries;
}

/**
 * The secrets a deploy would leave the deployment without: not given now, and
 * not a parameter of its stack already — of which a new stack has none.
 */
export function missingSecrets(
  deployment: AwsDeployment,
  given: readonly string[],
  stackParameters: readonly string[],
): string[] {
  return deployment.secrets.filter(
    (name) => !given.includes(name) && !stackParameters.includes(secretParameter(name)),
  );
}

/**
 * `aws cloudformation deploy --parameter-overrides` for the given secrets, as
 * Key=Value strings: the one form both major versions of the AWS CLI read
 * from a file. Each is split at its first `=`, so a value may hold more.
 */
export function secretOverrides(secrets: Record<string, string>): string[] {
  return Object.entries(secrets).map(([name, value]) => `${secretParameter(name)}=${value}`);
}

const execFileAsync = promisify(execFile);

interface Stack {
  Parameters?: { ParameterKey: string }[];
  Outputs?: { OutputKey: string; OutputValue: string }[];
}

/** A stack as DescribeStacks has it, or undefined if there is none. */
async function describeStack(name: string): Promise<Stack | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "aws",
      ["cloudformation", "describe-stacks", "--stack-name", name, "--output", "json"],
      { env: { ...process.env, AWS_PAGER: "" } },
    );
    return (JSON.parse(stdout) as { Stacks: Stack[] }).Stacks[0];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("deploying needs the AWS CLI, `aws`, on the PATH");
    }
    if (String((err as { stderr?: unknown }).stderr).includes("does not exist")) return undefined;
    throw err;
  }
}

function run(command: string, args: string[]): Promise<number> {
  const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function deploy(
  deployment: AwsDeployment,
  secretsFile: string | undefined,
  deployArgs: string[],
): Promise<number> {
  const secrets = secretsFile ? parseSecretsFile(await readFile(secretsFile, "utf8")) : {};
  const unknown = Object.keys(secrets).filter((name) => !deployment.secrets.includes(name));
  if (unknown.length) {
    throw new Error(`not in secrets.required for ${deployment.name}: ${unknown.join(", ")}`);
  }

  // What `secrets.required` does for `wrangler deploy`: refuse to ship a
  // deployment whose every run could only fail.
  const stack = await describeStack(deployment.name);
  const missing = missingSecrets(
    deployment,
    Object.keys(secrets),
    (stack?.Parameters ?? []).map((parameter) => parameter.ParameterKey),
  );
  if (missing.length) {
    console.error(
      `${deployment.name}: no value for ${missing.join(", ")}\n` +
        `set them with: pnpm aws deploy <env> --secrets-file <file>`,
    );
    return 1;
  }

  const bootstrap = await describeStack(BOOTSTRAP_STACK);
  const bucket = bootstrap?.Outputs?.find((output) => output.OutputKey === "ArtifactsBucket")?.OutputValue;
  if (!bucket) {
    console.error(`no artifacts bucket: deploy infra/github-oidc.yaml as ${BOOTSTRAP_STACK} first`);
    return 1;
  }

  await build([deployment]);
  const packaged = join(OUTDIR, `${deployment.name}.packaged.json`);
  const packagedCode = await run("aws", [
    "cloudformation",
    "package",
    "--template-file",
    templateFile(deployment),
    "--s3-bucket",
    bucket,
    "--s3-prefix",
    deployment.name,
    "--output-template-file",
    packaged,
    "--use-json",
  ]);
  if (packagedCode !== 0) return packagedCode;

  // Secrets reach the AWS CLI in a file only this user can read, never on its
  // command line.
  const dir = await mkdtemp(join(tmpdir(), "keeper-"));
  try {
    const overrides: string[] = [];
    if (Object.keys(secrets).length) {
      const file = join(dir, "secrets.json");
      await writeFile(file, JSON.stringify(secretOverrides(secrets)), { mode: 0o600 });
      overrides.push("--parameter-overrides", `file://${file}`);
    }
    return await run("aws", [
      "cloudformation",
      "deploy",
      "--template-file",
      packaged,
      "--stack-name",
      deployment.name,
      "--capabilities",
      "CAPABILITY_IAM",
      "--no-fail-on-empty-changeset",
      ...overrides,
      ...deployArgs,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Args {
  positional: string[];
  vars: Record<string, string>;
  paused: boolean;
  secretsFile?: string;
  rest: string[];
}

function parseArgs(args: string[]): Args {
  const parsed: Args = { positional: [], vars: {}, paused: false, rest: [] };
  const { positional, vars } = parsed;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return { ...parsed, rest: args.slice(i + 1) };
    if (arg === "--paused") parsed.paused = true;
    else if (arg === "--secrets-file") {
      parsed.secretsFile = args[++i];
      if (!parsed.secretsFile) throw new Error("--secrets-file takes a KEY=value file");
    } else if (arg === "--var") {
      const pair = args[++i] ?? "";
      const colon = pair.indexOf(":");
      if (colon < 1) throw new Error(`--var takes NAME:value, got "${pair}"`);
      vars[pair.slice(0, colon)] = pair.slice(colon + 1);
    } else positional.push(arg);
  }
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const { positional, vars, paused, secretsFile, rest } = parseArgs(argv);
  const [command, ...envs] = positional;
  const deployments = envs.map((env) => awsDeployment(env, vars, { paused }));
  if (command === "build") {
    await build(deployments);
    return 0;
  }
  if (command === "deploy" && deployments.length === 1) {
    return deploy(deployments[0]!, secretsFile, rest);
  }
  console.error("usage: pnpm aws build [<env>...] | deploy <env> [--secrets-file <file>]");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

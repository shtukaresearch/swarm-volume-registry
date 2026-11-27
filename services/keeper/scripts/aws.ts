/**
 * Deploys each wrangler env to AWS Lambda through the Lambda, EventBridge and
 * IAM REST APIs alone, signed with aws4fetch: what the account's
 * LambdaCronDeveloper permission set allows.
 *
 *   pnpm aws build
 *   pnpm aws deploy <env> [--var NAME:value]... [--paused] [--secrets-file <file>] [--profile <name>]
 *
 * Credentials: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`(/`AWS_SESSION_TOKEN`),
 * or `aws configure export-credentials` for `AWS_PROFILE` — `aws sso login`
 * is enough.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build as esbuild } from "esbuild";
import { zipSync } from "fflate";
import { unstable_readConfig } from "wrangler";
import {
  type Aws,
  type FunctionConfiguration,
  type PermissionStatement,
  createAws,
  credentials,
  regionFromEnv,
} from "./aws-api.ts";
import { AWS_START_DELAY_MS, MAX_RUN_SECONDS, cronIntervalSeconds, toEventBridgeCron } from "../src/schedule.ts";

const ROOT = join(import.meta.dirname, "..");
const WRANGLER = join(ROOT, "wrangler.jsonc");
const OUTDIR = join(ROOT, "dist", "aws");
/** The account's role for both functions: logs only. The deploy creates no IAM. */
export const EXECUTION_ROLE = "lambda-cron-exec";

export interface AwsDeployment {
  /** The Worker's name with `keeper-aws-` for `keeper-cloudflare-`, for the functions and the rule. */
  name: string;
  vars: Record<string, string>;
  secrets: string[];
  cron: string;
  /** Seconds between runs. */
  interval: number;
  /** Schedule off. */
  paused: boolean;
}

/**
 * One wrangler env, with any `--var` overrides. Its own name, and its
 * `CYCLE_TIMEOUT_MS` shortened by the longest start delay, so a delayed run
 * still ends inside its interval.
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
  if (!config.name.startsWith("keeper-cloudflare-")) {
    throw new Error(`${env}: ${config.name} is not named keeper-cloudflare-<deployment>`);
  }
  const name = config.name.replace(/^keeper-cloudflare-/, "keeper-aws-");
  const vars = { ...(config.vars as Record<string, string>), ...overrides };
  const cycleTimeout = Number(vars.CYCLE_TIMEOUT_MS) - AWS_START_DELAY_MS.max;
  if (!(cycleTimeout > 0)) {
    throw new Error(`${env}: CYCLE_TIMEOUT_MS ${vars.CYCLE_TIMEOUT_MS} leaves no time after the start delay`);
  }
  const cron = crons[0]!;
  return {
    name,
    vars: { ...vars, DEPLOYMENT_NAME: name, CYCLE_TIMEOUT_MS: String(cycleTimeout) },
    secrets: [...(config.secrets?.required ?? [])],
    cron,
    interval: cronIntervalSeconds(cron),
    paused,
  };
}

/** Both functions' environment: the env's vars, and its secrets, given now or kept from the deployed keeper. */
export function environment(
  { vars, secrets }: AwsDeployment,
  deployed: Record<string, string> = {},
  given: Record<string, string> = {},
): Record<string, string> {
  const values = secrets.flatMap((name) => {
    const value = given[name] || deployed[name];
    return value ? [[name, value]] : [];
  });
  return { ...vars, ...Object.fromEntries(values), NODE_OPTIONS: "--enable-source-maps" };
}

export function missingSecrets({ secrets }: AwsDeployment, env: Record<string, string>): string[] {
  return secrets.filter((name) => !env[name]);
}

/** Both functions' configuration. /health is its own, so URL traffic can't take the keeper's run. */
export function configurations(
  { name, interval }: AwsDeployment,
  role: string,
  env: Record<string, string>,
): { keeper: FunctionConfiguration; health: FunctionConfiguration } {
  const common: Omit<FunctionConfiguration, "FunctionName" | "Handler" | "Timeout"> = {
    Role: role,
    Runtime: "nodejs24.x",
    MemorySize: 256,
    Environment: { Variables: env },
    LoggingConfig: { LogFormat: "JSON" },
    Architectures: ["arm64"],
  };
  return {
    keeper: {
      ...common,
      FunctionName: name,
      Description: `${name}: one keeper cycle per scheduled run`,
      Handler: "index.scheduled",
      // Never outlasts its interval.
      Timeout: Math.min(interval, MAX_RUN_SECONDS),
    },
    health: {
      ...common,
      FunctionName: `${name}-health`,
      Description: `${name}: GET /health, the wallet to fund`,
      Handler: "index.health",
      Timeout: 10,
    },
  };
}

/** The EventBridge rule that runs the keeper, and the event each run gets. */
export function schedule({ name, cron, paused }: AwsDeployment) {
  const rule = {
    Name: name,
    Description: `${name}: ${cron}`,
    ScheduleExpression: toEventBridgeCron(cron),
    State: paused ? ("DISABLED" as const) : ("ENABLED" as const),
  };
  // EventBridge quotes the time itself.
  const input = {
    InputPathsMap: { time: "$.time" },
    InputTemplate: `{"cron":${JSON.stringify(cron)},"scheduledTime":<time>}`,
  };
  return { rule, input };
}

/** Creates or updates both functions, the /health URL and the schedule. Returns the URL. */
export async function deploy(
  deployment: AwsDeployment,
  given: Record<string, string>,
  zip: Uint8Array,
  aws: Aws,
  log: (line: string) => void = console.warn,
): Promise<string> {
  const role = await executionRole(aws);
  const deployed = await aws.functionConfiguration(deployment.name);
  const env = environment(deployment, deployed?.Environment?.Variables, given);
  // Like `secrets.required` for wrangler: never deploy without every secret.
  const missing = missingSecrets(deployment, env);
  if (missing.length) {
    throw new Error(`${deployment.name}: no value for ${missing.join(", ")}; pass them with --secrets-file`);
  }

  const sha256 = createHash("sha256").update(zip).digest("base64");
  const { keeper, health } = configurations(deployment, role, env);
  const keeperArn = await upsert(aws, keeper, zip, sha256);
  await upsert(aws, health, zip, sha256);

  // The Worker's noRetry(): the next tick is the retry.
  await aws.putEventInvokeConfig(keeper.FunctionName);
  for (const { FunctionName } of [keeper, health]) {
    await reserveOneRun(aws, FunctionName, log);
  }
  const url = await publicUrl(aws, health.FunctionName);

  const { rule, input } = schedule(deployment);
  const ruleArn = await aws.putRule(rule);
  await aws.addPermission(keeper.FunctionName, {
    StatementId: "schedule",
    Action: "lambda:InvokeFunction",
    Principal: "events.amazonaws.com",
    SourceArn: ruleArn,
  });
  await aws.putTargets(rule.Name, [
    {
      Id: "keeper",
      Arn: keeperArn,
      InputTransformer: input,
      RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
    },
  ]);
  return url;
}

async function executionRole(aws: Aws): Promise<string> {
  try {
    return await aws.executionRole(EXECUTION_ROLE);
  } catch (err) {
    const name = (err as Error).name;
    if (name !== "NoSuchEntity" && name !== "NoSuchEntityException") throw err;
    throw new Error(`the account has no ${EXECUTION_ROLE} role; an administrator creates it once (README)`);
  }
}

/** Creates the function, or updates its code (if it changed) and configuration. Returns its ARN. */
async function upsert(aws: Aws, config: FunctionConfiguration, zip: Uint8Array, sha256: string) {
  const { FunctionName } = config;
  const current = await aws.functionConfiguration(FunctionName);
  if (!current) {
    const arn = await aws.createFunction({ ...config, Code: { ZipFile: zip } });
    await aws.waitUntilActive(FunctionName);
    return arn;
  }
  if (current.CodeSha256 !== sha256) {
    await aws.updateFunctionCode(FunctionName, zip);
    await aws.waitUntilUpdated(FunctionName);
  }
  await aws.updateFunctionConfiguration(config);
  await aws.waitUntilUpdated(FunctionName);
  return current.FunctionArn!;
}

/**
 * One concurrent run, where the account allows it. An account at Lambda's
 * starting limit of 10 can reserve none, and the deploy goes ahead without:
 * the timeout already ends each run before the next tick and retries are off,
 * so what is left unguarded is EventBridge's rare duplicate delivery. Two runs
 * then race the wallet's nonce, one fails and alerts, and `trigger`'s
 * idempotence means nothing is paid twice.
 */
async function reserveOneRun(aws: Aws, FunctionName: string, log: (line: string) => void) {
  try {
    await aws.putFunctionConcurrency(FunctionName, 1);
  } catch (err) {
    if (!(err as Error).message?.includes("UnreservedConcurrentExecution")) throw err;
    log(
      `warning: ${FunctionName} runs without a reserved concurrent run; ` +
        "raise the account's Lambda concurrency quota (L-B99A9384) and redeploy to add one",
    );
  }
}

async function publicUrl(aws: Aws, FunctionName: string): Promise<string> {
  const url = await aws.functionUrl(FunctionName);
  // A public URL needs both since October 2025.
  const grants: PermissionStatement[] = [
    {
      StatementId: "public-url",
      Action: "lambda:InvokeFunctionUrl",
      Principal: "*",
      FunctionUrlAuthType: "NONE",
    },
    {
      StatementId: "public-url-invoke",
      Action: "lambda:InvokeFunction",
      Principal: "*",
      InvokedViaFunctionUrl: true,
    },
  ];
  for (const grant of grants) await aws.addPermission(FunctionName, grant);
  return url;
}

/** Bundles the Lambda into dist/aws/, ESM only. */
export async function build(): Promise<void> {
  await rm(OUTDIR, { recursive: true, force: true });
  const { metafile } = await esbuild({
    entryPoints: [join(ROOT, "src", "aws", "handler.ts")],
    outfile: join(OUTDIR, "index.mjs"),
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
}

/** dist/aws/ as a zip: the same bytes for the same bundle, every file world-readable. */
export async function zipBundle(): Promise<Uint8Array> {
  const attributes = { mtime: new Date("2000-01-01T00:00:00Z"), os: 3, attrs: 0o100644 << 16 };
  const files: Record<string, [Uint8Array, typeof attributes]> = {};
  for (const name of (await readdir(OUTDIR)).sort()) {
    files[name] = [await readFile(join(OUTDIR, name)), attributes];
  }
  return zipSync(files, { level: 9 });
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

interface Args {
  positional: string[];
  vars: Record<string, string>;
  paused: boolean;
  secretsFile?: string;
  profile?: string;
}

function parseArgs(args: string[]): Args {
  const parsed: Args = { positional: [], vars: {}, paused: false };
  const { positional, vars } = parsed;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--paused") parsed.paused = true;
    else if (arg === "--secrets-file") {
      parsed.secretsFile = args[++i];
      if (!parsed.secretsFile) throw new Error("--secrets-file takes a KEY=value file");
    } else if (arg === "--profile") {
      parsed.profile = args[++i];
      if (!parsed.profile) throw new Error("--profile takes an AWS profile name");
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
  const { positional, vars, paused, secretsFile, profile } = parseArgs(argv);
  const [command, env] = positional;
  if (command === "build") {
    await build();
    return 0;
  }
  if (command !== "deploy" || !env) {
    console.error(
      "usage: pnpm aws build | deploy <env> [--var NAME:value]... [--paused] [--secrets-file <file>] [--profile <name>]",
    );
    return 2;
  }
  const deployment = awsDeployment(env, vars, { paused });
  const given = secretsFile ? parseSecretsFile(await readFile(secretsFile, "utf8")) : {};
  const unknown = Object.keys(given).filter((name) => !deployment.secrets.includes(name));
  if (unknown.length) {
    throw new Error(`not in secrets.required for ${deployment.name}: ${unknown.join(", ")}`);
  }
  await build();
  const aws = createAws({ region: regionFromEnv(), credentials: credentials(profile) });
  const url = await deploy(deployment, given, await zipBundle(), aws);
  console.log(`${deployment.name}: deployed${paused ? ", schedule off" : ""}\nGET ${new URL("/health", url)}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

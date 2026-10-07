/**
 * The keeper's AWS deployments, derived from wrangler.jsonc so both platforms
 * run one configuration. Each wrangler env becomes a CloudFormation stack of
 * the same name, from template.yaml:
 *
 *   vars              → KEEPER_VARS on the function, as JSON
 *   secrets.required  → SSM SecureStrings under /<name>/, checked before deploy
 *   triggers.crons    → the EventBridge schedule, and the function timeout
 *
 * Usage (from services/keeper; `pnpm aws` runs this file on Node 24, which
 * strips its types itself):
 *
 *   pnpm aws build
 *   pnpm aws parameters <env> [--var NAME:value]...
 *   pnpm aws put-secrets <env> <file>
 *   pnpm aws deploy <env> [--var NAME:value]... [--paused] [-- <sam deploy args>]
 *
 * `--var` overrides a var for this deploy only, as with `wrangler dev`: e.g.
 * `--var DRY_RUN:true` for a first deploy. `--paused` deploys with the
 * schedule off; the next deploy without it turns it back on. `put-secrets`
 * reads the same KEY=value file `wrangler deploy --secrets-file` does.
 */
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DescribeParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { build as esbuild } from "esbuild";
import { unstable_readConfig } from "wrangler";
import { MAX_RUN_SECONDS, cronIntervalSeconds, toEventBridgeCron } from "../src/schedule.ts";

const ROOT = join(import.meta.dirname, "..");
const WRANGLER = join(ROOT, "wrangler.jsonc");
export const TEMPLATE = join(ROOT, "template.yaml");
export const OUTDIR = join(ROOT, "dist", "aws");

export interface AwsDeployment {
  /** The Worker's name, reused for the stack, the function and the SSM path. */
  name: string;
  /** Where the secrets live in SSM: `/<name>/`. */
  secretsPath: string;
  secrets: string[];
  /** template.yaml's parameters. */
  parameters: Record<string, string>;
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
  const interval = cronIntervalSeconds(cron);
  const vars = { ...(config.vars as Record<string, string>), ...overrides };
  const secrets = [...(config.secrets?.required ?? [])];

  return {
    name: config.name,
    secretsPath: `/${config.name}/`,
    secrets,
    parameters: {
      DeploymentName: config.name,
      KeeperVars: JSON.stringify(vars),
      KeeperSecrets: secrets.join(","),
      Cron: cron,
      ScheduleExpression: toEventBridgeCron(cron),
      // A run cannot outlast its interval, so two never share the wallet.
      TimeoutSeconds: String(Math.min(interval, MAX_RUN_SECONDS)),
      IntervalSeconds: String(interval),
      ScheduleState: paused ? "DISABLED" : "ENABLED",
    },
  };
}

/**
 * One `--parameter-overrides` entry. SAM CLI unescapes `\"` in a quoted value
 * and nothing else, so a value containing a backslash cannot round-trip.
 */
export function samParameter(key: string, value: string): string {
  if (value.includes("\\")) {
    throw new Error(`${key}: SAM CLI cannot pass a value containing a backslash`);
  }
  return `${key}="${value.replaceAll('"', '\\"')}"`;
}

/**
 * Bundle src/aws/handler.ts, viem and the SSM client into dist/aws/index.mjs —
 * ESM only. Fails if any CommonJS module would be bundled.
 */
export async function build(): Promise<void> {
  await rm(OUTDIR, { recursive: true, force: true });
  const { metafile } = await esbuild({
    entryPoints: [join(ROOT, "src", "aws", "handler.ts")],
    outfile: join(OUTDIR, "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // Node's default is `main` first, which for the AWS SDK is its CommonJS build.
    mainFields: ["module", "main"],
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

/**
 * The secrets the deployment requires that SSM does not have. Names only: the
 * caller needs `ssm:DescribeParameters`, never a secret's value.
 */
export async function missingSecrets(
  deployment: AwsDeployment,
  client: Pick<SSMClient, "send"> = new SSMClient({}),
): Promise<string[]> {
  const wanted = deployment.secrets.map((name) => deployment.secretsPath + name);
  const found = new Set<string>();
  let NextToken: string | undefined;
  do {
    const page = await client.send(
      new DescribeParametersCommand({
        ParameterFilters: [{ Key: "Name", Option: "Equals", Values: wanted }],
        NextToken,
      }),
    );
    for (const { Name } of page.Parameters ?? []) if (Name) found.add(Name);
    NextToken = page.NextToken;
  } while (NextToken);
  return wanted.filter((name) => !found.has(name));
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

async function putSecrets(deployment: AwsDeployment, file: string): Promise<void> {
  const entries = parseSecretsFile(await readFile(file, "utf8"));
  const unknown = Object.keys(entries).filter((name) => !deployment.secrets.includes(name));
  if (unknown.length) {
    throw new Error(`not in secrets.required for ${deployment.name}: ${unknown.join(", ")}`);
  }
  const client = new SSMClient({});
  for (const [name, value] of Object.entries(entries)) {
    await client.send(
      new PutParameterCommand({
        Name: deployment.secretsPath + name,
        Value: value,
        Type: "SecureString",
        Overwrite: true,
      }),
    );
    console.log(`set ${deployment.secretsPath}${name}`);
  }
}

async function deploy(deployment: AwsDeployment, samArgs: string[]): Promise<number> {
  // What `secrets.required` does for `wrangler deploy`: refuse to ship a
  // deployment whose every run could only fail.
  const missing = await missingSecrets(deployment);
  if (missing.length) {
    console.error(
      `${deployment.name}: missing in SSM: ${missing.join(", ")}\n` +
        `set them with: pnpm aws put-secrets <env> <file>`,
    );
    return 1;
  }
  await build();
  const sam = spawn(
    "sam",
    [
      "deploy",
      "--template-file",
      TEMPLATE,
      "--stack-name",
      deployment.name,
      "--capabilities",
      "CAPABILITY_IAM",
      "--resolve-s3",
      "--no-fail-on-empty-changeset",
      "--parameter-overrides",
      ...Object.entries(deployment.parameters).map(([k, v]) => samParameter(k, v)),
      ...samArgs,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  return new Promise((resolve, reject) => {
    sam.on("error", reject);
    sam.on("exit", (code) => resolve(code ?? 1));
  });
}

interface Args {
  positional: string[];
  vars: Record<string, string>;
  paused: boolean;
  rest: string[];
}

function parseArgs(args: string[]): Args {
  const parsed: Args = { positional: [], vars: {}, paused: false, rest: [] };
  const { positional, vars } = parsed;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return { ...parsed, rest: args.slice(i + 1) };
    if (arg === "--paused") parsed.paused = true;
    else if (arg === "--var") {
      const pair = args[++i] ?? "";
      const colon = pair.indexOf(":");
      if (colon < 1) throw new Error(`--var takes NAME:value, got "${pair}"`);
      vars[pair.slice(0, colon)] = pair.slice(colon + 1);
    } else positional.push(arg);
  }
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const { positional, vars, paused, rest } = parseArgs(argv);
  const [command, env, file] = positional;
  if (command === "build") {
    await build();
    return 0;
  }
  if (!env) {
    console.error("usage: pnpm aws build | parameters <env> | put-secrets <env> <file> | deploy <env>");
    return 2;
  }
  const deployment = awsDeployment(env, vars, { paused });
  switch (command) {
    case "parameters":
      console.log(JSON.stringify(deployment, null, 2));
      return 0;
    case "put-secrets":
      if (!file) throw new Error("put-secrets needs a KEY=value file");
      await putSecrets(deployment, file);
      return 0;
    case "deploy":
      return deploy(deployment, rest);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

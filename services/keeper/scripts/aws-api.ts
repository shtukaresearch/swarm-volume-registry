/**
 * The few AWS calls scripts/aws.ts makes, signed with SIGV4 by aws4fetch
 * (~5 KB) instead of the official SDK clients (tens of MB of devDependencies).
 *
 * Credentials come from the environment, or from `aws configure
 * export-credentials`, so a laptop that has run `aws sso login` needs no
 * further setup and no key is stored in this repo. Region from `AWS_REGION`
 * or `AWS_DEFAULT_REGION`, default `eu-central-1`.
 */
import { execFileSync } from "node:child_process";
import { AwsClient } from "aws4fetch";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Lambda's function configuration, as far as this deploy reads and writes it. */
export interface FunctionConfiguration {
  FunctionName: string;
  Role: string;
  Runtime: string;
  MemorySize: number;
  Environment: { Variables: Record<string, string> };
  LoggingConfig?: { LogFormat?: string };
  Description?: string;
  Handler: string;
  Timeout: number;
  Architectures?: string[];
  CodeSha256?: string;
  FunctionArn?: string;
  State?: string;
  LastUpdateStatus?: string;
}

export interface FunctionUrlConfig {
  AuthType: "AWS_IAM" | "NONE";
  FunctionUrl: string;
}

export interface PermissionStatement {
  StatementId: string;
  Action: string;
  Principal: string;
  SourceArn?: string;
  FunctionUrlAuthType?: "AWS_IAM" | "NONE";
  InvokedViaFunctionUrl?: boolean;
}

export interface Rule {
  Name: string;
  Description: string;
  ScheduleExpression: string;
  State: "ENABLED" | "DISABLED";
}

export interface Target {
  Id: string;
  Arn: string;
  InputTransformer: { InputPathsMap: Record<string, string>; InputTemplate: string };
  RetryPolicy: { MaximumRetryAttempts: number; MaximumEventAgeInSeconds: number };
}

/** Everything scripts/aws.ts asks of AWS, so a test can stand in for all of it. */
export interface Aws {
  /** The account's execution role ARN. Throws `NoSuchEntity` if it is missing. */
  executionRole(roleName: string): Promise<string>;
  functionConfiguration(name: string): Promise<FunctionConfiguration | undefined>;
  createFunction(config: FunctionConfiguration & { Code: { ZipFile: Uint8Array } }): Promise<string>;
  updateFunctionCode(name: string, zip: Uint8Array): Promise<void>;
  updateFunctionConfiguration(config: FunctionConfiguration): Promise<void>;
  putEventInvokeConfig(name: string): Promise<void>;
  putFunctionConcurrency(name: string, reserved: number): Promise<void>;
  /** The function's URL, creating it if it has none. */
  functionUrl(name: string): Promise<string>;
  addPermission(name: string, statement: PermissionStatement): Promise<void>;
  putRule(rule: Rule): Promise<string>;
  putTargets(rule: string, targets: Target[]): Promise<void>;
  waitUntilActive(name: string): Promise<void>;
  waitUntilUpdated(name: string): Promise<void>;
}

const ENDPOINT = {
  lambda: (region: string) => `https://lambda.${region}.amazonaws.com`,
  events: (region: string) => `https://events.${region}.amazonaws.com`,
  // IAM has one global endpoint, signed for us-east-1.
  iam: () => "https://iam.amazonaws.com",
} as const;

type Service = keyof typeof ENDPOINT;

/** Credentials from the environment, else `aws configure export-credentials`. */
export function credentials(profile = process.env.AWS_PROFILE): Credentials {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN,
    };
  }
  // `process` is the CLI's JSON credentials for a credential_process.
  const args = ["configure", "export-credentials", "--format", "process"];
  if (profile) args.push("--profile", profile);
  const exported = JSON.parse(execFileSync("aws", args, { encoding: "utf8" })) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken?: string;
  };
  return {
    accessKeyId: exported.AccessKeyId,
    secretAccessKey: exported.SecretAccessKey,
    sessionToken: exported.SessionToken,
  };
}

export function regionFromEnv(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-central-1";
}

/** An error whose `name` is AWS's error type, as the SDK's would be. */
function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * The real client. Lambda and EventBridge are JSON over REST, IAM is its
 * older form-encoded query protocol with an XML answer.
 */
export function createAws(
  { region, credentials: creds }: { region: string; credentials: Credentials },
  log: (line: string) => void = console.warn,
): Aws {
  const client = new AwsClient(creds);

  async function call(
    service: Service,
    path: string,
    init: { method?: string; json?: unknown; form?: Record<string, string>; target?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/x-amz-json-1.1";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    if (init.target) headers["x-amz-target"] = init.target;
    // IAM is signed for us-east-1 whatever the account's region.
    const response = await client.fetch(`${ENDPOINT[service](region)}${path}`, {
      method: init.method ?? "POST",
      headers,
      body,
      aws: { service, region: service === "iam" ? "us-east-1" : region },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return response;
    const text = await response.text();
    const name = errorName(service, response, text);
    throw awsError(name, `${name}: ${text.slice(0, 500) || `HTTP ${response.status}`}`);
  }

  /**
   * The error type the SDK would name: the `x-amzn-errortype` header where
   * the service sends one, IAM's XML `<Code>`, else Lambda's JSON `Type` —
   * which for a 404 is only `User`, so the status answers first.
   */
  function errorName(service: Service, response: Response, text: string): string {
    const header = response.headers.get("x-amzn-errortype")?.split(":")[0];
    if (header) return header;
    if (service === "iam") return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${response.status}`;
    if (response.status === 404) return "ResourceNotFoundException";
    if (response.status === 409) return "ResourceConflictException";
    try {
      const { Type } = JSON.parse(text) as { Type?: string };
      if (Type && Type !== "User") return Type;
    } catch {
      // not JSON: fall through
    }
    return `HTTP${response.status}`;
  }

  async function configuration(name: string): Promise<FunctionConfiguration | undefined> {
    try {
      const response = await call("lambda", `/2015-03-31/functions/${encodeURIComponent(name)}/configuration`, {
        method: "GET",
      });
      return (await response.json()) as FunctionConfiguration;
    } catch (err) {
      if ((err as Error).name === "ResourceNotFoundException") return undefined;
      throw err;
    }
  }

  /**
   * Lambda finishes a create or an update after the call returns, and rejects
   * another update until then. Poll until it says so, for up to 5 minutes.
   */
  async function waitUntil(
    name: string,
    done: (config: FunctionConfiguration) => boolean,
    what: string,
  ): Promise<void> {
    for (let waited = 0; ; waited += 1_000) {
      const config = await configuration(name);
      if (config && done(config)) return;
      if (waited >= 300_000) throw awsError("Timeout", `${name}: not ${what} after 5 min`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  log(`AWS ${region} as ${creds.accessKeyId.slice(0, 4)}…`);

  return {
    async executionRole(roleName) {
      const response = await call("iam", "/", {
        form: { Action: "GetRole", Version: "2010-05-08", RoleName: roleName },
      });
      const arn = /<Arn>([^<]+)<\/Arn>/.exec(await response.text())?.[1];
      if (!arn) throw awsError("MalformedResponse", `GetRole(${roleName}) named no ARN`);
      return arn;
    },

    functionConfiguration: configuration,

    async createFunction(config) {
      const { Code, ...rest } = config;
      const response = await call("lambda", "/2015-03-31/functions", {
        json: { ...rest, Code: { ZipFile: Buffer.from(Code.ZipFile).toString("base64") } },
      });
      return ((await response.json()) as { FunctionArn: string }).FunctionArn;
    },

    async updateFunctionCode(name, zip) {
      await call("lambda", `/2015-03-31/functions/${encodeURIComponent(name)}/code`, {
        method: "PUT",
        json: { ZipFile: Buffer.from(zip).toString("base64"), Architectures: ["arm64"] },
      });
    },

    async updateFunctionConfiguration(config) {
      await call("lambda", `/2015-03-31/functions/${encodeURIComponent(config.FunctionName)}/configuration`, {
        method: "PUT",
        json: config,
      });
    },

    async putEventInvokeConfig(name) {
      await call("lambda", `/2019-09-25/functions/${encodeURIComponent(name)}/event-invoke-config`, {
        method: "PUT",
        json: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
      });
    },

    async putFunctionConcurrency(name, reserved) {
      await call("lambda", `/2017-10-31/functions/${encodeURIComponent(name)}/concurrency`, {
        method: "PUT",
        json: { ReservedConcurrentExecutions: reserved },
      });
    },

    async functionUrl(name) {
      const path = `/2021-10-31/functions/${encodeURIComponent(name)}/url`;
      try {
        const response = await call("lambda", path, { json: { AuthType: "NONE" } });
        return ((await response.json()) as FunctionUrlConfig).FunctionUrl;
      } catch (err) {
        if ((err as Error).name !== "ResourceConflictException") throw err;
        const response = await call("lambda", path, { method: "GET" });
        return ((await response.json()) as FunctionUrlConfig).FunctionUrl;
      }
    },

    addPermission: async (name, statement) => {
      try {
        await call("lambda", `/2015-03-31/functions/${encodeURIComponent(name)}/policy`, { json: statement });
      } catch (err) {
        // Already there, which is the same policy.
        if ((err as Error).name !== "ResourceConflictException") throw err;
      }
    },

    async putRule(rule) {
      const response = await call("events", "/", { json: rule, target: "AWSEvents.PutRule" });
      return ((await response.json()) as { RuleArn: string }).RuleArn;
    },

    async putTargets(rule, targets) {
      const response = await call("events", "/", {
        json: { Rule: rule, Targets: targets },
        target: "AWSEvents.PutTargets",
      });
      const { FailedEntryCount, FailedEntries } = (await response.json()) as {
        FailedEntryCount: number;
        FailedEntries?: Array<{ ErrorMessage?: string }>;
      };
      if (FailedEntryCount) throw awsError("FailedEntryCount", FailedEntries?.[0]?.ErrorMessage ?? rule);
    },

    waitUntilActive: (name) => waitUntil(name, (c) => c.State === "Active", "active"),
    waitUntilUpdated: (name) => waitUntil(name, (c) => c.LastUpdateStatus === "Successful", "updated"),
  };
}

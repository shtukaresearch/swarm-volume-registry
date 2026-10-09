# keeper

The Swarm `VolumeRegistry` keeper: one implementation, deployed once per chain. Each scheduled run enumerates the registry's active volumes, sends `trigger(bytes32)` for each — one transaction per volume, per [`docs/KEEPERS.md`](../../docs/KEEPERS.md) — and reports what the contract did.

It runs on **Cloudflare Workers** or **AWS Lambda** — the same code, the same configuration. Each deployment runs on exactly one of them at a time. The platform's scheduler is the only scheduler: Cron Triggers on Cloudflare, EventBridge Scheduler on AWS. GitHub Actions tests and deploys; it never runs a cycle.

| Deployment | Name | Chain | Registry | Schedule |
|---|---|---|---|---|
| `sepolia` | `keeper-sepolia` | Sepolia (11155111) | v2 `0x33a53c79…4c493729` | every minute |
| `gnosis` | `keeper-gnosis` | Gnosis (100) | v1 `0x9639ae4c…ddd02aad` | hourly |

Both are envs in [`wrangler.jsonc`](./wrangler.jsonc), with independent wallets and RPC credentials, and that file configures them on both platforms: the AWS stacks are derived from it. They may share one Telegram group; every alert names its deployment, chain and registry.

## Layout

| | |
|---|---|
| `src/index.ts` | the Worker: `scheduled()` and `GET /health` |
| `src/config.ts` | validates the bindings into a config, reporting every problem at once |
| `src/client.ts` | supported chains, the per-run RPC probe, the viem client |
| `src/keeper/` | the keeper cycle: enumerate at a pinned block, trigger each volume, decode each receipt |
| `src/reporting.ts` | the one structured report per run that logs and alerts are both rendered from |
| `src/notifications/telegram.ts` | formats that report for Telegram and sends it |
| `src/schedule.ts` | reads the cron shapes the deployments use, for the run budget and for EventBridge |
| `src/aws/handler.ts` | the Lambda adapter: drives the Worker's own `scheduled()` and `fetch()`, with the function's environment variables as its bindings |
| `scripts/aws.ts` | renders each AWS stack from `wrangler.jsonc` — both functions, the schedule, log groups, alarms — and deploys it with the AWS CLI |
| `infra/github-oidc.yaml` | one-time AWS setup: the GitHub deploy role, the permissions boundary, the artifacts bucket |

## What a run reports

Every run logs one JSON object (`kind: "keeper/run"`) — to Workers Logs, or to CloudWatch Logs as the `message` of Lambda's JSON log line — at the level matching its `status`:

- **`failure`** (`console.error`) — invalid configuration, no usable RPC endpoint, the registry unreadable, or any volume whose transaction failed, reverted, or went unconfirmed within `RECEIPT_TIMEOUT_MS`. One failed volume does not stop the rest being attempted. The invocation itself then fails, so Cron Events — or Lambda's `Errors` metric — shows it too.
- **`warning`** (`console.warn`) — a failover to a secondary RPC, the wallet below `MIN_BALANCE_WEI`, a `TopupSkipped` (`NoAuth`: payer revoked; `PaymentFailed`: out of BZZ or allowance), a retirement, deferred work, or dry-run mode.
- **`ok`** (`console.log`).

`failures` and `warnings` each list `{ message, volumeId?, hash? }`; `volumes` has the per-volume detail, including the healthy `noop`s. Filter on `status` or `deployment` — in the Workers Logs query builder, or in CloudWatch Logs Insights as `message.status`.

Failures and warnings go to Telegram in both deployments. `NOTIFY_WARNINGS` remains configurable, but defaults to `true` so skipped top-ups, retirements and RPC failovers are visible.

A failed run is not retried by the platform — `noRetry()` on Cloudflare, retries switched off in the stack on AWS: the next tick is the retry, and an overlapping one would race the same wallet's nonce. `trigger` is idempotent, so nothing is lost by waiting.

RPC URLs are reduced to scheme and host, and the bot token and private key are masked, everywhere a report goes — viem puts the full endpoint URL in its error text.

On AWS, CloudWatch alarms cover what Telegram cannot: a run that failed before it could read its alert channel (`keeper-<env>-run-failed`), a tick that found the previous run still going (`-run-overlap`), and a schedule that stopped firing (`-not-running`, after three silent intervals). They publish to the SNS topic `keeper-<env>-alarms`.

## Configuration

Secrets, per deployment — never shared between them:

| | |
|---|---|
| `PRIVATE_KEY` | The keeper wallet. Generate a fresh one (`cast wallet new`). It only pays gas: fund it with Sepolia ETH or xDAI and nothing else. |
| `RPC_URL` | Comma-separated, from independent providers. Probed every run — chain id included — and tried in order. |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. |
| `TELEGRAM_CHAT_ID` | Numeric user or private-group chat ID. Both deployments may post to the same group, but store it independently. |

Declared in `secrets.required`. On Cloudflare they are Worker secrets; on AWS, environment variables of both functions, set through the stack's NoEcho parameters — so anyone who can read a function's configuration can read them. Either deploy refuses to ship a deployment with any of them unset. The keeper validates their shape too: a key or URL set to the wrong thing fails the run and alerts, rather than passing for an idle keeper.

Variables, in `wrangler.jsonc` per env: `DEPLOYMENT_NAME`, `CHAIN_ID`, `REGISTRY_ADDRESS`, `NOTIFY_WARNINGS`, `MIN_BALANCE_WEI` (0 disables the warning), and the cycle limits `MAX_VOLUMES_PER_CYCLE`, `CYCLE_TIMEOUT_MS`, `RECEIPT_TIMEOUT_MS`, `CONFIRMATIONS`. Not set by either deployment, but accepted: `DRY_RUN`, `VOLUME_IDS` (maintain only these), `PAGE_SIZE`. On AWS each is an environment variable of the same name, so a change to `wrangler.jsonc` needs a redeploy on either platform.

**A run must fit inside its cron interval**, so two runs never share the wallet at once: 5 s of RPC probing, plus `CYCLE_TIMEOUT_MS` (no new transaction starts after it), plus `RECEIPT_TIMEOUT_MS` for the last one, plus 5 s of slack. `test/config.test.ts` holds each env to that, and to the 15-minute limit both platforms put on a scheduled run. On AWS the function's timeout is the interval itself, and it may run only one invocation at a time. On Sepolia that leaves about two volumes a minute at 12 s blocks — if it ever maintains more, that budget is what to revisit.

## Choosing the platform

Repository variables `KEEPER_PLATFORM_SEPOLIA` and `KEEPER_PLATFORM_GNOSIS` — `cloudflare` (the default when unset) or `aws` — decide where `keeper-deploy` ships each deployment. **Never run one deployment on both**: two keepers on one wallet race each other's nonces. CI only deploys to the chosen platform; stopping the other is a manual step.

To move a deployment from Cloudflare to AWS:

1. Set up AWS (below) and deploy the stack with its schedule off (*Initial deployment*). Check `/health` reports the same wallet as the Worker's.
2. Stop the Worker: `pnpm exec wrangler delete --env <env>`. Its secrets go with it.
3. Set `KEEPER_PLATFORM_<ENV>=aws` and deploy without `--paused` — dispatch `keeper-deploy`, or `pnpm aws deploy <env>`.

A paused stack is safe to keep beside a live Worker; an unpaused one is not, even with `DRY_RUN` — a dry run still spends RPC quota and posts warnings every tick.

Back to Cloudflare is the same in reverse: `aws cloudformation delete-stack --stack-name keeper-<env>` (its secrets go with it), then set the variable to `cloudflare` and redeploy the Worker with its secrets (*Initial worker deployment*).

## Working on it

Node 24 and pnpm; pnpm installs the Node version `package.json` pins (`devEngines.runtime`).

```bash
pnpm install
pnpm test            # Vitest; includes whole scheduled runs against a mock chain, on both platforms' entry points
pnpm typecheck
pnpm check:deploy    # bundles both envs for Cloudflare, as CI does
pnpm check:aws       # bundles the Lambda, renders both stacks and lints them (needs cfn-lint)
```

After changing `wrangler.jsonc`, run `pnpm types` and commit `worker-configuration.d.ts`; CI fails if it is stale.

To run it locally against a real chain, put the four secrets in `.dev.vars` (see `.dev.vars.example`), then:

```bash
pnpm dev --var DRY_RUN:true          # wrangler dev --env sepolia
curl "localhost:8787/cdn-cgi/local/scheduled?format=json"
```

`DRY_RUN` simulates each trigger and sends nothing — the safe way to check a new deployment's RPC and registry. Only `secrets.required` names are read from `.dev.vars`; override anything else with `--var NAME:value`.

## Cloudflare

Needs Workers Paid: a run signs and sends transactions, which the Free plan's 10 ms CPU and 50 subrequests per invocation do not cover.

### Initial worker deployment

A new Worker cannot take `wrangler secret put` before it exists, and `secrets.required` blocks deploying without them — so the first deploy carries secrets inline:

```bash
cd services/keeper && pnpm install
printf 'PRIVATE_KEY=0x…\nRPC_URL=https://…,https://…\nTELEGRAM_BOT_TOKEN=…\nTELEGRAM_CHAT_ID=-100…\n' > .secrets.sepolia
pnpm exec wrangler deploy --env sepolia --secrets-file .secrets.sepolia
rm .secrets.sepolia
```

Then fund the wallet:

```bash
curl https://keeper-sepolia.<subdomain>.workers.dev/health
```

`GET /health` returns the wallet address to fund (and `503` with every validation problem if the configuration is invalid, without making RPC calls). Fund it with Sepolia ETH or xDAI — it pays gas only, never holds BZZ.

Finally, configure CI for all later deploys (so you never deploy from a laptop again): in repository settings create Environments `sepolia` and `gnosis` (give `gnosis` required reviewers), add repository/Environment secret `CLOUDFLARE_API_TOKEN` (from the *Edit Cloudflare Workers* token template) and variable `CLOUDFLARE_ACCOUNT_ID`. From then on every `push` to `main` auto-deploys `keeper-sepolia`; `keeper-gnosis` deploys only by manual `workflow_dispatch` of `keeper-deploy`.

### Secret rotation

Secrets are never in `wrangler.jsonc` or git — they live in Cloudflare Workers Secrets per env.

```bash
# single value
pnpm exec wrangler secret put PRIVATE_KEY --env sepolia
pnpm exec wrangler secret put RPC_URL --env sepolia          # comma-separated, independent providers

# or atomically via file (avoids typing a key into shell history)
printf 'PRIVATE_KEY=0x…\nRPC_URL=https://…,https://…\nTELEGRAM_BOT_TOKEN=…\nTELEGRAM_CHAT_ID=-100…\n' > .secrets.sepolia
pnpm exec wrangler deploy --env sepolia --secrets-file .secrets.sepolia
rm .secrets.sepolia
```

Validate immediately:

```bash
curl https://keeper-sepolia.<subdomain>.workers.dev/health   # 200 + wallet if ok, 503 with every problem if not
pnpm exec wrangler tail --env sepolia   # then wait one cron tick
```

The next cron tick uses the new value; no restart needed.

## AWS

One CloudFormation stack per deployment, named like the Worker (`keeper-sepolia`), rendered from `wrangler.jsonc` by [`scripts/aws.ts`](./scripts/aws.ts) — plain CloudFormation, no transform:

- **`keeper-<env>`** — the keeper function (Node 24, arm64), run by an EventBridge schedule derived from the env's cron. One invocation at a time, timeout = the cron interval, no retries.
- **`keeper-<env>-health`** — `GET /health` on a public Function URL. Its own function, so traffic on the URL can never take the keeper's one concurrent run.
- Log groups (30 days), the alarm topic and three alarms.

Both functions get the Worker's bindings as their environment variables, under the same names: the env's `vars` as they are, its `secrets.required` from NoEcho stack parameters (`PRIVATE_KEY` is `PrivateKey`), so no template holds them.

`pnpm aws deploy <env>` checks the stack will have a value for every `secrets.required` name, bundles the Lambda, renders the template, and ships both with the AWS CLI: `aws cloudformation package` uploads the bundle to the artifacts bucket, `aws cloudformation deploy` creates or updates the stack. It needs the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and credentials for the target account and region (`AWS_PROFILE` / `AWS_REGION`). `pnpm aws build <env>` renders the template without deploying, to `dist/aws/keeper-<env>.json`.

### One-time account setup

1. **Lambda concurrency.** The keeper reserves one concurrent execution and its health function another, and Lambda always keeps 100 unreserved — so an account at the default quota of 10 cannot deploy it. Check, and request 1000 if needed:

   ```bash
   aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384
   ```

2. **Public Function URLs.** If the account is in an AWS Organization, check no SCP or Lambda public-access block denies `lambda:InvokeFunctionUrl` with `FunctionUrlAuthType: NONE`; `/health` needs it.

3. **Deploy role, permissions boundary and artifacts bucket**, as an administrator:

   ```bash
   aws cloudformation deploy --stack-name keeper-bootstrap \
     --template-file infra/github-oidc.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubRepository=<owner>/<repo>
   # CreateOidcProvider=false if the account already has GitHub's OIDC provider
   ```

   Every keeper stack puts its roles under the `keeper-permissions-boundary` this creates, and its bundle in the bucket, so it must exist before any keeper stack — even one deployed by hand. Keep the stack name: `pnpm aws deploy` finds the bucket in `keeper-bootstrap`'s outputs.

4. **CI.** Set repository variables `AWS_DEPLOY_ROLE_ARN` (the stack's `DeployRoleArn` output) and `AWS_REGION`. They must be repository variables: the deploy job checks them before it enters an Environment.

### Initial deployment

```bash
cd services/keeper && pnpm install
printf 'PRIVATE_KEY=0x…\nRPC_URL=https://…,https://…\nTELEGRAM_BOT_TOKEN=…\nTELEGRAM_CHAT_ID=-100…\n' > .secrets.sepolia
pnpm aws deploy sepolia --paused --secrets-file .secrets.sepolia   # schedule off while the Worker still runs
rm .secrets.sepolia
```

On an account with no Worker for this deployment, `--var DRY_RUN:true` instead of `--paused` runs on schedule but sends nothing, reporting each run as a warning.

`--secrets-file` reads the same file `wrangler deploy --secrets-file` does, and refuses names that are not in `secrets.required`; a new stack needs all of them. The AWS CLI gets them in a file only you can read, never on its command line. `--var` overrides a variable for this deploy only, as with `wrangler dev`.

A first deploy that fails leaves the stack in `ROLLBACK_COMPLETE`, which cannot be updated: delete it (`aws cloudformation delete-stack --stack-name keeper-sepolia`) and deploy again.

Then:

- **Subscribe to the alarms**, once — subscriptions are not part of the stack, so redeploys keep them:

  ```bash
  aws sns subscribe --protocol email --notification-endpoint you@example.com \
    --topic-arn "$(aws cloudformation describe-stacks --stack-name keeper-sepolia \
      --query "Stacks[0].Outputs[?OutputKey=='AlarmTopic'].OutputValue" --output text)"
  ```

- **Fund the wallet.** The stack's `HealthUrl` output, plus `health`, answers exactly as the Worker's `/health` does.
- **Watch a run:** `aws logs tail /aws/lambda/keeper-sepolia --follow`.
- **Go live**, once the Worker is stopped (*Choosing the platform*): `pnpm aws deploy sepolia`.

### Secret rotation

```bash
pnpm aws deploy sepolia --secrets-file .secrets.sepolia   # any subset of the four names
```

A secret the file leaves out keeps its value. The deploy updates both functions' environment, and Lambda starts new instances with it, so the next run and `/health` use the new value. It deploys the checked-out code too, as `wrangler deploy --secrets-file` does: rotate from an up-to-date `main`. Rotate only through the stack, never by editing a function's environment: a later deploy would put the stack's value back.

### Pausing

```bash
pnpm aws deploy sepolia --paused   # schedule off, not-running alarm off
pnpm aws deploy sepolia            # back on
```

Every deploy sets the schedule's state, so the next CI deploy turns a paused stack back on. To keep it paused, disable the `keeper-deploy` workflow meanwhile.

## Code updates

1. Edit `services/keeper/src/**` (cycle logic lives in `src/keeper/`, wiring in `src/index.ts`/`src/config.ts`/`src/client.ts`/`src/reporting.ts`, the Lambda adapter in `src/aws/`).
2. Verify locally: `pnpm test && pnpm typecheck && pnpm check:deploy && pnpm check:aws`. If you changed `wrangler.jsonc`, run `pnpm types` and commit the regenerated `worker-configuration.d.ts`.
3. Push to a branch — `keeper-ci.yml` runs install, typecheck, tests, and both platforms' bundles.
4. Push/merge to `main` auto-deploys `keeper-sepolia` to its platform via `keeper-deploy.yml`. Deploy `keeper-gnosis` by manual `workflow_dispatch` (choose `gnosis` under *Run workflow*), after Environment required reviewers approve.

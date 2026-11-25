# keeper

The Swarm `VolumeRegistry` keeper: one deployment per registry deployment, on a Cloudflare Worker or AWS Lambda from the same source. Each scheduled run enumerates the registry's active volumes, sends them through the batched `trigger(bytes32[])`, up to 8 and 4M gas to a transaction, and reports what the contract did to each. A batch reverts as a whole when any of its volumes does ([ADR-0007](../../docs/adr/0007-keeper-endpoints-revert-only-on-bugs.md)), so each batch's gas is estimated before it is sent, and a batch whose estimate reverts is reported with the decoded reason and not sent.

Cloudflare Cron Triggers are the scheduler for the Workers; an EventBridge rule drives the Lambdas. GitHub Actions tests the Worker on every PR, and `keeper-deploy.yml` deploys every env in `wrangler.jsonc` when a keeper change merges to `main`. AWS deploys are run by hand ([AWS Lambda](#aws-lambda)).

| Env | Worker | Chain | Registry | Schedule |
|---|---|---|---|---|
| `sepolia-v2-rc4` | `keeper-cloudflare-sepolia-v2-rc4` | Sepolia (11155111) | v2-rc4 `0xe4913089…dad332a4` | every 10 minutes |

Each env in [`wrangler.jsonc`](./wrangler.jsonc) is one registry deployment, keyed by its deployment label, with its own wallet and RPC credentials. This tree supports only the deployments it has envs for. A new registry deployment replaces its predecessor's env ([`RELEASING.md`](./RELEASING.md)); the predecessor's Worker keeps running what it was last deployed with until it is deleted, and `wrangler.jsonc` lists those Workers and the commits they were deployed from. Keepers may share one Telegram group; every alert names its deployment, chain and registry.

## Layout

| | |
|---|---|
| `src/index.ts` | `scheduled()` and `GET /health` |
| `src/config.ts` | validates the Worker's bindings into a config, reporting every problem at once |
| `src/client.ts` | supported chains, the per-run RPC probe, the viem client |
| `src/keeper/` | the keeper cycle: enumerate at a pinned block, trigger each volume, decode each receipt |
| `src/reporting.ts` | the one structured report per run that logs and alerts are both rendered from |
| `src/notifications/telegram.ts` | formats that report for Telegram and sends it |

## What a run reports

Every run writes one JSON object to Workers Logs (`kind: "keeper/run"`) at the level matching its `status`:

- **`failure`** (`console.error`) — invalid configuration, no usable RPC endpoint, the registry unreadable, or any volume whose transaction failed or reverted, or whose batch was not sent because its gas estimate failed. One failed volume does not stop the rest being attempted. The invocation itself then fails, so Cron Events shows it too.
- **`warning`** (`console.warn`) — a transaction unconfirmed within `RECEIPT_TIMEOUT_MS` (its volumes are `pending`), a failover to a secondary RPC, the wallet below `MIN_BALANCE_WEI`, a `TopupSkipped` (`NoAuth`: payer revoked; `PaymentFailed`: out of BZZ or allowance; `NotActive`: retired before the batch reached it; `NotFound`: not a volume in this registry), a retirement, deferred work, or dry-run mode.
- **`ok`** (`console.log`).

`failures` and `warnings` each list `{ message, volumeId?, hash? }`; `volumes` has the per-volume detail, including the healthy `noop`s. In the Workers Logs query builder, filter on `status` or `deployment`.

Failures and warnings go to Telegram. `NOTIFY_WARNINGS` remains configurable, but defaults to `true` so skipped top-ups, retirements and RPC failovers are visible.

A failed run is not retried by the platform (`noRetry()`): the next tick is the retry, and an overlapping one would race the same wallet's nonce. `trigger` is idempotent, so nothing is lost by waiting.

RPC URLs are reduced to scheme and host, and the bot token and private key are masked, everywhere a report goes — viem puts the full endpoint URL in its error text.

## Configuration

Secrets, per deployment — never shared between them:

| | |
|---|---|
| `PRIVATE_KEY` | The keeper wallet, one per deployment, created and funded by `scripts/new_wallet.py`. It only pays gas: fund it with Sepolia ETH or xDAI and nothing else. Every batch is sent with its `pending` gas estimate plus 5%, at most 4M unless a single volume needs more. It pays only for the gas it uses, but the node wants the whole limit covered at the fee cap (twice the base fee) up front. |
| `RPC_URL` | Comma-separated, from independent providers. Probed every run — chain id included — and tried in order. |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. |
| `TELEGRAM_CHAT_ID` | Numeric user or private-group chat ID. Deployments may post to the same group, but store it independently. |

Declared in `secrets.required`, so `wrangler deploy` refuses to ship a deployment with any of them unset. The Worker validates their shape too: a key or URL set to the wrong thing fails the run and alerts, rather than passing for an idle keeper.

Variables, in `wrangler.jsonc` per env: `DEPLOYMENT_NAME`, `CHAIN_ID`, `REGISTRY_ADDRESS`, `NOTIFY_WARNINGS`, `MIN_BALANCE_WEI` (0 disables the warning), and the cycle limits `MAX_VOLUMES_PER_CYCLE`, `CYCLE_TIMEOUT_MS`, `RECEIPT_TIMEOUT_MS`, `CONFIRMATIONS`. Not set by any deployment, but accepted: `DRY_RUN`, `VOLUME_IDS` (maintain only these), `PAGE_SIZE`.

**A run must fit inside its cron interval**, so two runs never share the wallet at once: 5 s of RPC probing, plus `CYCLE_TIMEOUT_MS` (no new transaction starts after it), plus `RECEIPT_TIMEOUT_MS` for the last one, plus 5 s of slack. `test/config.test.ts` holds each env to that, and to the 15-minute Cron Trigger limit. On Sepolia that is up to 7 minutes of new transactions, roughly 35 at 12 s blocks, and up to 2 minutes for each receipt. Transactions are sent one at a time, each with up to 8 volumes, so a run reaches roughly `8 × CYCLE_TIMEOUT_MS / block time` volumes, capped at 30 by `MAX_VOLUMES_PER_CYCLE`. The rest are deferred, with a warning, and each run starts at a different point in the list so the same volumes are not deferred every time. If the active set outgrows that, raise the budget.

Every RPC request counts against the platform's per-invocation subrequest cap: 50 on Workers Free, 10,000 on Workers Paid. A run spends about 20 on fixed work (probing each endpoint twice, enumeration, nonce and fees once per cycle, the balance check, the alert), then several per transaction: its gas estimate (one more each time a batch over 4M is cut down), its send, and the receipt wait. On Workers Free, when each volume took its own transaction, runs reached about 3 volumes, whatever `CYCLE_TIMEOUT_MS` allowed.

## Setting up a deployment

Needs Workers Paid: a run signs and sends transactions, which the Free plan's 10 ms CPU and 50 subrequests per invocation do not cover.

### Initial worker deployment

A new deployment's Worker is set up by [`RELEASING.md`](./RELEASING.md): `scripts/new_wallet.py` creates and funds its wallet, `wrangler secret bulk` stores its secrets before the env merges, and the merge deploys it. `GET /health` then returns the wallet address the Worker signs with (and `503` with every validation problem if the configuration is invalid, without making RPC calls).

### Worker code update

1. Edit `services/keeper/src/**` (cycle logic lives in `src/keeper/`, Worker wiring in `src/index.ts`/`src/config.ts`/`src/client.ts`/`src/reporting.ts`).
2. Verify locally:

   ```bash
   pnpm install
   pnpm test           # includes whole scheduled runs against mock-chain
   pnpm typecheck
   pnpm check:deploy   # wrangler deploy --dry-run
   ```

   If you changed `wrangler.jsonc`, run `pnpm types` and commit the regenerated `worker-configuration.d.ts` (CI fails if stale).

3. Push to a branch — `keeper-ci.yml` runs the same checks. It never runs a keeper cycle or deploys.
4. Merge to `main`. `keeper-deploy.yml` reruns the checks and deploys every env. To redeploy without a change, run it by hand from `main` (`gh workflow run keeper-deploy.yml`).

### Retiring a Worker

A Worker whose env has left `wrangler.jsonc` is never redeployed from this tree: it would run code written for another deployment. It keeps running until it is deleted, out of band:

```bash
pnpm exec wrangler delete --name keeper-sepolia
```

### Secret rotation

Secrets are never in `wrangler.jsonc` or git — they live in Cloudflare Workers Secrets per env (`secrets.required: PRIVATE_KEY, RPC_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID`).

Rotate one value without redeploying code:

```bash
# single value
pnpm exec wrangler secret put PRIVATE_KEY --env sepolia-v2-rc4
pnpm exec wrangler secret put RPC_URL --env sepolia-v2-rc4          # comma-separated, independent providers
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN --env sepolia-v2-rc4
pnpm exec wrangler secret put TELEGRAM_CHAT_ID --env sepolia-v2-rc4

# or atomically via file (avoids typing a key into shell history)
printf 'PRIVATE_KEY=0x…\nRPC_URL=https://…,https://…\nTELEGRAM_BOT_TOKEN=…\nTELEGRAM_CHAT_ID=-100…\n' > .secrets.sepolia-v2-rc4
pnpm exec wrangler secret bulk .secrets.sepolia-v2-rc4 --env sepolia-v2-rc4
rm .secrets.sepolia-v2-rc4
```

Validate immediately:

```bash
curl https://keeper-cloudflare-sepolia-v2-rc4.<subdomain>.workers.dev/health   # 200 + wallet if ok, 503 with every problem if not
pnpm exec wrangler tail --env sepolia-v2-rc4   # then force a cycle: curl "localhost:8787/cdn-cgi/local/scheduled?format=json" in dev, or wait one cron tick
```

Notes:

* `wrangler deploy` refuses if any `secrets.required` entry is missing; the Worker itself re-validates shape (e.g. `PRIVATE_KEY` is `0x`-hex, `RPC_URL` parses) and **fails the run and alerts** rather than reporting `ok` with no work — a bad rotation is never silent.
* `HEALTH` is unauthenticated and reveals only the wallet address, not secret values.
* Keep `PRIVATE_KEY` per deployment; keys are never shared. `TELEGRAM_CHAT_ID` is also a per-deployment secret, even when deployments post to the same group.
* After rotation, the next cron tick uses the new value; no Workers restart needed. Old secrets are overwritten in place — delete the local `.secrets.*` file after.

## AWS Lambda

The same source also runs on AWS Lambda: `src/aws/handler.ts` calls the Worker's `scheduled()` and `fetch()` directly, `src/aws/websocket.ts` stands in for viem's `isows` import, and an EventBridge rule replaces the Cron Trigger. Each wrangler env gets its own pair of functions and rule, named `keeper-aws-<deployment>` for `keeper-cloudflare-<deployment>` — a deployment's Cloudflare and AWS keepers never share a name, a wallet is per deployment, and running both is a way to survive one platform's outage.

```bash
# bundle only, as CI's check:aws would
pnpm check:aws
# build, then create or update both functions, their URL and the rule
AWS_PROFILE=<profile> pnpm aws deploy sepolia-v2-rc4 --secrets-file .secrets.sepolia-aws
# first deploy, with the rule left off
AWS_PROFILE=<profile> pnpm aws deploy sepolia-v2-rc4 --secrets-file .secrets.sepolia-aws --paused
```

- **Credentials** come from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`(/`AWS_SESSION_TOKEN`), or from `aws configure export-credentials` for `AWS_PROFILE`, so `aws sso login` suffices. Region from `AWS_REGION`/`AWS_DEFAULT_REGION`, default `eu-central-1`. The deploy uses aws4fetch (a few KB) and the REST APIs, not the AWS SDK.
- **Secrets** are the env's `secrets.required`, given with `--secrets-file` or kept from the deployed function, as `wrangler deploy` does. The deploy refuses without all of them.
- **Account setup** is a `lambda-cron-exec` role that only writes logs, and the `LambdaCronDeveloper` permission set.
- **One run at a time**: each function reserves one concurrent execution, retries are off, and the Lambda timeout equals the cron interval.
- **Start delay**: every run waits a random 60–180 s before the cycle, so it does not reach the same volumes at the same second as a Cloudflare keeper on the same schedule. The deploy takes the longest wait out of `CYCLE_TIMEOUT_MS` (420 s becomes 240 s), so the run still ends inside its timeout. `test/config.test.ts` holds each env to that budget.
- **Runtime**: `nodejs24.x`, `arm64`, 256 MB. `/health` is a separate function behind a public Function URL, so health traffic cannot take the keeper's single concurrent run.

A merge deploys the Workers only: after a keeper change, redeploy each AWS env by hand with the commands above. Run the function once (`aws lambda invoke --function-name keeper-aws-<deployment> --payload '{}' --cli-binary-format raw-in-base64-out out.json`) and read the `keeper/run` line in CloudWatch, not the empty `out.json`.

## Working on it

```bash
pnpm install
pnpm test           # includes whole scheduled runs against a mock chain
pnpm typecheck
pnpm check:deploy   # bundles the env, as CI does
```

After changing `wrangler.jsonc`, run `pnpm types` and commit `worker-configuration.d.ts`; CI fails if it is stale.

To run it locally against a real chain, put the four secrets in `.dev.vars` (see `.dev.vars.example`), then:

```bash
pnpm dev --var DRY_RUN:true          # wrangler dev --env sepolia-v2-rc4
curl "localhost:8787/cdn-cgi/local/scheduled?format=json"
```

`DRY_RUN` estimates each batch and sends nothing — the safe way to check a new deployment's RPC and registry. Only `secrets.required` names are read from `.dev.vars`; override anything else with `--var NAME:value`.

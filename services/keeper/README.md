# keeper

The Swarm `VolumeRegistry` keeper: one Cloudflare Worker per registry deployment. Each scheduled run enumerates the registry's active volumes, sends `trigger(bytes32)` for each — one transaction per volume, per [`docs/KEEPERS.md`](../../docs/KEEPERS.md) — and reports what the contract did.

Cloudflare Cron Triggers are the only scheduler. GitHub Actions only tests the Worker; deploys are by hand with `wrangler`.

| Env | Worker | Chain | Registry | Schedule |
|---|---|---|---|---|
| `sepolia-v2-rc3` | `keeper-cloudflare-sepolia-v2-rc3` | Sepolia (11155111) | v2-rc3 `0xab326d6d…0078745e` | every 10 minutes |

Each env in [`wrangler.jsonc`](./wrangler.jsonc) is one registry deployment, keyed by its deployment label, with its own wallet and RPC credentials. This tree supports only the deployments it has envs for. A new registry deployment replaces its predecessor's env ([`RELEASING.md`](../../RELEASING.md) Part C); the predecessor's Worker keeps running what it was last deployed with until it is deleted, and `wrangler.jsonc` lists those Workers and the commits they were deployed from. Keepers may share one Telegram group; every alert names its deployment, chain and registry.

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

- **`failure`** (`console.error`) — invalid configuration, no usable RPC endpoint, the registry unreadable, or any volume whose transaction failed, reverted, or went unconfirmed within `RECEIPT_TIMEOUT_MS`. One failed volume does not stop the rest being attempted. The invocation itself then fails, so Cron Events shows it too.
- **`warning`** (`console.warn`) — a failover to a secondary RPC, the wallet below `MIN_BALANCE_WEI`, a `TopupSkipped` (`NoAuth`: payer revoked; `PaymentFailed`: out of BZZ or allowance), a retirement, deferred work, or dry-run mode.
- **`ok`** (`console.log`).

`failures` and `warnings` each list `{ message, volumeId?, hash? }`; `volumes` has the per-volume detail, including the healthy `noop`s. In the Workers Logs query builder, filter on `status` or `deployment`.

Failures and warnings go to Telegram. `NOTIFY_WARNINGS` remains configurable, but defaults to `true` so skipped top-ups, retirements and RPC failovers are visible.

A failed run is not retried by the platform (`noRetry()`): the next tick is the retry, and an overlapping one would race the same wallet's nonce. `trigger` is idempotent, so nothing is lost by waiting.

RPC URLs are reduced to scheme and host, and the bot token and private key are masked, everywhere a report goes — viem puts the full endpoint URL in its error text.

## Configuration

Secrets, per deployment — never shared between them:

| | |
|---|---|
| `PRIVATE_KEY` | The keeper wallet, one per deployment, created and funded by `scripts/new_wallet.py`. It only pays gas: fund it with Sepolia ETH or xDAI and nothing else. |
| `RPC_URL` | Comma-separated, from independent providers. Probed every run — chain id included — and tried in order. |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. |
| `TELEGRAM_CHAT_ID` | Numeric user or private-group chat ID. Deployments may post to the same group, but store it independently. |

Declared in `secrets.required`, so `wrangler deploy` refuses to ship a deployment with any of them unset. The Worker validates their shape too: a key or URL set to the wrong thing fails the run and alerts, rather than passing for an idle keeper.

Variables, in `wrangler.jsonc` per env: `DEPLOYMENT_NAME`, `CHAIN_ID`, `REGISTRY_ADDRESS`, `NOTIFY_WARNINGS`, `MIN_BALANCE_WEI` (0 disables the warning), and the cycle limits `MAX_VOLUMES_PER_CYCLE`, `CYCLE_TIMEOUT_MS`, `RECEIPT_TIMEOUT_MS`, `CONFIRMATIONS`. Not set by any deployment, but accepted: `DRY_RUN`, `VOLUME_IDS` (maintain only these), `PAGE_SIZE`.

**A run must fit inside its cron interval**, so two runs never share the wallet at once: 5 s of RPC probing, plus `CYCLE_TIMEOUT_MS` (no new transaction starts after it), plus `RECEIPT_TIMEOUT_MS` for the last one, plus 5 s of slack. `test/config.test.ts` holds each env to that, and to the 15-minute Cron Trigger limit. On Sepolia that is up to 7 minutes of new transactions, roughly 35 volumes at 12 s blocks, capped at 30 by `MAX_VOLUMES_PER_CYCLE`, and up to 2 minutes for each receipt. Volumes are sent one at a time, so a run reaches roughly `CYCLE_TIMEOUT_MS / block time` of them. The rest are deferred, with a warning, and each run starts at a different point in the list so the same volumes are not deferred every time. If the active set outgrows that, raise the budget.

Every RPC request counts against the platform's per-invocation subrequest cap: 50 on Workers Free, 10,000 on Workers Paid. A run spends about 20 on fixed work (probing each endpoint twice, enumeration, nonce and fees once per cycle, the balance check, the alert), then several per volume: its gas estimate, its send, and the receipt wait. On Workers Free, runs reached about 3 volumes, whatever `CYCLE_TIMEOUT_MS` allowed.

## Setting up a deployment

Needs Workers Paid: a run signs and sends transactions, which the Free plan's 10 ms CPU and 50 subrequests per invocation do not cover.

### Initial worker deployment

A new deployment's Worker is set up by [`RELEASING.md`](../../RELEASING.md) Part C: `scripts/new_wallet.py` creates and funds its wallet, and the first `wrangler deploy` carries the secrets in a file, because a Worker cannot take `wrangler secret put` before it exists. `GET /health` then returns the wallet address the Worker signs with (and `503` with every validation problem if the configuration is invalid, without making RPC calls).

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
4. Merge to `main`, then deploy by hand from it:

   ```bash
   pnpm exec wrangler deploy --env sepolia-v2-rc3
   ```

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
pnpm exec wrangler secret put PRIVATE_KEY --env sepolia-v2-rc3
pnpm exec wrangler secret put RPC_URL --env sepolia-v2-rc3          # comma-separated, independent providers
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN --env sepolia-v2-rc3
pnpm exec wrangler secret put TELEGRAM_CHAT_ID --env sepolia-v2-rc3

# or atomically via file (avoids typing a key into shell history)
printf 'PRIVATE_KEY=0x…\nRPC_URL=https://…,https://…\nTELEGRAM_BOT_TOKEN=…\nTELEGRAM_CHAT_ID=-100…\n' > .secrets.sepolia-v2-rc3
pnpm exec wrangler deploy --env sepolia-v2-rc3 --secrets-file .secrets.sepolia-v2-rc3
rm .secrets.sepolia-v2-rc3
```

Validate immediately:

```bash
curl https://keeper-cloudflare-sepolia-v2-rc3.<subdomain>.workers.dev/health   # 200 + wallet if ok, 503 with every problem if not
pnpm exec wrangler tail --env sepolia-v2-rc3   # then force a cycle: curl "localhost:8787/cdn-cgi/local/scheduled?format=json" in dev, or wait one cron tick
```

Notes:

* `wrangler deploy` refuses if any `secrets.required` entry is missing; the Worker itself re-validates shape (e.g. `PRIVATE_KEY` is `0x`-hex, `RPC_URL` parses) and **fails the run and alerts** rather than reporting `ok` with no work — a bad rotation is never silent.
* `HEALTH` is unauthenticated and reveals only the wallet address, not secret values.
* Keep `PRIVATE_KEY` per deployment; keys are never shared. `TELEGRAM_CHAT_ID` is also a per-deployment secret, even when deployments post to the same group.
* After rotation, the next cron tick uses the new value; no Workers restart needed. Old secrets are overwritten in place — delete the local `.secrets.*` file after.

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
pnpm dev --var DRY_RUN:true          # wrangler dev --env sepolia-v2-rc3
curl "localhost:8787/cdn-cgi/local/scheduled?format=json"
```

`DRY_RUN` simulates each trigger and sends nothing — the safe way to check a new deployment's RPC and registry. Only `secrets.required` names are read from `.dev.vars`; override anything else with `--var NAME:value`.

# keeper

The Swarm `VolumeRegistry` keeper: one Cloudflare Worker, deployed once per chain. Each scheduled run enumerates the registry's active volumes, sends `trigger(bytes32)` for each — one transaction per volume, per [`docs/KEEPERS.md`](../../docs/KEEPERS.md) — and reports what the contract did.

Cloudflare Cron Triggers are the only scheduler. GitHub Actions tests and deploys the Worker; it never runs a cycle.

| Deployment | Worker | Chain | Registry | Schedule |
|---|---|---|---|---|
| `sepolia` | `keeper-sepolia` | Sepolia (11155111) | v2 `0x33a53c79…4c493729` | every minute |
| `gnosis` | `keeper-gnosis` | Gnosis (100) | v1 `0x9639ae4c…ddd02aad` | hourly |

Both are envs in [`wrangler.jsonc`](./wrangler.jsonc), with independent wallets and RPC credentials. They may share one Telegram group; every alert names its deployment, chain and registry.

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

Failures always go to Telegram. Warnings go only where `NOTIFY_WARNINGS` is `true` — on for Gnosis, off for Sepolia, where a standing warning would repeat every minute.

A failed run is not retried by the platform (`noRetry()`): the next tick is the retry, and an overlapping one would race the same wallet's nonce. `trigger` is idempotent, so nothing is lost by waiting.

RPC URLs are reduced to scheme and host, and the bot token and private key are masked, everywhere a report goes — viem puts the full endpoint URL in its error text.

## Configuration

Secrets, per deployment — never shared between them:

| | |
|---|---|
| `PRIVATE_KEY` | The keeper wallet. Generate a fresh one (`cast wallet new`). It only pays gas: fund it with Sepolia ETH or xDAI and nothing else. |
| `RPC_URL` | Comma-separated, from independent providers. Probed every run — chain id included — and tried in order. |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. |

Declared in `secrets.required`, so `wrangler deploy` refuses to ship a deployment with any of them unset. The Worker validates their shape too: a key or URL set to the wrong thing fails the run and alerts, rather than passing for an idle keeper.

Variables, in `wrangler.jsonc` per env: `DEPLOYMENT_NAME`, `CHAIN_ID`, `REGISTRY_ADDRESS`, `TELEGRAM_CHAT_ID`, `NOTIFY_WARNINGS`, `MIN_BALANCE_WEI` (0 disables the warning), and the cycle limits `MAX_VOLUMES_PER_CYCLE`, `CYCLE_TIMEOUT_MS`, `RECEIPT_TIMEOUT_MS`, `CONFIRMATIONS`. Not set by either deployment, but accepted: `DRY_RUN`, `VOLUME_IDS` (maintain only these), `PAGE_SIZE`.

**A run must fit inside its cron interval**, so two runs never share the wallet at once: 5 s of RPC probing, plus `CYCLE_TIMEOUT_MS` (no new transaction starts after it), plus `RECEIPT_TIMEOUT_MS` for the last one, plus 5 s of slack. `test/config.test.ts` holds each env to that, and to the 15-minute Cron Trigger limit. On Sepolia that leaves about two volumes a minute at 12 s blocks — if it ever maintains more, that budget is what to revisit.

## Setting up a deployment

Needs Workers Paid: a run signs and sends transactions, which the Free plan's 10 ms CPU and 50 subrequests per invocation do not cover.

1. **First deploy, from your machine.** A new Worker cannot take `wrangler secret put` before it exists, and `secrets.required` blocks deploying without them — so the first deploy carries them:

   ```bash
   cd services/keeper && bun install
   printf 'PRIVATE_KEY=0x…\nRPC_URL=https://…,https://…\nTELEGRAM_BOT_TOKEN=…\n' > .secrets.sepolia
   bunx wrangler deploy --env sepolia --secrets-file .secrets.sepolia
   rm .secrets.sepolia
   ```

   Later changes: `bunx wrangler secret put RPC_URL --env sepolia`.

2. **Fund the wallet.** `curl https://keeper-sepolia.<subdomain>.workers.dev/health` returns its address — and `503` with the problems if the configuration is invalid. It makes no RPC calls.

3. **Let CI deploy from then on.** In repository settings:
   - Environments `sepolia` and `gnosis`. Give `gnosis` required reviewers, and restrict it to tags.
   - Secret `CLOUDFLARE_API_TOKEN` (from the *Edit Cloudflare Workers* token template) and variable `CLOUDFLARE_ACCOUNT_ID`, on the repository or on each environment.
   - Variable `KEEPER_DEPLOY_SEPOLIA_ON_MERGE=true` to deploy Sepolia on every merge to `main`. Unset, merges deploy nothing.

   Gnosis ships only by running **keeper-deploy** by hand, from a release tag, after approval.

## Working on it

```bash
bun install
bun test               # includes whole scheduled runs against a mock chain
bun run typecheck
bun run check:deploy   # bundles both envs, as CI does
```

After changing `wrangler.jsonc`, run `bun run types` and commit `worker-configuration.d.ts`; CI fails if it is stale.

To run it locally against a real chain, put the three secrets in `.dev.vars` (see `.dev.vars.example`), then:

```bash
bun run dev --var DRY_RUN:true          # wrangler dev --env sepolia
curl "localhost:8787/cdn-cgi/local/scheduled?format=json"
```

`DRY_RUN` simulates each trigger and sends nothing — the safe way to check a new deployment's RPC and registry. Only `secrets.required` names are read from `.dev.vars`; override anything else with `--var NAME:value`.

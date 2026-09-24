# Volume Registry Data API — Client interface

The tool is `ethswarm-volumes`. The read client and dashboard share one set of option semantics; the CLI renders them as flags, the dashboard as controls. Both read the same artifact ([`SCHEMA.md`](./SCHEMA.md)) and fold locally ([ADR-0009](./adr/0009-client-side-folding.md)).

```
ethswarm-volumes sync [options]                 # run the indexer (the ARCHITECTURE.md §1 write path)
ethswarm-volumes stat [<deployment>] [options]  # render the 3-measure summary
```

`sync` reads to `finalized`, updates the [`event_log`](./data-model/event-log.md) cache, projects, and writes/publishes the artifact. Its main option is `--store-dir <path>` (the cache location; default `$XDG_CACHE_HOME/ethswarm-volumes`, overridable via `$ETHSWARM_VOLUMES_STORE`), alongside the RPC endpoint configuration. `stat` is the read path below. Further verbs (e.g. volume management) come later; v1 is these two.

## `stat`

`<deployment>` selects by `label` (primary) or `chain:address` (unambiguous fallback); optional when only one deployment is present. With no `<deployment>` and several present, `stat` lists them.

| Option | Meaning | Default |
|---|---|---|
| `--source <url\|path>` | where to read the artifact | URL once published; local path used first |
| `--bucket-width 1d\|7d\|30d` | fold width | `1d` |
| `--bucket-count N` / `-n` | series length (number of buckets back) | 30 |
| `--since DATE` | explicit start (alternative to `--bucket-count`) | — |
| `--capacity-basis nominal\|effective` | which capacity figure | `nominal` |
| `--capacity-unit auto\|GiB\|TiB\|chunks` | display unit | `auto` |
| `--fiat none\|USD\|…` | fiat conversion of fee figures (validated against `fiat_currencies`) | `none` |
| `--json` | emit the resolved summary as JSON | — |

## Query resolution

How each consumer query resolves against the artifact (all client-side, over the single fetched artifact):

| Need | Computation |
|---|---|
| Fee volume, window / since genesis | sum `fee_volume_daily.bzz` over the slice |
| Fee volume in fiat | `Σ (bzz × price_daily[fiat])` over the slice — historical per day |
| Capacity now / at a past point | `snapshot.capacity` / `capacity_daily` lookup; basis picks the field |
| Capacity / accounts series | sample the daily series at bucket edges (stocks sample; flows sum) |
| Accounts authorized | `snapshot.accounts.authorized` / `accounts_daily` |
| Accounts paid in window | `snapshot.accounts.paid_in_window[N]` — fixed N (1/7/30 d) |

`paid_in_window` is a **fixed pre-baked set** (1/7/30 d), independent of the bucket options; the accounts series carries the `authorized` level ([ADR-0009](./adr/0009-client-side-folding.md)).

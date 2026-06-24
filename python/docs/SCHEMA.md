# Volume Registry Data API — Artifact Schema

This document specifies the wire format the indexer writes and the clients read. It is
the contract referenced by [`ARCHITECTURE.md`](./ARCHITECTURE.md). Two formats are
defined: the **published artifact** (one file) and the client's **`--json` summary**
(the resolved view-model).

## 1. Conventions

- **One file.** All deployments live in a single JSON document. `schema_version` and
  `generated_at` appear once at the top; each deployment is a self-contained entry.
- **Full daily history from genesis.** Each entry carries every UTC day from the
  deployment's genesis day through `as_of` — the artifact is not pre-windowed. Clients
  slice and fold locally, so "since deployment", arbitrary windows, and any
  `--bucket-width` / `--bucket-count` are all answered without refetching. Size is small
  (days × a few fields).
- **UTC calendar day.** `date` is `"YYYY-MM-DD"`; a day boundary is UTC midnight.
- **Amounts are plain JSON numbers in BZZ.** Not PLUR, not strings. Floating point is
  fine; rounding is fine; precision below ~1 BZZ/day is not guaranteed. Byte counts are
  likewise plain numbers.
- **Partial edges.** The genesis day and the final day (up to `as_of.ts`) are partial.
  The final `date` equals `as_of`'s UTC day; clients should treat the last bucket as
  in-progress.
- **Fiat is baked, historical, per day.** `price_daily` gives fiat per **1 BZZ** for each
  UTC day; fee-volume-in-fiat is the per-day product summed over the slice. Clients need
  no network access and no "current" rate.

## 2. Versioning

- `schema_version` (top level) versions the **artifact structure** and follows semver:
  **major** = breaking kernel change; **minor** = additive optional section; **patch** =
  non-structural. It is synced fleet-wide (every entry is regenerated at the current
  version each publish).
- `registry_version` (per entry) names the **contract** variant. It is orthogonal to
  `schema_version` and heterogeneous across deployments.
- The **kernel** — `snapshot` plus the four daily series — is stable across contract
  versions. Version-specific facts appear only under `extra` and as additive optional
  sections.
- Clients accept an equal major, ignore unknown keys (forward-compatible on minor), and
  refuse a higher major.

## 3. Published artifact

```jsonc
{
  "schema_version": "1.0.0",                 // semver; artifact structure; synced fleet-wide
  "generated_at": "2026-06-09T12:00:00Z",    // UTC ISO 8601; publish time

  "deployments": [
    {
      // ----- identity (contract-agnostic) -----
      "label": "gnosis",                      // selector for `ethswarm-volumes stat <label>`
      "chain_id": 100,
      "registry": "0x9639…",
      "registry_version": "v1",               // which contract; orthogonal to schema_version
      "genesis_ts": "2026-05-20T08:00:00Z",   // UTC ISO 8601; deployment time
      "as_of": { "block": 38211904, "ts": "2026-06-09T12:00:00Z" },  // per-deployment chain head
      "fiat_currencies": ["USD"],             // bounds what client --fiat accepts

      // ----- version-specific wiring (the v1 shape) -----
      "extra": {
        "grace_blocks": 17280,
        "postage": "0x45a1502382541Cd610CC9068e88727426b696293",
        "price_oracle": "0x47EeF336e7fE5bED98499A4696bce8f28c1B0a8b",
        "bzz": "0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da"
      },

      // ----- snapshot: current point-in-time (precomputed convenience) -----
      "snapshot": {
        "fee_volume_total_bzz": 1204.3,       // cumulative since genesis, BZZ
        "capacity": {
          "active_volumes": 1182,
          "nominal_bytes": 0,                  // (1 << depth) × 4096, summed over active
          "effective_bytes": 0                 // depth → effective lookup, summed over active
        },
        "accounts": {
          "authorized": 470,                   // currently active == true
          "paid_in_window": { "1d": 12, "7d": 41, "30d": 88 }   // fixed N; distinct payers
        }
      },

      // ----- daily series: the atomic grain everything folds from -----
      "fee_volume_daily": [                    // flow: BZZ forwarded to Postage that day
        { "date": "2026-06-08", "bzz": 3.1 }
      ],
      "capacity_daily": [                      // stock: level at UTC day end
        { "date": "2026-06-08", "active_volumes": 1180, "nominal_bytes": 0, "effective_bytes": 0 }
      ],
      "accounts_daily": [                      // stock: authorized level at UTC day end
        { "date": "2026-06-08", "authorized": 469 }
      ],
      "price_daily": [                         // fiat per 1 BZZ, per day, per currency
        { "date": "2026-06-08", "bzz_fiat": { "USD": 0.34 } }
      ]
    }
    // … one entry per tracked deployment
  ]
}
```

### Field reference

| Path | Type | Notes |
|---|---|---|
| `schema_version` | string (semver) | artifact structure version; synced fleet-wide |
| `generated_at` | string (UTC ISO 8601) | publish time |
| `deployments[]` | array | one self-contained entry per deployment |
| `…label` | string | human selector; unique within the file |
| `…chain_id` | number | EVM chain id |
| `…registry` | string (address) | the `VolumeRegistry` address |
| `…registry_version` | string | contract variant; selects the projector that produced this entry |
| `…genesis_ts` | string (UTC ISO 8601) | deployment time; anchor for "since deployment" |
| `…as_of` | `{block:number, ts:string}` | chain head this entry reflects |
| `…fiat_currencies` | string[] | currencies present in `price_daily`; bounds `--fiat` |
| `…extra` | object | version-specific bag; shape depends on `registry_version` (v1 fields shown) |
| `…snapshot.fee_volume_total_bzz` | number | cumulative fee volume since genesis, BZZ |
| `…snapshot.capacity` | object | current `active_volumes`, `nominal_bytes`, `effective_bytes` |
| `…snapshot.accounts.authorized` | number | accounts currently `active == true` |
| `…snapshot.accounts.paid_in_window` | `{ "1d":n, "7d":n, "30d":n }` | distinct paying accounts over fixed windows |
| `…fee_volume_daily[]` | `{date, bzz}` | flow; BZZ → Postage that UTC day |
| `…capacity_daily[]` | `{date, active_volumes, nominal_bytes, effective_bytes}` | stock at UTC day end |
| `…accounts_daily[]` | `{date, authorized}` | authorized level at UTC day end |
| `…price_daily[]` | `{date, bzz_fiat:{<ccy>:number}}` | fiat per 1 BZZ per day |

## 4. Client `--json` summary (resolved view-model)

`ethswarm-volumes stat --json` emits the resolved summary after applying the options — the same
numbers the human view renders, and the same view-model the dashboard builds. `unit`
flips to `"BZZ"` and the `fiat` fields drop when `--fiat none`.

```jsonc
{
  "deployment": {
    "label": "gnosis", "chain_id": 100, "registry": "0x9639…",
    "registry_version": "v1", "genesis_ts": "2026-05-20T08:00:00Z",
    "as_of": { "block": 38211904, "ts": "2026-06-09T12:00:00Z" }
  },
  "options": {
    "bucket_width": "1d", "bucket_count": 30,
    "capacity_basis": "nominal", "capacity_unit": "auto", "fiat": "USD"
  },
  "fee_volume": {
    "unit": "USD",                              // or "BZZ"
    "total": 0,                                 // since genesis (fiat = historical per-day sum)
    "window": 0,                                // over bucket_width × bucket_count
    "series": [ { "start": "2026-06-08", "bzz": 3.1, "fiat": 1.05 } ]
  },
  "capacity": {
    "active_volumes": 1182, "basis": "nominal",
    "bytes": 0, "display": "9.1 TiB",
    "series": [ { "start": "2026-06-08", "active_volumes": 1180, "bytes": 0 } ]
  },
  "accounts": {
    "authorized": 470,
    "paid_in_window": { "1d": 12, "7d": 41, "30d": 88 },
    "series": [ { "start": "2026-06-08", "authorized": 469 } ]
  }
}
```

Resolution rules (all client-side, against §3):

- **Fee volume window/total** — sum `fee_volume_daily.bzz` over the slice; in fiat, sum
  `bzz × price_daily[ccy]` per day (historical per-bucket).
- **Capacity** — `basis` selects `nominal_bytes` or `effective_bytes`; `display` formats
  `bytes` per `capacity_unit`; series samples `capacity_daily` at bucket edges.
- **Accounts** — `authorized` from `snapshot` / `accounts_daily`; `paid_in_window` copied
  through from `snapshot` (fixed N, not derived from the bucket options).
- **Folds** — flows (fee volume) sum across a bucket; stocks (capacity, accounts) sample
  the bucket's right edge.

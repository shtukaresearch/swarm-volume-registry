# ADR-0009: Clients fold locally; `paid_in_window` pre-baked

Status: Accepted

## Context

Windowing, bucketing, and fiat conversion could happen server-side (parameterized queries)
or client-side (over a shipped daily series). Distinct-accounts-over-a-window is special: it
does not compose from per-day counts, so it cannot be re-derived by a client slicing the
daily series.

## Decision

Ship full daily history from genesis in the artifact and have clients do all windowing,
bucketing, and fiat conversion. Pre-bake `paid_in_window` over fixed windows (1 / 7 / 30
days) into the artifact.

## Consequences

- One artifact feeds two thin renderers (CLI, dashboard) with shared option semantics;
  arbitrary windows, "since genesis", and any bucket width/count are answered without a
  refetch.
- Fiat is baked per day, so clients need no network access and no live rate.
- `paid_in_window` is a fixed set independent of the bucket options; the accounts series
  therefore carries the `authorized` level only. Other window widths for distinct payers
  would require baking additional pre-computed sets.

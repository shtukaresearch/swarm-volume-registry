"""Client-side fiat conversion of fee volume (``docs/SCHEMA.md`` §4, ``docs/TESTING.md`` §7).

Conversion is historical-per-day: each day's BZZ is valued at *that day's* baked
``price_daily`` rate, then summed over the requested slice. There is no "current rate"
— every fiat figure is fully determined by the artifact.

Interface stubs; bodies filled in by the builder.
"""

from __future__ import annotations

from .model import DailyFee, DailyPrice


def fee_fiat_daily(
    fee_daily: list[DailyFee], price_daily: list[DailyPrice], currency: str
) -> list[float]:
    """Per-day fiat value of fee volume: ``bzz[d] * rate[currency][d]`` for each day.

    Aligns the two series by ``date``; a fee day with no matching price day is valued at
    ``0.0`` (no rate, no contribution). Raises ``ValueError`` if ``currency`` is absent
    from a day's ``bzz_fiat`` when a rate for that day *is* present.
    """
    rate_by_date: dict[str, dict[str, float]] = {p.date: p.bzz_fiat for p in price_daily}
    out: list[float] = []
    for day in fee_daily:
        rates = rate_by_date.get(day.date)
        if rates is None:
            out.append(0.0)
            continue
        if currency not in rates:
            raise ValueError(f"no {currency!r} rate for {day.date}")
        out.append(day.bzz * rates[currency])
    return out


def fee_fiat_total(
    fee_daily: list[DailyFee], price_daily: list[DailyPrice], currency: str
) -> float:
    """Sum of :func:`fee_fiat_daily` — fiat over the whole slice (e.g. since genesis)."""
    return sum(fee_fiat_daily(fee_daily, price_daily, currency))

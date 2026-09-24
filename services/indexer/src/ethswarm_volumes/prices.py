"""Historical BZZ price baking via the DeFiLlama API (``docs/SCHEMA.md`` §1, "Fiat").

The artifact bakes ``price_daily`` — fiat per 1 BZZ for each UTC day — so clients need no
network access and no "current" rate. This module fetches that daily history from
DeFiLlama's coins API at sync time, keyed by the BZZ token's ``chain:address``.

DeFiLlama quotes USD only, so the baked currency set is ``["USD"]`` when data is available.
Fetching is **best-effort**: any failure (offline, unknown token, HTTP error) yields an
empty series, and the deployment is published with no fiat rather than failing the sync.
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone

from .model import DailyPrice

#: chain_id -> DeFiLlama chain slug for the ``coins`` API.
LLAMA_CHAIN: dict[int, str] = {
    1: "ethereum",
    100: "gnosis",
}

_CHART_URL = "https://coins.llama.fi/chart/{coin}"
_ONE_DAY = 86_400


def _http_get_json(url: str, *, timeout: float) -> dict:
    """GET ``url`` and parse a JSON body (stdlib only; no runtime dependency)."""
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 (trusted host)
        return json.loads(resp.read().decode("utf-8"))


def fetch_price_daily(
    chain_id: int,
    token_address: str,
    *,
    start_ts: datetime,
    end_ts: datetime,
    timeout: float = 15.0,
) -> list[DailyPrice]:
    """Daily USD price of one BZZ for each UTC day in ``[start_ts, end_ts]``.

    Returns one :class:`DailyPrice` per day for which DeFiLlama has a quote; days without a
    quote are omitted (the client's fiat fold treats a missing day as no contribution). On
    any error — unsupported chain, network failure, malformed response — returns ``[]``.
    """
    slug = LLAMA_CHAIN.get(chain_id)
    if slug is None:
        return []

    start = int(start_ts.timestamp())
    end = int(end_ts.timestamp())
    span = max(1, (end - start) // _ONE_DAY + 2)
    coin = f"{slug}:{token_address}"
    url = f"{_CHART_URL.format(coin=coin)}?start={start}&span={span}&period=1d&searchWidth=12h"

    try:
        doc = _http_get_json(url, timeout=timeout)
        points = doc["coins"][coin]["prices"]
    except Exception:
        return []

    # Collapse to one price per UTC day (last quote wins for a given day).
    by_day: dict[str, float] = {}
    for point in points:
        day = datetime.fromtimestamp(point["timestamp"], tz=timezone.utc).strftime("%Y-%m-%d")
        by_day[day] = point["price"]

    return [
        DailyPrice(date=date, bzz_fiat={"USD": price}) for date, price in sorted(by_day.items())
    ]

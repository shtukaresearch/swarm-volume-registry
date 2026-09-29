"""Storage-capacity reference data: depth -> bytes.

Two bases (``docs/SCHEMA.md`` §3, ``docs/usage.md`` §12):

- **nominal**: ``(1 << depth) * 4096`` — exact.
- **effective**: the documented usable volume at ``bucketDepth = 16``, unencrypted,
  no erasure coding. These are bucket-limited figures from the upstream Swarm docs
  and are approximate by nature.

This module is pure reference data — the projector sums these over the active set.
"""

from __future__ import annotations

#: Chunk size in bytes.
CHUNK_SIZE_BYTES = 4096


def nominal_bytes(depth: int) -> int:
    """Nominal capacity at ``depth``: ``(1 << depth)`` chunks of 4 KiB. Exact."""
    return (1 << depth) * CHUNK_SIZE_BYTES


#: Effective usable bytes per depth (bucketDepth 16, unencrypted, no erasure coding).
#: Source: ``docs/usage.md`` §12 / Swarm docs. Approximate (bucket-limited).
EFFECTIVE_BYTES: dict[int, int] = {
    17: 44_700,
    18: 6_660_000,
    19: 112_060_000,
    20: 687_620_000,
    21: 2_600_000_000,
    22: 7_730_000_000,
    23: 19_940_000_000,
    24: 47_060_000_000,
    25: 105_510_000_000,
    26: 227_980_000_000,
    27: 476_680_000_000,
    28: 993_650_000_000,
    29: 2_040_000_000_000,
    30: 4_170_000_000_000,
    31: 8_450_000_000_000,
    32: 17_070_000_000_000,
    33: 34_360_000_000_000,
    34: 69_040_000_000_000,
    35: 138_540_000_000_000,
    36: 277_720_000_000_000,
    37: 556_350_000_000_000,
    38: 1_110_000_000_000_000,
    39: 2_230_000_000_000_000,
    40: 4_460_000_000_000_000,
    41: 8_930_000_000_000_000,
}


def effective_bytes(depth: int) -> int:
    """Effective usable capacity at ``depth``. Raises ``KeyError`` for unknown depth."""
    return EFFECTIVE_BYTES[depth]

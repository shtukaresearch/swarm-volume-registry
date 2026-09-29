"""CLI entry point: ``ethswarm-volumes sync`` and ``ethswarm-volumes stat``.

Two verbs over the one data contract (``docs/CLIENT.md``):

- ``sync`` — the write path. For each registry deployment on the connected chain: acquire
  the delta to ``finalized`` range by range, decode it across the ``event_log`` boundary,
  feed the fresh rows plus the cached prior history straight to the projector, bake fiat,
  and write/merge the single artifact file. Each range is appended to the JSONLines cache
  and checkpointed as it completes, so an interrupted sync resumes where it stopped — the
  cache is off the projector's data path (``docs/ARCHITECTURE.md`` §1).
- ``stat`` — the read path. Load the artifact, fold one deployment per the bucket / capacity
  / fiat options, and render it as text or ``--json`` (``docs/SCHEMA.md`` §4).

The RPC endpoint is ``--rpc``, or else an environment variable named for the chain by its
EIP-3770 short name: ``sync <deployment>`` reads ``$<SHORT>_RPC_URL`` for that deployment's
chain (``$GNO_RPC_URL`` on Gnosis, ``$SEP_RPC_URL`` on Sepolia); a bare ``sync`` reads
``$GNO_RPC_URL`` and indexes every registered deployment on the chain it reaches. A named
deployment on a different chain from the endpoint is refused before any contract call.
The deployment set is the built-in registry, overridable with ``--config``
(:mod:`ethswarm_volumes.registry`).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import acquire, decode, node, prices, registry, serialize, store, view
from .model import Artifact, Deployment, EventLog
from .project import project_entry

DEFAULT_ARTIFACT_NAME = "artifact.json"
#: EIP-3770 short names of the chains with a default RPC variable, ``$<SHORT>_RPC_URL``.
CHAIN_SHORT_NAMES = {1: "ETH", 100: "GNO", 11155111: "SEP"}
#: The chain a bare ``sync`` (no deployment named) connects to by default.
DEFAULT_CHAIN_ID = 100


def rpc_env(chain_id: int) -> str | None:
    """The default RPC environment variable for ``chain_id``, if it has a short name."""
    short = CHAIN_SHORT_NAMES.get(chain_id)
    return f"{short}_RPC_URL" if short else None


RPC_ENV = rpc_env(DEFAULT_CHAIN_ID)


class _Progress:
    """Block-range progress for one deployment's acquisition, on stderr.

    Disabled (a no-op) for headless runs; ``--progress`` / ``--no-progress`` override the
    default, which is on only when stderr is a terminal. On a terminal the line redraws in
    place; otherwise each update is its own line, so a forced ``--progress`` stays readable
    in a log file.
    """

    def __init__(self, enabled: bool, label: str, from_block: int, to_block: int) -> None:
        self.enabled = enabled and from_block <= to_block
        self.label = label
        self.from_block = from_block
        self.total = to_block - from_block + 1
        self.inplace = sys.stderr.isatty()

    def update(self, block: int, n_logs: int) -> None:
        if not self.enabled:
            return
        pct = 100 * (block - self.from_block + 1) // self.total
        line = f"  {self.label}: block {block} ({pct}%), {n_logs} new logs"
        print(
            f"\r{line}" if self.inplace else line,
            end="" if self.inplace else "\n",
            file=sys.stderr,
            flush=True,
        )

    def done(self) -> None:
        if self.enabled and self.inplace:
            print(file=sys.stderr)


# ---------------------------------------------------------------------------
# sync
# ---------------------------------------------------------------------------


def _sync_and_project(
    w3, rpc, store_dir: Path, spec: registry.DeploymentSpec, head_block: int, progress: bool
):
    """Sync one deployment's delta and project its artifact entry.

    Fresh decoded rows feed the projector directly; the JSONLines cache is off the data
    path (``docs/ARCHITECTURE.md`` §1). The cache supplies the prior history and the
    resume head, so a resync acquires only ``(head, head_block]`` and no freshly-decoded
    row round-trips through disk before projection. Each acquired range is appended to
    the cache and its end checkpointed as the head before the next range is requested,
    purely so an interrupted sync — or the next one — resumes without refetching.
    """
    dep_id = spec.deployment_id
    genesis_block = spec.genesis_block
    if genesis_block is None:
        genesis_block = node.find_genesis_block(w3, spec.registry)
        print(f"  discovered genesis block {genesis_block}", file=sys.stderr)

    extra = node.resolve_extra(w3, spec.registry)

    # Prior history + resume head from the cache (the cache branch of the diagram).
    prior = store.load_event_log(store_dir, dep_id)
    head = store.load_head(store_dir, dep_id)
    from_block = head + 1 if head is not None else genesis_block

    # Acquire + decode only the delta, one checkpointed range at a time. Timestamps ride
    # on the logs (``blockTimestamp``), so decoding needs no further RPC.
    fresh: list = []
    bar = _Progress(progress, spec.label, from_block, head_block)
    chunks = acquire.iter_log_chunks(
        rpc,
        registry=spec.registry,
        bzz_token=extra["bzz"],
        postage=extra["postage"],
        from_block=from_block,
        to_block=head_block,
    )
    for _, end, raw in chunks:
        rows = [
            decode.decode_log(log, deployment_id=dep_id, registry_version=spec.registry_version)
            for log in raw
        ]
        store.append_rows(store_dir, rows)  # rows first, then the head: at-least-once
        store.save_head(store_dir, dep_id, end)
        fresh.extend(rows)
        bar.update(end, len(fresh))
    bar.done()
    print(f"  synced [{from_block}, {head_block}] — {len(fresh)} new logs", file=sys.stderr)

    # Feed prior history + the fresh delta straight to the projector — no reload.
    events = EventLog.from_rows([*prior.merged(), *fresh])

    as_of_ts = node.block_timestamp(w3, head_block)
    genesis_ts = node.block_timestamp(w3, genesis_block)
    price_daily = prices.fetch_price_daily(
        spec.chain_id, extra["bzz"], start_ts=genesis_ts, end_ts=as_of_ts
    )
    fiat_currencies = ["USD"] if price_daily else []

    deployment = Deployment(
        label=spec.label,
        chain_id=spec.chain_id,
        registry=spec.registry,
        registry_version=spec.registry_version,
        genesis_ts=genesis_ts,
        fiat_currencies=fiat_currencies,
        extra=extra,
    )
    return project_entry(deployment, events, price_daily, as_of_block=head_block, as_of_ts=as_of_ts)


def _unsupported(targets: list[registry.DeploymentSpec]) -> list[registry.DeploymentSpec]:
    """The sync targets whose ``registry_version`` this package build cannot decode.

    The built-in fleet is closed over supported versions by construction (a unit test
    gates every release), but an operator ``--config`` bypasses that gate — so ``sync``
    checks its targets and refuses clearly rather than failing with a ``KeyError`` at
    decode time.
    """
    return [t for t in targets if t.registry_version not in decode.supported_versions()]


def _artifact_path(args, store_dir: Path) -> Path:
    return Path(args.output) if args.output else store_dir / DEFAULT_ARTIFACT_NAME


def _load_existing(path: Path) -> Artifact | None:
    if path.is_file():
        return serialize.artifact_from_json(path.read_text(encoding="utf-8"))
    return None


def cmd_sync(args) -> int:
    store_dir = store.resolve_store_dir(args.store_dir)
    try:
        reg = registry.load_registry(args.config)
    except (KeyError, ValueError) as exc:
        print(f"error: invalid deployment registry: {exc}", file=sys.stderr)
        return 2

    # Resolve a named deployment first: its chain picks the default endpoint.
    chosen = None
    if args.deployment:
        chosen = registry.select(reg, args.deployment)
        if chosen is None:
            print(f"error: unknown deployment {args.deployment!r}", file=sys.stderr)
            return 2
    env = rpc_env(chosen.chain_id if chosen else DEFAULT_CHAIN_ID)
    rpc_url = args.rpc or (os.environ.get(env) if env else None)
    if not rpc_url:
        hint = f"pass --rpc or set ${env}" if env else "pass --rpc"
        print(f"error: no RPC endpoint ({hint})", file=sys.stderr)
        return 2

    w3 = node.connect(rpc_url, timeout=args.rpc_timeout)
    if not w3.is_connected():
        print(f"error: cannot connect to {rpc_url}", file=sys.stderr)
        return 2
    rpc = node.Web3RpcClient(w3)
    chain_id = w3.eth.chain_id

    if chosen is not None:
        if chosen.chain_id != chain_id:
            print(
                f"error: deployment {chosen.label!r} is on chain {chosen.chain_id}, but the"
                f" RPC endpoint serves chain {chain_id}; pass --rpc for chain {chosen.chain_id}"
                + (f" or set ${env}" if env else ""),
                file=sys.stderr,
            )
            return 2
        targets = [chosen]
    else:
        targets = [s for s in reg if s.chain_id == chain_id]
        if not targets:
            print(f"error: no registry deployment on chain {chain_id}", file=sys.stderr)
            return 2

    # The head to index to: an explicit --to-block, else the reorg-safe finalized head.
    # All targets share one chain, so one resolution covers them.
    head_block = args.to_block if args.to_block is not None else rpc.finalized_block_number()

    bad = _unsupported(targets)
    if bad:
        supported = ", ".join(sorted(decode.supported_versions()))
        for spec in bad:
            print(
                f"error: deployment {spec.label!r} has registry_version"
                f" {spec.registry_version!r}, which this package build does not support"
                f" (supported: {supported})",
                file=sys.stderr,
            )
        return 2

    progress = sys.stderr.isatty() if args.progress is None else args.progress
    entries = []
    for spec in targets:
        print(f"sync {spec.label} (chain {spec.chain_id})", file=sys.stderr)
        try:
            entries.append(_sync_and_project(w3, rpc, store_dir, spec, head_block, progress))
        except decode.MissingBlockTimestampError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    # Merge into the single artifact: replace synced entries, keep the rest.
    existing = _load_existing(_artifact_path(args, store_dir))
    by_id = {
        (e.chain_id, e.registry.lower()): e for e in (existing.deployments if existing else [])
    }
    for entry in entries:
        by_id[(entry.chain_id, entry.registry.lower())] = entry

    # The latest pointers: the prior file's, overridden by this registry's, kept only where
    # they name an entry the file actually carries.
    deployments = list(by_id.values())
    labels = {e.label for e in deployments}
    latest = {**(existing.latest if existing else {}), **reg.latest}
    artifact = Artifact(
        schema_version=serialize.SCHEMA_VERSION,
        generated_at=datetime.now(timezone.utc),
        deployments=deployments,
        latest={net: label for net, label in latest.items() if label in labels},
    )
    path = _artifact_path(args, store_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialize.artifact_to_json(artifact) + "\n", encoding="utf-8")
    print(f"wrote {path}", file=sys.stderr)
    return 0


# ---------------------------------------------------------------------------
# stat
# ---------------------------------------------------------------------------


def cmd_stat(args) -> int:
    store_dir = store.resolve_store_dir(args.store_dir)
    source = Path(args.source) if args.source else store_dir / DEFAULT_ARTIFACT_NAME
    if not source.is_file():
        print(f"error: artifact not found at {source} (run sync first)", file=sys.stderr)
        return 2
    artifact = serialize.artifact_from_json(source.read_text(encoding="utf-8"))

    entry = registry.resolve(artifact.deployments, artifact.latest, args.deployment)
    if entry is None:
        choices = [e.label for e in artifact.deployments]
        choices += [f"{net} (= {label})" for net, label in sorted(artifact.latest.items())]
        print(f"select a deployment: {', '.join(choices)}", file=sys.stderr)
        return 2

    opts = view.ViewOptions(
        bucket_width=args.bucket_width,
        bucket_count=args.bucket_count,
        since=args.since,
        capacity_basis=args.capacity_basis,
        capacity_unit=args.capacity_unit,
        fiat=None if args.fiat == "none" else args.fiat,
    )
    try:
        resolved = view.resolve_view(entry, opts)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(resolved, indent=2))
    else:
        print(view.render_text(resolved))
    return 0


# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ethswarm-volumes")
    parser.add_argument("--store-dir", help="event_log cache directory (default: XDG cache)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_sync = sub.add_parser("sync", help="index to finalized and write the artifact")
    p_sync.add_argument(
        "deployment", nargs="?", help="label, network or chain:address (default: by chain)"
    )
    p_sync.add_argument(
        "--rpc",
        help="RPC endpoint (default: $<SHORT>_RPC_URL for the named deployment's chain,"
        f" e.g. $SEP_RPC_URL; ${RPC_ENV} when none is named)",
    )
    p_sync.add_argument(
        "--rpc-timeout",
        type=float,
        default=node.DEFAULT_TIMEOUT,
        help=f"per-request RPC timeout in seconds (default: {node.DEFAULT_TIMEOUT:g})",
    )
    p_sync.add_argument(
        "--progress",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="report block-range progress on stderr (default: only when stderr is a terminal)",
    )
    p_sync.add_argument("--config", help="deployment registry JSON (default: built-in fleet)")
    p_sync.add_argument(
        "--to-block",
        type=int,
        default=None,
        help="index up to this block (default: the chain's finalized head)",
    )
    p_sync.add_argument(
        "--output", help=f"artifact path (default: <store-dir>/{DEFAULT_ARTIFACT_NAME})"
    )
    p_sync.set_defaults(func=cmd_sync)

    p_stat = sub.add_parser("stat", help="render the 3-measure summary")
    p_stat.add_argument("deployment", nargs="?", help="label, network or chain:address")
    p_stat.add_argument(
        "--source", help="artifact path or URL (default: <store-dir>/artifact.json)"
    )
    p_stat.add_argument("--bucket-width", choices=("1d", "7d", "30d"), default="1d")
    p_stat.add_argument("--bucket-count", "-n", type=int, default=30)
    p_stat.add_argument("--since", help="explicit start date YYYY-MM-DD")
    p_stat.add_argument("--capacity-basis", choices=("nominal", "effective"), default="nominal")
    p_stat.add_argument("--capacity-unit", choices=("auto", "GiB", "TiB", "chunks"), default="auto")
    p_stat.add_argument("--fiat", default="none", help="fiat currency (e.g. USD) or none")
    p_stat.add_argument("--json", action="store_true", help="emit the resolved summary as JSON")
    p_stat.set_defaults(func=cmd_stat)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

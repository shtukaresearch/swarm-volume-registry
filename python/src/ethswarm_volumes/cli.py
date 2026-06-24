"""CLI entry point: ``ethswarm-volumes sync`` and ``ethswarm-volumes stat``.

Two verbs over the one data contract (``docs/ARCHITECTURE.md`` §7):

- ``sync`` — the write path. For each registry deployment on the connected chain: acquire
  logs to ``finalized``, decode them across the ``event_log`` boundary, append to the cache,
  project, bake fiat, and write/merge the single artifact file.
- ``stat`` — the read path. Load the artifact, fold one deployment per the bucket / capacity
  / fiat options, and render it as text or ``--json`` (``docs/SCHEMA.md`` §4).

The RPC endpoint defaults to ``$GNO_RPC_URL`` and is overridable with ``--rpc``. The
deployment set is the built-in registry, overridable with ``--config``
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
from .model import Artifact, Deployment

DEFAULT_ARTIFACT_NAME = "artifact.json"
RPC_ENV = "GNO_RPC_URL"


# ---------------------------------------------------------------------------
# sync
# ---------------------------------------------------------------------------


def _sync_one(w3, rpc, store_dir: Path, spec: registry.DeploymentSpec, head_block: int) -> None:
    """Sync one deployment into the cache up to ``head_block`` (the resolved head)."""
    dep_id = spec.deployment_id
    genesis_block = spec.genesis_block
    if genesis_block is None:
        genesis_block = node.find_genesis_block(w3, spec.registry)
        print(f"  discovered genesis block {genesis_block}", file=sys.stderr)

    extra = node.resolve_extra(w3, spec.registry)
    head = store.load_head(store_dir, dep_id)
    from_block = head + 1 if head is not None else genesis_block

    raw = acquire.acquire_logs(
        rpc,
        deployment_id=dep_id,
        registry=spec.registry,
        bzz_token=extra["bzz"],
        postage=extra["postage"],
        from_block=from_block,
        to_block=head_block,
    )

    if raw:
        ts_by_block = node.block_timestamps(w3, {int(log["blockNumber"]) for log in raw})
        rows = [
            decode.decode_log(
                log,
                deployment_id=dep_id,
                block_ts=ts_by_block[int(log["blockNumber"])],
                registry_version=spec.registry_version,
            )
            for log in raw
        ]
        store.append_rows(store_dir, rows)
    store.save_head(store_dir, dep_id, head_block)
    print(f"  synced [{from_block}, {head_block}] — {len(raw)} new logs", file=sys.stderr)


def _build_entry(w3, store_dir: Path, spec: registry.DeploymentSpec):
    """Project one deployment's cached log into its artifact entry."""
    dep_id = spec.deployment_id
    genesis_block = spec.genesis_block or node.find_genesis_block(w3, spec.registry)
    extra = node.resolve_extra(w3, spec.registry)

    finalized = store.load_head(store_dir, dep_id)
    as_of_ts = node.block_timestamp(w3, finalized)
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
    events = store.load_event_log(store_dir, dep_id)
    from .project import project_entry

    return project_entry(deployment, events, price_daily, as_of_block=finalized, as_of_ts=as_of_ts)


def _artifact_path(args, store_dir: Path) -> Path:
    return Path(args.output) if args.output else store_dir / DEFAULT_ARTIFACT_NAME


def _load_existing(path: Path) -> Artifact | None:
    if path.is_file():
        return serialize.artifact_from_json(path.read_text(encoding="utf-8"))
    return None


def cmd_sync(args) -> int:
    rpc_url = args.rpc or os.environ.get(RPC_ENV)
    if not rpc_url:
        print(f"error: no RPC endpoint (pass --rpc or set ${RPC_ENV})", file=sys.stderr)
        return 2

    store_dir = store.resolve_store_dir(args.store_dir)
    specs = registry.load_registry(args.config)
    w3 = node.connect(rpc_url)
    if not w3.is_connected():
        print(f"error: cannot connect to {rpc_url}", file=sys.stderr)
        return 2
    rpc = node.Web3RpcClient(w3)
    chain_id = w3.eth.chain_id
    # The head to index to: an explicit --to-block, else the reorg-safe finalized head.
    # All targets share one chain, so one resolution covers them.
    head_block = args.to_block if args.to_block is not None else rpc.finalized_block_number()

    if args.deployment:
        chosen = registry.select(specs, args.deployment)
        if chosen is None:
            print(f"error: unknown deployment {args.deployment!r}", file=sys.stderr)
            return 2
        targets = [chosen]
    else:
        targets = [s for s in specs if s.chain_id == chain_id]
        if not targets:
            print(f"error: no registry deployment on chain {chain_id}", file=sys.stderr)
            return 2

    entries = []
    for spec in targets:
        print(f"sync {spec.label} (chain {spec.chain_id})", file=sys.stderr)
        _sync_one(w3, rpc, store_dir, spec, head_block)
        entries.append(_build_entry(w3, store_dir, spec))

    # Merge into the single artifact: replace synced entries, keep the rest.
    existing = _load_existing(_artifact_path(args, store_dir))
    by_id = {
        (e.chain_id, e.registry.lower()): e for e in (existing.deployments if existing else [])
    }
    for entry in entries:
        by_id[(entry.chain_id, entry.registry.lower())] = entry

    artifact = Artifact(
        schema_version=serialize.SCHEMA_VERSION,
        generated_at=datetime.now(timezone.utc),
        deployments=list(by_id.values()),
    )
    path = _artifact_path(args, store_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialize.artifact_to_json(artifact) + "\n", encoding="utf-8")
    print(f"wrote {path}", file=sys.stderr)
    return 0


# ---------------------------------------------------------------------------
# stat
# ---------------------------------------------------------------------------


def _select_entry(artifact: Artifact, selector: str | None):
    """Resolve a ``stat`` selector against the artifact's deployment entries."""
    if selector is None:
        return artifact.deployments[0] if len(artifact.deployments) == 1 else None
    for e in artifact.deployments:
        if e.label == selector:
            return e
    for e in artifact.deployments:
        if f"{e.chain_id}:{e.registry}".lower() == selector.lower():
            return e
    return None


def cmd_stat(args) -> int:
    store_dir = store.resolve_store_dir(args.store_dir)
    source = Path(args.source) if args.source else store_dir / DEFAULT_ARTIFACT_NAME
    if not source.is_file():
        print(f"error: artifact not found at {source} (run sync first)", file=sys.stderr)
        return 2
    artifact = serialize.artifact_from_json(source.read_text(encoding="utf-8"))

    entry = _select_entry(artifact, args.deployment)
    if entry is None:
        labels = ", ".join(e.label for e in artifact.deployments)
        print(f"select a deployment: {labels}", file=sys.stderr)
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
    p_sync.add_argument("deployment", nargs="?", help="label or chain:address (default: by chain)")
    p_sync.add_argument("--rpc", help=f"RPC endpoint (default: ${RPC_ENV})")
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
    p_stat.add_argument("deployment", nargs="?", help="label or chain:address")
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

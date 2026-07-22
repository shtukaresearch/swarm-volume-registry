"""Integration-test harness: a real ``VolumeRegistry`` stack on a live node.

The contract-derived test tiers (``docs/TESTING.md``) run against a genuine chain (Anvil),
not hand-built fixtures: this module deploys the vendored ``PostageStamp`` / ``PriceOracle`` /
``TestToken`` plus a fresh ``VolumeRegistry`` (mirroring
``contracts/test/fixtures/RegistryFixture.sol``), drives a scripted, time-controlled timeline
of real transactions, and exposes:

- :class:`Web3RpcClient` — the real ``acquire.RpcClient`` the indexer uses, backed by web3,
  so tests pull logs through the production acquisition path (real ``eth_getLogs``).
- :class:`Chain` — timeline driving (``set_day`` + actions) and oracle reads
  (``getActiveVolumeCount`` / ``getActiveVolumes`` / ``getAccount`` / ``balanceOf`` at any
  historical block) used as the independent source of truth.

ABI + bytecode come from the **pinned per-version fixtures** (``tests/fixtures/<version>/``):
slim Foundry build artifacts frozen at the deployed contract release (see ``provenance.json``
there). The harness therefore tests each ``registry_version`` against the contracts actually
deployed under that version — contracts ``HEAD`` can drift without touching this suite, and
no Foundry toolchain is needed to run it (only ``anvil``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from web3 import Web3

ONE_DAY = 86400
#: Timeline genesis — a UTC midnight comfortably in the future, so warping forward from the
#: node's (real-clock) deploy blocks is always monotonic. Calendar date is irrelevant.
GENESIS = 1893456000  # 2030-01-01T00:00:00Z

_FIXTURES = Path(__file__).resolve().parent / "fixtures"

#: The registry version this harness drives. The ``Chain`` driver's function signatures and
#: oracle reads are as version-specific as the fixture bytecode, so a future version with
#: changed semantics gets its own fixture dir *and* driver variant.
REGISTRY_VERSION = "v1"

# Fixture constants mirroring RegistryFixture.sol.
MIN_BUCKET_DEPTH = 16
DEFAULT_BUCKET = 16
INITIAL_PRICE = 1000
GRACE_BLOCKS = 15
VALIDITY_BLOCKS = 12
ONE_BZZ_PLUR = 10**16  # TestToken has 16 decimals


def load_artifact(name: str, version: str = REGISTRY_VERSION) -> tuple[list, str]:
    """Return ``(abi, bytecode)`` for a contract from the pinned ``version`` fixtures."""
    doc = json.loads((_FIXTURES / version / f"{name}.json").read_text())
    return doc["abi"], doc["bytecode"]["object"]


@dataclass
class Stack:
    """Deployed contract instances + the registry deployment block."""

    bzz: Any
    stamp: Any
    oracle: Any
    registry: Any
    genesis_block: int


class Web3RpcClient:
    """The real ``acquire.RpcClient`` (``ARCHITECTURE.md`` §2), backed by web3.

    This is the production seam under test — log acquisition goes through genuine
    ``eth_getLogs`` against the node, returning the real RPC log shape to ``decode``.
    """

    def __init__(self, w3: Web3) -> None:
        self._w3 = w3

    def finalized_block_number(self) -> int:
        # Anvil finalizes instantly; latest == finalized for the harness.
        return self._w3.eth.block_number

    def get_logs(
        self, *, from_block: int, to_block: int, address: str, topics: list[Any]
    ) -> list[dict[str, Any]]:
        flt: dict[str, Any] = {"fromBlock": from_block, "toBlock": to_block}
        if address is not None:
            flt["address"] = address
        if topics is not None:
            flt["topics"] = topics
        return [dict(log) for log in self._w3.eth.get_logs(flt)]


class Chain:
    """A deployed stack on a live node: timeline driver + oracle reads."""

    def __init__(self, w3: Web3, stack: Stack) -> None:
        self.w3 = w3
        self.s = stack
        accts = w3.eth.accounts
        self.deployer = accts[0]
        self.owner = accts[1]
        self.owner_b = accts[2]
        self.payer = accts[3]
        self.payer_b = accts[4]
        self.signer = accts[5]
        self.owners: list[str] = []
        self.payers: list[str] = []
        self.volumes: dict[str, str] = {}  # label -> volumeId (hex)
        self._clock = GENESIS - 1

    # ---- timeline control ----

    def set_day(self, day_index: int) -> None:
        """Move the timeline cursor to UTC day ``day_index`` (0 == genesis day)."""
        self._clock = GENESIS + day_index * ONE_DAY

    def _send(self, fn, sender: str):
        """Mine one tx from ``sender`` at the next cursor second (one block per action).

        An explicit gas limit is set because web3's auto-estimate underestimates
        ``createVolume`` (it threads postage batch creation) and the tx would revert.
        """
        self._clock += 1
        self.w3.provider.make_request("evm_setNextBlockTimestamp", [self._clock])
        tx = fn.transact({"from": sender, "gas": 10_000_000})
        rcpt = self.w3.eth.wait_for_transaction_receipt(tx)
        assert rcpt["status"] == 1, f"transaction reverted: {fn.fn_name}"
        return rcpt

    # ---- actions (real transactions) ----

    def activate(self, owner: str, payer: str, fund_bzz: int) -> None:
        self._send(self.s.registry.functions.designateFundingWallet(payer), owner)
        self._send(self.s.registry.functions.confirmAuth(owner), payer)
        # Funding is not part of the indexed stream (mint/approve are filtered out).
        self._send(self.s.bzz.functions.mint(payer, fund_bzz), self.deployer)
        self._send(self.s.bzz.functions.approve(self.s.registry.address, 2**256 - 1), payer)
        if owner not in self.owners:
            self.owners.append(owner)
        if payer not in self.payers:
            self.payers.append(payer)

    def reauthorize(self, owner: str, payer: str) -> None:
        self._send(self.s.registry.functions.designateFundingWallet(payer), owner)
        self._send(self.s.registry.functions.confirmAuth(owner), payer)

    def create(self, label: str, owner: str, signer: str, depth: int) -> str:
        self._send(
            self.s.registry.functions.createVolume(signer, depth, DEFAULT_BUCKET, 0, False),
            owner,
        )
        # The newest volume is the last entry in the active set (appended on create).
        n = self.s.registry.functions.getActiveVolumeCount().call()
        vols = self.s.registry.functions.getActiveVolumes(0, n).call()
        vid = vols[-1][0].hex()
        self.volumes[label] = vid
        return vid

    def delete(self, label: str, owner: str) -> None:
        vid = bytes.fromhex(self.volumes[label])
        self._send(self.s.registry.functions.deleteVolume(vid), owner)

    def revoke(self, owner: str) -> None:
        self._send(self.s.registry.functions.revoke(owner), owner)

    # ---- oracle reads (independent source of truth), at a historical block ----

    def active_count(self, block: int) -> int:
        return self.s.registry.functions.getActiveVolumeCount().call(block_identifier=block)

    def active_depths(self, block: int) -> list[int]:
        n = self.active_count(block)
        if n == 0:
            return []
        vols = self.s.registry.functions.getActiveVolumes(0, n).call(block_identifier=block)
        return [v[6] for v in vols]  # VolumeView.depth is field index 6

    def authorized(self, block: int) -> int:
        return sum(
            1
            for o in self.owners
            if self.s.registry.functions.getAccount(o).call(block_identifier=block)[1]
        )

    def postage_balance(self, block: int) -> int:
        """Cumulative BZZ held by the postage contract — every fee leg lands here, so its
        increase over an interval is the fee volume (independent of event decoding, and
        unaffected by payer funding)."""
        return self.s.bzz.functions.balanceOf(self.s.stamp.address).call(block_identifier=block)

    # ---- artifact-entry identity ----

    def deployment_doc(self) -> dict[str, Any]:
        return {
            "label": "anvil",
            "chain_id": self.w3.eth.chain_id,
            "registry": self.s.registry.address,
            "registry_version": REGISTRY_VERSION,
            "genesis_ts": datetime.fromtimestamp(GENESIS, tz=timezone.utc),
            "fiat_currencies": [],
            "extra": {
                "grace_blocks": GRACE_BLOCKS,
                "postage": self.s.stamp.address,
                "price_oracle": self.s.oracle.address,
                "bzz": self.s.bzz.address,
            },
        }


# ---------------------------------------------------------------------------
# Scenarios (real timelines) + the node-state oracle for tier 2
# ---------------------------------------------------------------------------


def drive_basic(chain: Chain) -> int:
    """Day0: activate + create V1(20)/V2(22). Day3: delete V1. Returns the as_of ts.

    Exercises fee (two create legs), capacity (creates add, delete retires, empty days
    1–2 gap-filled), authorized = 1, and a partial final day.
    """
    chain.set_day(0)
    chain.activate(chain.owner, chain.payer, 10**30)
    chain.create("V1", chain.owner, chain.signer, 20)
    chain.create("V2", chain.owner, chain.signer, 22)
    chain.set_day(3)
    chain.delete("V1", chain.owner)
    return GENESIS + 4 * ONE_DAY + ONE_DAY // 2  # mid-day4


def drive_revoke_reconfirm(chain: Chain) -> int:
    """Day0: activate + create. Day1: revoke. Day2: re-confirm. Returns the as_of ts.

    Exercises non-monotonic ``authorized`` (1 -> 0 -> 1), owner counted once.
    """
    chain.set_day(0)
    chain.activate(chain.owner, chain.payer, 10**30)
    chain.create("V1", chain.owner, chain.signer, 20)
    chain.set_day(1)
    chain.revoke(chain.owner)
    chain.set_day(2)
    chain.reauthorize(chain.owner, chain.payer)
    return GENESIS + 3 * ONE_DAY + ONE_DAY // 2


@dataclass
class Oracle:
    """Per-UTC-day node-state truth + snapshot, keyed by ``YYYY-MM-DD`` (tier 2)."""

    fee_bzz: dict[str, float] = field(default_factory=dict)  # date -> BZZ forwarded that day
    cap: dict[str, tuple[int, list[int]]] = field(default_factory=dict)  # date -> (count, depths)
    authorized: dict[str, int] = field(default_factory=dict)  # date -> authorized level
    snap_active: int = 0
    snap_authorized: int = 0
    fee_total_bzz: float = 0.0
    as_of_block: int = 0


def oracle(chain: Chain, as_of_ts: int) -> Oracle:
    """Compute the independent oracle by reading node state at each UTC day-end.

    Fee per day = postage BZZ-balance delta; capacity = ``getActiveVolumeCount`` + depths;
    authorized = ``getAccount`` recount. The day-end block is the last block whose timestamp
    precedes the next UTC midnight (or ``as_of`` for the partial final day).
    """
    w3 = chain.w3
    latest = w3.eth.block_number
    g0 = chain.s.genesis_block
    ts_of = {n: w3.eth.get_block(n)["timestamp"] for n in range(g0, latest + 1)}

    out = Oracle(as_of_block=latest)
    gen_day = GENESIS // ONE_DAY
    asof_day = as_of_ts // ONE_DAY
    base = chain.postage_balance(g0)
    prev = base
    for day in range(gen_day, asof_day + 1):
        right = as_of_ts + 1 if day == asof_day else (day + 1) * ONE_DAY
        cands = [n for n, ts in ts_of.items() if ts < right]
        b = max(cands) if cands else g0
        date = datetime.fromtimestamp(day * ONE_DAY, tz=timezone.utc).strftime("%Y-%m-%d")
        cur = chain.postage_balance(b)
        out.fee_bzz[date] = (cur - prev) / ONE_BZZ_PLUR
        prev = cur
        out.cap[date] = (chain.active_count(b), chain.active_depths(b))
        out.authorized[date] = chain.authorized(b)
    out.snap_active = chain.active_count(latest)
    out.snap_authorized = chain.authorized(latest)
    out.fee_total_bzz = (chain.postage_balance(latest) - base) / ONE_BZZ_PLUR
    return out


def deploy_stack(w3: Web3) -> Stack:
    """Deploy the full stack, mirroring ``RegistryFixture.setUp`` (deployer == accounts[0])."""
    deployer = w3.eth.accounts[0]

    def _deploy(name: str, *args):
        abi, code = load_artifact(name)
        c = w3.eth.contract(abi=abi, bytecode=code)
        tx = c.constructor(*args).transact({"from": deployer})
        addr = w3.eth.wait_for_transaction_receipt(tx)["contractAddress"]
        return w3.eth.contract(address=addr, abi=abi)

    def _tx(fn):
        return w3.eth.wait_for_transaction_receipt(fn.transact({"from": deployer}))

    bzz = _deploy("TestToken", "BZZ", "BZZ", 0)
    stamp = _deploy("PostageStamp", bzz.address, MIN_BUCKET_DEPTH)
    _tx(stamp.functions.setMinimumValidityBlocks(VALIDITY_BLOCKS))
    oracle = _deploy("PriceOracle", stamp.address)
    role = stamp.functions.PRICE_ORACLE_ROLE().call()
    _tx(stamp.functions.grantRole(role, deployer))
    _tx(stamp.functions.setPrice(INITIAL_PRICE))
    registry = _deploy("VolumeRegistry", stamp.address, bzz.address, GRACE_BLOCKS)
    return Stack(bzz, stamp, oracle, registry, genesis_block=w3.eth.block_number)

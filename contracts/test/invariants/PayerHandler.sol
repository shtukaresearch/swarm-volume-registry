// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, Vm} from "forge-std/Test.sol";

import {VolumeRegistry} from "../../src/VolumeRegistry.sol";
import {PostageStamp} from "storage-incentives/src/PostageStamp.sol";
import {TestToken} from "storage-incentives/src/TestToken.sol";
import {IVolumeRegistryViews} from "../../src/interfaces/IVolumeRegistryViews.sol";

/// @notice Handler contract shared by the I3/I8/I9 invariant suites.
///
/// The handler holds a fixed set of actors (owners, payers, chunk signers)
/// and exposes a small set of public entrypoints that Foundry's invariant
/// runner calls in random order. Each entrypoint exercises one of the
/// registry's observable state transitions and records:
///   - cumulative BZZ that has moved OUT of each payer,
///   - cumulative BZZ that has been accounted to Toppedup or createVolume
///     events (the "allowed" outflow).
///
/// The two sums must stay equal at all times (I8). A similar bookkeeping
/// lens serves I9 (revoked owner → zero spend).
///
/// For I14 and volume-ID uniqueness the handler also keeps a per-owner ghost
/// nonce (count of that owner's successful creating calls) and the set of
/// issued volume IDs. `registerVolume` / `importVolume` draw from a pool of
/// batches that mixes external batches (created by the handler's signers
/// directly on Postage) with batches the registry minted.
contract PayerHandler is Test {
    VolumeRegistry public immutable registry;
    PostageStamp public immutable stamp;
    TestToken public immutable bzz;
    uint8 public immutable depth;
    uint8 public immutable bucketDepth;
    uint64 public immutable graceBlocks;

    // Actors — fixed, small set so action space stays tractable.
    address[3] public owners;
    address[3] public payers;
    address[2] public signers;
    address[3] public strangers;

    // Bookkeeping.
    mapping(address => uint256) public spentByPayer; // actual delta observed
    mapping(address => uint256) public allowedByPayer; // expected from events
    bytes32[] public createdVolumeIds;
    mapping(bytes32 => bool) public volumeExists;

    // Ghost: per-block snapshot of balances, seeded on handler construction.
    mapping(address => uint256) public snapshotBalance;

    // Ghost state for I14 / ID uniqueness.
    mapping(address => uint64) public ghostNonce; // successful creating calls per owner
    mapping(bytes32 => bytes32) public batchIdOf; // batchId recorded at creation
    bool public duplicateIdIssued;

    // Batches eligible for registerVolume / importVolume.
    bytes32[] public batchPool;
    uint256 internal constant MAX_EXTERNAL_BATCHES = 8;
    uint256 public externalBatchCount;

    constructor(
        VolumeRegistry _registry,
        PostageStamp _stamp,
        TestToken _bzz,
        uint8 _depth,
        uint8 _bucketDepth,
        uint64 _graceBlocks
    ) {
        registry = _registry;
        stamp = _stamp;
        bzz = _bzz;
        depth = _depth;
        bucketDepth = _bucketDepth;
        graceBlocks = _graceBlocks;

        for (uint256 i = 0; i < 3; ++i) {
            owners[i] = makeAddr(string(abi.encodePacked("handler_owner_", vm.toString(i))));
            payers[i] = makeAddr(string(abi.encodePacked("handler_payer_", vm.toString(i))));
            strangers[i] = makeAddr(string(abi.encodePacked("handler_stranger_", vm.toString(i))));
        }
        for (uint256 i = 0; i < 2; ++i) {
            signers[i] = makeAddr(string(abi.encodePacked("handler_signer_", vm.toString(i))));
        }

        // Seed every payer with a big stockpile + max approval to the
        // registry. Snapshot starting balance.
        for (uint256 i = 0; i < 3; ++i) {
            bzz.mint(payers[i], 1e40);
            vm.prank(payers[i]);
            bzz.approve(address(registry), type(uint256).max);
            snapshotBalance[payers[i]] = bzz.balanceOf(payers[i]);
        }

        // Seed the batch pool with one long-lived external batch per signer
        // (≈ 1000 × graceBlocks of runway, so imports of it hit NoDeficit
        // for the whole run). Thin ones are added by `mintExternalBatch`.
        uint256 thick = uint256(_stamp.lastPrice()) * _graceBlocks * 1000;
        for (uint256 i = 0; i < 2; ++i) {
            _mintExternalBatch(signers[i], thick);
        }
    }

    // ----- action space ------------------------------------------------

    function designate(uint8 ownerIdx, uint8 payerIdx) external {
        address o = owners[ownerIdx % 3];
        address p = payers[payerIdx % 3];
        vm.prank(o);
        registry.designateFundingWallet(p);
    }

    function confirm(uint8 ownerIdx, uint8 payerIdx) external {
        address o = owners[ownerIdx % 3];
        address p = payers[payerIdx % 3];
        if (registry.designated(o) != p) return;
        vm.prank(p);
        registry.confirmAuth(o);
    }

    function revoke_(uint8 ownerIdx, bool byOwner) external {
        address o = owners[ownerIdx % 3];
        IVolumeRegistryViews.Account memory a = registry.getAccount(o);
        if (a.payer == address(0)) return;
        address caller = byOwner ? o : a.payer;
        vm.prank(caller);
        registry.revoke(o);
    }

    function createVolume(uint8 ownerIdx, uint8 signerIdx) external {
        address o = owners[ownerIdx % 3];
        address s = signers[signerIdx % 2];
        IVolumeRegistryViews.Account memory a = registry.getAccount(o);
        if (!a.active) return;

        uint256 balBefore = bzz.balanceOf(a.payer);
        bytes32 expectedBatchId =
            keccak256(abi.encode(address(registry), bytes32(registry.nextNonce())));
        vm.prank(o);
        try registry.createVolume(s, depth, bucketDepth, 0, false) returns (bytes32 id) {
            _recordCreation(o, id, expectedBatchId);
            batchPool.push(expectedBatchId);

            uint256 charge = balBefore - bzz.balanceOf(a.payer);
            spentByPayer[a.payer] += charge;

            // Formula: price * grace * (1<<depth)
            uint256 expected = uint256(stamp.lastPrice()) * graceBlocks * (uint256(1) << depth);
            allowedByPayer[a.payer] += expected;
        } catch {}
    }

    /// @notice Adds a thin external batch (Postage's minimum balance, below
    ///         the registry's target) to the pool, up to a fixed cap.
    function mintExternalBatch(uint8 signerIdx) external {
        if (externalBatchCount >= MAX_EXTERNAL_BATCHES) return;
        _mintExternalBatch(signers[signerIdx % 2], stamp.minimumInitialBalancePerChunk());
    }

    function registerVolume(uint8 ownerIdx, uint8 batchIdx) external {
        address o = owners[ownerIdx % 3];
        bytes32 b = batchPool[uint256(batchIdx) % batchPool.length];
        uint256[3] memory balsBefore = _payerBalances();

        vm.prank(o);
        try registry.registerVolume(b, 0) returns (bytes32 id) {
            _recordCreation(o, id, b);
        } catch {}

        // registerVolume is charged nothing; any observed outflow is
        // unaccounted and breaks the I8 equality.
        _bookObservedOutflow(balsBefore);
    }

    function importVolume(uint8 ownerIdx, uint8 batchIdx) external {
        address o = owners[ownerIdx % 3];
        bytes32 b = batchPool[uint256(batchIdx) % batchPool.length];
        address payer = registry.getAccount(o).payer;
        uint256[3] memory balsBefore = _payerBalances();

        vm.recordLogs();
        vm.prank(o);
        try registry.importVolume(b, 0) returns (bytes32 id) {
            _recordCreation(o, id, b);
            // Charges inside importVolume surface as Toppedup events.
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bytes32 toppedupSig = keccak256("Toppedup(bytes32,uint256,uint256)");
            for (uint256 i = 0; i < logs.length; ++i) {
                if (logs[i].emitter != address(registry)) continue;
                if (logs[i].topics.length == 0 || logs[i].topics[0] != toppedupSig) continue;
                (uint256 amount,) = abi.decode(logs[i].data, (uint256, uint256));
                allowedByPayer[payer] += amount;
            }
        } catch {
            vm.getRecordedLogs(); // drain
        }

        _bookObservedOutflow(balsBefore);
    }

    function triggerOne(uint8 volIdx) external {
        if (createdVolumeIds.length == 0) return;
        bytes32 id = createdVolumeIds[uint256(volIdx) % createdVolumeIds.length];
        _triggerAndBook(id);
    }

    function triggerBatch(uint8 seed) external {
        uint256 n = createdVolumeIds.length;
        if (n == 0) return;
        uint256 k = (uint256(seed) % 3) + 1;
        if (k > n) k = n;
        bytes32[] memory ids = new bytes32[](k);
        for (uint256 i = 0; i < k; ++i) {
            ids[i] = createdVolumeIds[(uint256(seed) + i) % n];
        }
        // Snapshot every payer, call, then book per volume owner→payer.
        uint256[3] memory balsBefore;
        for (uint256 i = 0; i < 3; ++i) {
            balsBefore[i] = bzz.balanceOf(payers[i]);
        }

        vm.recordLogs();
        registry.trigger(ids);

        // Parse Toppedup logs to attribute deltas to (volumeId, payer).
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // For bookkeeping we just accept the aggregate: allowedByPayer should
        // rise by the sum of Toppedup amounts where the event's volume owner
        // resolves to that payer.
        bytes32 toppedupSig = keccak256("Toppedup(bytes32,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(registry)) continue;
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] != toppedupSig) continue;
            bytes32 vid = logs[i].topics[1];
            (uint256 amount,) = abi.decode(logs[i].data, (uint256, uint256));
            IVolumeRegistryViews.VolumeView memory v = registry.getVolume(vid);
            allowedByPayer[v.payer] += amount;
        }

        // Observed deltas.
        for (uint256 i = 0; i < 3; ++i) {
            uint256 after_ = bzz.balanceOf(payers[i]);
            if (after_ < balsBefore[i]) spentByPayer[payers[i]] += balsBefore[i] - after_;
        }
    }

    function roll(uint8 n) external {
        vm.roll(block.number + (uint256(n) % 16) + 1);
    }

    function deleteVolume(uint8 volIdx) external {
        if (createdVolumeIds.length == 0) return;
        bytes32 id = createdVolumeIds[uint256(volIdx) % createdVolumeIds.length];
        IVolumeRegistryViews.VolumeView memory v = registry.getVolume(id);
        if (v.status != IVolumeRegistryViews.Status.Active) return;
        vm.prank(v.owner);
        try registry.deleteVolume(id) {} catch {}
    }

    // Stranger-called paths. Used to confirm no-one-else-can-spend-payer.
    function strangerCalls(uint8 strangerIdx, uint8 action, uint8 volIdx) external {
        address s = strangers[strangerIdx % 3];
        if (createdVolumeIds.length == 0) return;
        bytes32 id = createdVolumeIds[uint256(volIdx) % createdVolumeIds.length];

        if (action % 4 == 0) {
            vm.prank(s);
            try registry.trigger(id) {} catch {}
        } else if (action % 4 == 1) {
            vm.prank(s);
            try registry.deleteVolume(id) {} catch {}
        } else if (action % 4 == 2) {
            vm.prank(s);
            try registry.reap(id) {} catch {}
        } else {
            vm.prank(s);
            try registry.revoke(owners[0]) {} catch {}
        }
    }

    // ----- helpers -----------------------------------------------------

    function _mintExternalBatch(address signer, uint256 perChunk) internal {
        uint256 total = perChunk << depth;
        bzz.mint(signer, total);
        vm.prank(signer);
        bzz.approve(address(stamp), total);
        bytes32 nonce = bytes32(++externalBatchCount);
        vm.prank(signer);
        bytes32 b = stamp.createBatch(signer, perChunk, depth, bucketDepth, nonce, false);
        batchPool.push(b);
    }

    /// @dev Books one successful creating call by `owner`: bumps the ghost
    ///      nonce, records the batch, and flags any reissued volume ID.
    function _recordCreation(address owner, bytes32 id, bytes32 batchId) internal {
        if (volumeExists[id]) duplicateIdIssued = true;
        volumeExists[id] = true;
        createdVolumeIds.push(id);
        batchIdOf[id] = batchId;
        ++ghostNonce[owner];
    }

    function _payerBalances() internal view returns (uint256[3] memory bals) {
        for (uint256 i = 0; i < 3; ++i) {
            bals[i] = bzz.balanceOf(payers[i]);
        }
    }

    function _bookObservedOutflow(uint256[3] memory balsBefore) internal {
        for (uint256 i = 0; i < 3; ++i) {
            uint256 after_ = bzz.balanceOf(payers[i]);
            if (after_ < balsBefore[i]) spentByPayer[payers[i]] += balsBefore[i] - after_;
        }
    }

    function _triggerAndBook(bytes32 id) internal {
        IVolumeRegistryViews.VolumeView memory v = registry.getVolume(id);
        address payer = v.payer;
        uint256 before = payer == address(0) ? 0 : bzz.balanceOf(payer);

        vm.recordLogs();
        try registry.trigger(id) {} catch {}
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 toppedupSig = keccak256("Toppedup(bytes32,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(registry)) continue;
            if (logs[i].topics.length == 0 || logs[i].topics[0] != toppedupSig) continue;
            (uint256 amount,) = abi.decode(logs[i].data, (uint256, uint256));
            allowedByPayer[payer] += amount;
        }

        if (payer != address(0)) {
            uint256 after_ = bzz.balanceOf(payer);
            if (after_ < before) spentByPayer[payer] += before - after_;
        }
    }

    function createdVolumeCount() external view returns (uint256) {
        return createdVolumeIds.length;
    }
}

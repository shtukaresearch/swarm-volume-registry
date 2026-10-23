// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Vm} from "forge-std/Test.sol";

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice `importVolume` (DESIGN §7.1, §8 outcomes; I6, I8, I10, I13;
///         ADR-0004).
///
/// `importVolume` = `registerVolume` + the §8 trigger steps in one
/// transaction. It succeeds only on ToppedUp or NoDeficit; every other
/// outcome reverts with `ImportTopupFailed`, except a Postage `topUp` revert,
/// which propagates. Every revert case asserts that nothing persists (I13).
contract VolumeImportTest is RegistryFixture {
    event VolumeImported(
        bytes32 indexed volumeId,
        address indexed owner,
        bytes32 indexed batchId,
        address chunkSigner,
        uint8 depth,
        uint64 ttlExpiry,
        uint256 normalisedBalance
    );
    event Toppedup(bytes32 indexed volumeId, uint256 amount, uint256 newNormalisedBalance);

    uint256 internal constant FUND_MULT = 20;

    /// @dev State an aborted import must leave untouched.
    struct Snapshot {
        uint64 nonce;
        bytes32 nextId;
        uint256 activeCount;
        uint256 payerBal;
        uint256 registryBal;
        uint256 stampBal;
        uint256 batchBalance;
    }

    function _target() internal view returns (uint256) {
        return uint256(stamp.lastPrice()) * GRACE_BLOCKS;
    }

    function _snapshot(address owner, address payer, bytes32 batchId)
        internal
        view
        returns (Snapshot memory s)
    {
        s.nonce = registry.getAccount(owner).nonce;
        s.nextId = _expectedVolumeId(owner, s.nonce);
        s.activeCount = registry.getActiveVolumeCount();
        s.payerBal = bzz.balanceOf(payer);
        s.registryBal = bzz.balanceOf(address(registry));
        s.stampBal = bzz.balanceOf(address(stamp));
        (,,,, s.batchBalance,) = stamp.batches(batchId);
    }

    /// @dev Calls `importVolume` as `owner`, expecting `revertData`, and
    ///      asserts I13: no record, no nonce consumed, no active-set entry,
    ///      no BZZ delta, batch balance unchanged. Events need no separate
    ///      check: the EVM discards a reverted call's logs, and
    ///      `vm.recordLogs` cannot observe that, because it also reports logs
    ///      from reverted frames.
    function _assertImportRevertsCleanly(
        address owner,
        address payer,
        bytes32 batchId,
        uint64 ttlExpiry,
        bytes memory revertData
    ) internal {
        Snapshot memory s = _snapshot(owner, payer, batchId);

        vm.prank(owner);
        vm.expectRevert(revertData);
        registry.importVolume(batchId, ttlExpiry);

        assertEq(registry.getAccount(owner).nonce, s.nonce, "nonce consumed");
        IVolumeRegistryViews.VolumeView memory v = registry.getVolume(s.nextId);
        assertEq(v.owner, address(0), "record persisted");
        assertEq(v.status, 0, "record persisted");
        assertEq(registry.getActiveVolumeCount(), s.activeCount, "active-set entry persisted");
        assertEq(bzz.balanceOf(payer), s.payerBal, "payer BZZ moved");
        assertEq(bzz.balanceOf(address(registry)), s.registryBal, "registry BZZ moved");
        assertEq(bzz.balanceOf(address(stamp)), s.stampBal, "stamp BZZ moved");
        (,,,, uint256 nb,) = stamp.batches(batchId);
        assertEq(nb, s.batchBalance, "batch balance changed");
    }

    // --- success outcomes ------------------------------------------------

    /// @dev ToppedUp outcome: VolumeImported then Toppedup in one tx, exact
    ///      formula charge, batch at target afterwards (I6 from import).
    function test_importVolume_thinBatch_topsUpToTarget() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        (,,,, uint256 nb,) = stamp.batches(batchId);
        uint256 deficit = _target() - _remaining(batchId);
        uint256 amount = deficit << DEFAULT_DEPTH;
        bytes32 expectedId = _expectedVolumeId(OWNER, 0);
        uint256 payerBefore = bzz.balanceOf(PAYER);

        vm.expectEmit(true, true, true, true);
        emit VolumeImported(expectedId, OWNER, batchId, CHUNK_SIGNER, DEFAULT_DEPTH, 0, nb);
        vm.expectEmit(true, true, true, true);
        emit Toppedup(expectedId, amount, nb + deficit);
        bytes32 id = _importDefault(OWNER, batchId);

        assertEq(id, expectedId);
        assertEq(payerBefore - bzz.balanceOf(PAYER), amount, "exact formula charge");
        assertEq(_remaining(batchId), _target(), "batch at target after import");

        IVolumeRegistryViews.VolumeView memory v = registry.getVolume(id);
        assertEq(v.owner, OWNER, "owner is the caller (I10)");
        assertEq(v.batchId, batchId);
        assertEq(v.chunkSigner, CHUNK_SIGNER);
        assertEq(v.depth, DEFAULT_DEPTH);
        assertEq(v.status, 1);
        assertEq(registry.getAccount(OWNER).nonce, 1);
        assertEq(registry.getActiveVolumeCount(), 1);
    }

    /// @dev NoDeficit outcome: batch already at target, import succeeds with
    ///      no transfer and no Toppedup.
    function test_importVolume_batchAtTarget_noTransfer() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 batchId = _createExternalBatch(CHUNK_SIGNER, DEFAULT_DEPTH, _target() * 2);
        uint256 payerBefore = bzz.balanceOf(PAYER);

        vm.recordLogs();
        bytes32 id = _importDefault(OWNER, batchId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 toppedupSig = keccak256("Toppedup(bytes32,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != toppedupSig, "unexpected Toppedup");
        }

        assertEq(bzz.balanceOf(PAYER), payerBefore);
        assertEq(registry.getVolume(id).status, 1);
        assertEq(registry.getAccount(OWNER).nonce, 1);
    }

    // --- revert outcomes (I13) -------------------------------------------

    function test_importVolume_allowanceTooLow_reverts() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        uint256 amount = (_target() - _remaining(batchId)) << DEFAULT_DEPTH;
        vm.prank(PAYER);
        bzz.approve(address(registry), amount - 1);

        _assertImportRevertsCleanly(
            OWNER,
            PAYER,
            batchId,
            0,
            abi.encodeWithSelector(IVolumeRegistryViews.ImportTopupFailed.selector)
        );
    }

    function test_importVolume_payerBalanceTooLow_reverts() public {
        _activateAccount(OWNER, PAYER, 0);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        uint256 amount = (_target() - _remaining(batchId)) << DEFAULT_DEPTH;
        bzz.mint(PAYER, amount - 1);

        _assertImportRevertsCleanly(
            OWNER,
            PAYER,
            batchId,
            0,
            abi.encodeWithSelector(IVolumeRegistryViews.ImportTopupFailed.selector)
        );
    }

    /// @dev A Postage `topUp` revert propagates unchanged.
    function test_importVolume_postagePaused_reverts() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        stamp.pause();

        _assertImportRevertsCleanly(OWNER, PAYER, batchId, 0, bytes("Pausable: paused"));
    }

    /// @dev A past TTL makes §8 end in Retired(VolumeExpired).
    function test_importVolume_pastTtl_reverts() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        vm.warp(vm.getBlockTimestamp() + 1000);

        _assertImportRevertsCleanly(
            OWNER,
            PAYER,
            batchId,
            uint64(vm.getBlockTimestamp() - 1),
            abi.encodeWithSelector(IVolumeRegistryViews.ImportTopupFailed.selector)
        );
    }

    /// @dev `ttlExpiry == block.timestamp` is already expired (§8 step 5).
    function test_importVolume_ttlNow_reverts() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 batchId = _createExternalBatch(CHUNK_SIGNER, DEFAULT_DEPTH, _target() * 2);

        _assertImportRevertsCleanly(
            OWNER,
            PAYER,
            batchId,
            uint64(block.timestamp),
            abi.encodeWithSelector(IVolumeRegistryViews.ImportTopupFailed.selector)
        );
    }

    // --- shared preconditions with registerVolume -------------------------

    function test_importVolume_inactiveAccount_reverts() public {
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        _assertImportRevertsCleanly(
            OWNER,
            PAYER,
            batchId,
            0,
            abi.encodeWithSelector(IVolumeRegistryViews.AccountNotActive.selector)
        );
    }

    function test_importVolume_missingBatch_reverts() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        _assertImportRevertsCleanly(
            OWNER,
            PAYER,
            keccak256("missing"),
            0,
            abi.encodeWithSelector(IVolumeRegistryViews.BatchNotLive.selector)
        );
    }

    function test_importVolume_expiredBatch_reverts() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        _roll(uint256(stamp.minimumValidityBlocks()));
        _assertImportRevertsCleanly(
            OWNER,
            PAYER,
            batchId,
            0,
            abi.encodeWithSelector(IVolumeRegistryViews.BatchNotLive.selector)
        );
    }
}

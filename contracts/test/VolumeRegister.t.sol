// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice `registerVolume` (DESIGN §7.1; I1, I7, I10, I11, I12; ADR-0001,
///         ADR-0002, ADR-0004).
///
/// Registration writes a volume record for an existing Postage batch and
/// moves no BZZ. `chunkSigner` and `depth` are snapshotted from Postage; the
/// caller need not be the batch owner.
contract VolumeRegisterTest is RegistryFixture {
    event VolumeImported(
        bytes32 indexed volumeId,
        address indexed owner,
        bytes32 indexed batchId,
        address chunkSigner,
        uint8 depth,
        uint64 ttlExpiry,
        uint256 normalisedBalance
    );
    event VolumeRetired(bytes32 indexed volumeId, uint8 reason);

    uint256 internal constant FUND_MULT = 20;

    function _fund() internal view returns (uint256) {
        return _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT;
    }

    /// @dev Snapshot of every field of a volume's view, for I12 comparisons.
    function _assertViewEq(
        IVolumeRegistryViews.VolumeView memory a,
        IVolumeRegistryViews.VolumeView memory b
    ) internal {
        assertEq(a.volumeId, b.volumeId);
        assertEq(a.batchId, b.batchId);
        assertEq(a.owner, b.owner);
        assertEq(a.payer, b.payer);
        assertEq(a.chunkSigner, b.chunkSigner);
        assertEq(a.createdAt, b.createdAt);
        assertEq(a.ttlExpiry, b.ttlExpiry);
        assertEq(a.depth, b.depth);
        assertEq(uint8(a.status), uint8(b.status));
        assertEq(a.accountActive, b.accountActive);
    }

    // --- happy path -----------------------------------------------------

    /// @dev Lost-key case: the batch owner (CHUNK_SIGNER) is not the caller
    ///      and plays no part in registration.
    function test_registerVolume_happy_externalBatch() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        (,,,, uint256 nb,) = stamp.batches(batchId);
        uint256 target = uint256(stamp.lastPrice()) * GRACE_BLOCKS;
        assertLt(_remaining(batchId), target, "batch must start below target");

        vm.warp(vm.getBlockTimestamp() + 1234);
        uint64 ttl = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 expectedId = _expectedVolumeId(OWNER, 0);
        uint256 payerBefore = bzz.balanceOf(PAYER);

        vm.expectEmit(true, true, true, true);
        emit VolumeImported(expectedId, OWNER, batchId, CHUNK_SIGNER, DEFAULT_DEPTH, ttl, nb);
        vm.prank(OWNER);
        bytes32 id = registry.registerVolume(batchId, ttl);

        assertEq(id, expectedId);
        IVolumeRegistryViews.VolumeView memory v = registry.getVolume(id);
        assertEq(v.volumeId, id);
        assertEq(v.batchId, batchId);
        assertEq(v.owner, OWNER, "owner is the caller (I10)");
        assertEq(v.payer, PAYER);
        assertEq(v.chunkSigner, CHUNK_SIGNER, "chunkSigner read from Postage");
        assertEq(v.depth, DEFAULT_DEPTH, "depth read from Postage");
        assertEq(v.createdAt, uint64(vm.getBlockTimestamp()));
        assertEq(v.ttlExpiry, ttl);
        assertEq(uint8(v.status), uint8(IVolumeRegistryViews.Status.Active));
        assertTrue(v.accountActive);

        assertEq(registry.getActiveVolumeCount(), 1);
        assertEq(registry.getActiveVolumes(0, 1)[0].volumeId, id);

        assertEq(bzz.balanceOf(PAYER), payerBefore, "registerVolume moved BZZ");
        assertLt(_remaining(batchId), target, "registerVolume topped up");
    }

    /// @dev Depth is snapshotted from Postage, not assumed: a batch at a
    ///      non-default depth is recorded at that depth.
    function test_registerVolume_snapshotsNonDefaultDepth() public {
        _activateAccount(OWNER, PAYER, _fund());
        uint8 depth = DEFAULT_DEPTH + 2;
        bytes32 batchId =
            _createExternalBatch(CHUNK_SIGNER, depth, stamp.minimumInitialBalancePerChunk());
        bytes32 id = _registerDefault(OWNER, batchId);
        assertEq(registry.getVolume(id).depth, depth);
    }

    // --- preconditions --------------------------------------------------

    function test_registerVolume_inactiveAccount_reverts() public {
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.AccountNotActive.selector);
        registry.registerVolume(batchId, 0);
    }

    /// @dev Account check runs first: an inactive account on a missing batch
    ///      reports AccountNotActive.
    function test_registerVolume_inactiveAccountAndMissingBatch_reportsAccount() public {
        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.AccountNotActive.selector);
        registry.registerVolume(keccak256("missing"), 0);
    }

    function test_registerVolume_missingBatch_reverts() public {
        _activateAccount(OWNER, PAYER, _fund());
        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.BatchNotLive.selector);
        registry.registerVolume(keccak256("missing"), 0);
    }

    function test_registerVolume_expiredBatch_reverts() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        _roll(uint256(stamp.minimumValidityBlocks()));
        (,,,, uint256 nb,) = stamp.batches(batchId);
        assertLe(nb, stamp.currentTotalOutPayment(), "batch should be expired");

        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.BatchNotLive.selector);
        registry.registerVolume(batchId, 0);
        assertEq(registry.getActiveVolumeCount(), 0);
    }

    /// @notice A batch at `minimumBucketDepth`, which only the admin's
    ///         `copyBatch` can make, is refused: Postage would refuse to top
    ///         it up (DESIGN §14).
    function test_registerVolume_depthAtMinimumBucketDepth_reverts() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = keccak256("copied");
        stamp.copyBatch(
            CHUNK_SIGNER, _perChunkCharge(), MIN_BUCKET_DEPTH, MIN_BUCKET_DEPTH / 2, batchId, false
        );
        vm.expectRevert(abi.encodeWithSignature("BatchTooSmall()"));
        stamp.topUp(batchId, 1);

        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.BatchDepthTooSmall.selector);
        registry.registerVolume(batchId, 0);
        assertEq(registry.getActiveVolumeCount(), 0);
    }

    // --- shared batches -------------------------------------------------

    function test_registerVolume_sameBatchTwice_distinctIds() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        bytes32 a = _registerDefault(OWNER, batchId);
        bytes32 b = _registerDefault(OWNER, batchId);

        assertTrue(a != b);
        assertEq(uint8(registry.getVolume(a).status), uint8(IVolumeRegistryViews.Status.Active));
        assertEq(uint8(registry.getVolume(b).status), uint8(IVolumeRegistryViews.Status.Active));
        assertEq(registry.getVolume(a).batchId, batchId);
        assertEq(registry.getVolume(b).batchId, batchId);
        assertEq(registry.getActiveVolumeCount(), 2);
    }

    function test_registerVolume_registryCreatedBatch_byOtherOwner() public {
        _activateAccount(OWNER, PAYER, _fund());
        _activateAccount(OWNER_B, PAYER2, _fund());
        bytes32 created = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        bytes32 batchId = _batchOf(created);

        bytes32 id = _registerDefault(OWNER_B, batchId);
        IVolumeRegistryViews.VolumeView memory v = registry.getVolume(id);
        assertEq(v.owner, OWNER_B);
        assertEq(v.batchId, batchId);
        assertEq(v.chunkSigner, CHUNK_SIGNER);
        assertEq(v.payer, PAYER2);
        assertEq(registry.getVolume(created).owner, OWNER, "original volume untouched");
    }

    // --- re-registration after retirement (I7) ---------------------------

    function _assertReRegistered(bytes32 oldId, bytes32 newId, bytes32 batchId) internal {
        assertTrue(newId != oldId, "retired ID reused");
        assertEq(
            uint8(registry.getVolume(oldId).status),
            uint8(IVolumeRegistryViews.Status.Retired),
            "old ID revived"
        );
        IVolumeRegistryViews.VolumeView memory v = registry.getVolume(newId);
        assertEq(uint8(v.status), uint8(IVolumeRegistryViews.Status.Active));
        assertEq(v.batchId, batchId);
        assertEq(v.createdAt, uint64(vm.getBlockTimestamp()), "fresh snapshot");
    }

    function test_reRegister_afterOwnerDeleted_newId() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        bytes32 oldId = _registerDefault(OWNER, batchId);
        vm.prank(OWNER);
        registry.deleteVolume(oldId);

        vm.warp(vm.getBlockTimestamp() + 10);
        bytes32 newId = _registerDefault(OWNER, batchId);
        _assertReRegistered(oldId, newId, batchId);
    }

    function test_reRegister_afterVolumeExpired_newId() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        uint64 ttl = uint64(block.timestamp + 100);
        vm.prank(OWNER);
        bytes32 oldId = registry.registerVolume(batchId, ttl);
        vm.warp(ttl);
        registry.reap(oldId);
        assertEq(
            uint8(registry.getVolume(oldId).status), uint8(IVolumeRegistryViews.Status.Retired)
        );

        bytes32 newId = _registerDefault(OWNER, batchId);
        _assertReRegistered(oldId, newId, batchId);
        assertEq(registry.getVolume(newId).ttlExpiry, 0);
    }

    function test_reRegister_afterDepthChanged_newIdAtNewDepth() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        bytes32 oldId = _registerDefault(OWNER, batchId);
        _increaseDepthAsSigner(batchId, CHUNK_SIGNER, DEFAULT_DEPTH);
        registry.trigger(oldId);
        assertEq(
            uint8(registry.getVolume(oldId).status), uint8(IVolumeRegistryViews.Status.Retired)
        );

        vm.warp(vm.getBlockTimestamp() + 10);
        bytes32 newId = _registerDefault(OWNER, batchId);
        _assertReRegistered(oldId, newId, batchId);
        assertEq(registry.getVolume(newId).depth, DEFAULT_DEPTH + 1, "snapshot of new depth");
        assertEq(registry.getVolume(oldId).depth, DEFAULT_DEPTH);
    }

    // --- I11 / I12 ------------------------------------------------------

    function test_i11_strangerRegisteringFirst_doesNotChangeOwnersNextId() public {
        _activateAccount(OWNER, PAYER, _fund());
        _activateAccount(STRANGER, PAYER2, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);

        bytes32 predicted = _expectedVolumeId(OWNER, registry.getAccount(OWNER).nonce);
        _registerDefault(STRANGER, batchId);
        _registerDefault(STRANGER, batchId);
        assertEq(registry.getAccount(OWNER).nonce, 0);

        bytes32 id = _registerDefault(OWNER, batchId);
        assertEq(id, predicted);
        assertEq(registry.getVolume(id).owner, OWNER);
    }

    function test_i12_deletingStrangersVolume_leavesOwnersRecord() public {
        _activateAccount(OWNER, PAYER, _fund());
        _activateAccount(STRANGER, PAYER2, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        bytes32 strangerId = _registerDefault(STRANGER, batchId);
        bytes32 ownerId = _registerDefault(OWNER, batchId);
        IVolumeRegistryViews.VolumeView memory before = registry.getVolume(ownerId);

        vm.prank(STRANGER);
        registry.deleteVolume(strangerId);

        _assertViewEq(registry.getVolume(ownerId), before);
        assertEq(registry.getActiveVolumeCount(), 1);
        assertEq(registry.getActiveVolumes(0, 1)[0].volumeId, ownerId);
    }

    function test_i12_retiringStrangersVolume_leavesOwnersRecord() public {
        _activateAccount(OWNER, PAYER, _fund());
        _activateAccount(STRANGER, PAYER2, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        uint64 ttl = uint64(block.timestamp + 100);
        vm.prank(STRANGER);
        bytes32 strangerId = registry.registerVolume(batchId, ttl);
        bytes32 ownerId = _registerDefault(OWNER, batchId);
        IVolumeRegistryViews.VolumeView memory before = registry.getVolume(ownerId);

        vm.warp(ttl);
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(strangerId, uint8(IVolumeRegistryViews.RetireReason.VolumeExpired));
        registry.trigger(strangerId);

        _assertViewEq(registry.getVolume(ownerId), before);
    }

    // --- Postage paused, past TTL ---------------------------------------

    function test_registerVolume_whilePostagePaused() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        stamp.pause();

        bytes32 id = _registerDefault(OWNER, batchId);
        assertEq(uint8(registry.getVolume(id).status), uint8(IVolumeRegistryViews.Status.Active));
        assertEq(registry.getVolume(id).batchId, batchId);
    }

    function test_registerVolume_pastTtl_acceptedThenRetiresOnTrigger() public {
        _activateAccount(OWNER, PAYER, _fund());
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        vm.warp(vm.getBlockTimestamp() + 1000);
        uint64 pastTtl = uint64(vm.getBlockTimestamp() - 1);

        vm.prank(OWNER);
        bytes32 id = registry.registerVolume(batchId, pastTtl);
        assertEq(uint8(registry.getVolume(id).status), uint8(IVolumeRegistryViews.Status.Active));
        assertEq(registry.getVolume(id).ttlExpiry, pastTtl);

        uint256 balBefore = bzz.balanceOf(PAYER);
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, uint8(IVolumeRegistryViews.RetireReason.VolumeExpired));
        registry.trigger(id);
        assertEq(uint8(registry.getVolume(id).status), uint8(IVolumeRegistryViews.Status.Retired));
        assertEq(bzz.balanceOf(PAYER), balBefore);
    }
}

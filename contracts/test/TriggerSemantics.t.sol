// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice Trigger semantics (DESIGN §8).
///
/// Check-order is load-bearing: batch-dead → batch-owner-mismatch → depth
/// → TTL → auth → payment. Ordering tests below pin this.
contract TriggerSemanticsTest is RegistryFixture {
    event Toppedup(bytes32 indexed volumeId, uint256 amount, uint256 newNormalisedBalance);
    event TopupSkipped(bytes32 indexed volumeId, uint8 reason);
    event VolumeRetired(bytes32 indexed volumeId, uint8 reason);

    uint64 internal constant FUND_MULT = 20;

    function _setupActiveVolume() internal returns (bytes32 id) {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        id = _createDefaultVolume(OWNER, CHUNK_SIGNER);
    }

    // -------- happy-path & idempotence ---------------------------------

    function test_trigger_happyTopup() public {
        bytes32 id = _setupActiveVolume();

        // Roll a few blocks so batch drains below target.
        _roll(5);

        uint256 price = uint256(stamp.lastPrice());
        uint256 target = price * GRACE_BLOCKS;
        (,,,, uint256 nb,) = stamp.batches(_batchOf(id));
        uint256 outpay = stamp.currentTotalOutPayment();
        uint256 remaining = nb - outpay;
        uint256 deficit = target - remaining;
        uint256 expected = deficit << DEFAULT_DEPTH;

        uint256 balBefore = bzz.balanceOf(PAYER);

        // Accept any newNormalisedBalance value in the event.
        vm.expectEmit(true, true, true, false);
        emit Toppedup(id, expected, 0);
        registry.trigger(id);

        assertEq(bzz.balanceOf(PAYER), balBefore - expected, "charge matches formula");

        // Volume still active.
        assertEq(registry.getVolume(id).status, 1);
    }

    function test_trigger_zeroDeficit_noop() public {
        bytes32 id = _setupActiveVolume();
        // Fresh volume: remaining per-chunk == target exactly. No deficit.
        uint256 balBefore = bzz.balanceOf(PAYER);
        registry.trigger(id);
        assertEq(bzz.balanceOf(PAYER), balBefore);
    }

    function test_trigger_idempotence_sameBlock() public {
        bytes32 id = _setupActiveVolume();
        _roll(5);
        registry.trigger(id); // first call: non-zero deficit → topup
        uint256 balAfterFirst = bzz.balanceOf(PAYER);
        // Second call in the same block → deficit == 0 → strict no-op.
        registry.trigger(id);
        assertEq(bzz.balanceOf(PAYER), balAfterFirst);
    }

    function test_trigger_retired_reverts() public {
        bytes32 id = _setupActiveVolume();
        vm.prank(OWNER);
        registry.deleteVolume(id);
        vm.expectRevert(IVolumeRegistryViews.VolumeNotActive.selector);
        registry.trigger(id);
    }

    // -------- skip-no-retire paths (auth / payment) --------------------

    function test_trigger_inactiveAccount_skipsNoRetire() public {
        bytes32 id = _setupActiveVolume();
        _roll(5);
        vm.prank(OWNER);
        registry.revoke(OWNER);

        uint256 balBefore = bzz.balanceOf(PAYER);
        vm.expectEmit(true, true, true, true);
        emit TopupSkipped(id, registry.SKIP_NO_AUTH());
        registry.trigger(id);
        assertEq(bzz.balanceOf(PAYER), balBefore);
        assertEq(registry.getVolume(id).status, 1);
    }

    function test_trigger_insufficientBalance_skipsNoRetire() public {
        bytes32 id = _setupActiveVolume();
        _roll(5);

        // Drain payer to 0.
        uint256 bal = bzz.balanceOf(PAYER);
        vm.prank(PAYER);
        bzz.transfer(STRANGER, bal);

        vm.expectEmit(true, true, true, true);
        emit TopupSkipped(id, registry.SKIP_PAYMENT_FAILED());
        registry.trigger(id);
        assertEq(registry.getVolume(id).status, 1);
    }

    function test_trigger_revokedAllowance_skipsNoRetire() public {
        bytes32 id = _setupActiveVolume();
        _roll(5);

        vm.prank(PAYER);
        bzz.approve(address(registry), 0);

        uint256 balBefore = bzz.balanceOf(PAYER);
        vm.expectEmit(true, true, true, true);
        emit TopupSkipped(id, registry.SKIP_PAYMENT_FAILED());
        registry.trigger(id);
        assertEq(bzz.balanceOf(PAYER), balBefore);
        assertEq(registry.getVolume(id).status, 1);
    }

    // -------- retire edges ---------------------------------------------

    function test_trigger_batchDied_retires() public {
        bytes32 id = _setupActiveVolume();
        // A batch dies when normalisedBalance <= currentTotalOutPayment.
        // With lastPrice=INITIAL_PRICE and initial normalised = outpay + perChunk,
        // outpay per block == lastPrice. Need to roll more than GRACE_BLOCKS
        // AND keep price-driven drain outstripping topups (no trigger). Roll
        // enough blocks so drain exceeds initial per-chunk deposit.
        _roll(uint256(GRACE_BLOCKS) + 1);

        // Sanity: batch.normalisedBalance <= outpay now.
        (,,,, uint256 nb,) = stamp.batches(_batchOf(id));
        assertLe(nb, stamp.currentTotalOutPayment());

        uint256 balBefore = bzz.balanceOf(PAYER);
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_BATCH_DIED());
        registry.trigger(id);
        assertEq(registry.getVolume(id).status, 2);
        assertEq(registry.getActiveVolumeCount(), 0);
        assertEq(bzz.balanceOf(PAYER), balBefore, "no charge on retire");
    }

    function test_trigger_depthChanged_retires() public {
        bytes32 id = _setupActiveVolume();

        // chunkSigner (batch owner on Postage) calls increaseDepth directly,
        // after a topup so the halved per-chunk balance clears Postage's floor.
        _increaseDepthAsSigner(_batchOf(id), CHUNK_SIGNER, DEFAULT_DEPTH);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_DEPTH_CHANGED());
        registry.trigger(id);
        assertEq(registry.getVolume(id).status, 2);
    }

    function test_trigger_ttlExpired_retires() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        uint64 ttl = uint64(block.timestamp + 100);
        bytes32 id = _createVolumeWithTtl(OWNER, CHUNK_SIGNER, ttl);

        vm.warp(ttl + 1);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_VOLUME_EXPIRED());
        registry.trigger(id);
        assertEq(registry.getVolume(id).status, 2);
    }

    // -------- ordering tests (retire beats NoAuth) ---------------------

    function test_trigger_ordering_batchDiedBeatsNoAuth() public {
        bytes32 id = _setupActiveVolume();
        // Revoke account first.
        vm.prank(OWNER);
        registry.revoke(OWNER);
        // Then let batch die by rolling blocks.
        _roll(uint256(GRACE_BLOCKS) + 1);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_BATCH_DIED());
        registry.trigger(id);
    }

    function test_trigger_ordering_depthChangedBeatsNoAuth() public {
        bytes32 id = _setupActiveVolume();

        _increaseDepthAsSigner(_batchOf(id), CHUNK_SIGNER, DEFAULT_DEPTH);

        // Revoke account.
        vm.prank(OWNER);
        registry.revoke(OWNER);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_DEPTH_CHANGED());
        registry.trigger(id);
    }

    function test_trigger_ordering_ttlExpiredBeatsNoAuth() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        uint64 ttl = uint64(block.timestamp + 100);
        bytes32 id = _createVolumeWithTtl(OWNER, CHUNK_SIGNER, ttl);

        vm.prank(OWNER);
        registry.revoke(OWNER);
        vm.warp(ttl + 1);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_VOLUME_EXPIRED());
        registry.trigger(id);
    }

    // -------- batched trigger ------------------------------------------

    function test_triggerBatch_perItemTryCatch() public {
        // 3 volumes: id1 healthy, id2 retired already, id3 revoked account.
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * 10);
        bytes32 id1 = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        bytes32 id2 = _createDefaultVolume(OWNER, CHUNK_SIGNER);

        _activateAccount(OWNER_B, PAYER2, _expectedCreateCharge(DEFAULT_DEPTH) * 10);
        bytes32 id3 = _createDefaultVolume(OWNER_B, CHUNK_SIGNER);

        // Retire id2 via deleteVolume.
        vm.prank(OWNER);
        registry.deleteVolume(id2);

        _roll(3);

        // Revoke id3's separate owner/payer pair without affecting id1.
        vm.prank(OWNER_B);
        registry.revoke(OWNER_B);

        bytes32[] memory ids = new bytes32[](3);
        ids[0] = id1;
        ids[1] = id2;
        ids[2] = id3;

        uint256 balBefore = bzz.balanceOf(PAYER);

        // Expect id3 to emit TopupSkipped(NoAuth). id2's revert is swallowed.
        // id1 emits Toppedup.
        vm.recordLogs();
        registry.trigger(ids);

        // id1 topped up (payer balance decreased).
        assertLt(bzz.balanceOf(PAYER), balBefore);
        // id2 still retired, unchanged.
        assertEq(registry.getVolume(id2).status, 2);
        // id3 still active (NoAuth never retires).
        assertEq(registry.getVolume(id3).status, 1);
    }

    // -------- reap -----------------------------------------------------

    function test_reap_idempotent() public {
        bytes32 id = _setupActiveVolume();
        vm.prank(OWNER);
        registry.deleteVolume(id);

        // No-op on already-retired volume. No events, no revert.
        vm.recordLogs();
        registry.reap(id);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_reap_retiresTtlExpiredVolume() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        uint64 ttl = uint64(block.timestamp + 50);
        bytes32 id = _createVolumeWithTtl(OWNER, CHUNK_SIGNER, ttl);

        vm.warp(ttl + 1);
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_VOLUME_EXPIRED());
        registry.reap(id);
        assertEq(registry.getVolume(id).status, 2);
    }

    // -------- trigger targets v.batchId --------------------------------

    function test_trigger_topsUpVolumeBatchId() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        bytes32 id = _registerDefault(OWNER, batchId);
        assertTrue(id != batchId);

        uint256 target = uint256(stamp.lastPrice()) * GRACE_BLOCKS;
        uint256 deficit = target - _remaining(batchId);
        (,,,, uint256 nbBefore,) = stamp.batches(batchId);

        vm.expectEmit(true, true, true, true);
        emit Toppedup(id, deficit << DEFAULT_DEPTH, nbBefore + deficit);
        registry.trigger(id);

        (,,,, uint256 nbAfter,) = stamp.batches(batchId);
        assertEq(nbAfter, nbBefore + deficit, "topup landed on the volume's batch");
        assertEq(_remaining(batchId), target);
    }

    // -------- shared batches (I5 batch level, §5) ----------------------

    function test_sharedBatch_sameBlock_onlyFirstPayerCharged() public {
        uint256 fund = _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT;
        _activateAccount(OWNER, PAYER, fund);
        _activateAccount(OWNER_B, PAYER2, fund);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        bytes32 idA = _registerDefault(OWNER, batchId);
        bytes32 idB = _registerDefault(OWNER_B, batchId);

        uint256 target = uint256(stamp.lastPrice()) * GRACE_BLOCKS;
        uint256 oneDeficit = (target - _remaining(batchId)) << DEFAULT_DEPTH;
        uint256 balA = bzz.balanceOf(PAYER);
        uint256 balB = bzz.balanceOf(PAYER2);

        registry.trigger(idA);
        registry.trigger(idB); // same block, batch already at target

        assertEq(balA - bzz.balanceOf(PAYER), oneDeficit, "first payer pays the deficit");
        assertEq(bzz.balanceOf(PAYER2), balB, "second payer charged for a shared batch");
        assertEq(_remaining(batchId), target);
        assertEq(registry.getVolume(idA).status, 1);
        assertEq(registry.getVolume(idB).status, 1);
    }

    function test_sharedBatch_depthChange_retiresEachVolume() public {
        uint256 fund = _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT;
        _activateAccount(OWNER, PAYER, fund);
        _activateAccount(OWNER_B, PAYER2, fund);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);
        bytes32 idA = _registerDefault(OWNER, batchId);
        bytes32 idB = _registerDefault(OWNER_B, batchId);

        _increaseDepthAsSigner(batchId, CHUNK_SIGNER, DEFAULT_DEPTH);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(idA, registry.REASON_DEPTH_CHANGED());
        registry.trigger(idA);
        // idB is untouched until its own trigger.
        assertEq(registry.getVolume(idB).status, 1);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(idB, registry.REASON_DEPTH_CHANGED());
        registry.trigger(idB);
        assertEq(registry.getActiveVolumeCount(), 0);
    }

    // -------- retire edges on a registered volume (I2) -----------------

    function _setupRegisteredVolume(uint64 ttlExpiry) internal returns (bytes32 id, bytes32 b) {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        b = _createThinExternalBatch(CHUNK_SIGNER);
        vm.prank(OWNER);
        id = registry.registerVolume(b, ttlExpiry);
    }

    function test_registered_ownerDeleted_retires() public {
        (bytes32 id,) = _setupRegisteredVolume(0);
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_OWNER_DELETED());
        vm.prank(OWNER);
        registry.deleteVolume(id);
        assertEq(registry.getVolume(id).status, 2);
    }

    function test_registered_batchDied_retires() public {
        (bytes32 id, bytes32 b) = _setupRegisteredVolume(0);
        // Thin batch holds minimumValidityBlocks (12) blocks of runway.
        _roll(uint256(stamp.minimumValidityBlocks()) + 1);
        (,,,, uint256 nb,) = stamp.batches(b);
        assertLe(nb, stamp.currentTotalOutPayment());

        uint256 balBefore = bzz.balanceOf(PAYER);
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_BATCH_DIED());
        registry.trigger(id);
        assertEq(registry.getVolume(id).status, 2);
        assertEq(bzz.balanceOf(PAYER), balBefore);
    }

    function test_registered_batchOwnerMismatch_retires() public {
        (bytes32 id, bytes32 b) = _setupRegisteredVolume(0);
        _forceBatchOwner(b, makeAddr("hijacker"));
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_BATCH_OWNER_MISMATCH());
        registry.trigger(id);
        assertEq(registry.getVolume(id).status, 2);
    }

    function test_registered_depthChanged_retires() public {
        (bytes32 id, bytes32 b) = _setupRegisteredVolume(0);
        _increaseDepthAsSigner(b, CHUNK_SIGNER, DEFAULT_DEPTH);
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_DEPTH_CHANGED());
        registry.trigger(id);
        assertEq(registry.getVolume(id).status, 2);
    }

    function test_registered_ttlExpired_retires() public {
        uint64 ttl = uint64(block.timestamp + 100);
        (bytes32 id,) = _setupRegisteredVolume(ttl);
        vm.warp(ttl + 1);
        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_VOLUME_EXPIRED());
        registry.trigger(id);
        assertEq(registry.getVolume(id).status, 2);
    }
}

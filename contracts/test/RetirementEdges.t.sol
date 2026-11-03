// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {StdStorage, stdStorage} from "forge-std/Test.sol";

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice Retirement edges (DESIGN §6.1, I2, I7).
contract RetirementEdgesTest is RegistryFixture {
    using stdStorage for StdStorage;

    event VolumeRetired(bytes32 indexed volumeId, uint8 reason);
    event TopupSkipped(bytes32 indexed volumeId, uint8 reason);

    uint64 internal constant FUND_MULT = 20;

    function _retiredVolume() internal returns (bytes32 id) {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        id = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        vm.prank(OWNER);
        registry.deleteVolume(id);
    }

    function test_retired_cannotBeTriggered() public {
        bytes32 id = _retiredVolume();
        vm.expectEmit(true, true, true, true);
        emit TopupSkipped(id, uint8(IVolumeRegistryViews.SkipReason.NotActive));
        registry.trigger(id);
        assertEq(uint8(registry.getVolume(id).status), uint8(IVolumeRegistryViews.Status.Retired));
    }

    function test_retired_notInActiveList() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 a = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        bytes32 b = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        vm.prank(OWNER);
        registry.deleteVolume(a);

        // Not in raw active list.
        IVolumeRegistryViews.VolumeView[] memory vs = registry.getActiveVolumes(0, 10);
        for (uint256 i = 0; i < vs.length; ++i) {
            assertTrue(vs[i].volumeId != a, "retired volume leaked into active list");
        }
        assertEq(vs.length, 1);
        assertEq(vs[0].volumeId, b);
    }

    function test_retired_deleteVolumeReverts() public {
        bytes32 id = _retiredVolume();
        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.VolumeNotActive.selector);
        registry.deleteVolume(id);
    }

    function test_retired_noTransferFromPayer() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        uint256 balAtCreate = bzz.balanceOf(PAYER);
        vm.prank(OWNER);
        registry.deleteVolume(id);

        // After retirement: no path must transfer BZZ from PAYER. We check a
        // representative sequence of caller-reachable functions.
        _roll(5);

        uint256 balBefore = bzz.balanceOf(PAYER);

        // trigger skips with NotActive.
        registry.trigger(id);

        // So does the batched trigger.
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        registry.trigger(ids);

        // reap is a no-op on retired.
        registry.reap(id);

        assertEq(bzz.balanceOf(PAYER), balBefore, "no transfer after retire");
        assertLe(bzz.balanceOf(PAYER), balAtCreate);
    }

    /// @notice I2 defensive branch: force PostageStamp.batches(id).owner !=
    ///         volume.chunkSigner via vm.store; trigger retires with
    ///         reason=BatchOwnerMismatch (DESIGN §6.1 — fifth reason).
    function test_i2_defensiveBatchOwnerMismatch() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);

        // Force batches(batchId).owner != volume.chunkSigner via direct
        // vm.store. The slot is keyed by the volume's batchId, not its
        // volumeId (DESIGN §4: the two differ).
        bytes32 batchId = _batchOf(id);
        assertTrue(batchId != id);
        address hijacker = makeAddr("hijacker");
        _forceBatchOwner(batchId, hijacker);

        // Sanity: the hijacked owner survived.
        (address bOwner,,,,,) = stamp.batches(batchId);
        assertEq(bOwner, hijacker);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, uint8(IVolumeRegistryViews.RetireReason.BatchOwnerMismatch));
        registry.trigger(id);
        assertEq(uint8(registry.getVolume(id).status), uint8(IVolumeRegistryViews.Status.Retired));
    }
}

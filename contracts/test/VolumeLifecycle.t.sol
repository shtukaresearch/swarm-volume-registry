// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice Volume lifecycle (DESIGN §7.1, I1, I10).
contract VolumeLifecycleTest is RegistryFixture {
    bytes4 internal constant LEGACY_TRANSFER_SELECTOR =
        bytes4(keccak256("transferVolumeOwnership(bytes32,address)"));

    event VolumeCreated(
        bytes32 indexed volumeId,
        address indexed owner,
        bytes32 indexed batchId,
        address chunkSigner,
        uint8 depth,
        uint64 ttlExpiry
    );
    event VolumeRetired(bytes32 indexed volumeId, uint8 reason);

    // --- createVolume ---------------------------------------------------

    function test_createVolume_happy() public {
        uint256 charge = _expectedCreateCharge(DEFAULT_DEPTH);
        _activateAccount(OWNER, PAYER, charge * 2);

        uint256 payerBalBefore = bzz.balanceOf(PAYER);
        uint256 nonce = registry.nextNonce();
        bytes32 expectedBatchId = keccak256(abi.encode(address(registry), bytes32(nonce)));
        bytes32 expectedId = _expectedVolumeId(OWNER, registry.getAccount(OWNER).nonce);

        vm.expectEmit(true, true, true, true);
        emit VolumeCreated(expectedId, OWNER, expectedBatchId, CHUNK_SIGNER, DEFAULT_DEPTH, 0);
        vm.prank(OWNER);
        bytes32 id = registry.createVolume(CHUNK_SIGNER, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);

        assertEq(id, expectedId, "volumeId formula mismatch");

        // Volume record.
        IVolumeRegistryViews.VolumeView memory v = registry.getVolume(id);
        assertEq(v.volumeId, id);
        assertEq(v.batchId, expectedBatchId);
        assertEq(v.owner, OWNER);
        assertEq(v.chunkSigner, CHUNK_SIGNER);
        assertEq(v.depth, DEFAULT_DEPTH);
        assertEq(v.ttlExpiry, 0);
        assertEq(v.status, 1); // STATUS_ACTIVE
        assertEq(v.payer, PAYER);
        assertTrue(v.accountActive);

        // In active set.
        assertEq(registry.getActiveVolumeCount(), 1);

        // BZZ transfer amount.
        assertEq(bzz.balanceOf(PAYER), payerBalBefore - charge, "payer charge exact");

        // Postage batch exists with correct owner/depth.
        (address bOwner, uint8 bDepth,,,,) = stamp.batches(expectedBatchId);
        assertEq(bOwner, CHUNK_SIGNER);
        assertEq(bDepth, DEFAULT_DEPTH);

        // Both nonces advanced.
        assertEq(registry.nextNonce(), nonce + 1);
        assertEq(registry.getAccount(OWNER).nonce, 1);
    }

    function test_createVolume_inactiveAccount_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.AccountNotActive.selector);
        registry.createVolume(CHUNK_SIGNER, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
    }

    function test_createVolume_payerInsufficientBalance_reverts() public {
        // active account, payer has less BZZ than charge
        uint256 charge = _expectedCreateCharge(DEFAULT_DEPTH);
        _activateAccount(OWNER, PAYER, charge - 1);
        vm.prank(OWNER);
        vm.expectRevert(); // ERC20: transfer amount exceeds balance
        registry.createVolume(CHUNK_SIGNER, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
    }

    function test_createVolume_payerInsufficientAllowance_reverts() public {
        uint256 charge = _expectedCreateCharge(DEFAULT_DEPTH);
        // _activateAccount approves unlimited; override to something small.
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER);
        vm.prank(PAYER);
        registry.confirmAuth(OWNER);
        bzz.mint(PAYER, charge * 2);
        vm.prank(PAYER);
        bzz.approve(address(registry), charge - 1);

        vm.prank(OWNER);
        vm.expectRevert();
        registry.createVolume(CHUNK_SIGNER, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
    }

    function test_createVolume_graceBlocksBelowPostageFloor_constructorReverts() public {
        // Floor is 12 (set in fixture); 11 must revert.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVolumeRegistryViews.GraceBlocksBelowFloor.selector, uint64(11), uint64(12)
            )
        );
        new VolumeRegistry(address(stamp), address(bzz), 11);
    }

    // --- deleteVolume ---------------------------------------------------

    function test_deleteVolume_retiresAndRemoves() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * 2);
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);

        vm.expectEmit(true, true, true, true);
        emit VolumeRetired(id, registry.REASON_OWNER_DELETED());
        vm.prank(OWNER);
        registry.deleteVolume(id);

        assertEq(registry.getVolume(id).status, 2); // STATUS_RETIRED
        assertEq(registry.getActiveVolumeCount(), 0);
    }

    function test_deleteVolume_byNonOwner_reverts() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * 2);
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);

        vm.prank(STRANGER);
        vm.expectRevert(IVolumeRegistryViews.NotVolumeOwner.selector);
        registry.deleteVolume(id);
    }

    function test_deleteVolume_alreadyRetired_reverts() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * 2);
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        vm.prank(OWNER);
        registry.deleteVolume(id);

        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.VolumeNotActive.selector);
        registry.deleteVolume(id);
    }

    // --- owner immutability (I10) --------------------------------------

    function test_ownerIsImmutable_legacyTransferSelectorReverts() public {
        uint256 charge = _expectedCreateCharge(DEFAULT_DEPTH);
        _activateAccount(OWNER, PAYER, charge * 10);
        _activateAccount(OWNER_B, PAYER2, charge * 10);
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);

        // The v1 transfer selector is absent in v2. Even the current owner
        // cannot attach the volume to another owner with an active payer.
        vm.prank(OWNER);
        (bool ok,) =
            address(registry).call(abi.encodeWithSelector(LEGACY_TRANSFER_SELECTOR, id, OWNER_B));
        assertFalse(ok, "legacy ownership transfer unexpectedly succeeded");
        assertEq(registry.getVolume(id).owner, OWNER, "volume owner changed");

        _roll(5);
        uint256 payerBalBefore = bzz.balanceOf(PAYER);
        uint256 recipientPayerBalBefore = bzz.balanceOf(PAYER2);
        registry.trigger(id);

        assertLt(bzz.balanceOf(PAYER), payerBalBefore, "original payer was not charged");
        assertEq(
            bzz.balanceOf(PAYER2),
            recipientPayerBalBefore,
            "recipient payer was charged for an unsolicited volume"
        );
    }
}

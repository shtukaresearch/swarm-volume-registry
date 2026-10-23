// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice Account state machine (DESIGN §6.2, I4), and nonce preservation
///         across account transitions (I14, ADR-0003).
contract AccountStateMachineTest is RegistryFixture {
    event PayerDesignated(address indexed owner, address payer);
    event AccountActivated(address indexed owner, address indexed payer);
    event AccountRevoked(address indexed owner, address indexed payer, address revoker);

    function test_designate_setsDesignated() public {
        vm.expectEmit(true, true, true, true);
        emit PayerDesignated(OWNER, PAYER);
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER);
        assertEq(registry.designated(OWNER), PAYER);
    }

    function test_designate_zeroClears() public {
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER);
        vm.prank(OWNER);
        registry.designateFundingWallet(address(0));
        assertEq(registry.designated(OWNER), address(0));
    }

    function test_confirmAuth_withoutDesignation_reverts() public {
        vm.prank(PAYER);
        vm.expectRevert(IVolumeRegistryViews.NotDesignated.selector);
        registry.confirmAuth(OWNER);
    }

    function test_confirmAuth_wrongDesignee_reverts() public {
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER);
        vm.prank(PAYER2);
        vm.expectRevert(IVolumeRegistryViews.NotDesignated.selector);
        registry.confirmAuth(OWNER);
    }

    function test_confirmAuth_activates() public {
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER);
        vm.expectEmit(true, true, true, true);
        emit AccountActivated(OWNER, PAYER);
        vm.prank(PAYER);
        registry.confirmAuth(OWNER);
        IVolumeRegistryViews.Account memory a = registry.getAccount(OWNER);
        assertEq(a.payer, PAYER);
        assertTrue(a.active);
    }

    function test_reconfirm_overwrites() public {
        // Start with {PAYER, true}.
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER);
        vm.prank(PAYER);
        registry.confirmAuth(OWNER);

        // Designate PAYER2, have them confirm.
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER2);
        vm.prank(PAYER2);
        registry.confirmAuth(OWNER);

        IVolumeRegistryViews.Account memory a = registry.getAccount(OWNER);
        assertEq(a.payer, PAYER2);
        assertTrue(a.active);
    }

    function test_revoke_byOwner_deactivates() public {
        _activateAccount(OWNER, PAYER, 0);
        vm.expectEmit(true, true, true, true);
        emit AccountRevoked(OWNER, PAYER, OWNER);
        vm.prank(OWNER);
        registry.revoke(OWNER);
        assertFalse(registry.getAccount(OWNER).active);
    }

    function test_revoke_byPayer_deactivates() public {
        _activateAccount(OWNER, PAYER, 0);
        vm.expectEmit(true, true, true, true);
        emit AccountRevoked(OWNER, PAYER, PAYER);
        vm.prank(PAYER);
        registry.revoke(OWNER);
        assertFalse(registry.getAccount(OWNER).active);
    }

    function test_revoke_byThirdParty_reverts() public {
        _activateAccount(OWNER, PAYER, 0);
        vm.prank(STRANGER);
        vm.expectRevert(IVolumeRegistryViews.NotAuthorizedToRevoke.selector);
        registry.revoke(OWNER);
    }

    function test_revoke_preservesPayerIdentity() public {
        _activateAccount(OWNER, PAYER, 0);
        vm.prank(OWNER);
        registry.revoke(OWNER);
        IVolumeRegistryViews.Account memory a = registry.getAccount(OWNER);
        assertEq(a.payer, PAYER, "payer identity lost on revoke");
        assertFalse(a.active);

        // Re-activation via confirmAuth should work without re-designation?
        // Per §6.2 the diagram shows revoke → ∅ (no Designated), so
        // re-activation requires a fresh designate + confirm. Verify that
        // path here.
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER);
        vm.prank(PAYER);
        registry.confirmAuth(OWNER);
        assertTrue(registry.getAccount(OWNER).active);
    }

    // --- nonce preservation (I14, ADR-0003) ----------------------------

    /// @dev Opens an account for OWNER with PAYER and makes two creating
    ///      calls, so the nonce under test is non-zero.
    function _accountWithVolumes() internal returns (uint64 nonce) {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * 10);
        _createDefaultVolume(OWNER, CHUNK_SIGNER);
        _registerDefault(OWNER, _createThinExternalBatch(CHUNK_SIGNER));
        nonce = registry.getAccount(OWNER).nonce;
        assertEq(nonce, 2);
    }

    function _assertNextIdUsesNonce(uint64 nonce) internal {
        assertEq(registry.getAccount(OWNER).nonce, nonce, "account transition changed nonce");
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        assertEq(id, _expectedVolumeId(OWNER, nonce), "next ID not derived from preserved nonce");
        assertEq(registry.getAccount(OWNER).nonce, nonce + 1);
    }

    function test_nonce_preservedOnReconfirmSamePayer() public {
        uint64 nonce = _accountWithVolumes();
        vm.prank(PAYER);
        registry.confirmAuth(OWNER);
        _assertNextIdUsesNonce(nonce);
    }

    function test_nonce_preservedOnRedesignateAndConfirmNewPayer() public {
        uint64 nonce = _accountWithVolumes();
        vm.prank(OWNER);
        registry.designateFundingWallet(PAYER2);
        assertEq(registry.getAccount(OWNER).nonce, nonce, "designate changed nonce");
        vm.prank(PAYER2);
        registry.confirmAuth(OWNER);
        assertEq(registry.getAccount(OWNER).payer, PAYER2);

        bzz.mint(PAYER2, _expectedCreateCharge(DEFAULT_DEPTH));
        vm.prank(PAYER2);
        bzz.approve(address(registry), type(uint256).max);
        _assertNextIdUsesNonce(nonce);
    }

    function test_nonce_preservedOnRevokeAndReconfirm() public {
        uint64 nonce = _accountWithVolumes();
        vm.prank(OWNER);
        registry.revoke(OWNER);
        assertEq(registry.getAccount(OWNER).nonce, nonce, "revoke changed nonce");
        vm.prank(PAYER);
        registry.confirmAuth(OWNER);
        _assertNextIdUsesNonce(nonce);
    }
}

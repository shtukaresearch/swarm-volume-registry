// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice Batch-ID and volume-ID derivation (DESIGN §4, ADR-0002), and the
///         per-owner account nonce (I14, ADR-0003).
///
/// Two counters are in play: the registry-global `nextNonce`, which salts
/// `PostageStamp.createBatch` and so fixes a minted batch's ID; and the
/// per-owner `getAccount(owner).nonce`, which every successful creating call
/// (`createVolume`, `registerVolume`, `importVolume`) consumes to derive the
/// volume ID.
contract NonceAndVolumeIdTest is RegistryFixture {
    uint256 internal constant FUND_MULT = 20;

    function _nonce(address owner) internal view returns (uint64) {
        return registry.getAccount(owner).nonce;
    }

    function test_createVolume_batchNonceIncrements() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);

        uint256 n0 = registry.nextNonce();
        bytes32 id0 = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        uint256 n1 = registry.nextNonce();
        bytes32 id1 = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        uint256 n2 = registry.nextNonce();

        assertEq(n1, n0 + 1);
        assertEq(n2, n0 + 2);

        assertEq(_batchOf(id0), keccak256(abi.encode(address(registry), bytes32(n0))));
        assertEq(_batchOf(id1), keccak256(abi.encode(address(registry), bytes32(n1))));
    }

    function test_createVolume_volumeIdFromOwnerNonce() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        uint64 n = _nonce(OWNER);
        uint256 batchNonce = registry.nextNonce();

        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);

        assertEq(id, _expectedVolumeId(OWNER, n), "volumeId = keccak(owner, accountNonce)");
        assertEq(id, keccak256(abi.encode(OWNER, uint256(n))), "uint64 encodes as one word");
        bytes32 batchId = keccak256(abi.encode(address(registry), bytes32(batchNonce)));
        assertEq(_batchOf(id), batchId);
        assertTrue(id != batchId, "volumeId must differ from batchId");
    }

    function test_accountNonce_incrementsPerCreatingCall() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        assertEq(_nonce(OWNER), 0);

        bytes32 a = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        assertEq(_nonce(OWNER), 1);
        assertEq(a, _expectedVolumeId(OWNER, 0));

        bytes32 b = _registerDefault(OWNER, _createThinExternalBatch(CHUNK_SIGNER));
        assertEq(_nonce(OWNER), 2);
        assertEq(b, _expectedVolumeId(OWNER, 1));

        bytes32 c = _importDefault(OWNER, _createThinExternalBatch(CHUNK_SIGNER));
        assertEq(_nonce(OWNER), 3);
        assertEq(c, _expectedVolumeId(OWNER, 2));
    }

    function test_accountNonce_independentPerOwner() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        _activateAccount(OWNER_B, PAYER2, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);

        _createDefaultVolume(OWNER, CHUNK_SIGNER);
        _createDefaultVolume(OWNER, CHUNK_SIGNER);
        assertEq(_nonce(OWNER), 2);
        assertEq(_nonce(OWNER_B), 0, "another owner's calls moved this nonce");

        // OWNER_B's first ID is derived from its own nonce 0 even though the
        // registry-global nextNonce has moved.
        bytes32 idB = _createDefaultVolume(OWNER_B, CHUNK_SIGNER);
        assertEq(idB, _expectedVolumeId(OWNER_B, 0));
        assertEq(_nonce(OWNER_B), 1);
        assertEq(_nonce(OWNER), 2);
    }

    function test_importVolume_revert_leavesNonceUnchanged() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        _createDefaultVolume(OWNER, CHUNK_SIGNER);
        uint64 before = _nonce(OWNER);
        bytes32 batchId = _createThinExternalBatch(CHUNK_SIGNER);

        vm.prank(PAYER);
        bzz.approve(address(registry), 0);

        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.ImportTopupFailed.selector);
        registry.importVolume(batchId, 0);

        assertEq(_nonce(OWNER), before, "reverted import consumed a nonce");
    }

    function test_registerVolume_revert_leavesNonceUnchanged() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        uint64 before = _nonce(OWNER);
        vm.prank(OWNER);
        vm.expectRevert(IVolumeRegistryViews.BatchNotLive.selector);
        registry.registerVolume(keccak256("no such batch"), 0);
        assertEq(_nonce(OWNER), before);
    }

    function test_getAccountNonce_predictsNextId() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * FUND_MULT);
        _createDefaultVolume(OWNER, CHUNK_SIGNER);
        _registerDefault(OWNER, _createThinExternalBatch(CHUNK_SIGNER));

        bytes32 predicted = _expectedVolumeId(OWNER, _nonce(OWNER));
        bytes32 actual = _importDefault(OWNER, _createThinExternalBatch(CHUNK_SIGNER));
        assertEq(actual, predicted);
    }
}

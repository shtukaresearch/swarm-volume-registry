// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {PayerHandler} from "./PayerHandler.sol";
import {PayerHandlerFixture} from "./PayerHandlerFixture.sol";

/// @notice I14 (nonce monotonicity) and volume-ID uniqueness.
///
/// The hazard is `confirmAuth` resetting the account nonce (ADR-0003): it
/// only shows under interleavings of account transitions and creating calls,
/// which the shared handler randomises. Its `confirm` action re-confirms
/// accounts that already have volumes, so a reset nonce makes the on-chain
/// nonce fall behind the handler's count of successful creating calls.
contract VolumeIdentityInvariant is PayerHandlerFixture {
    PayerHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = _deployPayerHandler();
        targetContract(address(handler));
    }

    /// @dev For every owner, the account nonce equals the number of that
    ///      owner's successful createVolume / registerVolume / importVolume
    ///      calls.
    function invariant_nonceMatchesSuccessfulCreations() public view {
        for (uint256 i = 0; i < 3; ++i) {
            address o = handler.owners(i);
            assertEq(registry.getAccount(o).nonce, handler.ghostNonce(o), "nonce drift");
        }
    }

    /// @dev No creating call ever returned an ID that was already issued.
    function invariant_volumeIdsUnique() public view {
        assertFalse(handler.duplicateIdIssued(), "volume ID issued twice");
    }
}

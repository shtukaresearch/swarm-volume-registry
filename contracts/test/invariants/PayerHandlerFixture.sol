// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {RegistryFixture} from "../fixtures/RegistryFixture.sol";
import {PayerHandler} from "./PayerHandler.sol";

/// @notice RegistryFixture plus deployment of the shared PayerHandler.
abstract contract PayerHandlerFixture is RegistryFixture {
    /// @dev PayerHandler mints BZZ in its constructor, so it needs MINTER_ROLE
    ///      before it exists. Deploy it with CREATE2 so its address follows
    ///      from the init code alone; predicting a CREATE address from
    ///      vm.getNonce is not stable across Foundry versions.
    function _deployPayerHandler() internal returns (PayerHandler h) {
        bytes32 salt = bytes32(0);
        bytes memory initCode = abi.encodePacked(
            type(PayerHandler).creationCode,
            abi.encode(registry, stamp, bzz, DEFAULT_DEPTH, DEFAULT_BUCKET, GRACE_BLOCKS)
        );
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), address(this));
        bzz.grantRole(bzz.MINTER_ROLE(), predicted);
        h = new PayerHandler{salt: salt}(
            registry, stamp, bzz, DEFAULT_DEPTH, DEFAULT_BUCKET, GRACE_BLOCKS
        );
        assertEq(address(h), predicted, "PayerHandler CREATE2 address");
    }
}

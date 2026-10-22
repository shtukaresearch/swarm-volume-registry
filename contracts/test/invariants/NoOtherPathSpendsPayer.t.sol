// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {PayerHandler} from "./PayerHandler.sol";
import {PayerHandlerFixture} from "./PayerHandlerFixture.sol";

/// @notice I8 — invariant: every BZZ delta from a payer
///         equals the sum of observed Toppedup + createVolume charges.
contract NoOtherPathSpendsPayerInvariant is PayerHandlerFixture {
    PayerHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = _deployPayerHandler();
        targetContract(address(handler));
    }

    function invariant_spentEqualsAllowedPerPayer() public view {
        for (uint256 i = 0; i < 3; ++i) {
            address p = handler.payers(i);
            uint256 spent = handler.spentByPayer(p);
            uint256 allowed = handler.allowedByPayer(p);
            assertEq(spent, allowed, "payer outflow diverged from allowed");
        }
    }
}

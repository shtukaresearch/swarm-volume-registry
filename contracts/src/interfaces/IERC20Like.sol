// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice The subset of ERC20 the registry uses on BZZ.
interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

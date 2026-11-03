// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice The OmniBridge `PermittableToken` extension the registry reads on
///         Gnosis BZZ. Not part of ERC-20; called only when the registry's
///         `bzzPermitExpiry` is set (DESIGN §10, ADR-0007).
interface IPermittableTokenLike {
    /// @notice Expiry, as a unix timestamp, of an unlimited allowance granted
    ///         by the legacy `permit`; 0 = none.
    function expirations(address owner, address spender) external view returns (uint256);
}

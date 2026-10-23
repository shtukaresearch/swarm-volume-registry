// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title IVolumeRegistryPayer
/// @notice Write functions for a payer ("funding wallet", DESIGN §2, §7.2).
///         Types, events, errors and views are in `IVolumeRegistryViews`.
/// @dev The registry spends a payer's BZZ through ERC20 `transferFrom`, so the
///      payer's allowance to the registry is its drain ceiling. `revoke` is
///      shared with `IVolumeRegistryOwner`.
interface IVolumeRegistryPayer {
    /// @notice Confirm the caller as `owner`'s payer, activating the account.
    /// @dev Requires `designated(owner) == msg.sender` (`NotDesignated`).
    ///      Overwrites any prior payer; preserves the owner's nonce. Emits
    ///      `AccountActivated`.
    function confirmAuth(address owner) external;

    /// @notice Deactivate `owner`'s account. Callable by the owner or its payer.
    /// @dev Reverts `NotAuthorizedToRevoke`. Leaves `payer`, the designation
    ///      and the nonce intact. Emits `AccountRevoked`.
    function revoke(address owner) external;
}

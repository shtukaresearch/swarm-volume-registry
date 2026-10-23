// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title IVolumeRegistryKeeper
/// @notice Write functions for a keeper (DESIGN §7.3, §11). All are
///         permissionless. Enumeration (`getActiveVolumes`,
///         `getActiveVolumeCount`), events and reason codes are in
///         `IVolumeRegistryViews`.
interface IVolumeRegistryKeeper {
    /// @notice Run the DESIGN §8 steps on one volume: retire it if Postage or
    ///         its TTL says so, otherwise top its batch up to the
    ///         `graceBlocks` target from the owner's payer.
    /// @dev Reverts `VolumeNotActive` on an unknown or Retired volume. A
    ///      `PostageStamp.topUp` revert propagates. Emits `VolumeRetired`,
    ///      `TopupSkipped` or `Toppedup`, or nothing when there is no deficit.
    function trigger(bytes32 volumeId) external;

    /// @notice `trigger` over several volumes, isolating each item: a
    ///         reverting item is skipped and the rest still run.
    /// @dev A reverted item leaves no trace in the receipt, and an item
    ///      starved of gas is indistinguishable from one that needed nothing.
    function trigger(bytes32[] calldata volumeIds) external;

    /// @notice Retire an Active volume whose TTL has passed; otherwise a no-op.
    /// @dev Does not consult Postage; `trigger` handles the batch edges.
    function reap(bytes32 volumeId) external;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title IVolumeRegistryKeeper
/// @notice Write functions for a keeper (DESIGN §7.3, §11). All are
///         permissionless. Enumeration (`getActiveVolumes`,
///         `getActiveVolumeCount`), events and reason codes are in
///         `IVolumeRegistryViews`.
/// @dev No state of a volume, account or payer makes these revert. They
///      revert only on out-of-gas, a paused PostageStamp, or a fault in the
///      registry or Postage (ADR-0007).
interface IVolumeRegistryKeeper {
    /// @notice Run the DESIGN §8 steps on one volume: retire it if Postage or
    ///         its TTL says so, otherwise top its batch up to the
    ///         `graceBlocks` target from the owner's payer.
    /// @dev Emits `VolumeRetired`, `TopupSkipped` or `Toppedup`, or nothing
    ///      when there is no deficit.
    function trigger(bytes32 volumeId) external;

    /// @notice `trigger` on each volume in order. Either every volume is
    ///         processed or the whole call reverts.
    function trigger(bytes32[] calldata volumeIds) external;

    /// @notice Retire an Active volume whose TTL has passed; otherwise a no-op.
    /// @dev Does not consult Postage; `trigger` handles the batch edges.
    function reap(bytes32 volumeId) external;
}

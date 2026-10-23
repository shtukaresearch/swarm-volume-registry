// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IVolumeRegistryViews} from "./IVolumeRegistryViews.sol";
import {IVolumeRegistryOwner} from "./IVolumeRegistryOwner.sol";
import {IVolumeRegistryPayer} from "./IVolumeRegistryPayer.sol";
import {IVolumeRegistryKeeper} from "./IVolumeRegistryKeeper.sol";

/// @title IVolumeRegistry
/// @notice The full public surface of `VolumeRegistry`: the shared read side
///         plus every actor's write functions.
interface IVolumeRegistry is
    IVolumeRegistryViews,
    IVolumeRegistryOwner,
    IVolumeRegistryPayer,
    IVolumeRegistryKeeper
{
    /// @inheritdoc IVolumeRegistryOwner
    function revoke(address owner) external override(IVolumeRegistryOwner, IVolumeRegistryPayer);
}

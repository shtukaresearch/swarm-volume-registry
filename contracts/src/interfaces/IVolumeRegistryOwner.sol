// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title IVolumeRegistryOwner
/// @notice Write functions for a volume owner (DESIGN §2, §7.1). Types,
///         events, errors and views are in `IVolumeRegistryViews`.
/// @dev `revoke` is shared with `IVolumeRegistryPayer`: either side of an
///      account may deactivate it.
interface IVolumeRegistryOwner {
    /// @notice Mint a new Postage batch and create a volume over it, charging
    ///         `graceBlocks × lastPrice × 2^depth` BZZ to the caller's payer.
    /// @dev Requires an active account (`AccountNotActive`). The caller
    ///      becomes the owner; `chunkSigner` becomes the batch owner. Emits
    ///      `VolumeCreated`.
    /// @param chunkSigner    Postage batch owner; the key that signs chunks.
    /// @param depth          Batch depth.
    /// @param bucketDepth    Batch bucket depth.
    /// @param ttlExpiry      Timestamp after which the volume retires; 0 = no expiry.
    /// @param immutableBatch Postage immutable flag.
    /// @return volumeId `keccak256(abi.encode(msg.sender, accountNonce))`.
    function createVolume(
        address chunkSigner,
        uint8 depth,
        uint8 bucketDepth,
        uint64 ttlExpiry,
        bool immutableBatch
    ) external returns (bytes32 volumeId);

    /// @notice Create a volume over an existing, live Postage batch. Moves no BZZ.
    /// @dev Requires an active account (`AccountNotActive`) and a live batch
    ///      (`BatchNotLive`), in that order. No relation between the caller
    ///      and the batch owner is required. `chunkSigner` and `depth` are
    ///      read from Postage. Emits `VolumeImported`. No survival bound holds
    ///      until the volume's first successful topup.
    /// @param batchId   The Postage batch.
    /// @param ttlExpiry Timestamp after which the volume retires; 0 = no expiry.
    /// @return volumeId `keccak256(abi.encode(msg.sender, accountNonce))`.
    function registerVolume(bytes32 batchId, uint64 ttlExpiry) external returns (bytes32 volumeId);

    /// @notice `registerVolume`, then a trigger on the new volume, atomically.
    /// @dev Succeeds only if the trigger tops the batch up or finds it already
    ///      at target; otherwise reverts `ImportTopupFailed`, or propagates a
    ///      `PostageStamp.topUp` revert. On revert nothing persists (I13).
    /// @param batchId   The Postage batch.
    /// @param ttlExpiry Timestamp after which the volume retires; 0 = no expiry.
    /// @return volumeId `keccak256(abi.encode(msg.sender, accountNonce))`.
    function importVolume(bytes32 batchId, uint64 ttlExpiry) external returns (bytes32 volumeId);

    /// @notice Retire one of the caller's Active volumes (`OwnerDeleted`).
    ///         Registry bookkeeping only: the batch is untouched.
    /// @dev Reverts `NotVolumeOwner` or `VolumeNotActive`.
    function deleteVolume(bytes32 volumeId) external;

    /// @notice Designate a payer for the caller's account; `address(0)` clears.
    /// @dev Grants nothing until the payer calls `confirmAuth(msg.sender)`.
    ///      Emits `PayerDesignated`.
    function designateFundingWallet(address payer) external;

    /// @notice Deactivate `owner`'s account. Callable by the owner or its payer.
    /// @dev Reverts `NotAuthorizedToRevoke`. Leaves `payer`, the designation
    ///      and the nonce intact. Emits `AccountRevoked`.
    function revoke(address owner) external;
}

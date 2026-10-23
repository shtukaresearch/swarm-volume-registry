// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20Like} from "./IERC20Like.sol";
import {IPostageStampLike} from "./IPostageStampLike.sol";

/// @title IVolumeRegistryViews
/// @notice The read side of `VolumeRegistry`, shared by every actor: the
///         public types, every event and error, the reason-code constants,
///         and the views. The actor interfaces (`IVolumeRegistryOwner`,
///         `IVolumeRegistryPayer`, `IVolumeRegistryKeeper`) carry only write
///         functions; an integration for one actor needs that actor's
///         interface plus this one.
/// @dev Events and errors live here rather than in the actor interfaces
///      because several are relevant to more than one actor (`VolumeRetired`
///      to owners and keepers, `AccountRevoked` to owners and payers), and
///      because a client decoding receipts or reverts wants the whole table
///      regardless of which calls it makes. See docs/DESIGN.md §7.4 and §9.
interface IVolumeRegistryViews {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice An owner's funding account (DESIGN §4, §6.2).
    /// @param payer  The confirmed payer. Retained after `revoke`.
    /// @param active Whether `trigger` and `createVolume` may charge `payer`.
    /// @param nonce  Successful creating calls by this owner; the next one
    ///               yields `volumeId = keccak256(abi.encode(owner, nonce))`.
    ///               Never reset (I14).
    struct Account {
        address payer;
        bool active;
        uint64 nonce;
    }

    /// @notice A volume record joined with its owner's account, as returned
    ///         by `getVolume` and `getActiveVolumes` (DESIGN §7.4).
    /// @param volumeId      The volume's ID.
    /// @param batchId       The underlying Postage batch.
    /// @param owner         The volume's owner; fixed at creation.
    /// @param payer         `accounts[owner].payer`, resolved at read time.
    /// @param chunkSigner   The Postage batch owner, recorded at creation.
    /// @param createdAt     Timestamp of the creating call (start of
    ///                      tracking, not batch age).
    /// @param ttlExpiry     Timestamp after which the volume retires;
    ///                      0 = no expiry.
    /// @param depth         Batch depth recorded at creation.
    /// @param status        0 = no such volume, 1 = Active, 2 = Retired.
    /// @param accountActive `accounts[owner].active`, resolved at read time.
    struct VolumeView {
        bytes32 volumeId;
        bytes32 batchId;
        address owner;
        address payer;
        address chunkSigner;
        uint64 createdAt;
        uint64 ttlExpiry;
        uint8 depth;
        uint8 status;
        bool accountActive;
    }

    // ---------------------------------------------------------------------
    // Events  (DESIGN §9)
    // ---------------------------------------------------------------------

    /// @notice A volume was created over a batch the registry minted.
    event VolumeCreated(
        bytes32 indexed volumeId,
        address indexed owner,
        bytes32 indexed batchId,
        address chunkSigner,
        uint8 depth,
        uint64 ttlExpiry
    );

    /// @notice A volume was created over an existing batch by
    ///         `registerVolume` or `importVolume`.
    /// @param normalisedBalance The batch's balance as read at registration,
    ///                          before any topup.
    event VolumeImported(
        bytes32 indexed volumeId,
        address indexed owner,
        bytes32 indexed batchId,
        address chunkSigner,
        uint8 depth,
        uint64 ttlExpiry,
        uint256 normalisedBalance
    );

    /// @notice A volume entered the terminal Retired state.
    /// @param reason One of the `REASON_*` codes.
    event VolumeRetired(bytes32 indexed volumeId, uint8 reason);

    /// @notice An owner set (or, with `payer == 0`, cleared) its designated payer.
    event PayerDesignated(address indexed owner, address payer);

    /// @notice A designated payer confirmed an owner; the account is active.
    event AccountActivated(address indexed owner, address indexed payer);

    /// @notice An account was deactivated by its owner or its payer.
    event AccountRevoked(address indexed owner, address indexed payer, address revoker);

    /// @notice A trigger topped a volume's batch up to the `graceBlocks` target.
    /// @param amount               BZZ pulled from the payer.
    /// @param newNormalisedBalance The batch's normalised balance after the topup.
    event Toppedup(bytes32 indexed volumeId, uint256 amount, uint256 newNormalisedBalance);

    /// @notice A trigger found a deficit but did not pay it.
    /// @param reason One of the `SKIP_*` codes.
    event TopupSkipped(bytes32 indexed volumeId, uint8 reason);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice A constructor argument was the zero address.
    error ZeroAddress();
    /// @notice Constructor `graceBlocks` is below Postage's `minimumValidityBlocks`.
    error GraceBlocksBelowFloor(uint64 grace, uint64 floor_);
    /// @notice The caller's account is not active.
    error AccountNotActive();
    /// @notice The caller does not own the volume.
    error NotVolumeOwner();
    /// @notice The volume does not exist or is Retired.
    error VolumeNotActive();
    /// @notice The caller is not the owner's designated payer.
    error NotDesignated();
    /// @notice The caller is neither the owner nor the account's payer.
    error NotAuthorizedToRevoke();
    /// @notice Declared but never thrown (see contracts/test/README.md,
    ///         coverage gaps).
    error DesignationClearedOnActivate();
    /// @notice The batch does not exist, or its balance is exhausted.
    error BatchNotLive();
    /// @notice `importVolume`'s topup neither went through nor was unnecessary.
    error ImportTopupFailed();

    // ---------------------------------------------------------------------
    // Constants  (reason codes)
    // ---------------------------------------------------------------------

    /// @notice `VolumeRetired.reason`: the owner called `deleteVolume`.
    function REASON_OWNER_DELETED() external view returns (uint8);
    /// @notice `VolumeRetired.reason`: `ttlExpiry` passed.
    function REASON_VOLUME_EXPIRED() external view returns (uint8);
    /// @notice `VolumeRetired.reason`: Postage reports the batch missing or expired.
    function REASON_BATCH_DIED() external view returns (uint8);
    /// @notice `VolumeRetired.reason`: Postage reports a depth other than `depth`.
    function REASON_DEPTH_CHANGED() external view returns (uint8);
    /// @notice `VolumeRetired.reason`: Postage reports an owner other than
    ///         `chunkSigner`. Defensive (I2).
    function REASON_BATCH_OWNER_MISMATCH() external view returns (uint8);
    /// @notice `TopupSkipped.reason`: the owner's account is not active.
    function SKIP_NO_AUTH() external view returns (uint8);
    /// @notice `TopupSkipped.reason`: pulling BZZ from the payer failed.
    function SKIP_PAYMENT_FAILED() external view returns (uint8);

    // ---------------------------------------------------------------------
    // Wiring  (DESIGN §10, immutable)
    // ---------------------------------------------------------------------

    /// @notice The `PostageStamp` contract this registry manages batches on.
    function postage() external view returns (IPostageStampLike);
    /// @notice The BZZ token.
    function bzz() external view returns (IERC20Like);
    /// @notice Runway, in blocks, charged at creation and restored by `trigger`.
    function graceBlocks() external view returns (uint64);

    // ---------------------------------------------------------------------
    // Views  (DESIGN §7.4)
    // ---------------------------------------------------------------------

    /// @notice One volume. An unknown ID returns a zeroed view with `status == 0`.
    function getVolume(bytes32 volumeId) external view returns (VolumeView memory);

    /// @notice A page of the active set, in index order. The keeper's
    ///         primary read.
    function getActiveVolumes(uint256 offset, uint256 limit)
        external
        view
        returns (VolumeView[] memory);

    /// @notice Size of the active set.
    function getActiveVolumeCount() external view returns (uint256);

    /// @notice An owner's account, including the nonce that determines its
    ///         next volume ID (provided its transactions land in order).
    function getAccount(address owner) external view returns (Account memory);

    /// @notice The payer `owner` has designated (pre-confirmation); 0 if none.
    function designated(address owner) external view returns (address);

    /// @notice Counter salting the next batch minted by `createVolume`.
    ///         Unrelated to the per-owner volume-ID nonce.
    function nextNonce() external view returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20Like} from "./interfaces/IERC20Like.sol";
import {IPermittableTokenLike} from "./interfaces/IPermittableTokenLike.sol";
import {IPostageStampLike} from "./interfaces/IPostageStampLike.sol";
import {IVolumeRegistry} from "./interfaces/IVolumeRegistry.sol";

/// @title VolumeRegistry
/// @notice Volume-lifecycle layer over Swarm postage-stamp batches.
/// @dev See docs/DESIGN.md for the full specification. Highlights:
///        - two-role model (owner / payer), bilateral auth (I4);
///        - `graceBlocks` is immutable global (§10);
///        - `volumeId = keccak256(abi.encode(owner, accounts[owner].nonce))`,
///          one per-owner nonce consumed by every successful creating call
///          (`createVolume` / `registerVolume` / `importVolume`) and never
///          reset (§4, I14);
///        - a volume records its `batchId`; minted batches are
///          `keccak256(abi.encode(address(this), nextNonce))`, imported ones
///          keep their Postage ID; one batch may back many volumes (§4);
///        - trigger check-order is: status → batch-dead → owner-mismatch
///          → depth-changed → TTL-expired → auth → payment (§8);
///        - retire beats auth-skip; payment-failure does not retire;
///        - keeper calls revert only on out-of-gas, a paused Postage, or a
///          fault; payer state is prechecked, never caught (ADR-0007);
///        - `importVolume` = register + trigger, atomic: it keeps only the
///          ToppedUp / NoDeficit outcomes and reverts otherwise (I13).
contract VolumeRegistry is IVolumeRegistry {
    // ---------------------------------------------------------------------
    // Enums  (public Status / RetireReason / SkipReason are declared in
    // IVolumeRegistryViews)
    // ---------------------------------------------------------------------

    // Outcome of one run of the §8 trigger steps. `trigger` treats all four
    // as success; `importVolume` keeps only NoDeficit and ToppedUp.
    enum TriggerOutcome {
        Retired, // steps 2–5
        Skipped, // steps 1, 6, 8
        NoDeficit, // step 7
        ToppedUp // step 9
    }

    // ---------------------------------------------------------------------
    // Types  (public `Account` / `VolumeView`, events and errors are
    // declared in IVolumeRegistryViews)
    // ---------------------------------------------------------------------

    struct Volume {
        address owner; // fixed at create; v2 has no ownership-transfer path
        address chunkSigner; // Postage batch owner, snapshotted at create
        bytes32 batchId; // underlying Postage batch; immutable
        uint64 createdAt; // start of tracking, not batch age
        uint64 ttlExpiry; // 0 = no expiry
        uint8 depth;
        Status status;
        uint32 activeIndex;
    }

    // ---------------------------------------------------------------------
    // Immutable wiring
    // ---------------------------------------------------------------------

    IPostageStampLike public immutable postage;
    IERC20Like public immutable bzz;
    uint64 public immutable graceBlocks;
    bool public immutable bzzPermitExpiry;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 => Volume) internal _volumes;
    mapping(address => address) public designated; // owner → chosen payer (pre-confirmation)
    mapping(address => Account) internal _accounts;

    bytes32[] internal _activeVolumeIds;
    uint256 public nextNonce; // salts Postage.createBatch; not the volume-ID nonce

    // ---------------------------------------------------------------------
    // Constructor  (DESIGN §10)
    // ---------------------------------------------------------------------

    constructor(address _postage, address _bzz, uint64 _graceBlocks, bool _bzzPermitExpiry) {
        if (_postage == address(0) || _bzz == address(0)) revert ZeroAddress();
        uint64 floor_ = IPostageStampLike(_postage).minimumValidityBlocks();
        if (_graceBlocks < floor_) revert GraceBlocksBelowFloor(_graceBlocks, floor_);
        // Uncaught: a token without `expirations` fails the deployment here
        // rather than every topup later.
        if (_bzzPermitExpiry) IPermittableTokenLike(_bzz).expirations(address(0), address(0));

        postage = IPostageStampLike(_postage);
        bzz = IERC20Like(_bzz);
        graceBlocks = _graceBlocks;
        bzzPermitExpiry = _bzzPermitExpiry;
    }

    // =====================================================================
    // Account API  (§7.1, §7.2)
    // =====================================================================

    /// @notice Owner designates a payer candidate. Pass `address(0)` to clear.
    /// @dev Unilateral — does not grant any spend permission until the payer
    ///      confirms via `confirmAuth(msg.sender)`.
    function designateFundingWallet(address payer) external {
        designated[msg.sender] = payer;
        emit PayerDesignated(msg.sender, payer);
    }

    /// @notice Payer confirms a previously-designated owner→payer pairing.
    ///         Overwrites `payer` and `active` of any prior account; the
    ///         owner's `nonce` is preserved.
    /// @dev Fields are written individually, never as a struct literal: a
    ///      reset nonce would make the owner's next volume ID collide with
    ///      one already issued (I14, ADR-0003).
    function confirmAuth(address owner) external {
        if (designated[owner] != msg.sender) revert NotDesignated();
        Account storage acct = _accounts[owner];
        acct.payer = msg.sender;
        acct.active = true;
        emit AccountActivated(owner, msg.sender);
    }

    /// @notice Revoke an account. Callable by the owner or the confirmed payer.
    ///         Only flips `active`; leaves `payer` intact for possible
    ///         re-activation via a later `confirmAuth`.
    function revoke(address owner) external {
        Account storage acct = _accounts[owner];
        if (msg.sender != owner && msg.sender != acct.payer) revert NotAuthorizedToRevoke();
        address payer = acct.payer;
        acct.active = false;
        emit AccountRevoked(owner, payer, msg.sender);
    }

    /// @notice Full account record, including `nonce`: the next creating
    ///         call by `owner` yields `keccak256(abi.encode(owner, nonce))`,
    ///         provided `owner`'s transactions land in order.
    function getAccount(address owner) external view returns (Account memory) {
        return _accounts[owner];
    }

    // =====================================================================
    // Volume lifecycle  (§7.1)
    // =====================================================================

    function createVolume(
        address chunkSigner,
        uint8 depth,
        uint8 bucketDepth,
        uint64 ttlExpiry,
        bool immutableBatch
    ) external returns (bytes32 volumeId) {
        Account storage acct = _accounts[msg.sender];
        if (!acct.active) revert AccountNotActive();
        if (chunkSigner == address(0)) revert ZeroAddress();

        // Initial per-chunk balance is contract-computed.
        uint256 currentPrice = uint256(postage.lastPrice());
        uint256 perChunk = currentPrice * uint256(graceBlocks);
        uint256 totalCharge = perChunk << depth;

        address payer = acct.payer;

        // Pull BZZ from payer → registry. Both `transferFrom`s and
        // `createBatch` live in the same transaction; any failure reverts
        // atomically and leaves no state change.
        require(bzz.transferFrom(payer, address(this), totalCharge), "BZZ_TRANSFER_FAIL");
        // Approve PostageStamp exactly once per call; leaves no lingering
        // allowance once createBatch consumes it.
        require(bzz.approve(address(postage), totalCharge), "BZZ_APPROVE_FAIL");

        bytes32 nonce = bytes32(nextNonce);
        unchecked {
            ++nextNonce;
        }
        bytes32 batchId =
            postage.createBatch(chunkSigner, perChunk, depth, bucketDepth, nonce, immutableBatch);
        // Sanity — PostageStamp derives the same way, so this equality is
        // mechanical; kept as a defensive assertion against upstream drift.
        require(batchId == keccak256(abi.encode(address(this), nonce)), "BATCHID_MISMATCH");

        volumeId = _recordVolume(acct, batchId, chunkSigner, depth, ttlExpiry);
        emit VolumeCreated(volumeId, msg.sender, batchId, chunkSigner, depth, ttlExpiry);
    }

    /// @notice Bring an existing, live Postage batch under management. Moves
    ///         no BZZ.
    /// @dev Preconditions, in order: active account (`AccountNotActive`),
    ///      live batch (`BatchNotLive`), depth above Postage's
    ///      `minimumBucketDepth` (`BatchDepthTooSmall`). No relation between the caller and
    ///      the batch owner is required (ADR-0001). `chunkSigner` and `depth`
    ///      are read from Postage. A past `ttlExpiry` is accepted; the volume
    ///      retires `VolumeExpired` on its first trigger. No survival bound
    ///      (I6) holds until the first successful topup.
    function registerVolume(bytes32 batchId, uint64 ttlExpiry) external returns (bytes32 volumeId) {
        volumeId = _registerVolume(batchId, ttlExpiry);
    }

    /// @notice `registerVolume`, then the §8 trigger steps on the new volume,
    ///         in one transaction.
    /// @dev Succeeds only if §8 ends in ToppedUp or NoDeficit; any other
    ///      outcome reverts `ImportTopupFailed`, and a `PostageStamp.topUp`
    ///      revert propagates. On revert nothing persists (I13). NoAuth is
    ///      unreachable: `_registerVolume` has just checked the account.
    function importVolume(bytes32 batchId, uint64 ttlExpiry) external returns (bytes32 volumeId) {
        volumeId = _registerVolume(batchId, ttlExpiry);
        TriggerOutcome outcome = _triggerOne(volumeId);
        if (outcome != TriggerOutcome.ToppedUp && outcome != TriggerOutcome.NoDeficit) {
            revert ImportTopupFailed();
        }
    }

    function deleteVolume(bytes32 volumeId) external {
        Volume storage v = _volumes[volumeId];
        if (v.owner != msg.sender) revert NotVolumeOwner();
        if (v.status != Status.Active) revert VolumeNotActive();
        _retire(volumeId, RetireReason.OwnerDeleted);
    }

    // =====================================================================
    // Keeper API  (§7.3, §8)
    // =====================================================================

    function trigger(bytes32 volumeId) external {
        _triggerOne(volumeId);
    }

    /// @notice Batched trigger. No item-level state reverts (ADR-0007), so
    ///         the loop needs no isolation: a revert here is out-of-gas, a
    ///         paused Postage or a fault, and rolls back the whole batch.
    function trigger(bytes32[] calldata volumeIds) external {
        uint256 n = volumeIds.length;
        for (uint256 i = 0; i < n; ++i) {
            _triggerOne(volumeIds[i]);
        }
    }

    /// @notice Retire an Active volume whose TTL has passed. No-op on an
    ///         already-retired volume. Mostly unnecessary; trigger() handles
    ///         this edge too.
    function reap(bytes32 volumeId) external {
        Volume storage v = _volumes[volumeId];
        if (v.status != Status.Active) return; // idempotent
        if (v.ttlExpiry != 0 && block.timestamp >= v.ttlExpiry) {
            _retire(volumeId, RetireReason.VolumeExpired);
        }
    }

    /// @dev Runs the §8 steps once and reports which of the four outcomes
    ///      they ended in. Events and reverts are identical whichever caller
    ///      consumes the outcome.
    function _triggerOne(bytes32 volumeId) internal returns (TriggerOutcome) {
        Volume storage v = _volumes[volumeId];
        bytes32 batchId = v.batchId;
        // Step 1 — volume must be Active. An unknown ID is told apart from a
        // retired one: the first is a fault in the keeper's input, the second
        // an ordinary race with retirement.
        Status status = v.status;
        if (status != Status.Active) {
            emit TopupSkipped(
                volumeId, status == Status.None ? SkipReason.NotFound : SkipReason.NotActive
            );
            return TriggerOutcome.Skipped;
        }

        // Step 2 — read Postage batch.
        (
            address bOwner,
            uint8 bDepth,, // bucketDepth
            , // immutableFlag
            uint256 bNormalisedBalance,
        ) = postage.batches(batchId);

        uint256 outpayment = postage.currentTotalOutPayment();
        bool batchMissing = (bOwner == address(0));
        bool batchExpired = !batchMissing && (bNormalisedBalance <= outpayment);
        if (batchMissing || batchExpired) {
            _retire(volumeId, RetireReason.BatchDied);
            return TriggerOutcome.Retired;
        }

        // Step 2b — owner mismatch (defensive; I2).
        if (bOwner != v.chunkSigner) {
            _retire(volumeId, RetireReason.BatchOwnerMismatch);
            return TriggerOutcome.Retired;
        }

        // Step 3 — depth mismatch.
        if (bDepth != v.depth) {
            _retire(volumeId, RetireReason.DepthChanged);
            return TriggerOutcome.Retired;
        }

        // Step 4 — TTL.
        if (v.ttlExpiry != 0 && block.timestamp >= v.ttlExpiry) {
            _retire(volumeId, RetireReason.VolumeExpired);
            return TriggerOutcome.Retired;
        }

        // Step 5 — auth. After this point, every retire-edge has been
        // checked; a revoked account only prevents payment, never retires.
        Account storage acct = _accounts[v.owner];
        if (!acct.active) {
            emit TopupSkipped(volumeId, SkipReason.NoAuth);
            return TriggerOutcome.Skipped;
        }

        // Step 6 — compute deficit. remaining = normalised − outpayment.
        uint256 remaining = bNormalisedBalance - outpayment; // strictly positive (expired caught above)
        uint256 currentPrice = uint256(postage.lastPrice());
        uint256 target = currentPrice * uint256(graceBlocks);
        if (remaining >= target) {
            // I5 idempotence: zero-deficit is a silent no-op.
            return TriggerOutcome.NoDeficit;
        }
        uint256 deficit = target - remaining;
        uint256 amount = deficit << v.depth;

        // Step 7 — pull BZZ. A payer that cannot pay is skipped, not retired.
        // Its state is read beforehand because Gnosis BZZ reports these
        // failures with empty revert data, indistinguishable from out-of-gas
        // (ADR-0007); once the precheck passes, a failed pull is a fault.
        address payer = acct.payer;
        if (!_canPull(payer, amount)) {
            emit TopupSkipped(volumeId, SkipReason.PaymentFailed);
            return TriggerOutcome.Skipped;
        }
        require(bzz.transferFrom(payer, address(this), amount), "BZZ_TRANSFER_FAIL");

        // Step 8 — approve & topUp. A revert here (e.g. Postage paused)
        // propagates.
        require(bzz.approve(address(postage), amount), "BZZ_APPROVE_FAIL");
        postage.topUp(batchId, deficit);

        // `topUp` adds exactly `deficit` to the batch's normalised balance.
        emit Toppedup(volumeId, amount, bNormalisedBalance + deficit);
        return TriggerOutcome.ToppedUp;
    }

    /// @dev Whether `bzz.transferFrom(payer, this, amount)` would succeed,
    ///      judged from the payer's balance, its allowance to the registry
    ///      and, on a token with `bzzPermitExpiry`, the expiry an unlimited
    ///      allowance from the legacy `permit` carries (`allowance()` does
    ///      not reflect it).
    function _canPull(address payer, uint256 amount) internal view returns (bool) {
        if (bzz.balanceOf(payer) < amount) return false;
        uint256 allowed = bzz.allowance(payer, address(this));
        if (allowed < amount) return false;
        if (bzzPermitExpiry && allowed == type(uint256).max) {
            uint256 expiry = IPermittableTokenLike(address(bzz)).expirations(payer, address(this));
            if (expiry != 0 && expiry < block.timestamp) return false;
        }
        return true;
    }

    // =====================================================================
    // Views  (§7.4)
    // =====================================================================

    function getVolume(bytes32 volumeId) external view returns (VolumeView memory) {
        Volume storage v = _volumes[volumeId];
        Account storage acct = _accounts[v.owner];
        return VolumeView({
            volumeId: volumeId,
            batchId: v.batchId,
            owner: v.owner,
            payer: acct.payer,
            chunkSigner: v.chunkSigner,
            createdAt: v.createdAt,
            ttlExpiry: v.ttlExpiry,
            depth: v.depth,
            status: v.status,
            accountActive: acct.active
        });
    }

    function getActiveVolumeCount() external view returns (uint256) {
        return _activeVolumeIds.length;
    }

    function getActiveVolumes(uint256 offset, uint256 limit)
        external
        view
        returns (VolumeView[] memory out)
    {
        uint256 n = _activeVolumeIds.length;
        if (offset >= n) return new VolumeView[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        uint256 len = end - offset;
        out = new VolumeView[](len);
        for (uint256 i = 0; i < len; ++i) {
            bytes32 id = _activeVolumeIds[offset + i];
            Volume storage v = _volumes[id];
            Account storage acct = _accounts[v.owner];
            out[i] = VolumeView({
                volumeId: id,
                batchId: v.batchId,
                owner: v.owner,
                payer: acct.payer,
                chunkSigner: v.chunkSigner,
                createdAt: v.createdAt,
                ttlExpiry: v.ttlExpiry,
                depth: v.depth,
                status: v.status,
                accountActive: acct.active
            });
        }
    }

    // =====================================================================
    // Internals
    // =====================================================================

    /// @dev Shared body of `registerVolume` / `importVolume`: checks the
    ///      preconditions, snapshots `chunkSigner` / `depth` from Postage,
    ///      writes the record and emits `VolumeImported`.
    function _registerVolume(bytes32 batchId, uint64 ttlExpiry)
        internal
        returns (bytes32 volumeId)
    {
        Account storage acct = _accounts[msg.sender];
        if (!acct.active) revert AccountNotActive();

        (
            address bOwner,
            uint8 bDepth,, // bucketDepth
            , // immutableFlag
            uint256 bNormalisedBalance,
        ) = postage.batches(batchId);
        // Same liveness test as §8 step 2.
        if (bOwner == address(0) || bNormalisedBalance <= postage.currentTotalOutPayment()) {
            revert BatchNotLive();
        }
        // Postage's `topUp` refuses such a batch; only `copyBatch` makes one.
        if (bDepth <= postage.minimumBucketDepth()) revert BatchDepthTooSmall();

        volumeId = _recordVolume(acct, batchId, bOwner, bDepth, ttlExpiry);
        emit VolumeImported(
            volumeId, msg.sender, batchId, bOwner, bDepth, ttlExpiry, bNormalisedBalance
        );
    }

    /// @dev The one record-writing path for all three creating calls.
    ///      Derives `volumeId` from the caller's pre-increment account nonce,
    ///      consumes the nonce, writes an Active record owned by
    ///      `msg.sender`, and appends it to the active set.
    function _recordVolume(
        Account storage acct,
        bytes32 batchId,
        address chunkSigner,
        uint8 depth,
        uint64 ttlExpiry
    ) internal returns (bytes32 volumeId) {
        uint64 n = acct.nonce;
        volumeId = keccak256(abi.encode(msg.sender, n));
        unchecked {
            acct.nonce = n + 1;
        }
        // Unreachable short of a hash collision or a nonce reset; kept as a
        // defensive assertion so an existing record is never overwritten.
        require(_volumes[volumeId].status == Status.None, "VOLUMEID_COLLISION");

        uint32 idx = uint32(_activeVolumeIds.length);
        _volumes[volumeId] = Volume({
            owner: msg.sender,
            chunkSigner: chunkSigner,
            batchId: batchId,
            createdAt: uint64(block.timestamp),
            ttlExpiry: ttlExpiry,
            depth: depth,
            status: Status.Active,
            activeIndex: idx
        });
        _activeVolumeIds.push(volumeId);
    }

    function _retire(bytes32 volumeId, RetireReason reason) internal {
        Volume storage v = _volumes[volumeId];
        v.status = Status.Retired;

        // swap-and-pop active list
        uint32 idx = v.activeIndex;
        uint256 last = _activeVolumeIds.length - 1;
        if (uint256(idx) != last) {
            bytes32 lastId = _activeVolumeIds[last];
            _activeVolumeIds[idx] = lastId;
            _volumes[lastId].activeIndex = idx;
        }
        _activeVolumeIds.pop();
        v.activeIndex = 0;

        emit VolumeRetired(volumeId, reason);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";

import {PostageStamp} from "storage-incentives/src/PostageStamp.sol";
import {PriceOracle} from "storage-incentives/src/PriceOracle.sol";
import {TestToken} from "storage-incentives/src/TestToken.sol";

import {VolumeRegistry} from "../../src/VolumeRegistry.sol";

/// @notice Shared L1 fixture
///
/// Deploys real vendored PostageStamp/PriceOracle/TestToken plus a fresh
/// VolumeRegistry. `minimumValidityBlocks` is coerced to 12 so tests match
/// the Sepolia floor. The test contract holds PRICE_ORACLE_ROLE on
/// PostageStamp so it can set `lastPrice` directly without routing through
/// PriceOracle's redundancy logic. PriceOracle itself is still deployed so
/// survival-floor tests (§3.8) can read its `changeRate`/`priceBase`
/// constants.
abstract contract RegistryFixture is Test {
    // Target per-chunk runway for fixture. Small so time-based tests run
    // quickly; ≥ minimumValidityBlocks (12) as required by the constructor.
    uint64 internal constant GRACE_BLOCKS = 15;

    // Reasonable Postage defaults; every test uses these unless overridden.
    uint8 internal constant MIN_BUCKET_DEPTH = 16;
    uint8 internal constant DEFAULT_DEPTH = 20; // 2^20 chunks per batch
    uint8 internal constant DEFAULT_BUCKET = 16;
    uint64 internal constant INITIAL_PRICE = 1000; // BZZ atto units per chunk-block

    PostageStamp internal stamp;
    PriceOracle internal oracle;
    TestToken internal bzz;
    VolumeRegistry internal registry;

    // Canonical test actors used across cases.
    address internal OWNER = makeAddr("owner");
    address internal OWNER_B = makeAddr("owner_b");
    address internal PAYER = makeAddr("payer");
    address internal PAYER2 = makeAddr("payer2");
    address internal CHUNK_SIGNER = makeAddr("chunk_signer");
    address internal STRANGER = makeAddr("stranger");

    // Per-fixture salt for `_createExternalBatch`, so repeated calls by the
    // same signer derive distinct batch IDs.
    uint256 private _externalBatchNonce;

    function setUp() public virtual {
        // 1. TestToken (BZZ). Decimals=16. This test contract is minter + admin.
        bzz = new TestToken("BZZ", "BZZ", 0);

        // 2. PostageStamp. minBucketDepth must be < any created depth.
        stamp = new PostageStamp(address(bzz), MIN_BUCKET_DEPTH);
        // Coerce floor to 12 to match Sepolia / DESIGN.md §10 constructor check.
        stamp.setMinimumValidityBlocks(12);

        // 3. PriceOracle — wired for constant reads in §3.8 only; not driving
        //    PostageStamp in most tests.
        oracle = new PriceOracle(address(stamp));

        // 4. Grant this test contract PRICE_ORACLE_ROLE directly on
        //    PostageStamp so it can call setPrice.
        stamp.grantRole(stamp.PRICE_ORACLE_ROLE(), address(this));

        // 5. Prime lastPrice BEFORE deploying the registry — the registry
        //    reads lastPrice at createVolume time; zero price would collapse
        //    charges to zero.
        stamp.setPrice(INITIAL_PRICE);

        // 6. VolumeRegistry itself.
        registry = new VolumeRegistry(address(stamp), address(bzz), GRACE_BLOCKS, false);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @notice Installs an active (owner, payer) account in one call.
    ///         Also funds+approves the payer with `fund` BZZ.
    function _activateAccount(address owner, address payer, uint256 fund) internal {
        vm.prank(owner);
        registry.designateFundingWallet(payer);
        vm.prank(payer);
        registry.confirmAuth(owner);

        bzz.mint(payer, fund);
        vm.prank(payer);
        bzz.approve(address(registry), type(uint256).max);
    }

    function _perChunkCharge() internal view returns (uint256) {
        return uint256(stamp.lastPrice()) * GRACE_BLOCKS;
    }

    function _expectedCreateCharge(uint8 depth) internal view returns (uint256) {
        return _perChunkCharge() << depth;
    }

    /// @notice Creates a volume using the fixture's default depth/bucket
    ///         and no TTL. Caller must already have an active account.
    function _createDefaultVolume(address owner, address chunkSigner) internal returns (bytes32) {
        vm.prank(owner);
        return registry.createVolume(chunkSigner, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
    }

    /// @notice Same as above, with an explicit TTL.
    function _createVolumeWithTtl(address owner, address chunkSigner, uint64 ttlExpiry)
        internal
        returns (bytes32)
    {
        vm.prank(owner);
        return registry.createVolume(chunkSigner, DEFAULT_DEPTH, DEFAULT_BUCKET, ttlExpiry, false);
    }

    /// @notice Creates a Postage batch with no registry involvement: mints
    ///         `balancePerChunk << depth` BZZ to `signer`, which approves
    ///         PostageStamp and calls `createBatch` itself. The batch owner is
    ///         `signer`; the batch ID is `keccak256(abi.encode(signer, nonce))`
    ///         for a fixture-local nonce.
    function _createExternalBatch(address signer, uint8 depth, uint256 balancePerChunk)
        internal
        returns (bytes32 batchId)
    {
        uint256 total = balancePerChunk << depth;
        bzz.mint(signer, total);
        vm.prank(signer);
        bzz.approve(address(stamp), total);
        bytes32 nonce = bytes32(++_externalBatchNonce);
        vm.prank(signer);
        batchId = stamp.createBatch(signer, balancePerChunk, depth, DEFAULT_BUCKET, nonce, false);
    }

    /// @notice Thin external batch: funded with exactly Postage's
    ///         `minimumInitialBalancePerChunk` (`minimumValidityBlocks ×
    ///         lastPrice` = 12 blocks), below the registry's 15-block target.
    function _createThinExternalBatch(address signer) internal returns (bytes32) {
        return _createExternalBatch(signer, DEFAULT_DEPTH, stamp.minimumInitialBalancePerChunk());
    }

    /// @notice `registerVolume(batchId, 0)` as `owner`.
    function _registerDefault(address owner, bytes32 batchId) internal returns (bytes32) {
        vm.prank(owner);
        return registry.registerVolume(batchId, 0);
    }

    /// @notice `importVolume(batchId, 0)` as `owner`.
    function _importDefault(address owner, bytes32 batchId) internal returns (bytes32) {
        vm.prank(owner);
        return registry.importVolume(batchId, 0);
    }

    /// @notice The volume ID an owner's creating call with account nonce
    ///         `nonce` produces (DESIGN §4).
    function _expectedVolumeId(address owner, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, nonce));
    }

    /// @notice The Postage batch underlying `volumeId`.
    function _batchOf(bytes32 volumeId) internal view returns (bytes32) {
        return registry.getVolume(volumeId).batchId;
    }

    /// @notice Per-chunk balance left on `batchId` (`normalisedBalance −
    ///         currentTotalOutPayment`). Reverts if the batch is dead.
    function _remaining(bytes32 batchId) internal view returns (uint256) {
        (,,,, uint256 nb,) = stamp.batches(batchId);
        return nb - stamp.currentTotalOutPayment();
    }

    /// @notice Overwrites `batches(batchId).owner` on PostageStamp via
    ///         `vm.store`, for the I2 defensive owner-mismatch witness.
    ///         stdStore can't resolve slots for struct-returning mappings.
    ///         Slot confirmed via `forge inspect PostageStamp storage-layout`:
    ///         `batches` → slot 2 (AccessControl._roles=0, then _paused +
    ///         bzzToken + minimumBucketDepth packed in slot 1; immutables are
    ///         inline). Batch struct slot 0 packs [owner(20), depth(1),
    ///         bucketDepth(1), immutableFlag(1)].
    function _forceBatchOwner(bytes32 batchId, address newOwner) internal {
        bytes32 slot = keccak256(abi.encode(batchId, uint256(2)));
        bytes32 packed = vm.load(address(stamp), slot);
        // Clear the low 160 bits (owner) and write newOwner.
        uint256 cleared = uint256(packed) & ~uint256(type(uint160).max);
        vm.store(address(stamp), slot, bytes32(cleared | uint256(uint160(newOwner))));
    }

    /// @notice Tops `batchId` up by `4 × graceBlocks` blocks of runway from
    ///         `signer`'s own funds and then has `signer` (the batch owner)
    ///         raise its depth by one. The topup keeps the halved per-chunk
    ///         balance above Postage's floor.
    function _increaseDepthAsSigner(bytes32 batchId, address signer, uint8 fromDepth) internal {
        uint256 topupPerChunk = uint256(stamp.lastPrice()) * GRACE_BLOCKS * 4;
        bzz.mint(signer, topupPerChunk << fromDepth);
        vm.prank(signer);
        bzz.approve(address(stamp), type(uint256).max);
        vm.prank(signer);
        stamp.topUp(batchId, topupPerChunk);
        vm.prank(signer);
        stamp.increaseDepth(batchId, fromDepth + 1);
    }

    /// @notice Advance the chain by `n` blocks. Does not move wall-clock time.
    function _roll(uint256 n) internal {
        vm.roll(block.number + n);
    }
}

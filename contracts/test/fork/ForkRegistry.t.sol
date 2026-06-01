// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";

import {VolumeRegistry} from "../../src/VolumeRegistry.sol";

/// @notice Fork-mode subset against a live chain.
///
/// Purpose: catch ABI/parameter drift between the pinned storage-incentives
/// submodule and the actual live PostageStamp/BZZ bytecode. Correctness
/// coverage stays in L1.
///
/// Requires both a fork URL (`forge test --fork-url $RPC`) and addresses
/// for the contracts under test:
///
///   - `FORK_POSTAGE_STAMP` (required) — live PostageStamp address.
///   - `FORK_BZZ` (required)           — live BZZ ERC20 address.
///   - `FORK_MULTICALL3` (optional)    — defaults to the canonical
///                                       0xcA11bde05977b3631167028862bE2a173976CA11.
///   - `FORK_GRACE_BLOCKS` (optional)  — registry constructor arg;
///                                       defaults to PostageStamp.minimumValidityBlocks().
///
/// All tests no-op if `FORK_POSTAGE_STAMP` is unset or its address has no
/// code on the active chain (i.e. plain `forge test` against a hermetic
/// EVM is a silent skip).
///
/// Fork-safe subset:
///   - test_createVolume_happy
///   - test_trigger_happyTopup
///   - test_trigger_zeroDeficit_noop
///   - test_trigger_idempotence_sameBlock
///   - test_activeSet_pagination (moderate N)
///   - Parity assertion at setUp
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IPostageStamp {
    function minimumValidityBlocks() external view returns (uint64);
    function lastPrice() external view returns (uint64);
    function priceOracle() external view returns (address);
    function batches(bytes32) external view returns (address, uint8, uint8, bool, uint256, uint256);
    function currentTotalOutPayment() external view returns (uint256);
}

contract ForkRegistryTest is Test {
    // Canonical Multicall3 (deterministic deployment, same address on every
    // EVM chain that has it). Used only as the default when FORK_MULTICALL3
    // is unset.
    address internal constant CANONICAL_MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    // Populated from env in setUp when the fork is active.
    address internal postageAddr;
    address internal bzzAddr;
    address internal multicall3Addr;
    uint64 internal graceBlocks;

    VolumeRegistry internal registry;
    IERC20 internal bzz;
    IPostageStamp internal stamp;

    address internal owner = makeAddr("fork_owner");
    address internal payer = makeAddr("fork_payer");
    address internal chunkSigner = makeAddr("fork_chunk_signer");

    uint8 internal constant DEFAULT_DEPTH = 20;
    uint8 internal constant DEFAULT_BUCKET = 16;

    modifier forkOnly() {
        if (!_forkActive()) {
            emit log("fork test skipped - FORK_POSTAGE_STAMP unset or no code at address");
            return;
        }
        _;
    }

    function _forkActive() internal view returns (bool) {
        address p = vm.envOr("FORK_POSTAGE_STAMP", address(0));
        return p != address(0) && p.code.length > 0;
    }

    function setUp() public {
        if (!_forkActive()) return;

        postageAddr = vm.envAddress("FORK_POSTAGE_STAMP");
        bzzAddr = vm.envAddress("FORK_BZZ");
        multicall3Addr = vm.envOr("FORK_MULTICALL3", CANONICAL_MULTICALL3);

        bzz = IERC20(bzzAddr);
        stamp = IPostageStamp(postageAddr);

        // FORK_GRACE_BLOCKS defaults to the chain's minimumValidityBlocks
        // (smallest value the registry constructor will accept).
        graceBlocks = uint64(vm.envOr("FORK_GRACE_BLOCKS", uint256(stamp.minimumValidityBlocks())));

        // Parity assertions.
        assertGt(postageAddr.code.length, 0, "PostageStamp code missing on fork");
        assertGt(multicall3Addr.code.length, 0, "Multicall3 missing at configured address");
        assertGe(
            uint256(graceBlocks),
            uint256(stamp.minimumValidityBlocks()),
            "FORK_GRACE_BLOCKS below chain's minimumValidityBlocks"
        );
        address oracle = stamp.priceOracle();
        assertTrue(oracle != address(0), "PriceOracle not discoverable");

        registry = new VolumeRegistry(postageAddr, bzzAddr, graceBlocks);

        // Fund + activate.
        deal(bzzAddr, payer, 1e30);
        vm.prank(payer);
        bzz.approve(address(registry), type(uint256).max);
        vm.prank(owner);
        registry.designateFundingWallet(payer);
        vm.prank(payer);
        registry.confirmAuth(owner);
    }

    function _charge() internal view returns (uint256) {
        return uint256(stamp.lastPrice()) * graceBlocks * (uint256(1) << DEFAULT_DEPTH);
    }

    function test_fork_createVolume_happy() public forkOnly {
        uint256 balBefore = bzz.balanceOf(payer);
        vm.prank(owner);
        bytes32 id = registry.createVolume(chunkSigner, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
        assertEq(balBefore - bzz.balanceOf(payer), _charge());
        (address bOwner, uint8 bDepth,,,,) = stamp.batches(id);
        assertEq(bOwner, chunkSigner);
        assertEq(bDepth, DEFAULT_DEPTH);
    }

    function test_fork_trigger_happyTopup() public forkOnly {
        vm.prank(owner);
        bytes32 id = registry.createVolume(chunkSigner, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
        vm.roll(block.number + 5);

        uint256 balBefore = bzz.balanceOf(payer);
        registry.trigger(id);
        assertLt(bzz.balanceOf(payer), balBefore);
    }

    function test_fork_trigger_zeroDeficit_noop() public forkOnly {
        vm.prank(owner);
        bytes32 id = registry.createVolume(chunkSigner, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
        uint256 balBefore = bzz.balanceOf(payer);
        registry.trigger(id);
        assertEq(bzz.balanceOf(payer), balBefore);
    }

    function test_fork_trigger_idempotence_sameBlock() public forkOnly {
        vm.prank(owner);
        bytes32 id = registry.createVolume(chunkSigner, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
        vm.roll(block.number + 5);
        registry.trigger(id);
        uint256 balAfter1 = bzz.balanceOf(payer);
        registry.trigger(id);
        assertEq(bzz.balanceOf(payer), balAfter1);
    }

    function test_fork_activeSet_pagination_moderate() public forkOnly {
        uint256 n = 30;
        for (uint256 i = 0; i < n; ++i) {
            vm.prank(owner);
            registry.createVolume(chunkSigner, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
        }
        assertEq(registry.getActiveVolumeCount(), n);
        VolumeRegistry.VolumeView[] memory page = registry.getActiveVolumes(0, 20);
        assertEq(page.length, 20);
        VolumeRegistry.VolumeView[] memory rest = registry.getActiveVolumes(20, 20);
        assertEq(rest.length, 10);
    }
}

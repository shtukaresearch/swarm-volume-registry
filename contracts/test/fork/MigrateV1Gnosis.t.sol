// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console2} from "forge-std/Test.sol";

import {VolumeRegistry} from "../../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../../src/interfaces/IVolumeRegistryViews.sol";

/// Rehearses migrating live v1 volumes into a freshly deployed v2 on a
/// Gnosis fork: real v1 registry, real batches, real payer balance (no deal).
///
///   MIGRATE_PAYER=0x...  forge test --fork-url $GNOSIS_RPC \
///     --match-path test/fork/MigrateV1Gnosis.t.sol -vv
///
/// Optional: MIGRATE_GRACE_BLOCKS (default 120960 = 7 d), V1_REGISTRY.

interface IV1 {
    struct VolumeView {
        bytes32 volumeId;
        address owner;
        address payer;
        address chunkSigner;
        uint64 createdAt;
        uint64 ttlExpiry;
        uint8 depth;
        uint8 status;
        bool accountActive;
    }

    function postage() external view returns (address);
    function bzz() external view returns (address);
    function getActiveVolumeCount() external view returns (uint256);
    function getActiveVolumes(uint256 offset, uint256 limit)
        external
        view
        returns (VolumeView[] memory);
    function getVolume(bytes32 id) external view returns (VolumeView memory);
    function deleteVolume(bytes32 id) external;
    function trigger(bytes32[] calldata ids) external;
    function revoke(address owner) external;
}

interface IERC20M {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IPostageM {
    function batches(bytes32) external view returns (address, uint8, uint8, bool, uint256, uint256);
    function currentTotalOutPayment() external view returns (uint256);
    function lastPrice() external view returns (uint64);
}

contract MigrateV1GnosisTest is Test {
    address internal constant DEFAULT_V1 = 0x9639Ae4C7A8Fa9efE585738d516a3915DdD02aAD;

    IV1 v1;
    VolumeRegistry v2;
    IERC20M bzz;
    IPostageM postage;
    address payer;

    bytes32[] ids;
    address[] owners;
    uint64[] ttls;

    function setUp() public {
        payer = vm.envOr("MIGRATE_PAYER", address(0));
        if (payer == address(0) || block.chainid != 100) return; // test fails or skips

        v1 = IV1(vm.envOr("V1_REGISTRY", DEFAULT_V1));
        postage = IPostageM(v1.postage());
        bzz = IERC20M(v1.bzz());
        uint64 grace = uint64(vm.envOr("MIGRATE_GRACE_BLOCKS", uint256(120960)));
        v2 = new VolumeRegistry(address(postage), address(bzz), grace, true);

        IV1.VolumeView[] memory all = v1.getActiveVolumes(0, v1.getActiveVolumeCount());
        for (uint256 i = 0; i < all.length; ++i) {
            if (all[i].payer != payer) continue;
            ids.push(all[i].volumeId);
            owners.push(all[i].owner);
            ttls.push(all[i].ttlExpiry);
        }
    }

    function _remaining(bytes32 batchId) internal view returns (uint256 perChunk) {
        (,,,, uint256 nb,) = postage.batches(batchId);
        uint256 out = postage.currentTotalOutPayment();
        perChunk = nb > out ? nb - out : 0;
    }

    function test_migrate_allPayerVolumes() public {
        if (payer != address(0)) {
            require(block.chainid == 100, "MIGRATE_PAYER set but not a Gnosis fork");
        }
        vm.skip(payer == address(0));
        uint256 n = ids.length;
        uint256 price = postage.lastPrice();
        console2.log("block", block.number, "lastPrice", price);
        console2.log("v2 graceBlocks", v2.graceBlocks(), "volumes to migrate", n);
        uint256 bal0 = bzz.balanceOf(payer);
        console2.log("payer BZZ (PLUR) before", bal0);

        // 1. Handshake per distinct owner, then one approve from the payer.
        for (uint256 i = 0; i < n; ++i) {
            if (v2.getAccount(owners[i]).active) continue;
            vm.prank(owners[i]);
            v2.designateFundingWallet(payer);
            vm.prank(payer);
            v2.confirmAuth(owners[i]);
            console2.log("account activated for owner", owners[i]);
        }
        vm.prank(payer);
        bzz.approve(address(v2), type(uint256).max);

        // 2. Import each batch while it is still in v1.
        bytes32[] memory newIds = new bytes32[](n);
        uint256 totalCharge;
        uint256 totalGas;
        for (uint256 i = 0; i < n; ++i) {
            (address bOwnerBefore, uint8 depth,,,,) = postage.batches(ids[i]);
            uint256 remBefore = _remaining(ids[i]);
            uint256 b = bzz.balanceOf(payer);
            uint256 g = gasleft();
            vm.prank(owners[i]);
            try v2.importVolume(ids[i], ttls[i]) returns (bytes32 nid) {
                uint256 used = g - gasleft();
                newIds[i] = nid;
                uint256 charge = b - bzz.balanceOf(payer);
                totalCharge += charge;
                totalGas += used;
                (address bOwnerAfter,,,,,) = postage.batches(ids[i]);
                assertEq(bOwnerAfter, bOwnerBefore, "batch owner changed");
                assertEq(v2.getVolume(nid).batchId, ids[i], "v2 record batchId");
                console2.log("imported depth", depth);
                console2.log(
                    "  runway blocks before/after", remBefore / price, _remaining(ids[i]) / price
                );
                console2.log("  charge PLUR", charge, "gas", used);
            } catch (bytes memory err) {
                console2.log("IMPORT FAILED for volume index", i);
                console2.logBytes(err);
                fail();
            }
        }
        console2.log("TOTAL import charge PLUR", totalCharge);
        console2.log("TOTAL import gas", totalGas);
        console2.log("payer BZZ (PLUR) after import", bzz.balanceOf(payer));

        // 3. Overlap window: both registries know every batch. A v1 keeper
        //    run must find no deficit (v2's target exceeds v1's), so it
        //    charges nothing.
        vm.roll(block.number + 100);
        uint256 b3 = bzz.balanceOf(payer);
        v1.trigger(ids);
        assertEq(bzz.balanceOf(payer), b3, "v1 trigger charged during overlap");
        console2.log("overlap: v1 trigger charged 0");

        // 4. Retire every volume in v1.
        for (uint256 i = 0; i < n; ++i) {
            vm.prank(owners[i]);
            v1.deleteVolume(ids[i]);
            assertEq(v1.getVolume(ids[i]).status, 2, "v1 volume not retired");
        }
        console2.log("v1 volumes deleted; v1 active count now", v1.getActiveVolumeCount());

        // 5. A day later, one batched v2 trigger keeps them all alive.
        vm.roll(block.number + 17280);
        uint256 b5 = bzz.balanceOf(payer);
        uint256 g5 = gasleft();
        v2.trigger(newIds);
        uint256 g5used = g5 - gasleft();
        console2.log(
            "day+1 batched v2 trigger: charge PLUR", b5 - bzz.balanceOf(payer), "gas", g5used
        );
        for (uint256 i = 0; i < n; ++i) {
            assertEq(uint8(v2.getVolume(newIds[i]).status), 1, "v2 volume not active");
        }

        // 6. v1 keeper after deletion charges nothing.
        uint256 b6 = bzz.balanceOf(payer);
        v1.trigger(ids);
        assertEq(bzz.balanceOf(payer), b6, "v1 charged after delete");
        console2.log("post-delete: v1 trigger charged 0");
    }
}

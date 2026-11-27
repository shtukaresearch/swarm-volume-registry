// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console2} from "forge-std/Test.sol";

import {VolumeRegistry} from "../../src/VolumeRegistry.sol";

/// Migrates a v1 volume into the DEPLOYED v2-rc4 on a Sepolia fork. Sepolia
/// v1 has no live volumes, so the test makes one first.
///
///   forge test --fork-url $SEPOLIA_RPC --match-path test/fork/MigrateV1Sepolia.t.sol -vv

interface IV1S {
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

    function designateFundingWallet(address payer) external;
    function confirmAuth(address owner) external;
    function createVolume(
        address chunkSigner,
        uint8 depth,
        uint8 bucketDepth,
        uint64 ttlExpiry,
        bool immutableFlag
    ) external returns (bytes32);
    function getVolume(bytes32 id) external view returns (VolumeView memory);
    function deleteVolume(bytes32 id) external;
    function trigger(bytes32 id) external;
    function revoke(address owner) external;
    function getAccount(address owner) external view returns (address payer, bool active);
}

interface IERC20S {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IPostageS {
    function batches(bytes32) external view returns (address, uint8, uint8, bool, uint256, uint256);
}

contract MigrateV1SepoliaTest is Test {
    IV1S constant V1 = IV1S(0x3A99b4B52a4BD75760667219EA93c627051b1af8);
    VolumeRegistry constant V2 = VolumeRegistry(0xE491308994aF391a32191A8c380ca818dad332A4);
    IERC20S constant BZZ = IERC20S(0x543dDb01Ba47acB11de34891cD86B675F04840db);
    IPostageS constant POSTAGE = IPostageS(0xcdfdC3752caaA826fE62531E0000C40546eC56A6);

    address owner = makeAddr("owner");
    address payer = makeAddr("payer");
    address signer = makeAddr("signer");

    function test_migrate_v1_to_deployed_v2rc4() public {
        vm.skip(block.chainid != 11155111);
        deal(address(BZZ), payer, 1e24);

        // v1 volume, profile B (owner EOA, separate payer).
        vm.prank(owner);
        V1.designateFundingWallet(payer);
        vm.startPrank(payer);
        V1.confirmAuth(owner);
        BZZ.approve(address(V1), type(uint256).max);
        vm.stopPrank();
        vm.prank(owner);
        bytes32 batchId = V1.createVolume(signer, 20, 16, 0, false);
        assertEq(V1.getVolume(batchId).status, 1);
        console2.log("v1 volume (= batchId) created");
        console2.logBytes32(batchId);

        vm.roll(block.number + 6);
        V1.trigger(batchId);

        // Migrate into the deployed v2-rc4.
        vm.prank(owner);
        V2.designateFundingWallet(payer);
        vm.startPrank(payer);
        V2.confirmAuth(owner);
        BZZ.approve(address(V2), type(uint256).max);
        vm.stopPrank();

        uint256 b = BZZ.balanceOf(payer);
        vm.prank(owner);
        bytes32 nid = V2.importVolume(batchId, 0);
        console2.log("import charge PLUR", b - BZZ.balanceOf(payer));
        assertEq(V2.getVolume(nid).batchId, batchId);
        assertEq(V2.getVolume(nid).chunkSigner, signer);
        assertEq(V2.getVolume(nid).owner, owner);

        vm.prank(owner);
        V1.deleteVolume(batchId);
        assertEq(V1.getVolume(batchId).status, 2);

        // Clean up v1 authority: revoke the pair, zero the allowance.
        vm.startPrank(payer);
        V1.revoke(owner);
        BZZ.approve(address(V1), 0);
        vm.stopPrank();
        (, bool v1active) = V1.getAccount(owner);
        assertFalse(v1active);

        // v2 keeps it alive past several grace periods.
        uint256 g = V2.graceBlocks();
        for (uint256 i = 0; i < 3; ++i) {
            vm.roll(block.number + g / 2);
            uint256 bb = BZZ.balanceOf(payer);
            V2.trigger(nid);
            console2.log("v2 trigger charge PLUR", bb - BZZ.balanceOf(payer));
        }
        assertEq(uint8(V2.getVolume(nid).status), 1);
        (address bOwner,,,,,) = POSTAGE.batches(batchId);
        assertEq(bOwner, signer);
    }
}

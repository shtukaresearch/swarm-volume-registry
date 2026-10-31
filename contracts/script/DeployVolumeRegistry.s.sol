// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script, console2} from "forge-std/Script.sol";

import {VolumeRegistry} from "../src/VolumeRegistry.sol";

/// @notice Deployment script for `VolumeRegistry`.
///
///         `script/deploy.py` resolves an explicitly selected profile from
///         `deployments.toml`, validates its chain ID, and passes the four
///         constructor arguments and the CREATE2 salt to `run`. Wallet
///         selection is handled by Forge's `--account` option.
///
///         The registry is deployed with CREATE2 through the factory
///         `deploy.py` passes as `--create2-deployer`, so its address is
///         keccak256(0xff ‖ factory ‖ salt ‖ keccak256(initcode))[12:] and
///         depends neither on the deployer account nor on its nonce. The salt
///         is the release name (see `deploy.release_salt`).
contract DeployVolumeRegistry is Script {
    function run(
        address postageStamp,
        address bzz,
        uint64 graceBlocks,
        bool bzzPermitExpiry,
        bytes32 salt
    ) external {
        vm.startBroadcast();
        VolumeRegistry reg =
            new VolumeRegistry{salt: salt}(postageStamp, bzz, graceBlocks, bzzPermitExpiry);
        vm.stopBroadcast();

        console2.log("VolumeRegistry deployed at:", address(reg));
        console2.log("  BZZ token:    ", bzz);
        console2.log("  PostageStamp: ", postageStamp);
        console2.log("  graceBlocks:  ", uint256(graceBlocks));
        console2.log("  permitExpiry: ", bzzPermitExpiry);
        console2.log("  CREATE2 salt: ", vm.toString(salt));
    }
}

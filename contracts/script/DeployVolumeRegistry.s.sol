// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script, console2} from "forge-std/Script.sol";

import {VolumeRegistry} from "../src/VolumeRegistry.sol";

/// @notice Deployment script for `VolumeRegistry`.
///
///         All parameters are supplied via environment variables; nothing
///         is hardcoded because the underlying `PostageStamp` contract is
///         expected to be redeployed across chains and across versions, and
///         this repo should track each new deployment without code changes.
///
///         Required:
///           - `POSTAGE_STAMP`  — current PostageStamp address for the target chain.
///           - `BZZ`            — BZZ ERC20 address for the target chain.
///           - `GRACE_BLOCKS`   — per-topup runway in blocks. Mainnet (Gnosis)
///                                uses 17280 (≈ 24 h at 5 s blocks); short
///                                values like 12 are useful on testnets for
///                                fast observation of topup and expiry cycles.
///                                Must be ≥ `PostageStamp.minimumValidityBlocks()`.
///           - `PRIVATE_KEY`    — deployer key.
///
///         See `docs/usage.md` §2 for the addresses currently in use and
///         `docs/DESIGN.md` §10 for `graceBlocks` semantics.
contract DeployVolumeRegistry is Script {
    function run() external {
        address bzz = vm.envAddress("BZZ");
        address stamp = vm.envAddress("POSTAGE_STAMP");
        uint64 graceBlocks = uint64(vm.envUint("GRACE_BLOCKS"));
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        VolumeRegistry reg = new VolumeRegistry(stamp, bzz, graceBlocks);
        vm.stopBroadcast();

        console2.log("VolumeRegistry deployed at:", address(reg));
        console2.log("  BZZ token:    ", bzz);
        console2.log("  PostageStamp: ", stamp);
        console2.log("  graceBlocks:  ", uint256(graceBlocks));
    }
}

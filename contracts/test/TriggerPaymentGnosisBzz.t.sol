// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";

import {PostageStamp} from "storage-incentives/src/PostageStamp.sol";
import {TestToken} from "storage-incentives/src/TestToken.sol";

import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice The subset of the OmniBridge `PermittableToken` these tests drive.
interface IPermittableToken {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function expirations(address, address) external view returns (uint256);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function PERMIT_TYPEHASH_LEGACY() external view returns (bytes32);
    function permit(
        address holder,
        address spender,
        uint256 nonce,
        uint256 expiry,
        bool allowed,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice Trigger payment against Gnosis BZZ (DESIGN §8 step 8, §10
///         `bzzPermitExpiry`; ADR-0007).
///
/// Runs on the real runtime bytecode of the `PermittableToken` behind Gnosis
/// BZZ (implementation `0xf8D1677c8a0c961938bf2f9aDc3F3CFDA759A9d9`, read at
/// Gnosis block 49029048), vendored as `fixtures/gnosis-bzz-permittable-token.bin`
/// and etched at a fixed address. The etched token starts with empty storage;
/// balances are set with `deal`, allowances through its own `approve` and
/// legacy `permit`.
///
/// The `tokenPremise` tests pin the token behaviour ADR-0007 rests on; the
/// rest show the registry's precheck turning each payer state into
/// `TopupSkipped(PaymentFailed)`.
contract TriggerPaymentGnosisBzzTest is Test {
    event Toppedup(bytes32 indexed volumeId, uint256 amount, uint256 newNormalisedBalance);
    event TopupSkipped(bytes32 indexed volumeId, uint8 reason);

    string internal constant CODE_PATH = "test/fixtures/gnosis-bzz-permittable-token.bin";
    bytes32 internal constant CODE_HASH =
        0x3c42cd875bf3a7c6ef70a1e3ff64377f4e9d35aa8db0695f6724a4f94e1f5c3f;

    uint64 internal constant GRACE_BLOCKS = 15;
    uint8 internal constant MIN_BUCKET_DEPTH = 16;
    uint8 internal constant DEPTH = 20;
    uint8 internal constant BUCKET = 16;
    uint64 internal constant PRICE = 1000;

    IPermittableToken internal bzz;
    PostageStamp internal stamp;
    VolumeRegistry internal registry;

    address internal OWNER = makeAddr("owner");
    address internal CHUNK_SIGNER = makeAddr("chunk_signer");
    address internal PAYER;
    uint256 internal PAYER_KEY;

    function setUp() public {
        (PAYER, PAYER_KEY) = makeAddrAndKey("payer");

        bytes memory code = vm.readFileBinary(CODE_PATH);
        assertEq(keccak256(code), CODE_HASH, "vendored token bytecode changed");
        bzz = IPermittableToken(makeAddr("gnosis_bzz"));
        vm.etch(address(bzz), code);

        stamp = new PostageStamp(address(bzz), MIN_BUCKET_DEPTH);
        stamp.setMinimumValidityBlocks(12);
        stamp.grantRole(stamp.PRICE_ORACLE_ROLE(), address(this));
        stamp.setPrice(PRICE);

        registry = _deployRegistry(true);
    }

    // ------------------------------------------------------------------
    // Token behaviour ADR-0007 rests on
    // ------------------------------------------------------------------

    /// @notice An insufficient balance hits SafeMath's `assert`, compiled to
    ///         `INVALID` by solc 0.4.24: empty revert data, and every unit of
    ///         gas the call was given is consumed.
    function test_tokenPremise_insufficientBalance_consumesAllGas() public {
        vm.prank(PAYER);
        bzz.approve(address(this), type(uint256).max);

        uint256 given = 1_000_000;
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = address(bzz).call{gas: given}(
            abi.encodeCall(IPermittableToken.transferFrom, (PAYER, address(this), 1))
        );
        uint256 used = g - gasleft();

        assertFalse(ok);
        assertEq(ret.length, 0, "no revert data");
        assertGe(used, given, "all forwarded gas consumed");
    }

    /// @notice After a legacy permit's expiry passes, `allowance()` still
    ///         reports an unlimited allowance while `transferFrom` reverts
    ///         with empty data.
    function test_tokenPremise_expiredPermit_allowanceLiesAndTransferReverts() public {
        deal(address(bzz), PAYER, 1e30);
        _legacyPermit(address(this), block.timestamp + 1 hours);
        vm.warp(block.timestamp + 2 hours);

        assertEq(bzz.allowance(PAYER, address(this)), type(uint256).max);
        (bool ok, bytes memory ret) = address(bzz)
            .call(abi.encodeCall(IPermittableToken.transferFrom, (PAYER, address(this), 1)));
        assertFalse(ok);
        assertEq(ret.length, 0, "no revert data");
    }

    // ------------------------------------------------------------------
    // Precheck
    // ------------------------------------------------------------------

    /// @notice A payer without the balance is skipped without touching the
    ///         token's `assert` path: the gas the skip uses does not depend on
    ///         the gas the call is given. Catching the token's revert instead
    ///         would burn about 63/64 of whatever was forwarded.
    function test_trigger_insufficientBalance_skipCostIndependentOfGasGiven() public {
        // Two volumes with broke payers, so neither measurement runs between
        // snapshot cheatcodes (which distort Forge's gas accounting). The second
        // call finds some slots warm; the tolerance absorbs that and is still far
        // below the millions of gas a caught revert would show.
        bytes32 small = _drainingVolume();
        address otherOwner = makeAddr("other_owner");
        address otherPayer = makeAddr("other_payer");
        _activate(otherOwner, otherPayer);
        vm.prank(otherOwner);
        bytes32 large = registry.createVolume(CHUNK_SIGNER, DEPTH, BUCKET, 0, false);
        vm.roll(block.number + 5);
        deal(address(bzz), PAYER, 0);
        deal(address(bzz), otherPayer, 0);

        uint256 usedSmall = _triggerGasUsed(small, 3_000_000);
        uint256 usedLarge = _triggerGasUsed(large, 10_000_000);

        assertApproxEqAbs(usedSmall, usedLarge, 50_000, "skip cost scales with gas given");
        _assertActive(small);
        _assertActive(large);
    }

    function test_trigger_finiteAllowanceShort_skips() public {
        bytes32 id = _drainingVolume();
        vm.prank(PAYER);
        bzz.approve(address(registry), 1);
        uint256 balBefore = bzz.balanceOf(PAYER);

        vm.expectEmit(true, true, true, true);
        emit TopupSkipped(id, uint8(IVolumeRegistryViews.SkipReason.PaymentFailed));
        registry.trigger(id);
        assertEq(bzz.balanceOf(PAYER), balBefore);
        _assertActive(id);
    }

    function test_trigger_expiredPermit_skips() public {
        bytes32 id = _drainingVolume();
        _legacyPermit(address(registry), block.timestamp + 1 hours);
        vm.warp(block.timestamp + 2 hours);
        uint256 balBefore = bzz.balanceOf(PAYER);

        vm.expectEmit(true, true, true, true);
        emit TopupSkipped(id, uint8(IVolumeRegistryViews.SkipReason.PaymentFailed));
        registry.trigger(id);
        assertEq(bzz.balanceOf(PAYER), balBefore);
        _assertActive(id);
    }

    function test_trigger_unexpiredPermit_topsUp() public {
        bytes32 id = _drainingVolume();
        _legacyPermit(address(registry), block.timestamp + 1 hours);

        vm.expectEmit(true, true, true, false);
        emit Toppedup(id, 0, 0);
        registry.trigger(id);
    }

    /// @notice An unlimited `approve` clears a stale expiry.
    function test_trigger_expiredPermitThenApprove_topsUp() public {
        bytes32 id = _drainingVolume();
        _legacyPermit(address(registry), block.timestamp + 1 hours);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(PAYER);
        bzz.approve(address(registry), type(uint256).max);
        assertEq(bzz.expirations(PAYER, address(registry)), 0);

        vm.expectEmit(true, true, true, false);
        emit Toppedup(id, 0, 0);
        registry.trigger(id);
    }

    /// @notice Why the flag exists: without it an expired permit reaches the
    ///         token and reverts the whole batch, taking a healthy volume
    ///         down with it.
    function test_trigger_expiredPermit_withoutFlag_revertsBatch() public {
        registry = _deployRegistry(false);
        bytes32 stale = _drainingVolume();

        address otherOwner = makeAddr("other_owner");
        address otherPayer = makeAddr("other_payer");
        _activate(otherOwner, otherPayer);
        vm.prank(otherOwner);
        bytes32 healthy = registry.createVolume(CHUNK_SIGNER, DEPTH, BUCKET, 0, false);

        _legacyPermit(address(registry), block.timestamp + 1 hours);
        vm.warp(block.timestamp + 2 hours);
        vm.roll(block.number + 5);

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = healthy;
        ids[1] = stale;
        uint256 otherBefore = bzz.balanceOf(otherPayer);
        vm.expectRevert(bytes(""));
        registry.trigger(ids);
        assertEq(bzz.balanceOf(otherPayer), otherBefore, "healthy top-up rolled back");
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    function test_constructor_flagOn_exposesFlag() public view {
        assertTrue(registry.bzzPermitExpiry());
    }

    /// @notice With the flag set against a token without `expirations`, the
    ///         deployment fails instead of every top-up.
    function test_constructor_flagOnWithoutExpirations_reverts() public {
        TestToken plain = new TestToken("BZZ", "BZZ", 0);
        PostageStamp plainStamp = new PostageStamp(address(plain), MIN_BUCKET_DEPTH);
        plainStamp.setMinimumValidityBlocks(12);

        vm.expectRevert();
        new VolumeRegistry(address(plainStamp), address(plain), GRACE_BLOCKS, true);

        VolumeRegistry ok =
            new VolumeRegistry(address(plainStamp), address(plain), GRACE_BLOCKS, false);
        assertFalse(ok.bzzPermitExpiry());
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _deployRegistry(bool permitExpiry) internal returns (VolumeRegistry) {
        return new VolumeRegistry(address(stamp), address(bzz), GRACE_BLOCKS, permitExpiry);
    }

    /// @notice Activates `owner` with `payer`, funds the payer and gives the
    ///         registry an unlimited plain allowance.
    function _activate(address owner, address payer) internal {
        vm.prank(owner);
        registry.designateFundingWallet(payer);
        vm.prank(payer);
        registry.confirmAuth(owner);
        deal(address(bzz), payer, 1e30);
        vm.prank(payer);
        bzz.approve(address(registry), type(uint256).max);
    }

    /// @notice An Active volume of `OWNER`, paid by `PAYER`, five blocks into
    ///         its runway so the next trigger finds a deficit.
    function _drainingVolume() internal returns (bytes32 id) {
        _activate(OWNER, PAYER);
        vm.prank(OWNER);
        id = registry.createVolume(CHUNK_SIGNER, DEPTH, BUCKET, 0, false);
        vm.roll(block.number + 5);
    }

    /// @notice `PAYER` grants `spender` an unlimited allowance expiring at
    ///         `expiry` through the token's legacy DAI-style `permit`.
    function _legacyPermit(address spender, uint256 expiry) internal {
        uint256 nonce = bzz.nonces(PAYER);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                bzz.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(bzz.PERMIT_TYPEHASH_LEGACY(), PAYER, spender, nonce, expiry, true)
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);
        bzz.permit(PAYER, spender, nonce, expiry, true, v, r, s);
        assertEq(bzz.allowance(PAYER, spender), type(uint256).max);
        assertEq(bzz.expirations(PAYER, spender), expiry);
    }

    /// @notice Gas used by `trigger(id)` given exactly `gas`, which must succeed
    ///         and skip with `PaymentFailed`.
    function _triggerGasUsed(bytes32 id, uint256 gas) internal returns (uint256 used) {
        vm.expectEmit(true, true, true, true);
        emit TopupSkipped(id, uint8(IVolumeRegistryViews.SkipReason.PaymentFailed));
        uint256 g = gasleft();
        (bool ok,) =
            address(registry).call{gas: gas}(abi.encodeWithSignature("trigger(bytes32)", id));
        used = g - gasleft();
        assertTrue(ok, "trigger reverted");
    }

    function _assertActive(bytes32 id) internal view {
        assertEq(uint8(registry.getVolume(id).status), uint8(IVolumeRegistryViews.Status.Active));
    }
}

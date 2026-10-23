// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";

/// @notice Survival floor (I6).
///
/// For each scenario: create a volume, never call `trigger`, drive the
/// PostageStamp price schedule to mimic PriceOracle's worst case (raise by
/// K_max every ROUND_LENGTH blocks), then measure the block at which the
/// batch dies. Assert T ≥ ⌊f × graceBlocks⌋ where f is computed in-test
/// from the observed K_max and ROUND_LENGTH constants (not hardcoded).
///
/// K_max and priceBase are read from the live PriceOracle deployed in the
/// fixture. ROUND_LENGTH is `private constant` in PriceOracle (not
/// accessible via a getter); we pin it at 152 and fail loudly if the
/// survival math stops making sense.
contract SurvivalFloorTest is RegistryFixture {
    // Pinned from PriceOracle source. Tests will become tighter if the
    // vendored oracle ever changes these — which is the point.
    uint256 internal constant ROUND_LENGTH = 152;
    // ln(x) approximation constants (fixed-point, 1e18).
    uint256 internal constant ONE = 1e18;

    function _Kmax_num() internal view returns (uint32) {
        return oracle.changeRate(0);
    }

    function _priceBase() internal view returns (uint32) {
        return oracle.priceBase();
    }

    /// @dev Natural log of `y` (1e18 fixed-point, `y >= ONE`) via the
    ///      atanh series ln(y) = 2·Σ z^(2k+1)/(2k+1), z = (y−1)/(y+1).
    ///      All terms are positive, so truncation (and integer division)
    ///      can only round down. For y ≤ 2 (z ≤ 1/3) the series reaches
    ///      1e-18 resolution within ~20 terms, so it is accurate across
    ///      every λ·G this suite uses, unlike a low-order Taylor of ln(1+x).
    function _ln(uint256 y) internal pure returns (uint256) {
        require(y >= ONE, "ln domain");
        uint256 z = ((y - ONE) * ONE) / (y + ONE);
        uint256 z2 = (z * z) / ONE;
        uint256 term = z; // z^(2k+1)
        uint256 sum = 0;
        for (uint256 k = 0; term > 0; ++k) {
            sum += term / (2 * k + 1);
            term = (term * z2) / ONE;
        }
        return 2 * sum;
    }

    /// @dev Compute floor(f * graceBlocks) where
    ///      f = ln(1 + λ·G) / (λ·G), with λ = ln(K_max) / ROUND_LENGTH and
    ///      K_max = changeRate(0) / priceBase read from the oracle.
    function _computeFloorBlocks(uint64 graceBlocks) internal view returns (uint256) {
        uint256 kNum = _Kmax_num();
        uint256 kDen = _priceBase();
        require(kNum > kDen, "K_max not > 1");
        uint256 lnK = _ln((kNum * ONE) / kDen); // 1e18 fixed

        // lambdaG (1e18) = lnK * graceBlocks / ROUND_LENGTH
        uint256 lambdaG = (lnK * uint256(graceBlocks)) / ROUND_LENGTH;
        if (lambdaG == 0) return graceBlocks; // flat price

        uint256 fScaled = (_ln(ONE + lambdaG) * ONE) / lambdaG; // f * 1e18
        return (uint256(graceBlocks) * fScaled) / ONE; // floor
    }

    /// @dev Drive postage.setPrice(p * K_max) every ROUND_LENGTH blocks.
    ///      Returns T = block offset from startBlock at which the batch is
    ///      first observed dead. Check is done at the END of each round,
    ///      before the price jump, so observed T is the first round
    ///      boundary at or after death; _refineDeathBlock then locates the
    ///      exact block within that round.
    ///
    ///      Requires a starting price large enough that
    ///      `p * kNum / kDen > p` (≳ 1248 given kNum/kDen≈1.000802), else
    ///      integer truncation flattens growth. Survival tests coerce this.
    function _runWorstCasePriceHarness(
        bytes32 id,
        uint64,
        /* graceBlocks */
        uint256 safetyCap
    )
        internal
        returns (uint256 T)
    {
        uint64 startBlock = uint64(block.number);
        uint256 kNum = _Kmax_num();
        uint256 kDen = _priceBase();

        while (block.number - startBlock < safetyCap) {
            _roll(ROUND_LENGTH);
            // Check before the price jump so the round just elapsed was
            // drained at a single price, which _refineDeathBlock relies on.
            (,,,, uint256 nb,) = stamp.batches(id);
            if (nb <= stamp.currentTotalOutPayment()) {
                return block.number - startBlock;
            }

            uint256 newPrice = (uint256(stamp.lastPrice()) * kNum) / kDen;
            require(newPrice > uint256(stamp.lastPrice()), "starting price too small for K_max");
            stamp.setPrice(newPrice);
        }
        return safetyCap + 1;
    }

    /// @dev Finer-grained: after the last round-jump where we observed death,
    ///      step back and find the exact block within that round. Used by
    ///      gnosis-default test which is sensitive to round-quantization.
    function _refineDeathBlock(bytes32 id) internal view returns (uint256) {
        // currentTotalOutPayment grows linearly within a round. Solve for
        // the block B ∈ [lastUpdatedBlock, now] at which
        // totalOutPayment_at_last_setPrice + (B - lastUpdatedBlock)*lastPrice
        // first meets normalisedBalance.
        (,,,, uint256 nb,) = stamp.batches(id);
        uint256 outpayNow = stamp.currentTotalOutPayment();
        uint256 last = stamp.lastUpdatedBlock();
        uint256 pr = uint256(stamp.lastPrice());
        if (outpayNow <= nb) return block.number; // still alive
        // outpay_at_block(B) = outpayNow - (block.number - B) * pr. Solve = nb.
        uint256 diff = outpayNow - nb; // blocks-of-price to back off
        uint256 blocksBack = diff / pr;
        uint256 deathBlock = block.number - blocksBack;
        if (deathBlock < last) deathBlock = last;
        return deathBlock;
    }

    // ---------------- tests --------------------------------------------

    function _setLargePrice(uint256 p) internal {
        // Ensures integer-math multiplicative K_max stepping is non-trivial
        // (needs p * kNum / kDen > p).
        stamp.setPrice(p);
    }

    /// @dev Deploy a registry with `grace`, create a volume, never trigger,
    ///      and drive the worst-case price schedule until the batch dies.
    ///      Asserts T ≥ ⌊f × grace⌋ (I6) and returns T in blocks.
    function _worstCaseSurvival(uint64 grace) internal returns (uint256 T) {
        VolumeRegistry reg = new VolumeRegistry(address(stamp), address(bzz), grace);

        // Use a realistic price (24000, same order as Swarm's min upscaled
        // price) so K_max arithmetic does not truncate.
        _setLargePrice(24000);

        bzz.mint(PAYER, 1e40);
        vm.prank(PAYER);
        bzz.approve(address(reg), type(uint256).max);
        vm.prank(OWNER);
        reg.designateFundingWallet(PAYER);
        vm.prank(PAYER);
        reg.confirmAuth(OWNER);
        vm.prank(OWNER);
        bytes32 volumeId = reg.createVolume(CHUNK_SIGNER, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
        bytes32 id = reg.getVolume(volumeId).batchId;

        uint256 bound = _computeFloorBlocks(grace);
        uint256 observed = _runWorstCasePriceHarness(id, grace, uint256(grace) * 2);
        assertLe(observed, uint256(grace) * 2, "batch did not die within 2 x graceBlocks");
        // Refine to the true death block within the last round so round-
        // quantization doesn't bias us below the bound.
        T = _refineDeathBlock(id) - (block.number - observed);

        emit log_named_uint("graceBlocks", grace);
        emit log_named_uint("floor blocks", bound);
        emit log_named_uint("observed blocks", T);
        assertGe(T, bound, "survived less than the I6 floor");
    }

    function test_survival_worstCasePrice_gnosisDefault() public {
        // graceBlocks = 17280 (≈ 24 h at 5 s blocks; the v1 Gnosis value).
        _worstCaseSurvival(17280);
    }

    function test_survival_worstCasePrice_gnosis7d() public {
        // graceBlocks = 120960 (7 d at 5 s blocks). λ·G ≈ 0.64, f ≈ 0.774.
        // Requirement: worst-case realised runway is at least 5 days
        // (86400 blocks at 5 s).
        uint256 T = _worstCaseSurvival(120960);
        emit log_named_uint("observed seconds at 5 s blocks", T * 5);
        assertGe(T, 86400, "7 d grace survived less than 5 days");
    }

    function test_survival_worstCasePrice_sepolia1h() public {
        // graceBlocks = 300 (1 h at 12 s blocks). λ·G ≈ 0.0016, f ≈ 0.9992.
        _worstCaseSurvival(300);
    }

    function test_survival_worstCasePrice_shortGrace() public {
        uint64 grace = 12;
        VolumeRegistry reg12 = new VolumeRegistry(address(stamp), address(bzz), grace);

        _setLargePrice(24000);

        bzz.mint(PAYER, 1e40);
        vm.prank(PAYER);
        bzz.approve(address(reg12), type(uint256).max);
        vm.prank(OWNER);
        reg12.designateFundingWallet(PAYER);
        vm.prank(PAYER);
        reg12.confirmAuth(OWNER);
        vm.prank(OWNER);
        bytes32 volumeId = reg12.createVolume(CHUNK_SIGNER, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
        bytes32 id = reg12.getVolume(volumeId).batchId;

        uint256 bound = _computeFloorBlocks(grace);
        // f very close to 1 because λ·G is tiny; with G=12 and ROUND=152,
        // the volume dies mid-first-round before any price jump triggers.
        // Walk block-by-block.
        uint64 start = uint64(block.number);
        for (uint256 i = 1; i <= uint256(grace) + 2; ++i) {
            _roll(1);
            (,,,, uint256 nb,) = stamp.batches(id);
            if (nb <= stamp.currentTotalOutPayment()) {
                uint256 T = block.number - start;
                assertGe(T, bound, "short-grace survival floor");
                return;
            }
        }
        revert("short-grace test did not observe batch death");
    }

    function test_survival_flatPrice_exactGrace() public {
        // Hold price constant. T should equal graceBlocks exactly (floor met
        // with equality up to 1-block rounding).
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * 4);
        bytes32 id = _batchOf(_createDefaultVolume(OWNER, CHUNK_SIGNER));

        uint64 startBlock = uint64(block.number);
        // Roll one block at a time checking batch liveness.
        for (uint256 i = 1; i <= uint256(GRACE_BLOCKS) + 2; ++i) {
            _roll(1);
            (,,,, uint256 nb,) = stamp.batches(id);
            if (nb <= stamp.currentTotalOutPayment()) {
                uint256 T = block.number - startBlock;
                // With flat price, exhaustion should land at exactly
                // graceBlocks (±1 for Postage's strict-less-than expiry).
                assertGe(T, uint256(GRACE_BLOCKS));
                assertLe(T, uint256(GRACE_BLOCKS) + 1);
                return;
            }
        }
        revert("flat price: batch did not die by graceBlocks+2");
    }

    function test_survival_fallingPrice_exceedsGrace() public {
        _activateAccount(OWNER, PAYER, _expectedCreateCharge(DEFAULT_DEPTH) * 4);
        bytes32 id = _batchOf(_createDefaultVolume(OWNER, CHUNK_SIGNER));

        uint64 startBlock = uint64(block.number);
        // Halve price after the first round — accelerates survival.
        _roll(ROUND_LENGTH);
        uint256 p = uint256(stamp.lastPrice());
        stamp.setPrice(p / 2);

        // Now roll until death; should exceed bare graceBlocks by a healthy
        // margin.
        uint256 cap = uint256(GRACE_BLOCKS) * 4;
        for (uint256 i = 0; i < cap; ++i) {
            _roll(1);
            (,,,, uint256 nb,) = stamp.batches(id);
            if (nb <= stamp.currentTotalOutPayment()) {
                uint256 T = block.number - startBlock;
                assertGt(T, uint256(GRACE_BLOCKS), "falling price did not extend survival");
                return;
            }
        }
        // Survived the whole cap → also a pass.
    }
}

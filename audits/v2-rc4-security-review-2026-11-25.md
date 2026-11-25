# VolumeRegistry v2-rc4 security review

- **Date:** 2026-11-25
- **Reviewed commit:** `665472e8e11504d07ea3b92cb16e32fd2acd71ad`
- **Release context:** testnet v2-rc4; proposed production mainnet v2
- **Source comparison:** contract source matches `v2-rc4`
- **Recommendation:** resolve the survival-guarantee issue and release-validation gaps before mainnet v2.

## Attribution and review configuration

This report was produced by **OpenAI Codex using GPT-6-Astra with high reasoning effort**, as reported by the user from the interface settings for this session. The audit was automated: the agent inspected source code, selected and executed analysis tools, wrote reproduction tests, interpreted results, assigned severity ratings, and authored the report. No independent human auditor review or sign-off is recorded in this work. Human approval of network access was execution authorization, not validation of the findings.

| Configuration item | Details |
|---|---|
| Agent/model identification | OpenAI Codex; interface model name **GPT-6-Astra**, as reported by the user. The exact backend model snapshot was not exposed to the agent. |
| Inference settings | Reasoning effort: **high**, as reported by the user from the interface. Temperature, sampling parameters, and seed were not exposed to the agent and are not asserted here. |
| Review execution | One agent, with no delegated subagents. Agent-directed source review, static analysis, local tests, an isolated authorization mutation experiment, and read-only mainnet fork access. |
| Workspace | Local Linux repository workspace using Bash; repository and `/tmp` writes permitted. Network access was restricted by default and approved for tool installation and Gnosis RPC checks. |
| Foundry | Forge 1.8.6, commit `6bad0a66de7c83f7b33695044138f0f5fa4c5990`, distribution build. |
| Solidity build | Solidity 0.8.19; optimizer enabled with 200 runs; `via_ir = true`; EVM target `paris`, as configured in `contracts/foundry.toml`. |
| Static analyzer | Trail of Bits Slither 0.11.6; 102 detectors; output filtered to exclude `lib/`, `test/`, and `script/` paths. Relevant dependency source was separately inspected by the agent. |
| Invariant execution | Existing campaigns: 256 runs / 128,000 calls per campaign. Isolated authorization mutation experiment: 32 runs with depth 100, totaling 3,200 calls. |
| Mainnet validation | Gnosis Chain, chain ID 100, pinned block 49,456,961, using `https://rpc.gnosischain.com`. Transactions were simulated locally; none were broadcast. |
| External reference | Solidity's official known-bug list was consulted for compiler-risk assessment. |

Findings and severity ratings are AI-generated assessments supported by the evidence described in this report. Tool results and passing tests provide bounded evidence; this review does not constitute formal verification or independent human security certification.

## Scope and conclusion

The review covered `VolumeRegistry`, its interfaces, tests, deployment parameters, and relevant Postage/BZZ interactions. The `services/` directory was excluded. Vendored dependencies were examined for integration risks, not comprehensively audited.

No confirmed critical- or high-severity exploit or unauthorized payer-drain path was found under the configured dependency assumptions. This conclusion is limited to the reviewed source, dependency assumptions, and validation described below; it is not a guarantee that all vulnerabilities have been identified.

Production contract source was not modified. Reproducible audit witnesses were added separately.

## Findings

### AUD-01 — Oracle catch-up invalidates the documented minimum survival guarantee

**Severity:** Medium

**Status:** Reproduced; unresolved

**Locations:** [VolumeRegistry.sol:157](../contracts/src/VolumeRegistry.sol#L157), [PriceOracle.sol:130](../contracts/lib/storage-incentives/src/PriceOracle.sol#L130), [survival specification](../docs/DESIGN.md#101-deviation-bound-for-graceblocks--17280).

Funding uses the current `postage.lastPrice()`, but the upstream oracle can apply accumulated price increases for previously missed rounds in one normal `adjustPrice()` call.

The following sequence was reproduced with the real vendored contracts:

1. Leave normal oracle updates absent for 1,000 rounds.
2. Create a volume with `graceBlocks = 120960`, priced at 24,000.
3. Execute the oracle's ordinary catch-up adjustment.
4. The price becomes 53,493, and the batch expires after **54,270 blocks**, approximately **3.14 days** at five seconds per block.

This violates the documented five-day minimum for the seven-day configuration. No malicious administrator price override is necessary. Existing survival tests simulate price increases starting after creation and miss the accumulated-update case.

**Impact:** consumers relying on the stated minimum runway can lose batch availability earlier than expected. A keeper can also encounter a much larger funding requirement immediately after catch-up.

**Recommendation:** make oracle freshness/backlog an explicit precondition for any guaranteed runway, or use a conservative funding calculation that accounts for pending adjustments. Test the actual oracle across delayed updates and round boundaries. Without such controls, describe runway as a current-price estimate rather than an unconditional minimum.

**Witness:** `test_audit_oracleCatchupBreaksSevenDaySurvivalFloor` in [AuditRegression.t.sol](#appendix-a-local-audit-witnesses).

### AUD-02 — Raising Postage's validity floor disables registry renewal

**Severity:** Medium; acknowledged dependency risk

**Status:** Reproduced; already acknowledged in the design

**Location:** [VolumeRegistry.sol:310](../contracts/src/VolumeRegistry.sol#L310).

The constructor checks `graceBlocks >= minimumValidityBlocks()` only once. Subsequent topups continue targeting immutable `graceBlocks`.

A valid volume becomes impossible to renew after the Postage administrator raises the minimum above that target. `trigger()` reverts with `InsufficientBalance`; the payer transfer rolls back, and the batch eventually expires. Creation also becomes unavailable.

**Impact:** deployment-wide availability loss, potentially followed by batch expiry. This requires an upstream administrative change.

**Recommendation:** explicitly accept this dependency risk with monitoring and a tested migration/direct-topup procedure, or redesign how an increased minimum is handled. Automatically spending more requires careful consideration of payer authorization.

**Witness:** `test_audit_raisedFloorBlocksRenewalAndEventuallyRetires` in [AuditRegression.t.sol](#appendix-a-local-audit-witnesses).

### AUD-03 — Existing mainnet fork suite fails before exercising the registry

**Severity:** Medium release-validation gap; not a demonstrated contract exploit

**Status:** Reproduced; original suite unresolved

**Location:** [ForkRegistry.t.sol:121](../contracts/test/fork/ForkRegistry.t.sol#L121).

The fork setup calls `PostageStamp.priceOracle()`. That getter is absent from the vendored implementation and its mainnet ABI.

The actual Gnosis fork run at block **49,456,961** failed in `setUp()`. Ordinary local runs report seven passing fork tests because the tests return early when the fork is unavailable.

**Impact:** a passing local suite does not establish production dependency compatibility, and the existing fork suite cannot provide that evidence in its current form.

**Recommendation:** remove the unsupported getter assumption, obtain any required oracle address explicitly, and make required fork jobs fail when configuration is missing. Use explicit skips for optional local runs.

A separate audit fork witness successfully exercised creation, import, topup, same-block idempotence, and revocation against actual Gnosis BZZ/Postage state with both **17,280- and 120,960-block configurations**. This establishes useful compatibility evidence but does not repair the original suite.

**Witnesses:** `test_audit_postageHasNoPriceOracleGetter` in [AuditRegression.t.sol](#appendix-a-local-audit-witnesses), and [AuditMainnet.t.sol](#appendix-b-mainnet-fork-witness).

### AUD-04 — Spending invariants trust the events they should independently validate

**Severity:** Low assurance gap; not a demonstrated contract exploit

**Status:** Confirmed by isolated mutation testing

**Location:** [PayerHandler.sol:185](../contracts/test/invariants/PayerHandler.sol#L185).

The handler adds the contract-emitted `Toppedup.amount` to allowed spending without independently establishing the corresponding authorization and permissible charge.

In an isolated `/tmp` copy, removing `_triggerOne`'s active-account authorization check still allowed `RevokedOwnerSpendsZeroInvariant` to pass **32 runs and 3,200 calls**. The dedicated revocation unit test correctly failed.

**Impact:** the invariant suite offers less security assurance than its names and comments imply. This is a testing weakness, not evidence that the actual authorization check is broken.

**Recommendation:** calculate expected spending from pre-call account, batch, price, allowance, and balance snapshots. Independently assert zero spending for inactive accounts and compare event amounts against that calculation. Include every handler path that can spend.

The authorization mutation was confined to the temporary copy; repository production source was not changed.

### AUD-05 — Constructor accepts inconsistent Postage/token wiring

**Severity:** Low

**Status:** Reproduced; unresolved

**Location:** [VolumeRegistry.sol:83](../contracts/src/VolumeRegistry.sol#L83).

The constructor does not establish that `_bzz` equals Postage's `bzzToken()`.

A test deployed a registry with a different, otherwise valid ERC20. Deployment succeeded, but creation failed when Postage attempted to pull its own token. Transfers rolled back atomically.

**Impact:** an incorrectly configured, immutable deployment can be unusable. This is a deployment-error risk, not an arbitrary-user exploit.

**Recommendation:** enforce token-address equality and deployed-code checks during construction or mandatory deployment validation.

**Witness:** `test_audit_wrongTokenAcceptedButCreateFailsAtomically` in [AuditRegression.t.sol](#appendix-a-local-audit-witnesses).

## Additional release considerations

### Immutable runway configuration

[deployments.toml:21](../contracts/deployments.toml#L21) selects **17,280 blocks**, while the design proposes **120,960** for Gnosis v2. Using the existing profile would deploy a one-day target. Select and verify the intended immutable value explicitly.

### Compiler assurance

The build pins optimized, via-IR Solidity **0.8.19** in [foundry.toml](../contracts/foundry.toml). Solidity's known-bug list, consulted during this review, includes `SOL-2026-7` (`YulOptimizerKnowledgeBaseStaleBookkeeping`), affecting that optimizer/version combination and fixed in 0.8.38.

No miscompilation was demonstrated in this contract. This remains a build-assurance concern requiring compiler upgrade validation or a documented applicability analysis. See the [Solidity known-bug list](https://docs.soliditylang.org/en/latest/bugs.html).

## Accepted security boundaries

- An authorized owner can consume the payer's available registry allowance. The registry does not independently enforce spending budgets.
- Shared-batch payment depends on trigger ordering.
- Permissionless registration permits active-set spam.
- Postage pauses, administrative changes, and token implementation changes affect availability.
- Batched triggers do not isolate every dependency failure; a reverting item can roll back the entire call.

These boundaries should be explicitly accepted for production operation. They are not additional newly demonstrated unauthorized-spend vulnerabilities.

## Validation performed

| Check | Result |
|---|---|
| Existing suite | 132 reported passes, including seven fork no-ops |
| Existing invariant campaigns | 256 runs / 128,000 calls per campaign |
| Added local audit witnesses | Four passed |
| Existing Gnosis fork suite | Failed in setup at block 49,456,961 |
| Added pinned Gnosis fork witness | Passed for both runway configurations |
| Authorization mutation experiment | Exposed invariant weakness; dedicated unit test detected mutation |
| Slither 0.11.6 | 102 detectors; 26 alerts reviewed and triaged by the AI agent |

The pinned Gnosis fork reported a minimum validity of **17,280 blocks** and a price of **207,270**. Fork transactions were simulated locally; no transactions were broadcast.

### Static-analysis triage

Slither's arbitrary-transfer alerts are constrained by the bilateral account authorization. Its reentrancy alerts require callbacks from configured dependencies; no attacker-controlled callback path was found in the reviewed implementations. Timestamp, loop, and equality alerts did not establish additional exploits. Compiler-version considerations are addressed separately above.

| Slither detector | Alerts |
|---|---:|
| `arbitrary-send-erc20` | 2 |
| `incorrect-equality` | 1 |
| `reentrancy-no-eth` | 1 |
| `unused-return` | 3 |
| `calls-loop` | 9 |
| `reentrancy-benign` | 2 |
| `reentrancy-events` | 2 |
| `timestamp` | 4 |
| `costly-loop` | 1 |
| `solc-version` | 1 |

## Reproduction

To reproduce the audit witnesses, use a disposable checkout of the reviewed commit and save the Solidity blocks in Appendices A and B at their specified paths. The witness source is preserved in this report; it is not installed in the repository test suite by this report-only change. Run the commands below from that checkout's `contracts/` directory.

Existing local suite:

```sh
forge test --summary
```

Added local audit witnesses:

```sh
forge test --match-contract AuditRegressionTest -vv
```

Added audit witness against the pinned Gnosis fork:

```sh
forge test --match-contract AuditMainnetTest \
  --fork-url https://rpc.gnosischain.com \
  --fork-block-number 49456961 -vv
```

Reproduce the original fork-suite setup failure:

```sh
FORK_POSTAGE_STAMP=0x45a1502382541Cd610CC9068e88727426b696293 \
FORK_BZZ=0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da \
FORK_BZZ_PERMIT_EXPIRY=true \
forge test --match-contract ForkRegistryTest \
  --fork-url https://rpc.gnosischain.com \
  --fork-block-number 49456961 -vv
```

Fork reproduction requires an RPC endpoint that serves the pinned block. The added fork test explicitly skips when run without Gnosis chain state.

## Audit evidence

- [AuditRegression.t.sol](#appendix-a-local-audit-witnesses): four local witnesses covering oracle catch-up, raised validity floor, mismatched token wiring, and the absent oracle getter.
- [AuditMainnet.t.sol](#appendix-b-mainnet-fork-witness): production-dependency integration witness for both runway configurations.

Production contract source remains unchanged. Findings have been reported and reproduced; remediation has not been implemented as part of this review.

## Appendix A: Local audit witnesses

Save as `contracts/test/AuditRegression.t.sol` in the disposable checkout.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {RegistryFixture} from "./fixtures/RegistryFixture.sol";
import {VolumeRegistry} from "../src/VolumeRegistry.sol";
import {PostageStamp} from "storage-incentives/src/PostageStamp.sol";
import {TestToken} from "storage-incentives/src/TestToken.sol";
import {IVolumeRegistryViews} from "../src/interfaces/IVolumeRegistryViews.sol";

/// @notice Audit witnesses of dependency and deployment assumptions; no production changes.
contract AuditRegressionTest is RegistryFixture {
    function test_audit_oracleCatchupBreaksSevenDaySurvivalFloor() public {
        stamp.grantRole(stamp.PRICE_ORACLE_ROLE(), address(oracle));
        oracle.grantRole(oracle.PRICE_UPDATER_ROLE(), address(this));
        stamp.setPrice(oracle.currentPrice());
        registry = new VolumeRegistry(address(stamp), address(bzz), 120960, false);
        _activateAccount(OWNER, PAYER, 1e30);

        // Normal price updates have been absent for 1000 rounds. Postage
        // still exposes the old price when the volume is funded.
        _roll(152 * 1000);
        uint256 oldPrice = stamp.lastPrice();
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        bytes32 batchId = _batchOf(id);
        assertTrue(oracle.adjustPrice(1));
        uint256 newPrice = stamp.lastPrice();
        assertGt(newPrice, oldPrice * 2);

        uint256 remaining = _remaining(batchId);
        uint256 lifetime = (remaining + newPrice - 1) / newPrice;
        emit log_named_uint("price before catchup", oldPrice);
        emit log_named_uint("price after catchup", newPrice);
        emit log_named_uint("actual lifetime blocks", lifetime);
        assertLt(lifetime, 86400, "less than the claimed five-day minimum");
        _roll(lifetime);
        registry.trigger(id);
        assertEq(uint8(registry.getVolume(id).status), uint8(IVolumeRegistryViews.Status.Retired));
    }

    function test_audit_raisedFloorBlocksRenewalAndEventuallyRetires() public {
        _activateAccount(OWNER, PAYER, 1e30);
        bytes32 id = _createDefaultVolume(OWNER, CHUNK_SIGNER);
        _roll(1);
        stamp.setMinimumValidityBlocks(GRACE_BLOCKS + 1);
        uint256 beforeBalance = bzz.balanceOf(PAYER);
        vm.expectRevert(PostageStamp.InsufficientBalance.selector);
        registry.trigger(id);
        assertEq(bzz.balanceOf(PAYER), beforeBalance);
        _roll(GRACE_BLOCKS);
        registry.trigger(id);
        assertEq(uint8(registry.getVolume(id).status), uint8(IVolumeRegistryViews.Status.Retired));
    }

    function test_audit_wrongTokenAcceptedButCreateFailsAtomically() public {
        TestToken other = new TestToken("Other", "OTHER", 0);
        VolumeRegistry miswired =
            new VolumeRegistry(address(stamp), address(other), GRACE_BLOCKS, false);
        vm.prank(OWNER);
        miswired.designateFundingWallet(PAYER);
        vm.prank(PAYER);
        miswired.confirmAuth(OWNER);
        other.mint(PAYER, 1e30);
        vm.prank(PAYER);
        other.approve(address(miswired), type(uint256).max);
        vm.prank(OWNER);
        vm.expectRevert();
        miswired.createVolume(CHUNK_SIGNER, DEFAULT_DEPTH, DEFAULT_BUCKET, 0, false);
        assertEq(other.balanceOf(PAYER), 1e30);
        assertEq(miswired.getActiveVolumeCount(), 0);
    }

    function test_audit_postageHasNoPriceOracleGetter() public view {
        (bool ok,) = address(stamp).staticcall(abi.encodeWithSignature("priceOracle()"));
        assertFalse(ok);
    }
}
```

## Appendix B: Mainnet fork witness

Save as `contracts/test/fork/AuditMainnet.t.sol` in the disposable checkout.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {VolumeRegistry} from "../../src/VolumeRegistry.sol";
import {IPostageStampLike} from "../../src/interfaces/IPostageStampLike.sol";
import {IERC20Like} from "../../src/interfaces/IERC20Like.sol";

/// @notice Run explicitly on a Gnosis fork; all transfers are local simulations.
contract AuditMainnetTest is Test {
    address constant POSTAGE = 0x45a1502382541Cd610CC9068e88727426b696293;
    address constant BZZ = 0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da;

    function test_audit_mainnet_createImportTopupAndRevoke() public {
        if (block.chainid != 100 || POSTAGE.code.length == 0) {
            vm.skip(true);
            return;
        }
        IPostageStampLike stamp = IPostageStampLike(POSTAGE);
        IERC20Like token = IERC20Like(BZZ);
        (bool oracleGetter,) = POSTAGE.staticcall(abi.encodeWithSignature("priceOracle()"));
        assertFalse(oracleGetter, "reassess fork setup finding if dependency changes");
        (bool ok, bytes memory result) = POSTAGE.staticcall(abi.encodeWithSignature("bzzToken()"));
        assertTrue(ok);
        assertEq(abi.decode(result, (address)), BZZ);
        emit log_named_uint("fork block", block.number);
        emit log_named_uint("minimum validity", stamp.minimumValidityBlocks());
        emit log_named_uint("price", stamp.lastPrice());
        _exercise(stamp, token, 17280);
        _exercise(stamp, token, 120960);
    }

    function _exercise(IPostageStampLike stamp, IERC20Like token, uint64 grace) internal {
        VolumeRegistry registry = new VolumeRegistry(POSTAGE, BZZ, grace, true);
        address owner = makeAddr("audit owner");
        address payer = makeAddr("audit payer");
        deal(BZZ, payer, 1e30);
        vm.prank(payer);
        token.approve(address(registry), type(uint256).max);
        vm.prank(owner);
        registry.designateFundingWallet(payer);
        vm.prank(payer);
        registry.confirmAuth(owner);
        uint256 beforeBalance = token.balanceOf(payer);
        vm.prank(owner);
        bytes32 id = registry.createVolume(owner, 20, 16, 0, false);
        assertEq(
            beforeBalance - token.balanceOf(payer), uint256(stamp.lastPrice()) * grace * (1 << 20)
        );
        assertEq(token.balanceOf(address(registry)), 0);
        assertEq(token.allowance(address(registry), POSTAGE), 0);
        vm.roll(block.number + 5);
        beforeBalance = token.balanceOf(payer);
        registry.trigger(id);
        assertEq(beforeBalance - token.balanceOf(payer), uint256(stamp.lastPrice()) * 5 * (1 << 20));
        beforeBalance = token.balanceOf(payer);
        registry.trigger(id);
        assertEq(token.balanceOf(payer), beforeBalance);
        vm.roll(block.number + 5);
        bytes32 batchId = registry.getVolume(id).batchId;
        vm.prank(owner);
        bytes32 imported = registry.importVolume(batchId, 0);
        assertEq(beforeBalance - token.balanceOf(payer), uint256(stamp.lastPrice()) * 5 * (1 << 20));
        vm.prank(payer);
        registry.revoke(owner);
        beforeBalance = token.balanceOf(payer);
        vm.roll(block.number + 5);
        registry.trigger(imported);
        assertEq(token.balanceOf(payer), beforeBalance);
        emit log_named_uint("verified grace blocks", grace);
    }
}
```

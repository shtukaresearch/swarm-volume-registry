# ADR-0007: Keeper endpoints revert only on out-of-gas, a paused Postage, or a bug

Status: Accepted

## Context

`trigger(bytes32[])` wraps each id in `try this._triggerExt(id) {} catch {}`, and step 8 of `trigger` wraps `bzz.transferFrom` in `try/catch`. Both catches absorb out-of-gas along with the conditions they were meant for. A batch that runs short of gas succeeds while topping up nothing from that point on, and `eth_estimateGas` converges on the cost of discarding failures rather than the cost of the work ([#2](https://github.com/shtukaresearch/swarm-volume-registry/issues/2)).

A catch can only absorb out-of-gas selectively if it can recognise the condition it is meant for. The production BZZ token cannot be recognised that way. Gnosis BZZ (`0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da`) is an EIP-1967 proxy over the OmniBridge `PermittableToken` (`0xf8D1677c8a0c961938bf2f9aDc3F3CFDA759A9d9`, solc 0.4.24). Its `SafeMath.sub` uses `assert`, which before Solidity 0.8 compiled to `INVALID`. An insufficient balance or finite allowance therefore halts exceptionally: empty returndata and all forwarded gas consumed, leaving the caller about 2/64 of what it had. Its third account-specific failure, an expired permit (below), is a bare `require` with empty returndata. All three are indistinguishable from out-of-gas at the catch site. The Sepolia token (`0x543dDb01Ba47acB11de34891cD86B675F04840db`, OpenZeppelin 4.8.2 `ERC20PresetMinterPauser`) reverts with reason strings, but a design that only works on the testnet token does not help.

`PermittableToken` also implements a legacy DAI-style `permit(holder, spender, nonce, expiry, allowed, v, r, s)`. With `allowed = true` it sets the ordinary allowance to `uint256(-1)` and records `expirations[holder][spender] = expiry`. `allowance()` does not consult `expirations`; `transferFrom` does, on the unlimited-allowance branch only. After a non-zero expiry passes, `allowance()` still reports `2^256-1` while every `transferFrom` by that spender reverts. Setting an unlimited allowance through any other path clears the expiry; `transferFrom` never decrements an unlimited allowance, so a payer in this state stays in it. `expirations` is not part of ERC-20 and does not exist on the Sepolia token.

## Decision

The keeper-facing endpoints are `trigger(bytes32)`, `trigger(bytes32[])` and `reap`. They do not revert on any state of a volume, account or payer. They revert only on:

- out-of-gas;
- a paused PostageStamp;
- a condition that indicates a bug in VolumeRegistry or PostageStamp.

Account-specific conditions — including account state in the VolumeRegistry itself and in the token contract — are detected by reading state before acting, not by catching a revert. This implies that no keeper-facing path need contain a `try/catch`. Endpoints for owners and payers are unaffected and keep reverting with named errors. A contract-facing variant of `trigger` that reverts on non-success outcomes may be added later, on the pattern of `importVolume` ([ADR-0004](./0004-register-and-import-entry-points.md)).

Concretely:

- `trigger(bytes32)` on an id with no volume record (status `None`) emits `TopupSkipped(NotFound)`, and on a Retired volume emits `TopupSkipped(NotActive)`, and returns, instead of reverting `VolumeNotActive`. `SkipReason` gains `NotFound` and `NotActive` as its next values. The two are distinguished because an id that never existed points to a fault in the keeper's input, whereas a retired id is an ordinary race with retirement.
- `trigger(bytes32[])` calls the trigger logic directly for each id. `_triggerExt` is removed.
- Before `transferFrom`, the trigger logic checks `bzz.balanceOf(payer) >= amount` and `bzz.allowance(payer, this) >= amount`, and, when `bzzPermitExpiry` is set and the allowance is `type(uint256).max`, `expirations(payer, this) == 0 || expirations(payer, this) >= block.timestamp`. If any check fails it emits `TopupSkipped(PaymentFailed)` and returns. Otherwise it calls `transferFrom` uncaught.
- `bzzPermitExpiry` is an immutable constructor argument, set per deployment: `true` for Gnosis BZZ, `false` for Sepolia. When `true`, the constructor calls `expirations(address(0), address(0))` uncaught, so a deployment against a token without it fails at deploy time.
- `registerVolume` rejects a batch with `depth <= postage.minimumBucketDepth()`. `createBatch` enforces this; the admin-only `copyBatch` does not.

### Exceptional conditions

Enumerated against PostageStamp at `0x45a1502382541Cd610CC9068e88727426b696293` (Gnosis) and `0xcdfdC3752caaA826fE62531E0000C40546eC56A6` (Sepolia), both solc 0.8.19 with identical `topUp`, and the two BZZ tokens above.

| Source | Condition | Class | Handling |
|---|---|---|---|
| Registry | Volume id never registered | keeper input | `TopupSkipped(NotFound)` |
| Registry | Volume Retired, including earlier in the same batch | account state | `TopupSkipped(NotActive)` |
| Registry | Batch dead, owner mismatch, depth changed, TTL passed | account state | `VolumeRetired` (unchanged) |
| Registry | Account not active | account state | `TopupSkipped(NoAuth)` (unchanged) |
| Registry | Zero deficit | account state | silent no-op (unchanged) |
| Registry | `_retire` index fault, `Panic(0x32)` | bug | revert |
| BZZ | Payer balance below `amount` | account state | precheck, `TopupSkipped(PaymentFailed)` |
| BZZ | Finite allowance below `amount` | account state | precheck, `TopupSkipped(PaymentFailed)` |
| BZZ (Gnosis) | Unlimited allowance with expired legacy permit | account state | precheck, `TopupSkipped(PaymentFailed)` |
| BZZ | `transferFrom` reverts after the precheck passed | bug | revert |
| BZZ | `approve` returns false or reverts | bug | revert |
| BZZ (Sepolia) | Token paused | global state | revert |
| PostageStamp | `currentTotalOutPayment()` overflow, `Panic(0x11)` | bug | revert |
| PostageStamp | `topUp` while paused, `Error("Pausable: paused")` | global state | revert |
| PostageStamp | `topUp` → `BatchDoesNotExist`, `BatchExpired` | bug: step 2 checks the same state in the same transaction | revert |
| PostageStamp | `topUp` → `BatchTooSmall` | bug once `registerVolume` rejects such batches | revert |
| PostageStamp | `topUp` → `InsufficientBalance` | bug: `minimumValidityBlocks` raised above `graceBlocks` | revert |
| PostageStamp | `topUp` → `TransferFailed` | bug: neither token returns false | revert |
| EVM | Out of gas | — | revert |

## Consequences

- A reverted keeper transaction means out-of-gas, a paused PostageStamp (or paused Sepolia BZZ), or a bug. A paused PostageStamp is easily detected through other channels, and we do not expect bugs to be easy to handle; only OOG is routine.
- `eth_estimateGas` can meaningfully estimate the gas cost of batch trigger. A single failed BZZ transfer cannot consume the entire gas balance.
- In a successful transaction every id emits exactly one of `Toppedup`, `TopupSkipped` or `VolumeRetired`, except a zero-deficit id, which emits nothing.
- `trigger(bytes32)` no longer reverts on an inactive volume. DESIGN §8 step 1 and the step 8 `try` change accordingly.
- The precheck duplicates the token's own conditions. It is correct only for the token implementations enumerated above. The Gnosis token is upgradeable by the bridge; a new account-specific revert path in a future implementation would revert whole batches until the precheck is extended.
- Adding `bzzPermitExpiry` changes the constructor arguments and so the CREATE2 address of new deployments. Existing deployments are unaffected. Reading an immutable costs a `PUSH`, not an `SLOAD`.
- The precheck adds two or three static calls per top-up. `transferFrom` then reads the same slots warm.
- Limitation: the constructor checks `graceBlocks >= minimumValidityBlocks`, but PostageStamp's admin can raise `minimumValidityBlocks` later. Every top-up on that deployment then reverts `InsufficientBalance`.
- Limitation: `copyBatch` batches with `depth <= minimumBucketDepth` cannot be registered.

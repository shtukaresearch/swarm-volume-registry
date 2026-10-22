# ADR-0004: Two entry points: `registerVolume` (record only) and `importVolume` (record + topup, atomic)

Status: Accepted

## Context

A minted volume is born funded to the `graceBlocks` target, so the survival bound (I6) holds from creation. An imported batch's balance is whatever it already has and may be thin; until its first funded trigger, no bound holds. Topping up in the same transaction closes that gap, but some callers want the record alone: a batch with a long runway already, many registrations to be funded later by one batched `trigger`, or registration while Postage is paused.

If the topup at import fails, the call could degrade like `trigger` does (emit `TopupSkipped` and keep the volume) or revert. Degrading leaves a caller who asked for a funded volume holding an unfunded one, discovered only from events.

## Decision

Two entry points with the same preconditions and record-writing path:

- `registerVolume(batchId, ttlExpiry)` writes the volume record and moves no BZZ.
- `importVolume(batchId, ttlExpiry)` writes the record and then runs the trigger logic on it in the same transaction. It succeeds only if that ends in a topup or in the zero-deficit no-op; any other outcome reverts the whole call.

Internally the trigger logic reports its outcome (Retired, Skipped, NoDeficit, ToppedUp). The external `trigger` treats every outcome as success, exactly as before; `importVolume` accepts only NoDeficit and ToppedUp.

## Consequences

- I13: `importVolume` either leaves an Active volume whose batch is at or above target, or changes no state (no record, no nonce consumed, no active-set entry).
- I6 holds from import for `importVolume`; `registerVolume` carries no survival guarantee until the volume's first successful topup.
- `NoAuth` cannot occur inside `importVolume`, because the account check ran earlier in the same transaction. `PaymentFailed`, a past `ttlExpiry` (retires `VolumeExpired`), and a Postage `topUp` revert all revert the import.
- `registerVolume` accepts a past `ttlExpiry`, as `createVolume` does; the volume retires on its first trigger.
- TTL keeps the existing convention: `uint64`, `0 = no expiry`.
- Symmetry: `createVolume` is mint + register, `importVolume` is register + trigger.

# ADR-0005: Status and reason codes as enums, not public constants

Status: Accepted

## Context

A volume's status (`VolumeView.status`) and the reasons carried by `VolumeRetired` and `TopupSkipped` were `uint8` fields, with their values defined as constants: `STATUS_ACTIVE`/`STATUS_RETIRED` internal, `REASON_*` and `SKIP_*` public. Every set started at 1 so that 0 could mean "unset" (`getVolume` on an unknown ID returns status 0). Nothing recorded why constants were chosen over enums.

Clients need a code → name table to decode these fields. Neither representation puts that table in the ABI:

- A public constant contributes a getter (`REASON_BATCH_DIED()`) whose name is in the ABI but whose value is not.
- An enum contributes nothing to the ABI beyond the `internalType` string (`enum IVolumeRegistryViews.RetireReason`) on each field of that type; the canonical type is `uint8`. abitype, and so viem and the wagmi CLI, ignores `internalType` and types the field as `number`.

Both are recoverable from the solc AST in the Foundry artifacts. Enums carry more there: member order fixes the values without parsing literals, and the `internalType` on each event or struct field names the table that decodes it. With constants, nothing links `VolumeRetired.reason` to the `REASON_*` set.

## Decision

Declare three enums in `IVolumeRegistryViews` and type the fields with them:

- `Status { None, Active, Retired }` for `VolumeView.status` and the stored volume status;
- `RetireReason { None, OwnerDeleted, VolumeExpired, BatchDied, DepthChanged, BatchOwnerMismatch }` for `VolumeRetired.reason`;
- `SkipReason { None, NoAuth, PaymentFailed }` for `TopupSkipped.reason`.

Each leading `None` keeps every other value equal to its old constant. Remove the `REASON_*` / `SKIP_*` constants and their getters.

## Consequences

- Wire encoding, event topic hashes and function selectors are unchanged: the fields are still `uint8` with the same values. Existing hand-written decode tables (keeper, indexer) stay correct.
- The `REASON_*` and `SKIP_*` getter functions disappear from the ABI. This is a breaking change for any caller of those getters; it ships with the other ABI breaks in `v2-rc3`.
- Inside the contract an out-of-range status or reason cannot be constructed.
- `RetireReason.None` and `SkipReason.None` are never emitted; they exist only to preserve the values.
- Generating name tables for clients still needs a step that reads the AST; ABI-only codegen yields plain numbers.

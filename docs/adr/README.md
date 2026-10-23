# Architecture Decision Records — contracts

The rationale behind changes to the `VolumeRegistry` contract. [`../DESIGN.md`](../DESIGN.md) states *what* the design is; each record here says *why*, with the alternatives weighed and the consequences accepted. The indexer keeps its own series in [`services/indexer/docs/adr/`](../../services/indexer/docs/adr/); numbers are local to each series.

Format per record: **Context** → **Decision** → **Consequences**.

| ADR | Decision |
|---|---|
| [0001](./0001-permissionless-batch-import.md) | Permissionless import of existing Postage batches |
| [0002](./0002-volume-ids-from-owner-nonce.md) | Volume IDs derived from `(owner, nonce)`, decoupled from batch IDs; IDs are terminal |
| [0003](./0003-nonce-in-account.md) | The per-owner nonce lives in `Account`; `confirmAuth` preserves it |
| [0004](./0004-register-and-import-entry-points.md) | Two entry points: `registerVolume` (record only) and `importVolume` (record + topup, atomic) |
| [0005](./0005-codes-as-enums.md) | Status and reason codes as enums, not public constants |

# ADR-0003: The per-owner nonce lives in `Account`; `confirmAuth` preserves it

Status: Accepted

## Context

[ADR-0002](./0002-volume-ids-from-owner-nonce.md) needs a per-owner counter. It can sit in a separate `mapping(address => uint64)` or be packed into `Account`, which is keyed by owner and occupies 21 bytes (`address payer`, `bool active`) of a 32-byte slot. `confirmAuth` currently overwrites the whole `Account` struct, which would reset any field packed into it.

A reset nonce is not harmless: the owner's next registration would derive an ID they have already used, reverting if the existence check catches it and overwriting a live volume's record if it does not.

## Decision

Pack `uint64 nonce` into `Account`. `confirmAuth` writes `payer` and `active` individually and never touches `nonce`; `revoke` already touches only `active`. No transition resets the nonce (I14). The nonce belongs to the owner address, not to the `(owner, payer)` pair: changing payer does not restart it.

## Consequences

- Incrementing the nonce writes a slot that is already non-zero for any owner with an active account (≈2.9k gas) instead of initialising a fresh one (≈20k).
- §6.2's "atomic overwrite of any prior account" becomes "overwrites `payer` and `active`; the nonce is preserved". This is the one place where a careless implementation silently breaks ID uniqueness, so it gets explicit regression tests (re-confirm, re-designate and confirm, revoke and re-confirm) and an invariant matching the nonce to the count of successful volume-creating calls.
- `getAccount` returns the nonce, changing its ABI (already broken by ADR-0002).

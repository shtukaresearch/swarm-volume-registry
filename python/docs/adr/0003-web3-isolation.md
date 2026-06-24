# ADR-0003: Web3 isolation at `event_log`; trusted ABI library + compiled ABI build dep

Status: Accepted

## Context

The pipeline mixes web3 concerns (RPC, topics, ABI-encoded bytes) with pure aggregation.
If web3 details leak into the projection logic, the projector becomes hard to test and
couples to transport. Mechanical ABI decoding is intricate and error-prone if hand-rolled.

## Decision

Wall all web3-dependent code — RPC, the eth API, and ABI decoding — into one layer whose
only output is decoded, web3-free rows in `event_log`. Drive a trusted ABI library
(`eth-abi` / web3.py) with the compiled contract ABI for the mechanical decode; the only
bespoke code is a small per-version mapping (ABI param names → `args` keys, enum ints →
names). Pin the compiled ABI per `registry_version` as a build dependency of `sync` —
either vendored at build/package time or resolved at runtime.

## Consequences

- The projector and its folds are web3-agnostic and testable on hand-authored `event_log`
  rows with zero web3 knowledge. `event_log` is the single seam between web3 and everything
  downstream.
- The mechanical decode rides on a trusted library, so only the per-version mapping needs
  unit tests.
- A contract change becomes a deliberate ABI bump, keyed by version, rather than silent
  drift; the events ABI must be available to `sync` at build or run time.

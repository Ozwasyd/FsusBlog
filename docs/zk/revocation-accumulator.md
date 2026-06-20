# Revocation Accumulator Contract

Status: fail-closed production handoff.

This document records the revocation accumulator boundary for
`fsus.anonymous.comment.v1`. The repository currently has a deterministic
legacy SHA-256 hash-tree accumulator for backend governance and migration
checks. It is not a circuit-friendly non-membership accumulator and must not be
advertised as production ZK ready.

## Metadata Gate

Root lifecycle metadata may describe the accumulator under
`circuitMetadata.revocationAccumulator`:

```json
{
  "layout": 2,
  "revocationAccumulator": {
    "algorithm": "legacy-sha256-hash-tree.v1",
    "productionZkReady": false
  }
}
```

`legacy-sha256-hash-tree.v1` is the only implemented backend accumulator today.
If metadata marks that algorithm with `productionZkReady=true`, rotation fails
closed with `anonymous_credential_revocation_accumulator_not_production_ready`.
Runtime root snapshots used by the production verifier exclude all accumulator
profiles that are not explicitly production compatible.

`circuit-friendly-non-membership.v1` is reserved as an implementation slot. It
is also not production compatible until real backend, prover, verifier, and
fixture tooling exist.

## Legacy Accumulator

The legacy algorithm is implemented by
`AnonymousCredentialRevocationAccumulator`:

- handle: SHA-256 over issuer public key hash and credential binding
- leaf: SHA-256 over epoch, issuer public key hash, and revoked handle
- node/root: SHA-256 domain-separated binary hash tree
- witness: SHA-256 over root, issuer, target handle, and sorted predecessor /
  successor handles

This witness is a backend consistency witness only. It is not a Groth16 witness
for non-membership because SHA-256 and the current neighbor hash semantics are
not the frozen circuit constraints.

## Production Requirements

A production-compatible accumulator must define and test all of the following
before `productionZkReady` can become true:

- accumulator type: for example Poseidon sparse Merkle, RSA accumulator, or
  pairing accumulator
- root encoding: field element or byte encoding used by public inputs
- leaf encoding: credential revocation handle mapping into the accumulator
- non-membership witness encoding: all private witness fields and ordering
- update rules: deterministic root transition after revocation
- verifier contract: native backend and circuit constraints use identical
  semantics
- fixture coverage: deterministic root, positive non-membership, revoked
  negative, and backend/front/circuit cross-stack witness fixtures

Until those pieces exist, ZK-Prod readiness must stay unavailable. Keeping the
legacy accumulator deterministic is useful for migration and operational
bookkeeping, but it is not a production anonymous-comment proof root.

## Complexity Notes

The legacy root recomputes over the sorted revoked handle set, so update cost is
linear in the number of revoked handles after the database read. Witness
construction also depends on the sorted handle list. A production design must
document large-set update complexity and witness size before it is accepted.

# Revocation Accumulator Contract

Status: backend accumulator and frontend witness envelope implemented;
production Groth16 proof consumption is still gated by the trusted setup and
browser prover artifacts.

This document records the revocation accumulator boundary for
`fsus.anonymous.comment.v2`. The repository keeps the deterministic legacy
SHA-256 accumulator for backend governance and migration checks, and adds the
production metadata slot `circuit-friendly-non-membership.v1` for a circuit
friendly sparse Merkle non-membership accumulator.

## Metadata Gate

Root lifecycle metadata describes the accumulator under
`circuitMetadata.revocationAccumulator`:

```json
{
  "layout": 3,
  "revocationAccumulator": {
    "algorithm": "circuit-friendly-non-membership.v1",
    "productionZkReady": true,
    "hash": "mimc7-bn254.v1",
    "tree": "sparse-merkle.v1",
    "depth": 128
  }
}
```

If metadata marks `legacy-sha256-hash-tree.v1` with
`productionZkReady=true`, rotation fails closed with
`anonymous_credential_revocation_accumulator_not_production_ready`. Runtime root
snapshots used by the production verifier exclude all accumulator profiles that
are not explicitly production compatible.

`circuit-friendly-non-membership.v1` is accepted by the backend lifecycle only
when `productionZkReady=true`. The native circuit/prover artifacts must mirror
the exact hash, leaf, node, and witness encodings below before ZK-Prod can be
released.

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

## Circuit-Friendly Sparse Merkle Accumulator

`circuit-friendly-non-membership.v1` is implemented by
`AnonymousCredentialRevocationAccumulator` as a 128-level sparse Merkle tree over
the BN254 scalar field:

- field: BN254 Fr
  `21888242871839275222246405745257275088548364400416034343698204186575808495617`
- hash: MiMC7 over BN254 Fr, 91 rounds, SHA-256-derived round constants under
  domain `fsus.anonymous.revocation.circuit.mimc7.bn254.round.v1`
- tree: sparse Merkle, depth `128`
- root encoding: 32-byte lower-case hex field element
- leaf key: first 128 bits of the normalized revocation handle hash
- empty leaf: MiMC7 hash under
  `fsus.anonymous.revocation.circuit.empty.v1`
- leaf: MiMC7 hash of domain
  `fsus.anonymous.revocation.circuit.leaf.v1`, epoch, issuer public key hash,
  revocation handle hash, and leaf key
- node: MiMC7 hash of domain
  `fsus.anonymous.revocation.circuit.node.v1`, level, left child, and right
  child

The non-membership witness is ordered from leaf level to root level:

- `algorithmId = circuit-friendly-non-membership.v1`
- `pathDepth = 128`
- `leafKey`
- `siblingHashes[0..127]`
- `revocationRootHash`
- `issuerPublicKeyHash`
- `revocationHandleHash`
- `witnessHash`, a MiMC7 binding of root, issuer, handle, leaf key, and sibling
  digest for fixture integrity

The backend fixture verifier shape is implemented by
`VerifyCircuitFriendlyNonMembershipWitness(witness)`. It uses epoch,
`revocationRootHash`, issuer public key hash, target revocation handle hash,
`leafKey`, `siblingHashes[0..127]` and `witnessHash`; it does not require the full revoked handle set. The verifier proves that the target handle maps to
`leafKey`, the leaf at that key is the empty default leaf, and each sibling
reconstructs `revocationRootHash`. Backend service code still rejects exact
revoked handles before witness creation using the epoch's revoked set, but that
database-backed check is not part of the Groth16 witness.

The Groth16 circuit shape is narrower than the backend fixture verifier:
`leafKey` and `siblingHashes[0..127]` are the circuit witness fields that
reconstruct `revocationRootHash`. `witnessHash` binds the fixture for backend and
cross-stack evidence integrity only; it includes a MiMC7 BN254 sibling digest and
is not a circuit input or in-circuit constraint. The circuit source records this as
`witness_hash_role=fixture_integrity_only` and
`witness_hash_circuit_input=false`.

`POST /api/binary/anonymous-credential/revocation-witness` exposes this witness
as AEDS frame `AnonymousCredentialRevocationWitnessResponse` for the browser
prover. The request is strong-anonymous and public-read only: it carries the
epoch, circuit id/numeric id/layout version, issuer public key hash, current
revocation root, and irreversible revocation handle hash. The endpoint rebuilds
the witness from the current root snapshot plus the epoch's revoked handle
hashes; it does not read user/session state and does not create or verify a
Groth16 proof.

The frontend stores the witness as the binary envelope produced by
`encodeCommentPrivacyRevocationWitnessMaterial` and validated by
`parseCommentPrivacyRevocationWitnessMaterial`. The envelope must contain
`algorithmId=circuit-friendly-non-membership.v1`, `pathDepth=128`, a 16-byte
`leafKey`, a 32-byte `witnessHash`, and 128 32-byte sibling hashes. The wasm
prover adapter rejects malformed revocation witness material before calling the
browser prover delegate.

## Update Rules

`AnonymousCredentialRootLifecycleService.RevokeAsync` resolves the accumulator
profile from the active root metadata. For `circuit-friendly-non-membership.v1`
it recomputes the sparse Merkle root from the full revoked handle set plus the
new handle, verifies the operator-supplied root matches that deterministic
transition, writes the revocation row, updates `anonymous_credential_root`, then
invalidates and refreshes the in-memory root snapshot.

The current backend implementation recomputes root state in `O(n * 128)` after
reading the epoch's revoked handles. This keeps proof verification on the hot
path at `O(1)` against the cached accepted-root snapshot. A later scale slice may
add an incremental node store, but it must preserve the exact public root and
witness encodings.

## Complexity Notes

The legacy root recomputes over the sorted revoked handle set, so update cost is
linear in the number of revoked handles after the database read. The circuit
friendly root recomputes over the revoked handle set with a fixed 128-level
sparse tree. Witness size is 128 sibling field elements plus metadata; prover
manifest and AEDS limits must account for that payload when the browser prover
artifact lands.

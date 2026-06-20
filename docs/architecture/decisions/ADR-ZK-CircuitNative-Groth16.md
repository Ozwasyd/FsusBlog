# ADR: ZK anonymous comments use circuit-native credentials and Groth16 proofs

Status: Accepted
Date: 2026-06-20
Scope: ZK-prod anonymous comment cryptography decision

## Context

The previous `comment.v1` direction used BLS12-381 Blind BBS+ credentials with
a bn254 Groth16 comment proof. That boundary is not the production path: proving
BLS12-381 BBS verification inside the bn254 circuit exceeds the browser prover
budget, and keeping a split BBS compatibility layer adds a second proof boundary.

FsusBlog now chooses the highest-performance local path: a circuit-native
credential signature verified directly by the anonymous comment Groth16 circuit.
The design keeps all backend runtime code in .NET, uses no backend JS package,
and keeps GPL pairing-circuit references as reference-only material.

## Decision

FsusBlog selects circuit-native credential v2 plus a Groth16 anonymous comment
proof.

- Anonymous credential scheme: `circuit-native-credential-v2`.
- Credential signature curve: bn254-compatible circuit-native field.
- Proof system: Groth16.
- Comment circuit id: `fsus.anonymous.comment.v2`.
- Public input layout: `public_input_layout_version = 3`.
- Verifying key binding: `verifying_key_hash` is the trusted setup vk hash and
  must be bound to circuit id, layout version, credential root metadata, and
  runtime verifier configuration.

The BBS+ v1 boundary is retired. New code must not introduce a v1 compatibility
layer for anonymous comment production readiness. Existing BBS-specific issuer,
frontend provider, readiness, and docs paths must be transformed to the v2
circuit-native names or removed.

## Credential Lifecycle

1. issue: an authenticated account requests a circuit-native anonymous
   credential. The issuer validates eligibility and signs the credential
   attributes with a circuit-native issuer key.
2. hold: the browser stores the credential secret, issuer key id, credential
   epoch, signature, and membership / revocation witness material locally. The
   server never stores the credential secret or later proof witness.
3. derive proof: for `zk_anonymous` comments, the browser builds the Groth16
   witness and proves credential signature validity, root membership,
   non-revocation, policy buckets, and nullifier binding in one proof.
4. ticket: `POST /api/binary/comment/anonymous-ticket` checks cheap public input
   invariants first, then verifies the Groth16 proof and signs a short-lived
   one-time ticket only if proof, root, revocation, nullifier, and policy checks
   pass.
5. submit: `POST /api/binary/comment/anonymous` consumes the ticket and writes a
   pending anonymous comment with `comment.user_id = null`.

## Nullifier

The circuit constrains:

```text
nullifier = PRF(credential_secret, action_context, scope)
```

For anonymous comments, `action_context` is `comment.create`, and `scope` is the
article / reply policy scope. The server must never derive a nullifier from user
id, session, ProofToken, credential issuance audit rows, IP address, or device
state.

## Circuit And Trusted Setup

`fsus.anonymous.comment.v2` covers the anonymous comment ticket proof only. It
does not authenticate users, issue credentials, moderate comments, or grant
admin permissions.

The `comment.v2` Groth16 circuit must constrain:

- circuit-native credential signature possession for an accepted issuer key;
- selective disclosure of `credential_level` and reputation bucket without
  exposing account identity fields;
- membership in the current credential root for the declared epoch;
- non-revocation against the current revocation root;
- `nullifier = PRF(credential_secret, action_context, scope)`;
- public input binding for `action_context`, scope, `circuit_id`,
  `verifying_key_hash`, `public_input_layout_version`, credential epoch,
  credential root, revocation root, issuer public key hash, nullifier,
  disclosed buckets, and comment policy context.

The repository asset contract for this decision is:

- `docs/zk/anonymous-comment-v2-circuit.md`
- `docs/zk/trusted-setup-ceremony.md`
- `security/zk/comment-v2-circuit.manifest.json`
- `security/zk/comment-v2-tamper-cases.manifest.json`
- `security/zk/comment-v2-feasibility.manifest.json`
- `security/zk/comment-v2-trusted-setup.manifest.json`
- `config/zk/anonymous-comment-v2-verifying-key.manifest.json`

Until real R1CS, proving key, verifying key, Powers of Tau transcript and
phase-2 transcript are supplied and hashed, `production_usable=false` and the
runtime verifying key hash stays empty.

## Security Assertion Boundary

The Groth16 proof and verifier establish only these seven assertions:

1. valid credential: the prover holds a circuit-native credential signed by an
   accepted issuer key.
2. current credential root: the credential is in the current credential root for
   the declared epoch.
3. not revoked: the credential's revocation witness is valid for the current
   revocation root.
4. qualification: disclosed attributes satisfy the configured anonymous comment
   policy.
5. nullifier correctness: the public nullifier is constrained by the credential
   secret, action context, and scope.
6. credential bucket legality: disclosed level and bucket values are signed
   credential attributes and belong to allowed catalogs.
7. account identity not disclosed: proof, public inputs, logs, tickets,
   moderation metadata, and provider payloads do not expose user id, username,
   public handle, credential secret, witness, or a reversible
   credential-to-account mapping.

The proof does not assert comment quality, legal acceptability, human
authorship, absence of spam, geographic visibility, or admin approval.

## Fail-Closed Requirements

Production ZK comments are disabled unless all cryptographic dependencies match
this ADR:

- `AnonymousIdentity:ZkAnonymousCommentsEnabled=true`.
- Production verifier enabled and configured with
  `circuit_id = "fsus.anonymous.comment.v2"`.
- `public_input_layout_version = 3`.
- Final trusted setup `verifying_key_hash` present and matching active root
  metadata.
- Active or grace credential root and revocation root present.
- Circuit-native issuer backend configured.
- Native backend available, bounded by timeout and concurrency limits.

Any disabled flag, unavailable verifier, root miss, root expiry, vk hash
mismatch, layout mismatch, oversized proof, backend timeout, backend exception,
invalid proof, missing public input, malformed nullifier, or revocation failure
returns a non-2xx ticket result and does not write a comment.

## Alternatives Considered

### BLS12-381 BBS+ inside bn254 Groth16

Rejected for the current production path. Public reference material shows
BLS12-381 pairing verification in bn254 circuits at a constraint and proving-key
size far beyond the committed browser prover budget. GPL reference
implementations are reference-only and must not be copied.

### Split BBS proof bound to a circuit-native proof

Rejected because it keeps a compatibility layer and a second credential proof
boundary. The implementation surface and equality-binding risk are not justified
when v2 can verify credential possession inside the Groth16 circuit directly.

### External hosted network

Rejected because anonymous comments must not expose issuance, proof, ticket, or
moderation correlation data to an external operator.

## Consequences

- Downstream contract work uses `fsus.anonymous.comment.v2` and layout version 3.
- BBS-specific production issuer/provider paths are retired rather than kept as
  compatibility code.
- Root rotation, revocation, moderation, anti-spam, and audit paths may use
  hashes / buckets / status summaries, but must not gain account deanonymization
  capabilities.
- The production path remains fail-closed until real circuit, trusted setup,
  native verifier, wasm prover, and circuit-native issuer issues are complete.

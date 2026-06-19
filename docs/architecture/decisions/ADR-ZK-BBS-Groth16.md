# ADR: ZK anonymous comments use BBS+ credentials and Groth16 proofs

Status: Accepted
Date: 2026-06-19
Scope: ZK-prod anonymous comment cryptography decision

## Context

FsusBlog's current anonymous comment ZK path has production fail-closed plumbing, but the cryptographic scheme must be fixed before BBS+ issuance, credential root / revocation, Groth16 circuits, native verification, or browser proving work can proceed. This ADR is the authority for issue #535 and the downstream #534 contract work.

The target property is narrow: for `zk_anonymous` comments, the server may verify eligibility and one-shot scope rules without learning which account submitted the comment. This ADR does not implement a circuit, prover, verifier, native binding, or trusted setup ceremony.

## Decision

FsusBlog selects BBS+ credential issuance plus a Groth16 anonymous comment proof.

- Anonymous credential scheme: BBS+.
- Proof system: Groth16.
- Production verifier shape: in-process native binding behind `IProductionZkProofBackend`, loaded by explicit configuration and used only through the existing fail-closed verifier service.
- Comment circuit id: `fsus.anonymous.comment.v1`.
- Public input layout: `public_input_layout_version = 2`.
- Verifying key binding: `verifying_key_hash` is a trusted setup vk hash and must be bound after the final `comment.v1` setup ceremony. A placeholder, missing hash, or hash for another circuit keeps production fail-closed.

BBS+ is used for unlinkable credential presentation and selective disclosure. The signed credential may contain account eligibility attributes such as `credential_level`, reputation bucket, account-age bucket, and credential epoch; anonymous comments disclose only the attributes required by policy.

Groth16 is used for the anonymous comment proof because proof size and verifier latency are small enough for the current binary endpoint and browser-wasm proving budget. The cost is a per-circuit trusted setup, which is acceptable because `fsus.anonymous.comment.v1` is explicitly versioned and changes to public inputs create a new setup boundary.

## Credential Lifecycle

1. issue: an authenticated account requests a BBS+ credential through the credential issuance endpoint. The issuer validates account eligibility and signs a blinded credential request. Issuance audit records may store account id, epoch, status, trace id, and irreversible request hashes only.
2. hold: the browser stores the BBS+ credential, credential secret, issuer public key id, credential epoch, and any membership / revocation witness material locally. The server does not store the credential secret or later proof witness.
3. derive proof: when submitting a `zk_anonymous` comment, the browser derives an unlinkable presentation proof and a Groth16 proof for the selected action and scope. Each presentation must use fresh randomness.
4. ticket: `POST /api/binary/comment/anonymous-ticket` verifies public inputs and the Groth16 proof, then signs a short-lived one-time ticket only if the proof, root, revocation, nullifier, and policy checks pass.
5. submit: `POST /api/binary/comment/anonymous` consumes the one-time ticket and writes a pending anonymous comment with `comment.user_id = null`.

Issuer unlinkability is mandatory. The issuer must not be able to predict later proof nullifier / commitment values, and issuance audit data must not let operators correlate issue, derive proof, ticket, submit, moderation, or revocation phases.

## Nullifier

The circuit constrains:

```text
nullifier = PRF(credential_secret, action_context, scope)
```

The server only receives and checks a public nullifier hash / token. It must not derive the nullifier from user id, session, ProofToken, credential commitment, issuer audit rows, IP, or device state. For anonymous comments, `action_context` is `comment.create`, and `scope` is the article / reply policy scope, such as `article:42`. The same credential and same scope produce a stable nullifier for replay and rate-limit enforcement; different scopes produce unlinkable nullifiers.

## Credential Root And Revocation

The proof must bind the credential to a current credential root and a revocation root for the declared epoch.

- `credential root`: the membership accumulator / Merkle root for credentials accepted in the epoch.
- `revocation root`: the accumulator root proving the credential or revocation handle is not revoked.
- Active and grace roots may be accepted by the runtime root reader; expired, missing, mismatched, or malformed roots fail closed before ticket issuance.
- Root rotation and revocation are admin-governed operations and must not reveal a credential-to-account mapping to the comment verification path.

## Circuit And Trusted Setup

`fsus.anonymous.comment.v1` covers the anonymous comment ticket proof only. It does not authenticate users, issue credentials, moderate comments, or grant admin permissions.

The `comment.v1` Groth16 circuit must constrain:

- BBS+ credential possession for the issuer public key accepted by the current root metadata.
- Selective disclosure of `credential_level` and other policy buckets without revealing account identity fields.
- Membership in the current credential root for the declared epoch.
- Non-revocation against the current revocation root.
- `nullifier = PRF(credential_secret, action_context, scope)`.
- Public input binding for `action_context`, scope, `circuit_id`, `verifying_key_hash`, `public_input_layout_version`, credential epoch, credential root, revocation root, nullifier, disclosed buckets, and comment policy context.

The trusted setup artifact set for this circuit must include the canonical circuit source hash, proving key hash, verifying key bytes, verifying key hash, ceremony transcript hash, and reproducible build metadata. `verifying_key_hash` must be computed from canonical verifying key bytes plus `circuit_id` and `public_input_layout_version`, then stored in root metadata / production verifier configuration. If the trusted setup artifact is absent or the vk hash is not the final setup output, production remains fail-closed.

The repository asset contract for this decision is fixed at:

- `docs/zk/anonymous-comment-v1-circuit.md`
- `docs/zk/trusted-setup-ceremony.md`
- `security/zk/comment-v1-circuit.manifest.json`
- `security/zk/comment-v1-tamper-cases.manifest.json`
- `security/zk/comment-v1-trusted-setup.manifest.json`
- `config/zk/anonymous-comment-v1-verifying-key.manifest.json`

These committed manifests are intentionally not production artifacts. They
define the public input layout, private witness contract, soundness/tamper
matrix, transcript consistency rules, upgrade rules, and future pk/vk paths.
Until the real R1CS, proving key, verifying key, Powers of Tau transcript and
phase-2 transcript are supplied and hashed, `production_usable=false` and the
runtime verifying key hash stays empty.

## Security Assertion Boundary

The Groth16 proof and verifier establish only these seven assertions:

1. valid credential: the prover holds a BBS+ credential signed by an accepted issuer key.
2. current credential root: the credential is in the current credential root for the declared epoch.
3. not revoked: the credential's revocation witness is valid for the current revocation root.
4. qualification: disclosed attributes satisfy the configured anonymous comment policy.
5. nullifier correctness: the public nullifier is constrained by the credential secret, action context, and scope.
6. credential_level legality: `credential_level` is a signed credential attribute and belongs to the allowed catalog.
7. account identity not disclosed: the proof, public inputs, logs, tickets, moderation metadata, and provider payloads do not expose user id, username, public handle, credential secret, witness, or a reversible credential-to-account mapping.

The proof does not assert comment quality, legal acceptability, human authorship, absence of spam, geographic visibility, or admin approval. Those remain moderation, RiskControl, region-policy, and admin-governance responsibilities.

## Fail-Closed Requirements

Production ZK comments are disabled unless all cryptographic dependencies are complete and match the ADR:

- `AnonymousIdentity:ZkAnonymousCommentsEnabled=true`.
- Production verifier enabled and configured with `circuit_id = "fsus.anonymous.comment.v1"`.
- `public_input_layout_version = 2`.
- Final trusted setup `verifying_key_hash` present and matching the active credential root metadata.
- Active or grace credential root and revocation root present.
- Native backend available, bounded by timeout and concurrency limits.

Any disabled flag, unavailable verifier, root miss, root expiry, vk hash mismatch, layout mismatch, oversized proof, backend timeout, backend exception, invalid proof, missing public input, malformed nullifier, or revocation failure returns a non-2xx ticket result and does not write a comment. Development / Test deterministic helpers such as `MvpDeterministicZkProofVerifier`, if present, are never a production verifier and never relax this fail-closed path.

## Alternatives Considered

### PS+Plonk

PS signatures with Plonk would avoid some Groth16 setup constraints and can support flexible circuit evolution. It is rejected for this slice because proof size, verifier shape, and browser prover complexity are less favorable for the current binary endpoint budget, and the FsusBlog circuit surface is small enough to version explicitly.

### Semaphore-style

Semaphore-style identity commitments and nullifier hashes are mature for group membership, but they do not directly provide BBS+ selective disclosure for `credential_level` / reputation buckets without adding another credential layer. It is rejected because FsusBlog needs unlinkable credential issuance and policy attribute disclosure, not only group membership.

### external hosted network

An external hosted network would reduce local cryptographic operations, but it adds a third-party availability, metadata, compliance, and deanonymization boundary. It is rejected because anonymous comments must not expose issuance, proof, ticket, or moderation correlation data to an external operator.

## Consequences

- Downstream contract work must align AEDS frames and docs with BBS+ credential bytes, Groth16 proof bytes, credential root, revocation root, `verifying_key_hash`, and `public_input_layout_version`.
- Native verifier and wasm prover issues must use `fsus.anonymous.comment.v1` and layout version 2 until a new ADR supersedes this one.
- Root rotation, revocation, moderation, anti-spam, and audit paths may use hashes / buckets / status summaries, but must not gain account deanonymization capabilities.
- The current production path remains fail-closed until the real BBS+, Groth16, trusted setup, native verifier, and wasm prover issues are complete.

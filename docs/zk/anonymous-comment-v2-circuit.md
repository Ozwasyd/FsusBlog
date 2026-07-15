# fsus.anonymous.comment.v3 circuit contract

Status: the v3/layout 4 circuit source, deterministic R1CS IR and binary
Groth16 R1CS handoff are present and hash-bound. Removing the stable public
credential commitment changed the statement, so every v2/layout 3 proving key,
verifying key and transcript is invalid for this contract. The v3 setup
manifest is deliberately `not-run` and ZK-Prod remains fail-closed until a new
ceremony, browser prover, root rotation and release evidence all pass.

## Issue #551 production circuit status

`comment.v2` replaces the retired `comment.v1` BBS credential boundary with a
circuit-native issuer signature verified inside the Groth16 circuit. The
repository now contains the self-authored circuit source at
`circuits/anonymous-comment-v2/comment_v2.circuit.json` and a deterministic
R1CS IR artifact at `artifacts/zk/comment-v2/comment_v2.r1cs`. It also includes
the binary Groth16 R1CS input for phase-2 setup at
`artifacts/zk/comment-v2/comment_v2_groth16.r1cs`, self-written phase
transcripts, `comment_v2_final.fsg16pk`, `comment_v2_verifying_key.bin`, and
the browser prover bundle recorded by
`artifacts/zk/comment-v2/comment_v2_prover_wasm.tar.gz`.

The manifest checker enforces that boundary:

- the current circuit manifest must keep an explicit artifact status, currently
  `source-and-r1cs`, because the source/R1CS contract remains distinct from the
  trusted setup artifact contract;
- `node tools/crypto/build-zk-comment-v2-r1cs.mjs --check` must reproduce the
  committed R1CS IR from the committed source;
- any future circuit `production-ready` status must include a real
  `circuit.r1cs_source.path` plus `circuit.r1cs_source.sha256`;
- the trusted setup manifest must also provide a real
  `artifacts.r1cs.path` plus `artifacts.r1cs.sha256`;
- `artifacts.groth16_r1cs.path` must exist and match
  `artifacts.groth16_r1cs.sha256`;
- both files must exist in the repository checkout and match their SHA-256
  digests before the checker will accept the production-ready claim.
- `setup.artifacts.r1cs` is marked `format=fsusblog.zk.r1cs-ir.v1` and
  `ceremony_input=false`; phase-2 setup must use
  `setup.artifacts.groth16_r1cs.path` instead.

## Canonical Assets

| Asset | Path |
| --- | --- |
| Circuit manifest | `security/zk/comment-v2-circuit.manifest.json` |
| Tamper and soundness cases | `security/zk/comment-v2-tamper-cases.manifest.json` |
| Feasibility and design decision gate | `security/zk/comment-v2-feasibility.manifest.json` |
| Trusted setup manifest | `security/zk/comment-v2-trusted-setup.manifest.json` |
| Verifying key config manifest | `config/zk/anonymous-comment-v2-verifying-key.manifest.json` |
| Circuit source | `circuits/anonymous-comment-v2/comment_v2.circuit.json` |
| R1CS IR artifact | `artifacts/zk/comment-v2/comment_v2.r1cs` |
| Groth16 R1CS ceremony input | `artifacts/zk/comment-v2/comment_v2_groth16.r1cs` |
| Final proving key | `artifacts/zk/comment-v2/comment_v2_final.fsg16pk` |
| Canonical verifying key | `artifacts/zk/comment-v2/comment_v2_verifying_key.bin` |
| Browser prover bundle | `artifacts/zk/comment-v2/comment_v2_prover_wasm.tar.gz` |
| Public browser prover manifest | `src/frontend/public/wasm/comment-privacy-prover.manifest.json` |
| R1CS IR builder | `tools/crypto/build-zk-comment-v2-r1cs.mjs` |
| Static checker | `tools/crypto/check-zk-comment-v2-manifests.mjs` |
| MCL platform asset checker | `tools/security/check-mcl-platform-assets.mjs` |

The circuit id is `fsus.anonymous.comment.v3`. The public input layout version
is `4`. Any change to public input order, meaning, encoding, or count requires a
new layout version and a new circuit-specific ceremony.

## Public Inputs

The public input list is intentionally coarse and identity-free:

| Name | Meaning |
| --- | --- |
| `public_input_layout_version` | Constant layout discriminator, currently `4`. |
| `circuit_id` | `fsus.anonymous.comment.v3`. |
| `action_context` | Must equal `comment.create`. |
| `scope` | Comment replay scope, for example `article:42`. |
| `nullifier_hash` | Public nullifier constrained by the private credential secret and scope. |
| `credential_root` | Active or grace credential membership root for the epoch. |
| `revocation_root` | Revocation accumulator root for non-membership. |
| `credential_epoch` | Epoch bound to the root snapshot and credential. |
| `credential_level` | Disclosed signed credential level used by policy. |
| `reputation_bucket` | Disclosed signed reputation bucket used by policy. |
| `issuer_public_key_hash` | Hash of the issuer key accepted by the root metadata. |
| `policy_hash` | Hash of the anonymous comment policy context used by the proof. |
| `verifying_key_hash` | SHA-256 binding for the final canonical verifying key bytes. |

`userId`, `user_id`, `username`, public handle, account id, session id, IP
address, device fingerprint, cookies, credential commitment, credential serial,
issuer record id, and any other cross-scope stable credential value are not
public inputs.

The runtime native verifier transcript is the byte output of
`NativeGroth16PublicInputCodec`: domain
`fsus.anonymous.comment.v3.public-inputs`, then length-prefixed UTF-8 /
little-endian scalar fields for `action_context`, `scope`, `circuit_id`,
`verifying_key_hash`, `public_input_layout_version`, `credential_epoch`,
`nullifier_hash`, `credential_root`,
`revocation_root`, `issuer_public_key_hash`, `policy_hash`,
`credential_level`, and `reputation_bucket`. The browser wasm prover must
return exactly those bytes as `publicInputs`; the ticket service rebuilds the
transcript from the POD fields, current root snapshot, and current comment
policy snapshot hash, then rejects mismatches before native verification.

## Private Witness

The witness contract is:

- `credential_secret`
- credential commitment/opening material used only inside the private witness
- circuit-native issuer signature over the credential attributes
- issuer signature public key used inside the circuit
- credential opening material
- credential membership proof for `credential_root`
- revocation non-membership witness for `revocation_root`
- signed credential attributes for `credential_level`, `reputation_bucket`, and epoch
- policy comparison witness for bucket legality

The witness also excludes account identity fields. Issuance audit records are
not witness inputs and must not be used to derive nullifiers.

## Revocation Non-Membership

`comment.v2` uses `circuit-friendly-non-membership.v1` for production
revocation roots. The backend contract is frozen in
`docs/zk/revocation-accumulator.md`:

- accumulator: 128-level sparse Merkle tree over BN254 Fr
- hash: MiMC7 over BN254 Fr, 91 rounds, repository domain-separated constants
- root/public input encoding: 32-byte lower-case hex field element
- leaf key: first 128 bits of `revocation_handle_hash`
- private witness order: `leafKey`, then `siblingHashes[0..127]` from leaf to root

The circuit must reconstruct `revocation_root` from the empty-leaf sparse Merkle path at `leafKey` and the sibling path. Backend witness creation rejects a
revoked handle before returning witness material; the Groth16 circuit mirrors
the repository verifier shape by checking that the supplied empty leaf and
siblings reconstruct the public root without reading the full revoked set. The
legacy `legacy-sha256-hash-tree.v1` accumulator is only a migration/governance
helper and is excluded from production root snapshots.

`witnessHash` is not part of the Groth16 circuit input set. It binds backend and
cross-stack fixture evidence only, and its sibling digest uses the same MiMC7
BN254 primitive family as the sparse Merkle path. The circuit source therefore records
`witness_hash_role=fixture_integrity_only` and
`witness_hash_circuit_input=false`; the in-circuit witness fields are `leafKey`
and `siblingHashes[0..127]`.

## Security Assertions

The circuit must prove exactly these assertions for the ticket path:

1. The prover holds a valid circuit-native anonymous credential signed by an
   accepted issuer key.
2. The credential belongs to the current credential root for the declared epoch.
3. The credential is not revoked according to the revocation accumulator.
4. The disclosed `credential_level` and `reputation_bucket` satisfy the comment
   eligibility policy.
5. `nullifier_hash = PRF(credential_secret, action_context, scope)`.
6. The disclosed level and bucket values are signed credential attributes and
   are members of the allowed catalogs.
7. No real account identity is exposed by public inputs, private witness,
   verifier payloads, logs, tickets, or comment rows.

The circuit does not prove comment quality, human authorship, moderation
acceptability, admin authorization, account login status, or rate-limit state.

## Nullifier PRF

`comment.v2` uses a circuit-friendly PRF, recorded in the manifest as Poseidon:

```text
nullifier_hash = Poseidon(
  domain = "fsus.anonymous.comment.v3:nullifier:v1",
  credential_secret,
  action_context,
  scope
)
```

The same credential secret and same scope must produce a stable nullifier so the
server can reject replay inside the scope. Different scopes must produce
different nullifiers. The canonical transcript must not contain a stable
credential equality tag, so two presentations cannot be linked by comparing a
credential commitment field. The server must never derive a nullifier from user
id, session, proof token, issuer audit rows, IP address, or device state.

`tools/security/check-zk-comment-v2-unlinkability.mjs` deterministically samples
100 scopes, verifies same-scope stability and cross-scope nullifier uniqueness,
and scans the ticket/public-input codecs for forbidden stable credential fields.
This is repository-local reproducible contract evidence, not a production
ceremony, independent audit, or live deployment claim.

## Soundness Matrix

`security/zk/comment-v2-tamper-cases.manifest.json` is the executable contract
for positive and negative cases. It requires at least one reject case for each
security assertion, including nullifier tamper, scope tamper, root tamper,
revocation tamper, unsigned policy bucket tamper, issuer-key tamper, layout
tamper, verifying-key-hash tamper, and identity-field injection.

The static checker validates the manifest coverage now. The committed
cross-stack smoke in `tests/security/zk-comment-v2-cross-stack-fixture.test.mjs`
loads the public browser WASM prover bundle, generates a proof/public-input
transcript, and verifies it with the MCL backend binding. Release evidence must
still prove the full tamper matrix: valid witness accepts; any single tamper
rejects.

`tests/fixtures/zk/comment-v2/circuit-ir/fixture.manifest.json` is the current
executable repository witness fixture for the circuit IR stage. It is generated
by `tools/crypto/build-zk-comment-v2-circuit-fixture.mjs`, binds the committed
source and tamper manifest, materializes a deterministic positive witness, and
records rejection results for every tamper case. It is intentionally marked
`groth16_proof=false` and `groth16_ceremony_input=false`; it covers the #551
circuit IR witness/tamper acceptance path but does not replace the FSG16/MCL
trusted setup artifacts, browser prover bundle, or release evidence.

## Real Cross-Stack Evidence Gate

Production smoke evidence must not use the native hashing fixture as readiness
proof. `tools/security/run-privacy-zk-prod-smoke.mjs --real-evidence
--require-real` and `tools/security/check-privacy-zk-prod-release.mjs` require
`evidenceKind=real-groth16-cross-stack`, `circuitId=fsus.anonymous.comment.v3`,
layout version `4`, `proofSystem=Groth16`, a 64-char `verifyingKeyHash`, and
SHA-256 bindings for the R1CS, proving key, canonical verifying key bytes,
native verifier, and wasm prover artifact.

Those bindings are not accepted as paper-only hashes. The evidence must also
include local `artifacts.*.path` plus `artifacts.*.sha256` entries for `r1cs`,
`provingKey`, `verifyingKey`, `nativeVerifier`, `wasmProver`, `proofFixture`,
`publicInputs`, `tamperCases`, and `unlinkabilityTranscripts`. The smoke and release gates recalculate
SHA-256 from those files; the first five artifact entries must match the
corresponding `artifactHashes` fields.

The same evidence must state that the frontend wasm prover generated the proof,
the backend native verifier accepted it, public inputs matched byte-for-byte,
all tamper cases rejected, `hashingFixtureUsed=false`,
at least 100 sampled scopes, stable same-scope nullifiers, distinct cross-scope
nullifiers, complete transcript unlinkability, and legacy layout rejection,
`performance.wasmProverP95Ms<=3000`, and
`performance.nativeVerifierP99Ms<=50`. Release checks bind the evidence
`verifyingKeyHash` to production config, trusted setup manifest, and the
verifying-key artifact hash before ZK-Prod can be enabled.

## Repository-local cryptographic review

`security/zk/comment-v2-local-review.manifest.json` and
`docs/zk/comment-v2-local-cryptographic-review.md` provide the reproducible
local review required by the release gate. The manifest binds the circuit
source/manifest, both R1CS forms, setup manifest, proving/verifying keys, native verifier,
Wasm prover and focused test sources. The immutable release also binds the complete
local-review manifest hash. It requires positive/tamper fixtures,
malformed and non-canonical proof rejection, subgroup checks, domain/root/epoch
binding, bounded concurrency and timeout fail-closed evidence.

This evidence deliberately sets `independent_audit_claimed=false`,
`external_evidence_required=false` and `production_authorization=false`. It is
not an external audit and cannot replace the trusted-setup, issuer, root or real
cross-stack gates. Run `node tools/security/check-zk-local-review.mjs` after any
bound file changes.

## Budgets

The repository contract sets production targets:

- proof bytes: at most 1024 bytes
- wasm prover p95: at most 3000 ms on the supported browser profile
- native verifier p99: at most 50 ms before endpoint overhead
- public input layout: stable version `3`

The committed cross-stack smoke checks the 138-byte proof shape and native
binding compatibility. Production release evidence must still provide measured
`wasmProverP95Ms<=3000` and `nativeVerifierP99Ms<=50`; the static manifest
fields alone are not sufficient to enable ZK-Prod.

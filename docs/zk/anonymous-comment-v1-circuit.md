# fsus.anonymous.comment.v1 circuit contract

Status: repository contract only. This document and its manifests define the
Groth16 circuit boundary for #543. They do not claim that a real R1CS, proving
key, verifying key, or browser prover artifact exists yet. Production remains
fail-closed until the trusted setup manifest is switched to real audited
artifacts.

## Canonical Assets

| Asset | Path |
| --- | --- |
| Circuit manifest | `security/zk/comment-v1-circuit.manifest.json` |
| Tamper and soundness cases | `security/zk/comment-v1-tamper-cases.manifest.json` |
| Trusted setup manifest | `security/zk/comment-v1-trusted-setup.manifest.json` |
| Verifying key config manifest | `config/zk/anonymous-comment-v1-verifying-key.manifest.json` |
| Static checker | `tools/crypto/check-zk-comment-v1-manifests.mjs` |

The circuit id is `fsus.anonymous.comment.v1`. The public input layout version
is `2`. Any change to public input order, meaning, encoding, or count requires a
new layout version and a new circuit-specific ceremony.

## Public Inputs

The public input list is intentionally coarse and identity-free:

| Name | Meaning |
| --- | --- |
| `public_input_layout_version` | Constant layout discriminator, currently `2`. |
| `circuit_id` | `fsus.anonymous.comment.v1`. |
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
address, device fingerprint, and cookies are not public inputs.

## Private Witness

The witness contract is:

- `credential_secret`
- BBS+ issuer signature over the credential attributes
- credential opening / blind-signature opening material
- credential membership proof for `credential_root`
- revocation non-membership witness for `revocation_root`
- signed credential attributes for `credential_level`, `reputation_bucket`, and epoch
- policy comparison witness for bucket legality

The witness also excludes account identity fields. Issuance audit records are
not witness inputs and must not be used to derive nullifiers.

## Security Assertions

The circuit must prove exactly these assertions for the ticket path:

1. The prover holds a valid BBS+ anonymous credential signed by an accepted
   issuer key.
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

`comment.v1` uses a circuit-friendly PRF, recorded in the manifest as Poseidon:

```text
nullifier_hash = Poseidon(
  domain = "fsus.anonymous.comment.v1:nullifier:v1",
  credential_secret,
  action_context,
  scope
)
```

The same credential secret and same scope must produce a stable nullifier so the
server can reject replay inside the scope. Different scopes must produce
unlinkable nullifiers. The server must never derive a nullifier from user id,
session, proof token, issuer audit rows, IP address, or device state.

## Soundness Matrix

`security/zk/comment-v1-tamper-cases.manifest.json` is the executable contract
for positive and negative cases. It requires at least one reject case for each
security assertion, including nullifier tamper, scope tamper, root tamper,
revocation tamper, unsigned policy bucket tamper, issuer-key tamper, layout
tamper, verifying-key-hash tamper, and identity-field injection.

The static checker validates the manifest coverage now. When real Groth16
artifacts land, the same cases must become proof-generation and verifier tests:
valid witness accepts; any single tamper rejects.

## Budgets

The repository contract sets production targets, not current measurements:

- proof bytes: at most 1024 bytes
- wasm prover p95: at most 3000 ms on the supported browser profile
- native verifier p99: at most 50 ms before endpoint overhead
- public input layout: stable version `2`

Until real artifacts exist, these budgets are enforced as required manifest
fields only. No benchmark in this slice claims real prover performance.

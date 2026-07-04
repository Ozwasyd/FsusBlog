# IntegrityProof Threat Model

This threat model covers the local off-chain IntegrityProof system in the single-process FsusBlog deployment. The assumed baseline is Kestrel, PostgreSQL, Redis, and C#/.NET 10 server code.

## Scope

In scope:

- canonical content hash generation;
- artifact digest collection for PublicAOT, ArticleDetailAeds, PublicHotRead, feed, sitemap, robots, and distribution outputs;
- publish proof signing;
- local transparency log append and verification;
- Merkle checkpoint construction and verification;
- public verification manifests;
- admin console read and retry controls.

Out of scope:

- IPFS, Arweave, blockchain, wallet, or chain anchoring;
- C++23/Wasm as the primary proof implementation;
- private user data confidentiality;
- audit log non-repudiation outside the dedicated audit chain;
- moderation correctness or comment quality.

## Threat Matrix

| Threat | Risk | Control | Residual Boundary |
|--------|------|---------|-------------------|
| spoofing | A fake proof claims to be produced by this site. | Verify `keyId`, `algorithm`, public key registry, signature payload domain, and `ECDSA_P256_SHA256` signature. | If the private key is compromised, old trust must be revoked or rebuilt by policy. |
| tamper | Content or artifact bytes change after publication. | Recompute canonical hash and artifact digest values before accepting the proof. | Only covered artifacts are protected. Unlisted runtime views are not proven. |
| replay | An old proof is presented as current. | Check `articleId`, `articleRevisionId`, `revisionNo`, proof status, transparency log position, and checkpoint scope. | Historical `superseded` proofs can remain valid as historical records. |
| key compromise | A signing key leaks or signs bad payloads. | Mark `compromisedAtUtc`, remove private key material, rotate `CurrentKeyId`, and rebuild affected proofs/checkpoints where policy requires. | A compromise event can invalidate trust even when bytes still verify cryptographically. |
| private data leakage | Proof payload accidentally includes sensitive data. | Consistency check and implementation notes ban admin principal id, audit context, comments, user private data, IP, session, device, token, and private keys. | Review new fields before adding them to public manifests. |
| log deletion | A transparency log row is deleted. | Hash chain verification detects sequence gaps and previous hash mismatches. | The local database still needs backup and access control. |
| checkpoint mismatch | Merkle checkpoint root does not match log leaves. | Rebuild checkpoint root from included entries and verify checkpoint signature. | Checkpoint only covers the declared local log range. |
| artifact stale | Proof binds an old PublicAOT, ArticleDetailAeds, PublicHotRead, feed, sitemap, robots, or distribution artifact. | Artifact digest collection compares current generated outputs before marking proof ready. | A missing artifact should become `pending` or `retrying`, not fake-ready. |

## Does Not Prove

IntegrityProof does not prove database immunity, Redis integrity, user privacy, XSS absence, SQL injection absence, moderation compliance, audit completeness, chain consensus, wallet ownership, IPFS storage, Arweave persistence, or permanent availability.

## Single-Process Boundary

The first implementation assumes one application process owns proof scheduling, signing, log append, and checkpoint generation. If the service becomes multi-writer, proof idempotency, log append locking, checkpoint selection, and key rotation must be re-reviewed before enabling concurrent writers.

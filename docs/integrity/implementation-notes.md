# IntegrityProof Developer Implementation Notes

These notes describe the current implementation boundary for #984-era IntegrityProof work. Keep this file aligned with code and tests when changing DTOs, storage, or proof scheduling.

## Runtime Boundary

- Main implementation: C#/.NET 10 in the backend.
- Deployment baseline: single-process Kestrel, PostgreSQL, Redis.
- C++23/Wasm is not the main implementation for proof generation, signing, or verification.
- Public runtime APIs remain normal JSON sidecars under `/integrity/**`; they are not `/api/binary/**` AEDS frames.

## Article Coordinates

Use current entity names:

- `Article`
- `ArticleBody`
- `ArticleRevision.Id`
- `RevisionNo`
- public manifest fields `articleId`, `articleRevisionId`, and `revisionNo`

Do not introduce a separate public revision identifier field. If a route or internal endpoint uses another route parameter for editor history, keep it out of IntegrityProof public manifest naming.

## Artifact Boundary

Current artifact digest inputs:

- PublicAOT
- ArticleDetailAeds
- PublicHotRead
- feed
- sitemap
- robots
- distribution outputs owned by DistributionEndpoints

Artifact digest code must treat missing, stale, not-yet-generated, and explicitly non-public artifacts as state inputs. It must not mint fake ready proofs.

## Outbox Boundary

`integrity-proof` is not part of `ArticleMutationReplayEdges.Required`. It is a publish-after-proof side effect scheduled only after required replay edges complete. Required publication, cache invalidation, search, taxonomy, AEDS, PublicHotRead, and notification side effects must not wait for the proof to become ready.

## Signing

Current signing uses `ECDSA_P256_SHA256` through .NET built-in cryptography. Ed25519 is not current/default behavior; it requires an explicit reviewed dependency and algorithm migration before use.

Private keys must stay server-side. Public manifests may include public key metadata, key id, algorithm, validity windows, and revoke/compromise markers.

## Performance And Memory

Prefer `Span<T>`, `ReadOnlySpan<T>`, pooled buffers, and deterministic serializers for canonical bytes. `unsafe` is allowed only for a small benchmark-proven hot path with clear tests and rollback, not for ordinary proof model code.

## Forbidden Public Proof Data

Never add these to public proof payloads, public manifests, fixture evidence, or release evidence:

- admin principal id
- audit log context
- private draft text
- comments or moderation payloads
- user private data
- IP address or IP hash
- user agent or device fingerprint
- session id
- token or cookie
- private key or secret material

If a new field helps operations but is sensitive, keep it in the admin console or internal audit model, not in public verification manifests.

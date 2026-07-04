# Publish Proof

Publish Proof records bind an `ArticleRevision` to the public artifacts that were produced for a publication moment. A proof is a server-side integrity record, not a blockchain receipt or a public author identity assertion.

## Persistent Model

The durable table is `article_publish_proof`, represented by `ArticlePublishProof`.

Core fields:

- `proof_version`: publish proof model version. Current value is `1`.
- `signature_payload_version`: canonical signing payload version. Current value is `1`.
- `article_id`: `Article.Id`.
- `article_revision_id`: `ArticleRevision.Id`. Ready proofs require a persisted revision row.
- `revision_no`: `ArticleRevision.RevisionNo`.
- `idempotency_key`: stable replay key, `article:{articleId}:revision:{articleRevisionId}:proof:{proofVersion}`.
- `canonical_hash`: canonical article hash from `Article`, `ArticleBody`, and `ArticleRevision` content fields.
- `aot_hash`: digest of the PublicAOT HTML or shell artifact for the article.
- `article_detail_aeds_hash`: digest of the public article detail AEDS payload.
- `public_hot_read_hash`: digest of the public hot-read artifact participating in the published surface.
- `asset_manifest_hash`: digest of the public asset manifest for article assets.
- `feed_hash`: digest of the feed artifact that includes the publication.
- `published_at`: UTC publication time bound into the proof payload.
- `proof_status`: workflow state.
- `signing_key_id`, `signing_key_version`, `signing_algorithm`, `signature`: site signing metadata and Base64Url signature.
- `failure_code`, `failure_detail`: non-secret failure metadata for retry/debug.
- `transparency_log_entry_id`, `transparency_log_entry_hash`: reverse pointer to the local transparency log entry that recorded this proof snapshot.
- `created_at`, `updated_at`, `superseded_at`: lifecycle timestamps.

`CreatedByAdminPrincipalId` is not part of `article_publish_proof` and is not exposed through publish proofs. Admin attribution remains an internal authoring/audit concern.

## Canonical Payload

`PublishProofCanonicalPayloadV1` serializes records with:

- domain separator: `fsusblog.integrity.publish-proof-record.v1`
- UTF-8 bytes
- fixed field order
- UTC timestamps with seven fractional digits
- lower-case SHA-256 hex digest fields
- `sha256:` input prefixes accepted but stripped before canonicalization

The site signing payload reuses `SiteIntegritySigningPayloadCanonicalizer` with:

- proof kind: `publish-proof`
- subject: `article:{articleId}:revision:{articleRevisionId}`
- digest: SHA-256 of the publish proof record payload
- extension fields: `articleId`, `articleRevisionId`, `revisionNo`, `proofVersion`, `signaturePayloadVersion`

## States

Valid states:

- `pending`: proof cannot be marked ready yet, usually because a revision or artifact is not available.
- `ready`: all required digests exist and the proof can be signed.
- `failed`: a non-transient artifact problem was observed, such as stale output or hash mismatch.
- `retrying`: failed or pending proof generation has been queued for another attempt.
- `superseded`: a later revision became the current public proof. Historical verification can still use the old signed payload.
- `not-public`: the article is draft, scheduled, archived, deleted, or one of the required artifacts is explicitly not public.

Transition rules:

- `pending` can move to `ready`, `failed`, `retrying`, `superseded`, or `not-public`.
- `retrying` can move to `ready`, `failed`, `superseded`, or `not-public`.
- `failed` can move to `retrying`, `superseded`, or `not-public`.
- `ready` can move only to `superseded` or `not-public`.
- `not-public` can move to `pending` or `superseded`.
- `superseded` is terminal.

## Artifact Behavior

Missing, pending, unknown, or unavailable artifacts keep the proof in `pending`; the server must not generate a fake ready proof. Stale artifacts or hash mismatches put the proof in `failed`. Artifacts marked `not-public` produce `not-public`.

Repeated publication of the same `ArticleRevision.Id` and proof version must reuse the same idempotency key. A rollback or later publication creates or activates the proof for that target revision without mutating the historical signed payload of superseded revisions.

Scheduled publications remain pending or not-public until the article is actually public. Archived or deleted articles do not continue generating ready public proofs; existing historical proof lookup can be added later as an explicit read feature.

## Outbox Integration

Publish proof scheduling is driven by `article_mutation_outbox`; public read requests do not create or repair proofs. `ArticleMutationOutboxDispatcher` first completes the dispatcher-owned cache invalidation edges and passes the updated edge set into `ArticleMutationSideEffectCoordinator`. The coordinator schedules `integrity-proof` only after every `ArticleMutationReplayEdges.Required` edge has completed.

`integrity-proof` is intentionally not part of `ArticleMutationReplayEdges.Required`. A failed, pending, or retrying proof records its own edge state and reason, but the source outbox event may still become processed once required cache, search, taxonomy, AEDS, PublicHot, and notification side effects are done. Proof generation therefore cannot block publishing, scheduled publishing, cache/search/AEDS/PublicHot refresh, or public reads.

Proof generation classifies missing or not-yet-produced artifacts as `pending`/`retrying`, stale artifacts as `failed`, and deleted or archived publications as `not-public`. Reason codes are normalized to low-cardinality values for retry and operations review. The first local implementation only reads local artifacts and database state; it does not call blockchain, IPFS, Arweave, or other external anchoring services.

After the proof row is upserted, the scheduler appends or reuses a `publish-proof` entry in the local transparency log. The append is idempotent per proof id and updates the proof's reverse pointer to the log head entry. See [Transparency Log](transparency-log.md) for chain verification and operational boundaries.

## What It Proves

A valid publish proof proves:

- the server produced a stable canonical record for a specific `Article`, `ArticleBody`, and `ArticleRevision.Id`;
- the listed public artifact digests were bound to that revision and publication time;
- the configured site signing key accepted that payload.

It does not prove:

- full article history beyond the bound revision;
- comments, messages, user profiles, moderation decisions, or audit logs;
- wallet ownership, IPFS, Arweave, blockchain anchoring, or external network publication;
- public identity of the admin principal who authored the change.

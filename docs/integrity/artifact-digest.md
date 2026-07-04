# Public Artifact Digest

`ArtifactDigestV1` defines local SHA-256 digests for public artifacts after they have been generated or become readable. It proves artifact bytes, not the canonical article source. It does not publish to IPFS, Arweave, a chain, or any external anchoring service.

## Difference From Article Canonical Hash

`ArticleCanonicalHashV1` binds normalized article source fields: article id, optional revision identity, route identity, taxonomy, publication time, and Markdown content.

`ArtifactDigestV1` binds emitted public bytes:

- PublicAOT HTML and PublicAOT shell artifacts.
- `ArticleDetailAeds` bytes produced for public article detail reads.
- `PublicHotRead` artifacts.
- `DistributionEndpoints` output: RSS, Atom, JSON Feed, `sitemap.xml`, and `robots.txt`.
- Public upload/image assets used by public articles.
- Per-article public asset manifest hash.

The two hashes answer different questions. A canonical hash can remain stable while a renderer, feed template, compression boundary, or public asset changes an emitted artifact digest. An artifact digest can change without meaning the article canonical source changed.

## Rules

- Domain separator: `fsusblog.integrity.artifact-digest.v1`
- `hashVersion`: `1`
- Hash algorithm: `sha256`
- Encoding for string payload helpers: UTF-8
- File artifacts: streaming hash with a bounded buffer; no full-file load is required.
- Small in-memory payloads: hashed directly from bytes.
- Public asset digest: reuse and verify `AssetLibraryItem.Sha256` when present.
- Legacy assets with missing or invalid `AssetLibraryItem.Sha256` are reported as `Unknown` until backfilled.
- A stored `AssetLibraryItem.Sha256` mismatch is reported as `HashMismatch` with both actual and expected digest visible.

## Entry Points

Core code uses `ArtifactDigestV1` for byte, string, stream, file, asset SHA-256, and public asset manifest hashing.

Server artifact producers and readers use `PublicArtifactDigestEntries` as the boundary adapter:

- `FromPublicAotHtml` reads `PublicAotCacheEntry.GetDocument().Utf8Bytes`.
- `FromPublicAotShell` hashes the serialized `PublicAotCacheEntry` shell bytes.
- `FromArticleDetailAeds` hashes `ArticleDetailAedsArtifact.Frame`.
- `FromPublicHotReadBinary` and `FromPublicHotReadHtml` hash `PublicHotRead` binary/html artifacts.
- `FromDistributionOutput` maps `DistributionEndpoints` output to `/feed/rss.xml`, `/feed/atom.xml`, `/feed/feed.json`, `/sitemap.xml`, and `/robots.txt`.
- `FromAssetLibraryItem` reuses `AssetLibraryItem.Sha256`.
- `ComputeArticleAssetManifest` produces the per-article public asset manifest hash.

## States

`ArtifactDigestState` is intentionally separate from cache state:

- `Ready`: bytes were read and hashed.
- `Missing`: the expected file or artifact is absent.
- `Pending`: generation or concurrent refresh is in flight.
- `Stale`: an artifact exists but is known to lag a newer invalidation or replay edge.
- `NotPublic`: the source is draft, scheduled, archived, deleted, or otherwise excluded from public artifacts.
- `Unknown`: an old asset or row has no reliable stored SHA-256.
- `Unavailable`: the artifact could not be read, for example because of filesystem or permission failure.
- `HashMismatch`: a stored public asset SHA-256 differs from the actual bytes.

## Exclusions

Artifact digest does not cover:

- drafts, previews, unpublished revisions, private authoring payloads
- comments, moderation records, audit logs, private messages
- subscription emails, session data, account recovery credentials
- viewer, IP, user agent, trace, or request context
- cache metadata, retry counters, outbox internal ids

## Limits

Artifact digest is not cache consistency. PublicAOT, `ArticleDetailAeds`, `PublicHotRead`, feed, sitemap, and search freshness still depend on cache invalidation, `article_mutation_outbox`, replay edge status, and each producer's existing write path. A digest can reveal that bytes differ or are missing; it does not decide whether a cache should be invalidated or replayed.

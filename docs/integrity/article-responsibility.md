# Article responsibility, sources, and revision disclosure

Each article revision may retain an append-only `article_responsibility_snapshot` version chain. Each save appends through an `expectedVersion` CAS and records `previousSnapshotId`; it never overwrites an old snapshot. This is responsibility and evidence disclosure, not search-ranking scoring, and it computes no keyword density, word count, E-E-A-T, or GEO score.

## Author inheritance and multiple authors

- A single-author site may set `inheritSiteAuthor=true`; the public manifest inherits the configured site author name.
- A multi-author article should provide an ordered `authors` array. Each item has a display name and an optional stable public profile URL.
- `reviewer` is optional and, when present, is displayed separately from authors.
- AI may assist writing, but the actual responsible person must confirm `responsiblePersonConfirmed`; the confirmation exposes neither a backend account nor actor id.

## Sources and revision disclosure

`sources` is a structured array of title, public URL, source type, access date, version, and optional citation note. Only public `http`/`https` links without URL user-info enter the manifest; private sources remain private.

Substantive updates should state what changed, why, when it took effect, and the conclusion impact `none | clarified | changed | unknown`. Research and evaluation content may enable `methodology`, `applicability`, and `limitations` by type; ordinary essays need not use a research template.

## Public verification and failure states

- current revision: `GET /integrity/article/{articleId}/responsibility`
- specified revision: `GET /integrity/article/{articleId}/revisions/{revisionNo}/responsibility`
- proof source: the manifest's `verification.url`

`verification.proofStatus` emits only `ready`, `failed`, or `unavailable`; it does not disclose failure details, backend principals, drafts, audit context, or keys. When an old article has no responsibility snapshot, the response is a deterministic site-author inheritance result marked `legacyFallback=true`; it never generates random or temporary content from request time. A public old article predating the revision table uses `revisionNo=0`, `proofStatus=unavailable`, and the current article proof URL at the current endpoint; a specified historical revision that does not exist still returns 404.

The public current sidecar reads the snapshot explicitly referenced by `current_publication_id`; a historical sidecar reads the explicit snapshot of that revision's publication. Later responsibility edits therefore do not rewrite old-publication evidence. Saving responsibility for a published current revision creates a new publication and, in the same transaction, a `responsibility-updated` outbox update for AOT, AEDS, cache, and notification. The management endpoint `GET /api/binary/author/articles/{articleId}/revisions/{articleRevisionId}/responsibility` reads all versions; PUT with a stale `expectedVersion` returns 409.

## Migration

The migration backfills existing snapshots with `responsibilityVersion=1` and backfills explicit snapshot pointers in publication/outbox; reruns remain idempotent. Historical articles without a snapshot continue using the legacy fallback. Batch backfill must append snapshots keyed by existing revision id; it must not rewrite historical revisions or fabricate a reviewer/source. Migration acceptance is local single-process PostgreSQL, with schema and code switched atomically.

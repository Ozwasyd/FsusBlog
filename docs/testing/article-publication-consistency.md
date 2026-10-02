# Article publication-coordinate migration and consistency verification

The [publication-coordinate contract](../api/article-publication-revisions.md) defines the API model; this document defines its verification matrix.

## Migration scope

`20260719-pre-article-publication-coordinates` performs expand/backfill;
`20260719-post-article-publication-consistency` installs the check view after CodeFirst:

1. add current revision, publication, and pending-publication time to `article`;
2. create immutable `article_publication` with a unique version constraint;
3. add revision/publication coordinates to the outbox;
4. backfill historical articles with revision, rights snapshot, and public publication records;
5. bind unprocessed historical outbox events to the migration transaction's stable coordinate;
6. create read-only view `article_publication_consistency_v1`.

The migration never rewrites processed events. Historical pending/retry events cannot recover a publication coordinate absent at their original time, so they explicitly bind to the migration transaction's current stable version. Every post-migration event must carry exact coordinates when written.

## Consistency query

Run before and after deployment:

```sql
SELECT issue, COUNT(*)
FROM article_publication_consistency_v1
GROUP BY issue
ORDER BY issue;
```

The expected result is empty. The checker covers a public article without a publication pointer, a publication without a revision, revision-number and rights-snapshot mismatches, and pending/retry outbox entries without exact revision coordinates.

## Local acceptance matrix

Acceptance uses only local PostgreSQL, a fixed UTC clock, a single-process
worker, and repository data:

- anonymous: list/detail retain the same `publicationNo`; before the scheduled time, the old version remains readable;
- signed-in: private detail exposes current editing `revisionNo` while the public coordinate remains old;
- admin: immediate/scheduled publish, archive, restore, and revision rollback use the shared transition entry point;
- state matrix: a fixed UTC clock covers all 5x5 source/target combinations and create, rollback, restore, and scheduled-worker constraints;
- validation: unknown enums, missing/expired schedule time, time on a non-scheduled state, and direct `Deleted` writes each assert a stable error details code;
- notification stream: event preview and outbox retain identical revision/publication coordinates;
- binary: new coordinates flow through list/detail projections and old cache versions remain readable;
- AOT, search, and cache: each article's public content and publication record point to the same revision;
- fault injection: failure in a publication record, pointer, or outbox write rolls back the transaction and leaves the old public version readable.

Full production environments, PRs, releases, and external validation platforms are not acceptance requirements for this issue.

The `public-minimal` fixture's published articles use the existing
`ICanonicalArticlePublicationFixturePort` and `CanonicalArticlePublicationVerifier`,
including revision/publication pointers, rights/responsibility bindings and outbox/audit
evidence. A status-only article created without a verified publication cannot stand in
for a published article in runtime-cache acceptance. The related-reading producer retains
the actual response bytes for all 102 requests; its independent checker requires HTTP
200, AEDS v2 `ArticleRelatedReading` type and valid payload CRC, same-key/hot byte parity,
cold DB commands at most two, one same-key build, and a zero-command hot L1 frame.
Negative-cache 404 responses cannot satisfy these assertions. Checker unit fixtures are
not a substitute for the source-bound real PostgreSQL/Redis/Kestrel run.

## Independent public fixture admission

The public-content composition root exposes a Development-only, loopback and
local-fixture-secret gated `/api/local/public-content-fixture/verify` port. Prepare
signs its run/namespace/profile/source/variant identity, owned IDs and original
observations with the local fixture key. Verify rejects foreign or altered proofs,
independently reruns the existing publication/lifecycle verifiers, and rereads owned
DB rows, public detail/list/hot/featured/search ports and actual Redis rank/version
state. It invokes no fixture writer, cache rebuild, invalidation or repair action.
Pointer, readability, ordering, cursor, cache or generation drift fails admission;
prepare observations and an adapter returning only `ok: true` cannot qualify it.

After independent verification, the unique CLI can project a verified receipt:

```bash
node tools/test-fixtures/cli.mjs verify --receipt prepare-state.json --out fixture-receipt.json
node tools/test-fixtures/cli.mjs project-verified --receipt fixture-receipt.json --out projection.json
```

The existing `article-pagination-deep` postcondition validates the sealed
pagination-keyset observation before its page 10/100/1000 cursors are projected.
The private projection binds the verified receipt digest and remains
`notAuthoritative: true`; neither a prepared projection nor a prepare-state can
authorize this command. Focused verifier/CLI regressions are not real-runtime
qualification, and a new source candidate requires fresh runtime evidence.

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

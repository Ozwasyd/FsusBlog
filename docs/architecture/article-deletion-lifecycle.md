# Article permanent-deletion lifecycle

`docs/architecture/article-deletion-data-catalog.json` is the machine-readable authority for every article-associated table touched or deliberately retained by permanent deletion. `ArticleDeletionKernel` is the only database deletion kernel used by both single-article permanent deletion and bulk trash clearing.

## Transaction boundary

The caller first locks and rechecks soft-deleted `article` rows. Inside the same PostgreSQL transaction, the kernel:

1. reconciles current-article and linked-draft asset URLs against the authoritative asset ledger;
2. removes current body, drafts, tags and current read/projection rows for the exact locked ids;
3. nulls only the source attribution on shared asset-library items;
4. removes current-article and linked-draft ledger sources while retaining revision sources;
5. writes one durable deletion outbox event per article;
6. deletes the soft-deleted aggregate roots and rejects a target-count mismatch so the transaction rolls back.

The single and bulk entry points therefore cannot drift into different table lists. A repeated single deletion returns not found; repeated trash clearing locks no targets and returns zero. Neither path broadens its SQL beyond the locked id set.

## Retained history is not live state

Revisions currently have no expiry policy. Revision rows, publication and rights/responsibility snapshots, proofs, transparency records and their revision asset references remain together. Mutation outbox rows remain replayable. Comment moderation events are database-enforced append-only, so comments and their compliance/moderation evidence remain a separately retained historical record. Public queries already require a live, visible article and cannot expose these retained rows as current content.

This retention is intentional and explicit in the catalog; adding a new article-linked table without a catalog policy makes the repository checker fail. A future retention job must remove each immutable graph and its revision asset sources atomically instead of extending the permanent-delete kernel ad hoc.

## File cleanup and operational degradation

The transaction never deletes a file. Zero-reference URLs are inserted into `article_asset_cleanup_queue`; the existing multi-consumer worker rechecks the ledger and deletes through the local `IFileService` substitute idempotently. Shared and retained-revision assets therefore survive article deletion.

Physical cleanup can be paused without restarting the application:

```sql
UPDATE article_asset_cleanup_queue
SET not_before_utc = (now() AT TIME ZONE 'utc') + interval '7 days',
    updated_at_utc = now() AT TIME ZONE 'utc';
```

This is the conservative rollback path: article database deletion stays committed, retained history and files remain intact, and cleanup resumes when queue deadlines are restored.

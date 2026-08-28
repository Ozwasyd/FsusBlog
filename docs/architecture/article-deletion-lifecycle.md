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
## Current deletion semantics

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.delete-semantics
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.delete-semantics
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.delete-semantics -->
| Key | Value |
| --- | --- |
| createsPublication | false |
| createsRevision | false |
| createsTombstone | false |
| enterVia | dedicated-delete-flow |
| ordinaryTransitionTarget | forbidden |
| outboxEventType | deleted |
| permanentDeleteEventType | permanently-deleted |
| preservesCurrentPublicationPointer | true |
| preservesImmutableHistory | true |
| softDelete | true |
| status | Deleted |
| visibilityTransition | current-to-deleted |
<!-- FSUSBLOG-GENERATED:END content.article.delete-semantics -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.article-public-visibility
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.public-visibility
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.public-visibility -->
| Key | Value |
| --- | --- |
| Archived | false |
| Deleted | false |
| Draft | false |
| Published | true |
| Scheduled | false |
<!-- FSUSBLOG-GENERATED:END content.article.public-visibility -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.article-admin-visibility
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.admin-visibility
render: enum-set
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.admin-visibility -->
- `Archived`
- `Deleted`
- `Draft`
- `Published`
- `Scheduled`
<!-- FSUSBLOG-GENERATED:END content.article.admin-visibility -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.delete-causal
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.delete.causal
render: relation-subject-predicate-object
-->
soft delete preserves current revision publication pointer and immutable history without creating revision publication or tombstone。

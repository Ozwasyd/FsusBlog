# Article revision concurrency

Article revision numbers are scoped to one article. Revision allocation must therefore serialize writers for the same article without taking a table lock that expands the lock graph to unrelated articles.

## Lock and allocation protocol

`ArticleService.SaveArticleRevisionAsync` runs inside the caller's PostgreSQL transaction and follows this order:

1. acquire `pg_advisory_xact_lock(hashtext('article_revision'), articleId)`;
2. lock the live `article` row with `FOR UPDATE` and reject deleted or missing articles;
3. read `MAX(revision_no)` for that article only and propose the next number;
4. insert the immutable revision, guarded by the unique `(article_id, revision_no)` index;
5. if an exceptional writer that does not follow the advisory-lock protocol wins the same number, `ON CONFLICT DO NOTHING` keeps the transaction usable and the allocator recomputes at most three times.

There is no `LOCK TABLE article_revision` statement. Same-article writers wait on one article-scoped advisory lock and produce a continuous unique sequence. Different-article writers acquire different lock keys and may commit while another article transaction remains open.

The unique index is the final database invariant, not the primary coordination mechanism. Bounded retry handles legacy or maintenance writers without an infinite loop; exhausting the limit fails the entire owning transaction.

## Rollback and operations

Advisory locks are transaction-scoped and release automatically on commit or rollback. A rolled-back insert does not consume a revision number; the next successful writer recomputes from committed rows and may reuse that number. No sequence repair or manual unlock is required.

Historical rollback uses the same article-scoped transaction and lock order as a normal update. The request supplies the current `baseRevisionId`; the article-row CAS runs before the source package is copied. A successful rollback allocates fresh revision and publication coordinates, copies the source rights and responsibility snapshots into new bindings, records source revision/actor/reason, and writes only the new coordinates to the mutation outbox. A stale base or incomplete required package aborts the transaction without partially persisted bindings or events. The historical row is never reactivated.

If revision writes must be degraded, disable the article authoring write surface through the existing active-slot rollback rather than dropping the unique index or terminating PostgreSQL sessions. Existing reads and immutable revisions remain available. The local PostgreSQL concurrency tests cover same-article contention, different-article progress, deleted-article rejection, bounded conflict handling shape and rollback reuse; production traffic or an external database service is not required.
## Current rollback semantics

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.rollback
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.rollback-semantics
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.rollback-semantics -->
| Key | Value |
| --- | --- |
| allowedTargets | &#91;"Archived","Draft","Published"&#93; |
| clonesResponsibilityFromSourceRevision | true |
| createsPublication | true |
| forbiddenTargets | &#91;"Deleted","Scheduled"&#93; |
| operation | Rollback |
<!-- FSUSBLOG-GENERATED:END content.article.rollback-semantics -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.rollback-causal
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.rollback.causal
render: relation-subject-predicate-object
-->
rollback creates new revision and new publication coordinates from a historical revision while preserving immutable history when the requested historical revision is accepted as the rollback source。

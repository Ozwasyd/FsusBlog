# Comment query boundary

`ICommentQueryService` owns public thread/reply reads, legacy Core query
projection, and attributable account history:

```text
binary comment GET routes / CommentCoreGateway
  -> ICommentQueryService
       -> ISqlSugarClient
       -> IRegionLegalModerationService
```

The query service applies keyset pagination, moderation visibility, conservative
unknown-region filtering, and author snapshot projection without calling the
comment command service. `CommentCommandService` no longer owns query methods or query
row models. `CommentCoreGateway` depends on separate query and command ports
instead of the aggregate implementation.

Routes, cursors, SQL ordering, region visibility, display fallbacks, cache keys,
and AEDS contracts remain unchanged. Rollback requires no schema or cache
migration.
## Current thread depth boundary

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.max-depth
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.max-depth
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.comment.max-depth -->
| Key | Value |
| --- | --- |
| compare | parent.depth + 1 &lt;= maxDepth |
| configurationKey | CommentThreads:MaxDepth |
| default | 32 levels |
| enforcement | reject-new-write |
| maximum | 256 levels |
| minimum | 2 levels |
<!-- FSUSBLOG-GENERATED:END content.comment.max-depth -->

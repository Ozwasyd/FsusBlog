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

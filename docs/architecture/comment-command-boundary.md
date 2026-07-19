# Comment command boundary

`CommentCommandService` is the composition root for comment mutations. It owns
only create/delete transaction orchestration and depends on four narrow domain
ports:

```text
CommentCommandService
  -> ICommentAttributionPrivacyService
  -> ICommentModerationService
  -> ICommentNotificationService
  -> ICacheInvalidationDispatcher
```

Query projection is served directly by `ICommentQueryService`; identity and
privacy, moderation and visibility, and notification behavior live behind the
ports above. There is no generic `CommentService` facade and none of the narrow
services calls back into command orchestration.

The rename does not change endpoint, response, transaction, or audit-source
semantics. Both `ICommentEndpointService` and the core bridge's
`ICommentCommandService` resolve to the same scoped command implementation.
Rollback can independently disable anonymous policy or automatic moderation
while public create/delete commands remain available.

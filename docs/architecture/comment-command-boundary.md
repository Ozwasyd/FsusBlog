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
## Current thread invariants

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.thread-invariants
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.thread-invariants
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.comment.thread-invariants -->
| Key | Value |
| --- | --- |
| depth | max(1, parent.Depth + 1) |
| parentMustBePubliclyApprovedVisible | true |
| replyToCommentIdDefaultsToParent | true |
| requestedRootMustMatchComputed | true |
| rootId | parent.RootId ?? parent.Id |
| rootRequiresParent | true |
<!-- FSUSBLOG-GENERATED:END content.comment.thread-invariants -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.child-limit
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.child-limit
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.comment.child-limit -->
| Key | Value |
| --- | --- |
| boundary | exclusive-upper-on-count |
| compare | childCount &lt; maxChildren |
| configurationKey | CommentThreads:MaxChildrenPerNode |
| default | 500 children |
| enforcement | reject-new-write |
| maximum | 10000 children |
| minimum | 1 children |
<!-- FSUSBLOG-GENERATED:END content.comment.child-limit -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.edit-delete-version
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.edit-delete-version
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.comment.edit-delete-version -->
| Key | Value |
| --- | --- |
| editWindow | {"configurationKey":"Comments:AuthorEditWindowMinutes","default":{"unit":"minutes","value":30}} |
| expectedVersionCas | true |
| nextVersion | currentVersion + 1 |
| operations | ["created","deleted","edited"] |
| softDeleteProjectsAsHiddenNextStatus | true |
<!-- FSUSBLOG-GENERATED:END content.comment.edit-delete-version -->

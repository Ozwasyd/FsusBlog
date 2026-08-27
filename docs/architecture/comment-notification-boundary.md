# Comment notification boundary

`ICommentNotificationService` owns comment removal realtime delivery and
transactional account notices:

```text
comment command / moderation result
  -> ICommentNotificationService
       -> IMessageRealtimePublisher
       -> IMessageCommandService
```

The comment command service depends on this narrow port and no longer owns
message publisher fields or notification formatting/execution. The notification
service never calls back into comment command, query, attribution, or moderation
services.

Realtime removal payloads, deletion notice wording, model-risk notice wording,
best-effort error handling, and fire-and-forget call sites remain unchanged.
## Current notification conditions

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.notification
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.notification
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.comment.notification -->
| Key | Value |
| --- | --- |
| anonymousReplyDoesNotMapIdentity | true |
| publishAdded | transition-into-Approved |
| publishRemoved | transition-out-of-Approved-or-delete |
| replyNotificationEvent | CommentReplyNotificationRequested |
| requiresPublicRecipientAccount | true |
<!-- FSUSBLOG-GENERATED:END content.comment.notification -->

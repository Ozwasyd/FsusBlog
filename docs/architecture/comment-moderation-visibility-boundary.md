# Comment moderation and visibility boundary

`ICommentModerationService` owns the policy and persistence work that follows a
validated comment command:

```text
comment command
  -> ICommentModerationService
       -> region decision and visibility rows
       -> anti-spam score and disposition policy
       -> guarded moderation status update
       -> cache invalidation and removal notification on automatic hide
```

`CommentCommandService` retains transaction ownership for creating a comment and
consuming its anonymous nullifier. Visibility rows are written through the
moderation boundary using the same scoped `ISqlSugarClient`, so they remain in
that transaction. The moderation service never calls back into comment command
or query services.

The extraction does not change endpoint, response, region, or moderation
semantics. A runtime rollback can disable the anti-spam provider or its
automatic disposition policy without restarting; region visibility persistence
continues independently.
## Current public visibility mapping

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.public-visibility
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.public-visibility
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.comment.public-visibility -->
| Key | Value |
| --- | --- |
| Approved | true |
| Hidden | false |
| Pending | false |
| Rejected | false |
<!-- FSUSBLOG-GENERATED:END content.comment.public-visibility -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.comment-admin-visibility
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.admin-visibility
render: enum-set
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.comment.admin-visibility -->
- `Approved`
- `Hidden`
- `Pending`
- `Rejected`
<!-- FSUSBLOG-GENERATED:END content.comment.admin-visibility -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.region-visibility
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.region-visibility
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.comment.region-visibility -->
| Key | Value |
| --- | --- |
| adminSurface | full-moderation-states |
| publicSurface | {"blockedRegionFilter":"viewer-region-aware","requires":"Approved","unknownViewer":"apply-all-blocked-regions"} |
| states | &#91;"deleted","hidden","limited","pending","public","rejected"&#93; |
<!-- FSUSBLOG-GENERATED:END content.comment.region-visibility -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.deleted-root-public
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.comment.deletedRoot.publicDescendants
render: relation-subject-predicate-object
-->
deleted root does-not-hide independently visible direct and recursive descendants while the root is a deleted placeholder when each descendant remains Approved region-visible and belongs to the same published article。

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.deleted-root-admin
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.comment.deletedRoot.adminDescendants
render: relation-subject-predicate-object
-->
deleted root does-not-hide direct or recursive descendant entities from the admin and attributable projections when the projection is authorized for administrative or author attribution access。

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

## Production-shared pure policy inputs

Compiled callers can evaluate existing policy without constructing database services:
`AnonymousCommentPolicyService.EvaluateAuthorMode(policy, requestedAuthorMode, publicSendExplicitlySelected)`,
`ArticleCommentPolicyService.Compose(articleId, site, article, thread)`, and
`ArticleCommentPolicyService.EvaluateWrite(policy, authorMode, utcNow)` are public static
entry points used by the production services. Author-mode admission must precede the
article write-policy decision; the latter does not authenticate an actor or reject
every unsupported author mode. `utcNow` is an explicit business-time input, while
the article ID and policy snapshots come from the caller's authoritative article-role
mapping. These functions allocate no comment, revision, outbox or security facts.

`CommentModerationService.ResolveInitialState(actor, regionDecision, modelEnabled,
modelProviderAvailable)` shares the production initial-state decision with explicit
model settings. Production region rejection precedes this decision, which preserves
the ordering of hidden-region, manual-region, actor-review and model-review rules.
`CommentModerationTransitions.IsAllowed` owns later transition legality and
`CommentCommandService.ResolveReplyRecipientId(targetAuthorAccountId,
replyingActorAccountId)` owns target-derived recipient/self-reply suppression.
`AnonymousCommentScopePolicy` owns versioned top/thread scopes and credential quotas.
These source APIs do not verify proofs, reserve nullifiers, validate persisted thread
visibility, sign fixture receipts or substitute for canonical command transactions.

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

## Production initial outbox construction

`CommentCommandService.ResolveInitialOutboxEventTypes(status, replyToAccountId)`
returns the production create transaction's ordered obligations: created and
visibility-changed, followed by reply-notification-requested only for an approved
comment with an observed positive recipient. The transaction consumes this same
selection and retains its original enqueue order and cancellation behavior.

`CommentCommandService.BuildOutboxEvent(eventType, comment, commentId, occurredAt,
previousStatus, nextStatus)` exposes the existing production envelope constructor.
The caller supplies an already normalized authoritative comment, its allocated ID
and explicit business time. The method preserves the normalized root/parent and
account/recipient facts; a top-level root falls back to the allocated comment ID.
It does not resolve an actor, validate a persisted thread, enforce an event kind or
qualify those inputs. In-memory envelopes retain existing entity defaults, including
a fresh event GUID; they are not deterministic persisted identities or receipts.
Persistence and delivery fields remain the outbox writer and worker's responsibility.
The envelope still has no exact comment-revision field. These APIs do not reserve a
nullifier, create rows, prove atomicity or satisfy transaction/derived-edge acceptance.

## Production-shared revision construction

`CommentCommandService.BuildRevision(commentId, version, operation, normalizedContent,
createdAtUtc, actorMode, actorAccountId, actorAdminPrincipalId)` returns the same
unpersisted revision used by production create, author edit and author delete.
The caller supplies the allocated comment ID, explicit version, operation, time
and admitted actor facts. The constructor retains the exact content bytes and the
existing lowercase SHA-256 of their UTF-8 encoding. It does not normalize again:
create retains its original trim behavior, while author edit still converts CRLF
to LF and trims before calling the shared constructor.

The returned revision ID remains zero; the native persistence writer allocates
the revision row ID. This constructor creates no row, authenticates no actor and
signs no receipt. Article-policy premoderation still maps create to `Pending`
with `article_policy_premoderated`; revision extraction does not change that
transaction decision. Native atomicity and exact persisted revision observation
remain separate acceptance requirements.

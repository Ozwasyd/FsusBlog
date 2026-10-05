# Article mutation side-effect boundaries

Article persistence commits before side effects are dispatched. The mutation
path remains in-process, but each consistency boundary now owns its own ports:

```text
ArticleService / ScheduledPublishWorker
  -> IArticlePublicMutationFence
       -> durable public-artifact revocation and lease release

ArticleMutationSideEffectCoordinator
  -> ArticleMutationProjectionInvalidator
       -> cache, taxonomy, detail AEDS, public artifacts, hot-read ranking
  -> ArticleMutationDelivery
       -> search, realtime notification, optional integrity proof
  -> ArticleAssetCleanupPolicy
       -> illustration deletion
```

`ArticleMutationSideEffectCoordinator` is an event and outbox orchestrator. It
loads the mutation result, orders required replay edges, records per-edge
failures, and invokes the narrow owners above; it no longer holds Redis, cache,
artifact, search, realtime, integrity, or fence-lease dependencies directly.

The public mutation fence is established before a public database mutation.
Commit promotes the durable revocation and releases the lease; an aborted
transaction uses the same fail-closed promotion path. Required outbox edges
remain individually replayable, while notification and integrity delivery keep
their existing idempotency and optional-failure semantics. Endpoint, AEDS,
authorization, transaction, and cache-visibility contracts are unchanged.

## Bulk plan facts and admission

`ArticleBulkPlanAuthority` freezes the exact selection before execution. Eligible
items require complete permission and state digests both at preflight and during
integrity verification, even when an adversarial plan has been independently
resealed. An inaccessible article has the same persisted facts and proposed-change
digest whether it is absent, belongs to another site, or is permission-denied;
private state cannot distinguish these cases through a digest. Authorized state
changes still invalidate the frozen plan, including authorized blocked items.

`ArticleBulkExecutionFramework` resolves an existing exact idempotency result
before new admission. For a new attempt it rechecks the original exclusive expiry
after awaited current-authority and article preflight, before creating the first
journal entry. At or beyond expiry no new admission request, journal head, or
planned event is created. It does not refresh the plan, rerun dynamic selection,
alter the operation strategy, or relax authorization and side-effect ownership.

## Current optional outbox edges

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.optional-edges
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.optional-outbox-edges
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.optional-outbox-edges -->
- `integrity-proof`
- `notification`
<!-- FSUSBLOG-GENERATED:END content.article.optional-outbox-edges -->

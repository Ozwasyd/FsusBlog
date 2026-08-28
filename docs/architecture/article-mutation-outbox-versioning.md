# Versioned article mutation outbox

`article_mutation_outbox` v2 prevents an old event from re-reading the newest article after consecutive updates. The producer and authority write share one PostgreSQL transaction. Before commit, the event columns and payload preserve:

- article revision ID/no;
- publication `releaseId`/no;
- rights snapshot ID;
- responsibility snapshot ID/version;
- `occurredAt` and `publicUpdatedAt`;
- category, tag, and visibility before/after scope.

Create, update, delete, restore, permanent-delete, trash-clear, scheduled publish, category/tag rename, rights proof, and responsibility update all use `ArticleMutationOutboxProducer` or the same ArticleService factory path. A producer must not write a legacy payload containing only `articleId` and `eventType`.

## Replay ordering and idempotency

After claim, the dispatcher validates column/payload agreement and resolves the revision, release, rights, and responsibility coordinates from PostgreSQL. If the current article pointer references another release/revision, the event is terminal superseded. Every unfinished required edge and the notification/integrity optional edges are persisted as `skipped`; `last_error` contains the same `superseded-by-release:<id>` or `superseded-by-revision:<id>` reason. Both `completed` and `skipped` are terminal edge states.

Only the current event enters consumers. PublicAOT uses the envelope before/after taxonomy scope. Search receives content resolved from the event release. ArticleDetail AEDS and PublicHotRead receive the expected release and preserve the current artifact if that coordinate no longer resolves. Notification uses the stable event delivery key and `occurredAt`. The unique edge key `(outbox_event_id, edge_name)` prevents duplicate claim from repeating a terminal edge. After process restart, an expired claim can be reclaimed and only failed/pending edges run.

## Migration and rollback

`20260720-pre-article-mutation-outbox-version` is an additive Expand migration. It adds the compatible responsibility version default first, then adds `schema_version`, `rights_snapshot_id`, and `responsibility_version` to the outbox and backfills legacy coordinates from publication and responsibility snapshots. The later responsibility migration can safely reuse the same additive column. Legacy v1 payload remains readable: dispatcher reconciliation prefers the backfilled stable columns, validates them like v2 coordinates, and persists the same per-edge terminal evidence. Every new writer emits v2; a legacy row does not authorize a new writer to omit coordinates.

Authority transactions treat the outbox insert as part of the write, not a post-commit notification. If production of a responsibility, publication, or article mutation event fails, its snapshot/current pointer and event all roll back together. Operators must repair the producer or schema and retry the authority command; they must not synthesize a latest-state event outside that transaction.

For a no-restart rollback, reload `ArticleMutationOutbox:Enabled=false` to stop new claims while authority writes continue to retain pending events. Re-enable it after repair for idempotent replay. Rollback must not delete v2 columns, events, or edge evidence.

## Verification

Focused validation covers v2 codec/factory, migration catalog, consecutive release changes, older E1 before current E2, legacy-current edge persistence, producer rollback, duplicate poll, expired-claim restart, and version-aware AEDS/HotRead/notification:

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter 'FullyQualifiedName~ArticleMutationOutbox'
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter 'FullyQualifiedName~ArticleMutationVersionedOutboxIntegrationTests|FullyQualifiedName~PublicArticleProjectionOutbox_CriticalFailureRetriesWithoutRepeatingCompletedEdges'
```
## Current outbox event types

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.event-types
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.outbox-events
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.outbox-events -->
- `category-updated`
- `created`
- `deleted`
- `permanently-deleted`
- `responsibility-updated`
- `restored`
- `rights-proof-updated`
- `scheduled-published`
- `tag-updated`
- `trash-cleared`
- `updated`
<!-- FSUSBLOG-GENERATED:END content.article.outbox-events -->

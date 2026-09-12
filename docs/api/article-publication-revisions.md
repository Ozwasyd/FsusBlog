# Article Revisions and Publication Coordinates

Canonical details live in the [API contracts](contracts.md) and [API design](design.md); the [publication-consistency tests](../testing/article-publication-consistency.md) are the verification reference for this model.

## Purpose

Editing and public state use independent coordinates:

- `current_revision_id` points to the current authoring revision.
- `current_publication_id` points to the current public publication record.

A publication is an immutable snapshot bound to `article_revision_id`, `revision_no`, `rights_snapshot_id`, optional `responsibility_snapshot_id`, publication time, and transition type. Public AOT, AEDS, search, and cache projections read that publication coordinate; event consumers must never infer the “latest revision.”

## State transitions

All writes go through `ArticlePublicationTransitionWriter`. The [API contracts](contracts.md) own the generated allowed/forbidden transition tables; this document and adjacent current authorities own the scheduled, rollback, restore, and delete coordinate relationships through their generated sections and controlled prose claims.

## Historical packages and rollback

A single-revision detail is a readable historical package containing the body revision, immutable Rights V3 snapshot, optional responsibility snapshot, and associated release coordinates. If a required rights snapshot is missing, return `packageComplete=false`; never synthesize a complete- looking package from the current or default policy.

Rollback uses AEDS JSON `ArticleRevisionRollbackRequest(213)` with `baseRevisionId`, target status, and an 8..500-character audit reason. In one transaction the server checks `baseRevisionId`, copies the source body, categories, tags, rights, and responsibility, then creates a new revision, rights/responsibility bindings, and release. The new revision records the source revision, executing admin principal, and reason. Old revisions and publications are never re-enabled or modified. `article_revision_conflict` returns without creating a revision, release, or outbox entry.

Every rollback receives new release coordinates, regardless of target visibility, and its outbox contains only the new revision/release. A `Draft` or `Archived` release is not publicly readable; only `Published` switches public projections. Therefore public AOT, search, feed, binary cache, and notification stream cannot replay an old publication as a new change.

The scheduler locks candidate articles, creates the publication, updates the article pointer, and writes the outbox in one database transaction. A failure rolls back the batch and leaves the old publication readable.

## Projection contract

Article list and detail projections carry `currentRevisionId` / `revisionNo` and `currentPublicationId` / `publicationNo`. Public title, summary, cover, category, body, tags, rights snapshot, and responsibility snapshot all come from the version fixed by `current_publication_id`; private authoring reads continue to show the current editing revision. Outbox events store exact coordinates in both columns and payload, and consumers process only the event's version.

## Revision body comparison contract

Revision body comparison consumes only a sealed compare plan reverified by `RevisionComparePlanVerifier`. The plan fixes the base and compare package references, raw Markdown SHA-256 digests, article/revision or draft coordinates, reader permission scope, metadata schema, options, expiry, cancellation identity, and resource budgets. Its admission record binds source bytes, physical-line counts, initial memory and minimum-output estimates, and token, hunk, and chunk limits before diff execution. The receipt independently binds those references and digests. Before execution, the service rereads both exact authorized packages; it must not reinterpret `latest` or a current pointer as another revision.

Historical and current revisions come from the existing authoring revision reader. Current drafts are reread through the existing authoring draft authority and sealed to the owner, primary site, article, draft key, server revision, source bytes, update time, and rights digest. Editing any of those coordinates makes the old document epoch stale. Missing, unauthorized, deleted, cross-article, incomplete, or tampered packages fail closed without returning package coordinates for unavailable sources. Packages remain the only authorities for body content, typed metadata, and rights/responsibility/release snapshots.

## Risks and no-restart rollback

Risks include legacy rows missing revision, rights, or responsibility snapshots, incomplete projection coordinates during migration, and old cache formats. Deploy expand-first: add nullable rollback-provenance columns and indexes, then enable the new code. An incomplete historical package fails closed; it is never filled from current/default policy. Cache readers accept the old format while writers emit the new one.

To downgrade, stop the scheduled-publish worker and outbox consumer while retaining pending events, switch traffic to code compatible with the old columns, and hide rollback. Keep the new database columns and indexes. On recovery, restart the worker and continue projection from exact event coordinates; neither PostgreSQL nor Redis needs a restart.

## Current publication coordinates

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.publication-coordinates
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.publication-coordinates
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.publication-coordinates -->
- `publicationId`
- `publicationNo`
- `responsibilitySnapshotId`
- `responsibilityVersion`
- `revisionId`
- `revisionNo`
- `rightsSnapshotId`
<!-- FSUSBLOG-GENERATED:END content.article.publication-coordinates -->

<a id="受控-publication-因果事实"></a>

## Controlled publication causality facts

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-boundary
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.scheduled-boundary
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.scheduled-boundary -->
| Key | Value |
| --- | --- |
| nonScheduledScheduledAt | forbidden |
| scheduledPublishAt | {"boundary":"exclusive","relationToUtcNow":"strictly-after","required":true,"unit":"utc-instant"} |
| status | Scheduled |
<!-- FSUSBLOG-GENERATED:END content.article.scheduled-boundary -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.restore-semantics
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.restore-semantics
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.restore-semantics -->
| Key | Value |
| --- | --- |
| createsPublication | true |
| operation | Restore |
| revivesOldPublicationPointer | false |
| source | Deleted |
| target | Published |
<!-- FSUSBLOG-GENERATED:END content.article.restore-semantics -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.responsibility
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.responsibility
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.responsibility -->
| Key | Value |
| --- | --- |
| publicProjection | article_responsibility_snapshot without admin-actor fields |
| requiredCoordinateWhenPresent | responsibilitySnapshotId |
| snapshotOptionalOnNonPublish | true |
| versionField | responsibilityVersion |
<!-- FSUSBLOG-GENERATED:END content.article.responsibility -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-pre-due
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.scheduled.preDueCurrent
render: relation-subject-predicate-object
-->
Before due time, a scheduled transition preserves the old current publication coordinate when the article already has a current publication and `pendingPublicationAt` is still in the future.

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-due
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.scheduled.dueTransition
render: relation-subject-predicate-object
-->
At or before the worker's current time, a due scheduled transition creates a new publication coordinate and switches the current pointer without creating another revision when `scheduledPublishAt` or `pendingPublicationAt` is due.

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-stale
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.scheduled.replaceCancelStale
render: relation-subject-predicate-object
-->
Replacement cancellation or a stale schedule does not switch the current publication pointer before a due row is successfully claimed when the due predicate no longer matches or the row loses its `FOR UPDATE SKIP LOCKED` claim.

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.restore-causal
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.restore.causal
render: relation-subject-predicate-object
-->
Restore creates a new publication coordinate without reviving the old publication or creating a new revision when a soft-deleted article is restored from its existing current revision.

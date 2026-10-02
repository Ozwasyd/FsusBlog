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

Compare packages, plans, and receipts use schema version `2` and planner `revision-compare-plan-v2`. A package carries its immutable schema version, which participates in its package digest; the verifier accepts only the current version. The metadata schema digest also binds the current schema and each field's normalization descriptor. The `summary` and `cover-image-url` fields remain typed `NullableString` values, with normalization `nullable-string-tagged-utf8-v2`: exact `N` means null; `S` followed by the original string means non-null. Thus empty is `S`, literal `null` is `Snull`, and literal `N` or `S` is `SN` or `SS`. Quotes, backslashes, control characters, and valid Unicode remain literal payload, without escaping, trimming, case folding, or Unicode normalization. Invalid Unicode sequences are rejected instead of being replaced during UTF-8 hashing. Consumers decode through the registry's typed codec, never infer null from displayed text.

The existing metadata payload limit remains 8192 .NET UTF-16 code units. Nullable-string framing is accounted for separately: the null tag carries zero payload units; a non-null tag adds exactly one unit to the encoded representation, allowing 8192 payload units and 8193 encoded units for this type only. The factory checks the raw payload before concatenation, and package validation applies the same tag and payload validator. All other metadata types retain their existing limit and representation, including nullable instants. This framing allowance does not raise any source, memory, output, or global resource budget. The existing source-based admission estimate is not a measurement or guarantee of total metadata heap usage.

Version 1 compare packages, plans, and receipts are incompatible and fail closed; version tags and bound digests, not lexical guesses, establish their provenance. Old plans are schema-stale before authorized package rereads; a version 2 envelope with a changed receipt or metadata-schema binding is tampered. A fresh authorized package with changed typed metadata, even null versus literal `null` with identical Markdown, makes its old version 2 plan source-stale. There is no dual acceptance, fallback, automatic resealing, or reinterpretation of old canonical values. Recovery must retain the original principal, site, and exact selectors, reread the existing authorized sources, and create and verify a new version 2 package and plan. Changed draft coordinates require a fresh draft epoch and server revision; historical selectors remain exact revisions, not `latest`. No revision, snapshot, storage, authorization, or AEDS wire schema is migrated. If consumers cannot use version 2, disable comparison until they can recreate current evidence rather than restoring colliding version 1 acceptance.

`revision-source-diff-v1` splits raw bytes into physical lines while preserving BOM, LF, CRLF, lone CR, trailing spaces, final-newline state, and Unicode bytes. Stable unique-line anchors produce closed equal/insert/delete/replace hunks without inferring moves. Only changed replace hunks are refined by `unicode-text-elements-v1`; invalid UTF-8 skips word refinement without changing the byte-level result. The registered `fsusblog-markdown-source-v1` provider supplies sealed ATX and setext source-node ranges while excluding fenced or indented code, block quotes, list containers, and HTML blocks. Rendered HTML, the current DOM, and local caches are never authorities.

The engine supplies stable context groups for unchanged ranges; consumers do not recalculate folding coordinates. Source byte, line, token, memory, time, output, hunk, and chunk limits come from the sealed admission. Token, output, and chunk accounting is enforced incrementally, and the algorithm runs on a worker task. Limit breaches, cancellation, expiry, package drift, structure ambiguity, and receipt/range tampering return no partial success.

The semantic receipt binds engine, segmenter, parser, budget, plan, source, structure, byte, line, token, word-edit, heading, context-group, hunk, chunk, memory, output, and representation identities. Identical inputs produce the same semantic receipt. Wall-clock elapsed time is isolated in an attempt receipt bound to that semantic digest. Diff results contain source ranges and content-addressed receipts only; they never become revision storage, an HTML patch, an AI summary, or a second body authority.

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
A scheduled transition before due preserves the old current publication coordinate when an article already has a current publication and pendingPublicationAt is still in the future.

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-due
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.scheduled.dueTransition
render: relation-subject-predicate-object
-->
A scheduled due transition creates new publication coordinate and switches current pointer without creating another revision when scheduledPublishAt or pendingPublicationAt is at or before the worker current time.

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.scheduled-stale
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.scheduled.replaceCancelStale
render: relation-subject-predicate-object
-->
Replacement cancellation or stale schedule does-not-switch the current publication pointer before a due row is successfully claimed when the due predicate no longer matches or the row loses the FOR UPDATE SKIP LOCKED claim.

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.restore-causal
behaviorId: article-comment-lifecycle-outbox
claimType: binary-relation
factPath: facts.article.restore.causal
render: relation-subject-predicate-object
-->
Restore creates a new publication coordinate without reviving the old publication or creating a new revision when a soft-deleted article is restored from its existing current revision.

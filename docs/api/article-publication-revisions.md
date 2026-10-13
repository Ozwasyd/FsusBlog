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

The original public AOT mapper carries those same snapshot coordinates into renderer options. Article normalization retains them in `bootstrap.article`, the browser's existing article-seed conversion retains them in `ArticleDetailResponse`, and the article entry also carries them into the hydration payload. IDs remain invariant decimal strings across the existing binary payload codec, including values above JavaScript's safe integer range; supplied numeric IDs must be safe integers and supplied coordinate numbers must be non-negative Int32 values. Legacy payloads with absent coordinates remain absent, and an explicitly null publication coordinate remains null. Neither missing coordinates nor a rights snapshot supplies publication or current-run proof: independent readback must compare the actual coordinates and original invocation against the persisted publication evidence. This projection does not change the AEDS wire or ABI.

## Revision body comparison contract

`POST /api/binary/author/articles/{articleId}/revisions/compare` accepts the dedicated AEDS `ArticleRevisionCompareRequest` (`253`) frame and returns `ArticleRevisionCompareResponse` (`254`). It uses the existing authoring binary admission and `ArticleWrite` permission. The server derives the admin principal, primary site, request identity, and expiry; clients supply only exact selectors, closed options/budgets, and cancellation identity. Revision IDs and persisted draft revisions are canonical decimal strings, including values above JavaScript's safe integer range. Requested metadata uses the existing service's independently verified source/metadata pipeline; source-only requests keep their original independent endpoint source verification. A single endpoint deadline starts before the service and covers final plan authorization. Original logical storage/workspace budgets remain enforced. Before AEDS materialization, the complete response must also pass the original AEDS JSON owner's bounded measurement with those same serialization options. The JSON payload budget is distinct from the protocol frame header; the same owner bounds known serialization/frame buffers using its fixed workspace, four times the measured JSON payload and the authoritative header size. This is not a measurement of native provider pools or complete process memory. Final package authorization follows these gates immediately before publication. Logical source storage estimates cannot replace this publication-byte check. Failure returns the existing binary error without partial coordinates, sizes, or content.

The bounded JSON measurement restricts individual text atoms to at most 2,730 UTF-16 characters or UTF-8 bytes (`16 KiB / 6`). A larger atom is refused before escape/transcoding scratch allocation, even when the total output budget would allow it. The writer also refuses requests exceeding its fixed 16 KiB buffer, so being within the atom limit alone does not guarantee acceptance. Accepted atoms use the original production encoder unchanged. The 64 KiB reservation covers the fixed counting buffer and bounded serializer state; it does not bound allocations inside arbitrary getters or custom converters. This conservative atom boundary does not qualify transport of arbitrary one-megabyte metadata values.

The response contains the plan receipt, source result and optional typed `metadataDiff`, never the complete bundle, reader context, raw package, or snapshot payload. Metadata `Number`, elapsed ticks and timing frequency are decimal strings; the original semantic receipt and its digest remain unchanged. `PartialMissingAuthority` is reviewable but is not complete or successful metadata acceptance. The single revision inspector materializes source ranges from the existing authorized revision/draft reads only after their exact identity, UTF-8 source digest and byte length match the receipt. Its source/metadata switch retains the cached result; unified/split changes create a new sealed compare request. No local diff, Markdown parser, HTML patch or metadata comparison replaces these server results. This contract does not establish production runtime or independent UI acceptance.

`POST /api/binary/author/articles/{articleId}/revisions/compare/draft-coordinate` uses `ArticleRevisionCompareDraftCoordinateRequest` (`255`) and `ArticleRevisionCompareDraftCoordinateResponse` (`256`) under that same admission. It authorizes the article before reading the actual principal's persisted draft, requires the exact draft key, article and decimal server revision, and obtains the document epoch from the original draft-context provider. The original context authority verifies the rights binding and current draft again; article authorization is reread before publication. The response contains only draft key, article ID, decimal server revision, document epoch and source digest. Missing, deleted, mismatched or unauthorized state returns a generic binary denial. The client consumes this coordinate unchanged for its sealed draft selector; it does not derive an epoch from the editor's local document state.

Revision body comparison consumes only a sealed compare plan reverified by `RevisionComparePlanVerifier`. The plan fixes the base and compare package references, raw Markdown SHA-256 digests, article/revision or draft coordinates, reader permission scope, metadata schema, options, expiry, cancellation identity, and resource budgets. Its admission record binds source bytes, physical-line counts, initial memory and minimum-output estimates, and token, hunk, and chunk limits before diff execution. The receipt independently binds those references and digests. Before execution, the service rereads both exact authorized packages; it must not reinterpret `latest` or a current pointer as another revision.

Historical and current revisions come from the existing authoring revision reader. Current drafts are reread through the existing authoring draft authority and sealed to the owner, primary site, article, draft key, server revision, source bytes, update time, and rights digest. Editing any of those coordinates makes the old document epoch stale. Missing, unauthorized, deleted, cross-article, incomplete, or tampered packages fail closed without returning package coordinates for unavailable sources. Packages remain the only authorities for body content, typed metadata, and rights/responsibility/release snapshots.

The closed metadata registry encodes nullable text as a canonical JSON string or the JSON null literal, preserving the distinction between absence, empty text, and the text `null`. Tag IDs are sorted positive stable IDs; duplicates and invalid IDs are rejected rather than silently removed. Sealing and independent verification reject noncanonical typed values, undefined lifecycle status values, and non-UTC instant encodings. Persisted timestamps with unspecified kind are interpreted as UTC, consistently with the draft epoch authority. Registry normalization participates in the metadata schema digest, so a plan created with the previous nullable representation cannot be reused. Independent authorized package rereads have their own sealed timeout, preserve caller cancellation, and reject packages returned after expiry or cancellation.

`revision-source-diff-v1` splits raw bytes into physical lines while preserving BOM, LF, CRLF, lone CR, trailing spaces, final-newline state, and Unicode bytes. Stable unique-line anchors produce closed equal/insert/delete/replace hunks without inferring moves. Only changed replace hunks are refined by `unicode-text-elements-v1`; invalid UTF-8 skips word refinement without changing the byte-level result. The registered `fsusblog-markdown-source-v1` provider supplies sealed ATX and setext source-node ranges while excluding fenced or indented code, block quotes, list containers, and HTML blocks. Rendered HTML, the current DOM, and local caches are never authorities.

The engine supplies stable context groups for unchanged ranges; consumers do not recalculate folding coordinates. Source byte, line, token, memory, time, output, hunk, and chunk limits come from the sealed admission. Token, output, and chunk accounting is enforced incrementally, and the algorithm runs on a worker task. Limit breaches, cancellation, expiry, package drift, structure ambiguity, and receipt/range tampering return no partial success.

Memory admission reserves a conservative managed-workspace envelope before line matching, UTF-16 decoding, token records and substrings, occurrence dictionaries, anchors/LIS arrays, heading identity sets, and output materialization. A span-only grapheme pass counts the actual tokens before token collections are allocated; a long coalesced word is charged for its character payload, not just one record. Temporary reservations are released after each matching/refinement phase while retained output stays charged. The successful receipt records the maximum concurrent envelope, independently reconstructed from verified raw ranges and token counts; a memory rejection records the prospective envelope that was refused and returns no partial ranges. Worker memory refusals pass through the original completion cancellation, expiry, and exact package rereads; a stale or cancelled comparison cannot publish a memory result instead. These are deterministic managed-workspace estimates, not measured process RSS, cumulative GC allocations, or ownership of the packages and canonical parser's allocations. No token or memory limit is lowered to make an input fit.

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


## Current publication projection invocation

Canonical fixture projection verification binds the independently retained original publication request to its exact persisted mutation command and immutable publication, rights, responsibility, and audit references. A receipt digest or relabeled run/namespace cannot replace that invocation. The existing canonical writer remains the sole publication owner; the projection verifier only observes its outputs and never writes or schedules repair. The prepare-bound public-content proof separately seals the original invocation for independent rereading. Current AOT document and hydration sidecar bytes must agree with the sealed version and rights under the existing bounded convergence deadline. Source integration for #2175 retains unresolved canonical runtime and release acceptance gates described in [Testing](../testing.md).

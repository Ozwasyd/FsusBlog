# Article Revisions and Publication Coordinates

Canonical details live in the [API contracts](contracts.md) and [API design](design.md); the [publication-consistency tests](../testing/article-publication-consistency.md) are the verification reference for this model.

## Purpose

Editing and public state use independent coordinates:

- `current_revision_id` points to the current authoring revision.
- `current_publication_id` points to the current public publication record.

A publication is an immutable snapshot bound to `article_revision_id`, `revision_no`, `rights_snapshot_id`, optional `responsibility_snapshot_id`, publication time, and transition type. Public AOT, AEDS, search, and cache projections read that publication coordinate; event consumers must never infer the “latest revision.”

## State transitions

All writes go through `ArticlePublicationTransitionWriter`. The [API contracts](contracts.md) own the generated allowed/forbidden transition tables; this document and adjacent current authorities own the scheduled, rollback, restore, and delete coordinate relationships through their generated sections and controlled prose claims.

## Explicit Inbox source commands

The shared `ArticleStatusValues` authority appends `Inbox=5` and the stable token
`inbox`; persisted Draft/Scheduled/Published/Archived/Deleted values remain 0–4.
The canonical lifecycle writer exposes `CreateInboxAsync`, `MoveToInboxAsync`
(Draft → Inbox), `TriageInboxAsync` (Inbox → Draft), `ArchiveInboxAsync`
(Inbox → Archived), and `RestoreArchivedAsync`. These commands require an ambient
caller transaction and current revision CAS, retain active-admin/article-write
admission, and reuse the existing revision, rights/responsibility, asset, outbox
and signed-audit owners. They do not commit a bulk item independently. Ordinary
Blank/Template article creation remains Draft. Generic updates may edit Inbox
content without changing its state; they cannot triage, archive, publish, schedule,
delete or move Draft into Inbox.

`previous_editable_status` records the exact Draft/Inbox source on archive and
survives same-state archive edits. Explicit restore must match that recorded
source. Legacy null provenance never grants this restore; Published/Scheduled
archive semantics retain their existing path and are not inferred as Inbox.
Inbox deletion uses the existing delete command and keeps Inbox provenance so
the old Deleted → Published restore cannot bypass triage. Deleted Inbox recovery
has no new command in this slice and remains refused until its product contract
is specified.

Inbox transitions create no publication. Existing public reads, public search,
AOT, RSS, sitemap and public counts select Published, so historical publication
timestamps/pointers do not make Inbox visible. Outbox visibility and Saved View
tokens use the shared lifecycle token authority. The internal author query source
reader can read Inbox coordinates/fields using the existing permission pipeline;
the public Inbox request/bucket gate stays unavailable pending current available
query/projection and downstream executor evidence. This source change does not
qualify or activate that surface, supply missing slugs, or issue bulk receipts.

The additive `20261011-post-article-inbox-editable-source` migration only defines
the nullable provenance column. It performs no experiment-row backfill: no
mechanically proven source-marker inventory exists in this source candidate.
No Draft is inferred from title, time, tags or content. The current draft reader
rejects explicit unknown values through the shared projection; omitted status
retains its existing default. The retained N-1 status projection rejects 5, but
its draft normalizer falls back to Published for unknown values. Public N-1
queries exclude persisted Inbox. Safe N-1 authoring compatibility is therefore
unproven and rollout must remain closed. Rollback after Inbox rows exist requires
retaining a reader that understands Inbox,
or disabling affected authoring access; never rewrite those rows to Draft to
make an old reader pass. The added column must precede compatible writer rollout.
Migration execution and provider/backup-restore qualification remain separate.

The existing lifecycle create path supplies article/revision/snapshot identity;
the independent `PostgresArticleCreatePersistence` currently supplies the formal
Blank/Template draft/document identity. Its convergence with CreateInbox is still
required before claiming the complete product create contract. A lifecycle result
alone is not a draft/document creation receipt or permission/site qualification.

## Historical packages and rollback

A single-revision detail is a readable historical package containing the body revision, immutable Rights V3 snapshot, optional responsibility snapshot, and associated release coordinates. If a required rights snapshot is missing, return `packageComplete=false`; never synthesize a complete- looking package from the current or default policy.

Rollback uses AEDS JSON `ArticleRevisionRollbackRequest(213)` with `baseRevisionId`, target status, and an 8..500-character audit reason. In one transaction the server checks `baseRevisionId`, copies the source body, categories, tags, rights, and responsibility, then creates a new revision, rights/responsibility bindings, and release. The new revision records the source revision, executing admin principal, and reason. Old revisions and publications are never re-enabled or modified. `article_revision_conflict` returns without creating a revision, release, or outbox entry.

Every rollback receives new release coordinates, regardless of target visibility, and its outbox contains only the new revision/release. A `Draft` or `Archived` release is not publicly readable; only `Published` switches public projections. Therefore public AOT, search, feed, binary cache, and notification stream cannot replay an old publication as a new change.

The scheduler locks candidate articles, creates the publication, updates the article pointer, and writes the outbox in one database transaction. A failure rolls back the batch and leaves the old publication readable.

## Projection contract

Article list and detail projections carry `currentRevisionId` / `revisionNo` and `currentPublicationId` / `publicationNo`. Public title, summary, cover, category, body, tags, rights snapshot, and responsibility snapshot all come from the version fixed by `current_publication_id`; private authoring reads continue to show the current editing revision. Outbox events store exact coordinates in both columns and payload, and consumers process only the event's version.

The original public AOT mapper carries those same snapshot coordinates into renderer options. Article normalization retains them in `bootstrap.article`, the browser's existing article-seed conversion retains them in `ArticleDetailResponse`, and the article entry also carries them into the hydration payload. IDs remain invariant decimal strings across the existing binary payload codec, including values above JavaScript's safe integer range; supplied numeric IDs must be safe integers and supplied coordinate numbers must be non-negative Int32 values. Legacy payloads with absent coordinates remain absent, and an explicitly null publication coordinate remains null. Neither missing coordinates nor a rights snapshot supplies publication or current-run proof: independent readback must compare the actual coordinates and original invocation against the persisted publication evidence. This projection does not change the AEDS wire or ABI.

## Revision body comparison contract

Revision body comparison consumes only a sealed compare plan reverified by `RevisionComparePlanVerifier`. The plan fixes the base and compare package references, raw Markdown SHA-256 digests, article/revision or draft coordinates, reader permission scope, metadata schema, options, expiry, cancellation identity, and resource budgets. Its admission record binds source bytes, physical-line counts, initial memory and minimum-output estimates, and token, hunk, and chunk limits before diff execution. The receipt independently binds those references and digests. Before execution, the service rereads both exact authorized packages; it must not reinterpret `latest` or a current pointer as another revision.

Historical and current revisions come from the existing authoring revision reader. Current drafts are reread through the existing authoring draft authority and sealed to the owner, primary site, article, draft key, server revision, source bytes, update time, and rights digest. Editing any of those coordinates makes the old document epoch stale. Missing, unauthorized, deleted, cross-article, incomplete, or tampered packages fail closed without returning package coordinates for unavailable sources. Packages remain the only authorities for body content, typed metadata, and rights/responsibility/release snapshots.

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

Server draft saves and canonical lifecycle revision updates retain the supplied Markdown verbatim, including BOM, line endings, trailing whitespace and final-newline state. The existing 200,000 UTF-16 code-unit bound is enforced before mutation: oversized source is refused rather than truncated, and invalid UTF-16 is refused rather than silently replaced during UTF-8 encoding. Draft retries compare the exact retained source within the existing client-revision/CAS rules. Revision updates pass the same source to immutable content storage, the mutable body projection and the existing audit/outbox transaction; other production metadata normalizers retain their current policies.

This source admission does not supply an embed dependency commit. The embed author's graph/relation contracts require independently observed current facts and the canonical writer's transactional persistence; a verified graph, refresh comparison or frozen dependency projection alone is not an authorized save or publication receipt. Dependency payload, host/draft/epoch/range/token bindings, old/new coordinate persistence, and atomic failure/replay acceptance remain required before embed refresh is qualified.

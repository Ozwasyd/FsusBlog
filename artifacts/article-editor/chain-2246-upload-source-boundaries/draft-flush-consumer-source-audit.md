# Historical source audit: Writer draft and journal checkpoint boundary

Coordination evidence only; no new API definition, runtime receipt or acceptance.
Related to #2246, #2250, #1809, #1813, #2243, #2294 and #1216.

## Inspected source and ownership

Writer source: `d547d6a71bd8b9791339ed23e21e80a43728ca80`.
Parent producer audit: `114661988af3ab6022a5adf9a0e7b18d6c630388`, fetched and read
without incorporation. The original journal blob is identical in both graphs:
`2c8df95d2403a62330a8a32153b5b8895871266a`.
Writer composable blob: `9bea980196cfd0907912d642af04ef2701a4b265`; parent's is
`10f83cc16aaa0770bb95a9c15462b8dda9a02c01`.
Draft API blob: `efd294dc989bb7eacb4e6db5fc941d6215674614`.
Original backend lifecycle service blob: `3130b80b71be500433ca0cd9625913abccd022cb`.

Original journal issue is #1813. PR #3413 is storage policy alignment, not the
checkpoint producer. Parent assigned journal source exclusively to saved task
`01a12cb0-a264-7798-9ddb-2c2a2642d00b`. That task owns
`src/frontend/src/services/articleRecoveryJournal.ts` and narrow controls/docs;
Writer owns the caller composition, not a second journal or its implementation.
The session factory remains with the original session owner/main session. The
actual Write.vue/layout and frame owners remain separate. No installer is called.

## Actual current call chain

`useAdminArticleWrite.ts` privately owns `articleRecoveryFlushOwner`, draft save
state and the original document binding. `saveDraftNow(): void` stages a snapshot,
starts `queueArticleRecoveryWrite`, then invokes async `saveServerDraftSnapshot`.
It is not synchronous persistence proof. `flushArticleRecoveryWrite()` returns
`Promise<ArticleRecoveryJournalWriteResult>` and can return unavailable/null record.
The original flush owner exposes `stage`, `flush`, `markConfirmed`, `drain`,
`clear` and `pendingClientRevision`, with private sequence/pending/in-flight state.
It has no public checkpoint capture, synchronous inspect or validate operation.

`ArticleRecoveryJournalWriteInput` has principal identity, articleId, tabId,
base/server/client revision and content. It does not carry editorSessionRef,
draft identity/key, document identity/epoch/source revision or site scope.
`ArticleRecoveryJournalRecord` has id/hash/article/tab/revisions/content/timestamps;
it has no immutable owner-held token binding those missing coordinates.
A copied record, source hash, client revision or derived string cannot become
`crashJournalRef`. Confirm, TTL, clear/discard/logout/scope change and stale async
settlement must remain original journal invalidation decisions.

The private `buildDraftSnapshot` captures form metadata/content and contextDigest,
but rights are only shallow copied and its result is mutable. No draft checkpoint
ref/custody table or synchronous validation exists. Keeping another copied form,
constructing a digest ref or calling `saveDraftNow` does not fill that gap.
`ServerDraftSaveRequest`/`ServerDraftResponse` carry draftKey, article/base revision,
client revision and CAS serverRevision. `AuthoringDraftLifecycleService` enforces
principal-owned persistence and exact-source writes. #1216 supplies server CAS,
not an editor-session checkpoint or server DocumentId issuer. #1814 is tracking
of product surfaces, not a new backend producer issue.

## Exact Writer caller inputs for the original journal owner

The caller can supply, from existing actual owners:

- Original principal and site scope from `articleDocumentContextAdapter.context`
  and current principal identity; original `draftKey`, not a derived authority ID.
- Actual registry entry's `editorSessionRef`, article/draft/document identity and
  source/draft revision; original registry revision and association lifecycle.
- Actual mounted editor object and its public session; public
  `inspectDocumentState()` document identity/epoch and numeric revision.
- Existing clientRevision and original stage/write coordinates; source only through
  the original journal writer, without a second persisted body or storage fallback.
- Caller checks that the mount, registry association, principal/site, document
  context, epoch/source/draft revisions and form inputs remain current before and
  after an async capture. A changed/released owner makes the result inadmissible.

The needed producer contract is real asynchronous persistence followed by the
original owner returning an immutable checkpoint token; synchronous inspect and
validate must check that exact issued token's custody, persisted record and all
coordinates. Stage/confirm/clear/TTL/discard/principal-site-document-session changes
must invalidate according to the existing owner's policy. This describes the
consumer's required facts, not callable invented symbols. Consume only the parent
supplied exact journal commit/API and source evidence, then bind it inside the
original composable. No journal issue implementation was duplicated here.

## Precise remaining blockers

The current `AuthoringSessionSnapshotRefs` requires `draftStateRef` and
`crashJournalRef`; the retained FsusUI public snapshot does not issue these
application refs. The current factory correctly refuses full capture before
replacing an existing snapshot. Its refusal must remain until real custody joins
exist. The new journal primitive is a producer dependency, not a failed runtime
claim. Writer draft checkpoint lifetime/restore semantics must also be supplied
by the existing draft owner; no backend change is inferred merely to support a
local same-owner checkpoint.

A server-authorized DocumentId binding is a distinct previously recorded gap:
local opaque document identity and `primary-site` do not substitute for the
principal-owned backend draft coordinate and exact `primary` site. Current
`IAuthoringDraftLifecycle`, draft DTOs/routes and context provider expose no
Document acquire/bind/verify contract. #2243/local context and the original backend
draft/compare owner must provide that contract and identity mapping; do not assign
it to #1814 tracking, #3413 policy, Canvas authority or journal token issuance.

This audit adds no product port until the exact original producer contract exists.
No application/frontend type rerun is needed for this evidence-only increment.
No tests, listing/collection, mount, browser, native, backend/DB or runtime acceptance
were executed. No source acceptance or full factory qualification is asserted.

## Later caller source offer

The earlier API absence findings describe the d547/parent114 source graphs. Parent
subsequently supplied original journal PR4225 exact61c15600. Caller source54ef3efe
adds the real reader/invalidation/release binding, documented in the historical
`../chain-2246-writer-checkpoint-source/README.md` source offer. The whole producer
intake was aborted on a docs conflict, so dependency integration, full factory refs,
draft custody and server Document binding remain open. No runtime acceptance follows.

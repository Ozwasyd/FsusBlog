# Historical source offer: original Writer journal checkpoint caller

Source WIP and coordination evidence only. Related to #2246, #2250, #1813 and #2294.
Actual caller source: `54ef3efee2ec7f2fff8e6dbcdfa6385a79e933ab`;
composable blob: `49822a978e9f53e8b95f7476592fdc60d55f1c45`.
Parent supplied journal producer PR4225 exact
`61c156009ee7b2bc540b5efd84071adf171d679e`, actual journal blob
`e7265075e8afac1417d028cd42065903ddbd5745`.
That exact producer was read, and used only in the isolated static projection.
Independent producer review found a lifecycle P2: stale async restore/list can
invalidate a newer prepared token. The original journal owner is fixing captured-
generation invalidation. Consume no guessed replacement; exact fixed source is
pending. This caller still awaits independent source review.

## Actual caller and scope

The original `useAdminArticleWrite().authoringEditorRuntime.bindEditor(...)` now
returns `bindRecoveryCheckpoint(editorSessionRef)`. Call it on the same live
runtime bound object, with the original registry session ref, after an actual
mounted editor/document association and existing unconfirmed client revision are
available. There is at most one live checkpoint binding on that runtime. Release
its returned port or release the original runtime to drop custody and listeners.
No route/tree discovery, alternative journal, Markdown cache or session index exists.

The reader borrows the original registry entry, registry/lifecycle revisions,
actual mounted source and public session document observation. It checks original
article/draft/document identity, epoch, source/draft revision, live permission and
lifecycle and the same runtime/context before and after the mounted callback.
It refuses unavailable mounts, released owners, source/association changes and
missing unconfirmed client revision. Source/content remain the original Writer
form and original document owner; the caller retains no second body.

The principal must equal the raw principal captured when the original document
owner was acquired. This avoids treating a sanitized user scope, its collisions,
initial unknown scope or a later login as authentic document ownership. Site scope
is the actual local context value; it is not asserted as a server authorization
coordinate or a replacement for the missing canonical server Document binding.
Existing recovery coordinator browser tabId, draft key, base/server/client revision
are used directly. Registry tabId and browser recovery tabId are distinct original
coordinates; no fabricated replacement is generated.

The returned port calls the original journal's actual methods on that owner:
`prepare(signal?)` is asynchronous original persistence/token issuance;
`inspect(token)` and `validate(token)` are synchronous owner-local admission;
`restore(token)` is asynchronous storage/integrity reread and does not apply bytes
to the editor. Context and principal changes invalidate through the original
journal. Runtime release/unmount releases custody and unsubscribes both listeners.
Input/context changes and the original journal's own confirm/discard/clear/TTL
invalidation remain in force. Method wrappers retain the original journal binding.

No opaque token is stringified, digested or assigned to `crashJournalRef`.
The session factory remains unchanged and rejects unavailable full snapshots.
The independent full factory string-ref join, draft state custody, renderer/panel
custody, external #2245 evidence and real product/native acceptance remain open.
The producer explicitly cannot guarantee unseen cross-tab changes; this caller
does not add such a guarantee. No installer or session qualification is supplied.

## Actual dependency conflict and portable source

Whole producer intake failed at `docs/security/private-surface-runtime.md`; the
implementation commits were97e9177d andc77c4b57. The apply-check failed, but the
combined command erroneously continued to attempt cherry-pick. That attempt also
conflicted; `git cherry-pick --abort` succeeded and restored the pre-intake tree.
No conflict was resolved and no producer source/doc/storage-registry commit was
retained on this branch. Exact commands/status limits are in `intake-conflict.json`.
Cross-chain resolution remains with the parent. Do not replace shared source files
or broadly cherry-pick to conceal this conflict.

The owned caller imports the real producer types and calls `bindCheckpointSource`.
Until the original dependency is incorporated, this branch still has the old journal
blob `2c8df95d2403a62330a8a32153b5b8895871266a`, which lacks those two types and the
method. Therefore the main branch is not a compiling application candidate. The
full postimage and minimal caller patch against5e324f1d are reviewable offers for
the parent to consume after the dependency is actually available.

## Static scope and remaining acceptance

The original application type entry and strict-full style entry run against the
isolated original Writer source projection with exact61 journal, intended UI06d
and two canonical config overlays699. `static-results.json` binds exact commands,
exit codes, postimage hashes and retained failed attempts. Baseline and final projection both have227 diagnostics (exit2), zero added or
removed normalized type findings; owned composable style passes (exit0). Initial
style7 findings and one TS2367 addition were corrected; raw failures remain.
These are source checks, not a claim that the unjoined main branch or whole producer PR compiles.
Only the exact original journal module was projected; private storage registry,
security docs, factory, Write.vue and frame source were not changed by this caller.

No tests/list/collection/mount/native/browser/backend/DB/runtime were run.
#2246, #2250, #2253, #2256, #2280, #2282, #2284, #2286 and #2287 remain unaccepted;
#1809 remains tracking-only with child evidence incomplete. Full source integration
and acceptance remain open; `fullGeometryVerified=false`.

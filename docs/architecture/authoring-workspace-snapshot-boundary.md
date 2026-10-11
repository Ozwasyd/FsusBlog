# Authoring workspace snapshot source handoff

This source capability implements #2302–#2305 domain code under #1856. It is not
terminal #2306 acceptance. The integration owner retains shared wire/DI/endpoint/
migration registration, article/session/router/group owners and the live shell.

## Root source integration

The runtime composition now registers one scoped PostgreSQL persistence, snapshot
store and typed transport, using the existing `TimeProvider`. Registration performs
no reads, writes, DDL, bootstrap or default reset. A singleton
`AuthoringWorkspaceSnapshotSourceIdentity` hashes the closed source contract/schema
version, the Server's real nonzero `FsusBlog.SourceCommit` assembly metadata, and
the actual Server and Shared assembly artifacts using streaming SHA-256. There is
no client, configuration or fixture source override. Missing source metadata or
on-disk artifacts fails closed; this adapter makes no single-file/AOT qualification
claim. The official SDK build must receive `FsusBlogCommitSha` from its actual frozen
source commit, with the resulting artifacts and run identity recorded together.

The root typed GET/POST source integration uses AEDS request/response frames
270/271, active authenticated admin sessions, the existing article-write permission,
server-derived owner/site scope and no-store responses. POST retains PoW and checks
the request's expected source digest before write/reset CAS. These are source
boundaries pending executable endpoint/authentication acceptance. The transferred
default still opens the outline, conflicting with #1805's collapsed default. Reset
therefore refuses with `default_layout_unqualified`; registration never invokes it,
and the transport never silently changes a signed layout.

The additive offline migration
`20261008-post-authoring-workspace-snapshot` owns the PostgreSQL table. The bounded
single-row SQL offer is checked against that descriptor and the generated required
runtime recipe. The same-day `current-20261008-authoring` catalog composes the
unchanged property descriptor with the workspace descriptor in stable execution
order. Its metadata classifies only additive DDL as non-destructive Expand with
compatible-code rollback; it does not grant runtime or migration qualification.
No request or serve startup provisions this table.

A Server or Shared rebuild changes the source digest. Older source-bound rows
remain blocked by the retained store's closed parser, including before reset; no
background repair, overwrite or removal occurs. A separate accepted migration or
reset owner is required to address them. The fresh stamped SDK build, database and
HTTP receipts, #1805 default alignment, actual permission-batch authority, live
router/group/shell wiring and retirement of the legacy preference API remain
explicit acceptance gates. Source integration alone does not complete #2306.

`AuthoringWorkspaceSnapshotContract` owns the closed reference-only schema:
`default`, authenticated user/site scope, 100 tabs, two groups, 64 KiB, and
integer splitter permille from 200 to 800. Snapshot numbers stay within JavaScript
safe integers. A shared fixture verifies C#/TypeScript canonical digest parity.
Inspector views follow the existing inspector registry, including `rights`.
#1805 requires collapsed outline navigation (`outlineOpen: false`) when no
explicit user/site preference exists, for fresh bootstrap and confirmed reset.
The exact default-alignment source commit has not been consumed here: the current
Shared and TypeScript defaults still use `true`, so reset remains refused as
`default_layout_unqualified`. The ordinary asynchronous lifecycle repair does not
change this default or authorize a signed layout rewrite. Existing valid snapshots
retain their recorded boolean and digest, including previously saved open
preferences; reads, cache verification, restore and migration do not rewrite them.
The same saved boolean applies to mobile Drawer and desktop rail. The original
shell owner must distinguish a transient reveal-related close from an explicit
preference change when projecting shell commands into the snapshot.

`AuthoringWorkspaceSnapshotStore` reads without writes and requires expected
revision CAS for create, update and confirmed layout reset. Its PostgreSQL adapter
atomically inserts on conflict or updates the expected revision; it retains one
bounded row per user/site/default, without a receipt history or mutation queue.
`SchemaSql` is an integration offer, never request-time schema provisioning.
Keep the revisioned row across reset to prevent missing-state ABA. Incompatible
or corrupt rows remain blocked; no automatic repair or content deletion occurs.

Bind `AuthoringWorkspaceSnapshotApi` to authenticated typed AEDS v2 using the
existing session, PoW, response/error and privacy protections. Session-derived
scope must reach the server service; client scope is not authentication. No JSON,
local or unavailable-server transport implementation is supplied here.

The single IndexedDB store retains at most eight 80 KiB entries, with a 24-hour
expiry. Entries contain only last verified server snapshots. Cache reads produce
`cached-placeholder`, never a final restore authority. Server observations and
prepared plans have process-local provenance and are invalidated by newer server
responses, offline/scope cleanup and reset. Local mutations stay in current-session
memory. Reconnect reads before a write; changed server revision requires an
explicit server choice. BroadcastChannel carries only scoped revision/lease
invalidation. Web Locks coordinate same-browser flushes; server CAS still arbitrates
all tabs/devices. Input, caret and scroll cause zero snapshot writes.
Web Locks rejection retains dirty memory and reports coordination failure without
starting an uncoordinated writer. Layout changes made while a confirmed reset is
in flight wait for its CAS result and retain their new current-session projection.
Stale restore summaries are dropped when observation authority expires.
Read requests carry a process-local sequence: superseded requests are rejected
before receipt verification can revoke a newer observation at the same server
revision. Startup, read, flush and reset check their lifecycle epoch and current
server provenance after asynchronous cache completion. Cache outcomes are assigned
only while the operation is still current; stop clears reset activity and prevents
late completion from changing closed state. No wire field or second authority is
introduced by these guards.

Restore planning uses one bounded current permission/lifecycle/draft batch. It
removes invalid refs deterministically and exposes reason counts without titles
or fresh denied identities. Execution requires the original qualified FsusUI
factory, official group/shell adapters and a current operation-epoch guard.
The guard must change on user operations, router reset, logout and site switch.
Execution rejects an already started registry, rechecks batch facts, checks
registry revisions and session bindings, and uses the checked activate command.
It never copies editor state or rolls back by deleting a risky session.

Legacy inventory finds one layout key, `fsusblog.article-outline.rail-open.v1`.
It has no user/site/source proof, so migration discards its value. Only explicit
missing-server bootstrap can write default layout via CAS; current server state
wins and successful migration cleans only that key. No draft/comment/journal
keys are read or removed. The existing outline component still owns the old
reader/writer; its removal and shell command binding require the original owner.
`authoringWorkspaceSnapshotStatusModel` and `AuthoringWorkspaceSnapshotResetController`
offer quiet machine-backed status and confirmation logic; live rendering,
keyboard/focus/mobile/a11y qualification remain open.

Focused checks use the ordinary Vitest configuration and backend xUnit project:

```sh
cd src/frontend
node_modules/.bin/vitest run ../../tests/frontend/unit/authoring/authoringWorkspaceSnapshot.test.ts --maxWorkers=1
cd ../..
FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE=postgres:17-alpine dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter FullyQualifiedName~AuthoringWorkspaceSnapshot
node tests/frontend/checks/static/check-authoring-workspace-snapshot-governance.mjs --self-test
node tests/frontend/checks/static/check-authoring-workspace-snapshot-governance.mjs --full --self-test
```

The source-stage scanner derives fields, aliases, statuses and policies directly
from the TypeScript contracts and checks C# field parity. Its thirteen in-memory
structural mutations exercise name/second-workspace/content/local-authority,
unregistered transport, editor hydration, cache authority/provenance, restore
provenance, CAS removal and reset content-dependency rejection. These are source
controls, not semantic behavior-mutation or terminal qualification. Full mode
currently fails on the still-live legacy outline reader/writer, as intended.
The integration owner must register these runners in the authoritative matrix;
this domain does not edit shared runner/package/protocol registrations.

Native Chromium controls live in
`tests/frontend/browser/authoringWorkspaceSnapshot.browser.spec.ts` and use
`src/frontend/playwright.workspace-snapshot.config.ts`. Start the ordinary Vite
server on port 4317 using the configured FsusUI candidate. Make the already locked
frontend dependencies resolvable from the repository test directory (the current
environment uses a temporary repository-root `node_modules` symlink to
`src/frontend/node_modules`, removed after the run), then run:

```sh
cd src/frontend
PLAYWRIGHT_BROWSERS_PATH=/workspace/.setup/playwright-browsers node_modules/.bin/playwright test --config playwright.workspace-snapshot.config.ts
```

Those controls exercise native IndexedDB with 100 references, reload and actual
browser process restart, bounded retention/atomic revision replacement, and two
real tabs sharing BroadcastChannel/Web Locks. Their explicitly marked test
transport issues server fixtures only; it forbids write/reset and cannot certify
authenticated HTTP or production article/editor restore. The source-stage browser
report is `.tmp/workspace-browser/report.json`, with failure traces retained.

PostgreSQL tests use isolated fixture-owned databases/containers and two independent
connections. Transport fixtures and synthetic router interleavings are unit
controls, not authenticated HTTP, production FsusUI or terminal acceptance evidence.
Actual wire/session/PoW, registered migration/DI, real permission batch, official
two-group ownership/collapse, rendered UX, full restore browser/multi-device end-to-end,
mutation governance and performance qualification must be completed before issue
closure. Existing registry/session type errors and title-field governance failure
remain original-owner dependencies; no failed gate is waived.

## Extension panel snapshot binding source

`AuthoringPanelSnapshotBindingAdapter` consumes this owner's actual
`AuthoringWorkspaceSnapshotSync.getServerObservation()` and
`ArticleWorkspaceTabRouter`/open-document registry. Its closed content-free
request binds extension/package/panel, explicit user/site scope, source and
snapshot revision/digest, group/tab/document identity and epoch/revision,
request, read-grant reference and deadline. Cloned/cache observations cannot
pass server provenance; snapshot coordinates are not read permission.

The mandatory `AuthoringPanelReadAdmission` has no default or production
composition. Current package and read authority must be supplied by the original
host owner. A bounded single pending read is cancelled on snapshot/document or
permission drift, hidden state, deadline, replacement and disposal. Reentrant
abort/admission callbacks cannot publish a superseded request. This source uses
`8f7ac0f357c37966c68ca8607a02f000bf41407a`; the original Vitest configuration
executes `authoringPanelSnapshotAdapter.test.ts` against the real public owners.

This binding adapter registers no panel slot, renderer, dock/group/navigation,
layout command, snapshot write/reset or persistence. The current snapshot schema
has no plugin panel references; that upstream contract is not invented here.
Two-group layouts are explicitly blocked pending the original group owner.
Slot/layout admission, model/command composition, production read grants, full
resource/UI/scale qualification and snapshot reference reconciliation remain
open. Local fixture provenance and test admission are not production or terminal
acceptance evidence.

## Public editor session source dependency (#2294/#2295)

`fsusUiEditorSessionFactory.ts` resolves the actual mounted editor only through an
explicit callback supplied by the existing editor/document owner. It compares
article/draft/document identity, document epoch and source/draft revision refs,
binds the real FsusUI `getSession` once, and rechecks the owner after a retained
snapshot. No route traversal, component-tree discovery, second article/session
index, body store or second history owner is introduced. The existing
`MarkdownTextEditor` and `MarkdownEditorAdapter` forward this actual public API;
missing mounted instances fail explicitly.

The upstream retained snapshot is a real transaction-owner/view checkpoint, but
it cannot yet satisfy `AuthoringSessionSnapshotRefs`: the public renderer has no
last-valid-render checkpoint, provider resources lack complete census and
reversible pause/resume, and no recoverable-disposal owner exists. Draft and crash
journal refs also need their existing application owners. Full host snapshot
capture therefore refuses before replacing a retained snapshot. Resource methods
delegate to the actual FsusUI session; they never return synthetic zero counts.
Full restoration reports blocked with both proof flags false. No disposal or
snapshot failure is relabeled as successful lifecycle admission.

`installArticleWorkspaceEditorSessions` is the sole composition function: with
an explicit real resolver it creates one instance of the existing
`AuthoringSessionHost` and installs the existing `createArticleWorkspaceSessionPort`
bridge on the singleton router. Repeated calls with the same resolver return that
host; a different resolver is rejected. It has no automatic bootstrap call yet:
the current writing route still owns one route-mounted editor and does not supply
a retained per-session mount owner. The existing immediate fallback remains in
the unchanged router source. Thus production composition is **UNWIRED**, not ready.
The integration owner must supply the mounted-session owner and complete upstream
snapshot/resource participants before activating this composition in production.

This source is intended for the local FsusUI alias only. No package publication,
authority refresh, qualified runtime/test discovery, server/browser/native
execution, issue closure or merge is included. Security/privacy/receipt/native/
race/backuprestore/IME holds continue to apply. Current source and draft revision
refs must come from the original document owner, not from copying the requested
registry entry into the resolver's answer.


### Actual renderer proof receiver increment

The same public session now reads the existing mounted full-document renderer's
opaque authorized last-valid result ref. A missing renderer, fragment/embed view,
unrendered revision, old document/epoch or missing projection returns null. The
retained public snapshot includes that real proof when present; no hidden renderer
is created to qualify a source-only editor. The Blog factory forwards
`captureLastValidRender(entry)` and re-resolves the mounted original owner with
exact document/epoch/editor revision checks after capture. It caches no renderer,
body, history or session index.

This is neither validated renderer restoration nor a complete host snapshot. The
full factory still lacks active-node/scroll/outline/search/attachment checkpoint
contracts, renderer restoration and original draft/journal custody. Full snapshots
refuse before replacing the retained checkpoint. Production composition remains
UNWIRED, immediate receipt behavior is unchanged, and all qualification holds
remain in force. The controller-only language/search and partial renderer source
increments do not qualify total lifecycle usage or recoverable eviction.


The receiver also passes mounted-owner document identity/epoch/editor revision
into public retained capture. Upstream checks the actual transaction owner before
digest or checkpoint mutation, so a stale binding cannot replace the prior valid
checkpoint before the receiver's post-capture validation rejects it. Full snapshot
and disposal failures continue to preserve the original retained state.


The factory's `restoreLastValidRender(entry, render)` now forwards to the actual
public FsusUI mounted-renderer projection restoration and re-resolves the existing
mounted editor binding after the await. It rejects replaced editor/document/revision
owners. This partial renderer operation does not issue or restore a complete
#2294 snapshot, prove resource quiescence, or install the production composition.
UI916 source `21c9e8769c005ffbc1fbd0a09a7ccc463211984e` remains WIP with
`complete:false`; full lifecycle admission and all runtime holds remain unchanged.
The legacy upload event/callback path supplies no actual service Promise to the UI
attachment owner; no Promise is fabricated from the event or terminal label.


Writer/layout source handoff: `ArticleWorkspaceMountedEditorSource` supplies
`readMountedEditor(editorSessionRef)` from its actual retained mount custody and
`readDocumentBinding(editorSessionRef)` from its original article/document owner.
`createArticleWorkspaceMountedEditorResolver(source)` reads the actual upstream
`inspectDocumentState()` before first edit/render; it does not trust adapter event
caches or echo the registry request. It checks editor instance, original identity,
epoch and document context across its reads and owns no extra mount registry.
The factory independently checks that actual upstream document state on resolve.

Ownership remains: this session lane supplies the public source/adapter/factory/
resolver/one installer; Writer/#2246 owner supplies actual mount/document reads
and original per-session mount lifetime; layout #4213 owner calls the one installer
once in AdminWorkspaceFrame before workspace open operations. AccountRouteFrame
then hosts Write with its existing before-content tabs/separator. No layout, Write,
registry/group or second index is added here. Production binding and bootstrap must
use those actual owners; full snapshot/resource guards remain even after wiring.


The same installed composition now retains its original factory for readonly
`inspectArticleWorkspaceEditorResourceSources(entry)` calls. No extra factory,
host, mount cache or lifecycle state is created by this read. Before installation
it refuses explicitly, without falling back to immediate readiness. Its factory
`inspectResourceSources(entry)` reads the actual public owner census and renderer
measured source, then re-resolves the original binding and rejects replacement or
document/revision drift. Renderer complete:false, nullable network and unknown
fields remain source observations; language keeps its actual registered
non-recoverable controller. No observation signs ready/paused/eviction receipts.

Renderer UI916439ad560207b6cde1a6641c41d35c73714b45ad8 source is consumed in the
UI dependency, including actual pending control transitions; its cleanup-exception
P1 remains under original-owner repair. Attachment UI9155be7dcee904c4ea90db6835abf97a1e7319bd6a4 is not consumed or
admitted and its review flag remains false. Writer supplies the original actual
mount/document callbacks; layout4213 already has a consumer of the sole installer.
Their files and production host placement remain outside this session lane.
Full snapshot/refset and complete resource admission are still BLOCKED.

The same factory resource observation now also forwards actual
`session.inspectAttachmentResourceSource()` from the original upstream pipeline.
Unknown legacy settlement and transitional-owner inspection errors propagate;
scalar consumer network totals remain null and review/complete gates remain closed.
This read exposes neither pause/recovery proof nor an extra service/mount owner.
The original mount/session/document/context is revalidated after all source reads.

The factory's lifecycle bridge re-reads the original mounted/document owner before
inspect/pause/resume and disposal. A released or replaced Writer binding cannot
operate on a previously captured native session. Resource operations return their
actual upstream counts only after rechecking the same editor/session and original
identity, epoch, source/draft coordinates and native revision; owner drift refuses
the result rather than creating a successful lifecycle receipt. Disposal validates
the original mounted binding before handing the real snapshot ref to upstream;
it does not re-open a disposed session afterward or replace upstream failure
semantics. Complete resource/full-snapshot admission remains unavailable.

The corrected pipeline A candidate is
`ef17179f8788a4bf69f0998e8635191460ad1db1` (PR927); its supplied cleanup P1 closure
is source-only. The notification-watermark P2 remains under original-owner repair.
Attachment311ffe5d remains unconsumed with final-jobs callback context and raw/proxy
job findings under repair. These candidates never activate reviewed resource gates.

The real partial factory also exposes `restoreRetainedSnapshot(entry, snapshot)`
paired with its existing actual retained capture. It sends the original opaque
checkpoint directly to the same public session, using the actual mounted document
identity/epoch/native revision as the expected context. Upstream alone decides
custody, copied-token, revision and partial view/history/selection restore proof.
The factory rechecks the original editor/session and document/source/draft context
after the restore callback, including blocked results. No checkpoint cache or
second history exists here. The returned proof is only the original same-owner,
same-revision retained restore; it supplies no complete panel/draft/journal refset,
renderer hydration, resource suspension, disposal recovery or host-ready receipt.
Full `FsusUiPublicEditorSession.restoreSnapshot` stays explicitly blocked.

Composition exposes paired `captureArticleWorkspaceRetainedEditorSnapshot` and
`restoreArticleWorkspaceRetainedEditorSnapshot` calls through its SAME installed
factory. Both refuse before installation. They never install a fallback factory,
retain another checkpoint/history slot or modify the original session-port receipt.

### Failed installation custody and original producer gaps

`retireArticleWorkspaceEditorSessions(host)` revokes only the current original
composition's admission. It checks exact host identity and is idempotent for that
host. The original factory resolver checks the same lifetime before and after the
real Writer resolver; the original port uses its existing nextUsedTick callback to
refuse before attach/activate. Composition reads/capture/restore and even a same-
resolver reinstall refuse after retirement. Setter failure also retires custody.
The original host/factory/native references remain retained; no immediate fallback,
replacement host, successful disposal or released-resource acknowledgment is made.
Rail owns calling this on restore failure/cancellation, stopping its host use and
settling its actual installation task. Original Group attachedRegistry retirement
is a separate original-owner dependency; this module does not mutate Group/registry.
A new installation stays blocked while unsupported host/native retirement prevents
safe release. This is admission retirement, not disposal, suspend or recovery.

Actual inspected checkpoint producers at the original039fd source:

- `useAdminArticleWrite.ts` owns private ArticleDraftSnapshot/buildDraftSnapshot,
  applyDraftToForm, articleRecoveryFlushOwner and serverDraftRevision. Its public
  return exposes saveDraftNow:void, restoreLocalDraft and articleForm/context, not
  an immutable draft/checkpoint token or synchronous capture/validate/restore API.
  saveDraftNow starts genuine async journal/server work; a void return cannot be a
  settled snapshot. Writer/#2246 must expose the original settled draft/session
  custody bound to native owner, principal, documentId/epoch and source/draft refs.
- `articleRecoveryJournal.ts` (original checkpoint owner #1813; #3413 policy alignment) owns ArticleRecoveryFlushOwner.stage/flush/
  drain/markConfirmed/clear and ArticleRecoveryJournal.write/list/confirm. flush is
  async; pendingClientRevision is not storage confirmation. Record identity is
  principal-hash/article-key/recovery-tab and lacks editorSessionRef/documentId/
  documentEpoch. write updates that same id, confirm deletes matching stored data;
  neither id nor mutable latest result is an immutable retained crash checkpoint.
  The original recovery owner must supply settled checkpoint custody/validation
  with document/session binding and confirmation/clear/expiry invalidation before
  synchronous #2294 capture can consume it. No new journal is created here.
- `authoringPanelSnapshotAdapter.ts` binds extension panel reads to current server
  workspace observations/package grants. It owns read deadline/abort/subscriptions,
  not editor active-node/scroll/outline/search/attachment checkpoints, and cannot
  issue those refs. It is not an editor panel-state producer.
- UI MarkdownEditor captureViewState currently owns partial mode/search/caret-
  scroll state. Outline navigation uses pure model/reveal planners; attachment
  owner exposes resource/provenance operations but no recoverable state checkpoint.
  Full original UI panel checkpoint capture/validation/restore remains #2294/#2295
  work coordinated with the original editor/typography and language/attachment
  owners. Ref aliases or a reconstructed second panel/history owner cannot fill it.

Existing native panel partial restore and actual server-draft/journal APIs are not
replaced or executed. No independently usable full draft/journal/panel checkpoint
adapter can be wired from these current producer APIs. Full factory refusal and
reviewed gates remain; runtime/list/discovery/mount/native remain UNRUN.

### Original journal checkpoint consumer handoff (#1813 / #2294 / #2295)

Dedicated original journal owner: `01a12cb0-a264-7798-9ddb-2c2a2642d00b`.
The following is a required producer/consumer join, not a declared implemented
checkpoint API. It does not change existing persistence/privacy behavior.

| Binding input | Actual current producer | Consumer requirement |
| --- | --- | --- |
| editorSessionRef | Original registry association plus native getSession | Match exact bound public session, never derive from route/title. |
| articleId, draftId, documentId | Original Writer document owner and mounted resolver | Match all identity fields; articleId alone cannot identify an unsaved document. |
| documentEpoch | Actual native inspectDocumentState and original document context | Match both original owners; same bytes under a new epoch invalidate. |
| editorRevision | Actual native inspectDocumentState.revision | Number, distinct from nullable source/draft reference strings. |
| sourceRevision, draftRevision | Original ArticleDocumentContextRef | Preserve actual nullable values; do not substitute server row revision or a digest. |
| principal identityId | Original Writer recoveryIdentityId/admin principal | Factory currently has no principal source; Writer must bind/recheck it. permissionRef is not principal identity. |
| recovery tabId | Original ArticleRecoveryCoordinator.tabId | Distinct from workspace entry.tabId; do not substitute one for the other. |
| clientRevision, baseRevisionId, serverRevision, content | Original staged ArticleRecoveryJournalWriteInput | Preserve the exact real staged write/version; a pending revision is not durable confirmation. |

The real journal owner prepares/persists asynchronously using the existing journal.
Only the original owner's completed, immutable, genuinely held token may then be
read synchronously by the Writer/factory. Factory capture must not start write,
flush, SHA-256, IndexedDB read or a replacement Promise from the synchronous host
captureSnapshot call. Full capture stays blocked if the original completed token
is missing, superseded, invalidated, failed, not current or for another owner.

Required producer surface semantics (names remain the original owner's choice):
synchronous read of a previously completed bound checkpoint; synchronous inspection
of the ORIGINAL token/ref and exact binding; synchronous validation against current
owner/version; original invalidation on overwrite, confirmation, discard/clear,
expiry, principal/source/draft/document/epoch changes and owner retirement. A ref
must resolve actual original-owner custody; copyable metadata, a digest or mutable
DB id is not custody. If physical restore/revalidation needs async I/O, it must be
completed by the original owner before synchronous host restore, otherwise block.
No full restore/dispose success is inferred from merely finding a stored record.

Host crashJournalRef must be an actual producer-issued content-free stable ref
matching the existing host pattern `[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}`. The token
must validate binding and original durable write version (id/clientRevision/
sourceHash), and its inspection must expose no content or raw principal to the
workspace refset. Journal sourceHash is SHA-256 over its original schema-prefixed
source; native editorContentDigest uses calculateOpenArticleDocumentDigest(source).
They are different encodings and must not be equated. Writer may join actual write
content/version to the native snapshot digest, but must not claim native custody
from a callback echo; the factory independently captures/checks actual native
identity/epoch/revision/digest and rechecks the original mounted/session owner.

The existing journal is deleted after matching server confirmation. A confirmed
clean/absent state is not automatically a valid crashJournalRef. Support for such
state must be a genuine original producer capability; until then full capture
blocks. The consumer must not postpone privacy-required deletion, create a dummy
record, retain another body copy or mint a synthetic empty-success ref.

Writer owns staging/flush, actual principal and recovery-tab binding plus current
source/draft association. The journal task edits only articleRecoveryJournal and
its narrow source tests/docs; it does not edit Writer/runtime/Write/factory. This
factory lane will consume the published original concrete API after independent
source review, with actual Writer current-owner rechecks and no second journal.
All runtime/list/discovery/mount/native/storage/network qualification remains UNRUN.

The consumer also needs synchronous original-token validation against the actual
native source. The existing UI captureSnapshot digest callback receives the real
sole-owner source before view/history/checkpoint custody is replaced. Factory can
call the original journal's synchronous completed-content/version validator there
and throw on mismatch, preserving the previous retained checkpoint. The journal
owner keeps its original completed write custody private; inspection must not
expose body/principal or create another body/journal owner. A prefixed async
sourceHash-only API cannot by itself perform this synchronous pre-custody join.
This is a required concrete original-producer seam, not an implemented substitute
or authorization receipt. Runtime/storage/crypto qualification remains UNRUN.

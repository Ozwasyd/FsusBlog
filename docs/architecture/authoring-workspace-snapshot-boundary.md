# Authoring workspace snapshot source handoff

## Retained document authority source boundary

The original `OpenArticleDocumentRegistry.issueRetainedDocumentHandle(tabId)`
issues an opaque process-local handle from its actual canonical membership.
`inspectRetainedArticleDocumentHandle` reads that same Registry's current facts;
a copied entry, matching string, copied handle or foreign Registry is not handle
provenance. Normal activation, pinning and joint Group/ratio publication preserve
the original membership. Final detach and preview replacement revoke before an
equal-ID reopen; changed document/draft/session/epoch invalidates the old handle.
Permission and lifecycle blocking preserve the canonical entry and recovery
obligations. Scope retirement prevents reissuing a handle for that same member.

Handle notifications run outside the original command preparation/publication
and history/CAS transaction. A failing listener is retained as a failed
notification in inspection; it cannot turn a committed command into a rejected
receipt. Reentrant notification commands refuse. Handles are not permission,
snapshot-restore or safe-eviction grants. No body/history/cache, second article
index, Host, persistence or server DocumentId contract is introduced here.

The original singleton `ArticleDocumentContextAuthority` owns the retained
adapters. `prepareRetainedDocument(registry, input, scopeReaders)` issues original
document/draft/editor-session identities and returns only a provenance-bound
preparation/context. Open that context through the canonical Registry, obtain
its issued handle, then call `acquireRetainedDocument(handle, preparation)`.
For an already open article, acquire its original handle without supplying a new
preparation; `discardRetainedPreparation` retires an unused offer. Caller strings
cannot replace the original issuer. Same-source articles and unsaved drafts have
separate adapters and task/epoch/source-revision ownership. No retained adapter
can be switched through the legacy route-owned binding.

The already mounted primary Writer calls
`adoptPrimaryRetainedDocument(registry, handle, originalBinding, scopeReaders)`.
This validates the actual previously issued binding, original Registry provenance,
identity/epoch and source/draft coordinates, and preserves the SAME adapter,
native document identity, original tasks and epoch. It never reacquires the
primary. The Registry's session reference and the original opaque editor session
ID remain their existing association; neither is reconstructed from a route.
Raw principal/site readers are reread on admission and use. Principal/site drift
and `revokeRetainedScope(siteScope, rawPrincipalIdentityId)` revoke admission for
the original owners and notify their consumers. Scope-revocation callbacks cannot
admit new owners reentrantly.

A loaded primary whose original identity differs from an existing canonical
member may call `preparePrimaryRetainedHandover(registry, handle, originalBinding,
scopeReaders)`, then consume that SAME preparation with
`acquireRetainedDocument(handle, preparation)`. The authority authenticates both
issued objects and reserves the actual handle/adapter before external readers.
Only one live primary binding, with no retained owner or other preparation, may
enter. Article/draft identity and numeric source/draft revision must already match
that canonical member. Its genuine handle supplies only document identity/epoch;
the original mounted adapter, editor-session identity and content digest remain.
Preparation does not mutate the primary; an unused preparation can be discarded
without disposing its borrowed adapter. Ordinary source edits invalidate the offer.

Consumption reserves context mutation, revalidates the actual primary/scope/member,
cancels the old context's tasks, revalidates again after their synchronous abort
callbacks, and publishes one switch receipt before the original retained binding.
Canceled work remains pending until its producer actually settles. Original context
listeners receive the new context; a post-publication refusal retires document
admission and retains actual custody instead of rolling back notified context or
claiming native completion. The actual Writer still registers its original consumer
through `attachConsumer`; a consumer already owned by any other retained owner
cannot be moved or duplicated. This is not an API to switch an existing retained
adapter or transfer a registered consumer's form/history/native resources.

The preparation installs an actual borrowed-primary admission guard before it
escapes. Scope retirement closes that guard synchronously, including nested
retirement whose canonical cleanup remains queued; task/source admission refuses
while real pending work and cleanup stay in the drain. The original owner's scope
is pinned independently of later edits to its borrowed adapter. Discard cannot
remove a retired owner from pending cleanup or reopen admission. A live unused
handover may still be edited; rejecting its now-stale offer does not dispose that
adapter or mark an identity publication. Explicit discard releases that unused pin
and preserves the actual edited context and pending work.

The sole-binding constraint is revalidated at consumption, after cancellation and
other external reads, and after publication/notification. A second genuine legacy
binding acquired since preparation prevents publication; after its real release,
the original unused offer can retry if all original context facts still match.
An explicit module-private marker records ONLY actual target context publication.
That marker, not any context difference, determines failed-publication custody and
discard refusal. Strict adoption cannot bypass an unbound handover pin. These
facts do not settle tasks or prove native/full-ref restoration. If a borrowed
primary's real disposal listener fails, its failure custody remains retained while
the original drain processes the remaining queued scopes. Only afterward does
revocation report the aggregate actual cleanup failures; no failed cleanup is
recorded as settled or silently discarded.

This handover does not validate a loaded body against a snapshot, grant full native
restore or label arbitrary source as current. A different article/draft, unmatched
source/draft revision, or unsupported Registry source reference refuses. Restored
unsaved drafts need their original draft/body producer's genuine identity/revision
handover; a new create-draft issuer cannot stand in for it. The original Writer/body
loader and Registry source-publication owner must establish those coordinates
before this API, and the original native/session owner must validate physical
binding, actual snapshot/body authority and resource lifetime afterward. No
revision renumbering, body store, new document ID issuer or native settlement is
introduced by this seam. All corresponding runtime qualifications remain HOLD.

The original Writer's `authoringDraftCheckpointRuntime.prepareDraftCheckpoint()`
prepares one bounded form candidate alongside its existing committed slot. It
requires that Writer's actual retained binding and mounted native owner at the
same identity/epoch/revision; no new Writer, body/draft issuer or persistence store
is involved. It reserves before borrowed readers and reference allocation. The
returned original preparation exposes immutable `info`, `validate()`,
`hasCustody()`, `publish()` and `cancel()`. Fresh validation reads the real
form/version/scope/member/native owners without invoking legacy reference
inspection or invalidation. Failed validation discards only that candidate and
cannot be retried. A fresh candidate may then be prepared against the still
current original owner.

`hasCustody()` checks private candidate/committed-slot/generation/lifetime/mount
references and the exact current ordinary client revision after validation. A
synchronous original save can change that non-reactive revision before its
journal/server continuation runs; the private predicate denies publication of
the previously validated version immediately, without a borrowed reader. It is
not fresh native/member or full-host evidence.
`publish()` performs only those private checks and the original slot assignments;
it invokes no external reader/callback, allocation, form setter or cleanup. A
successful publication supersedes the old draft reference exactly once. Cancel
and preparation failures preserve the old committed slot; genuine intervening
edits/retirement still invalidate it through the original owner. Pending candidate
custody blocks legacy capture/restore/release and explicit draft recovery entry.
Genuine retained lifetime notifications cancel that candidate, not committed
form custody. Completed/canceled candidates shed private snapshot/previous-slot
references, retaining no additional body/history store.

The original host must join this protocol with its genuine native, journal and
renderer preparations and final private guards before publishing a complete
refset. A candidate `info` is not an already committed reference; legacy
`inspectDraftReference`/`captureDraftCheckpoint` must not stand in for candidate
validation/preparation. Writer publication alone grants no native commit,
cross-identity/epoch/revision/full-ref restoration, recoverable disposal, eviction
or ready status. Unavailable joins remain refused, and all runtime acceptance
remains HOLD/UNRUN.

The original Writer mounted runtime's `bindRecoveryCheckpoint(editorSessionRef)`
also exposes the original Journal publication binding's five endpoints:
`preparePublication`, `validatePrepared`, `hasPreparedCustody`, `publishPrepared`
and `cancelPrepared`. Each directly forwards to the SAME `issued` binding created
by the original `articleRecoveryJournal.bindCheckpointSource(readSource)`. It
preserves the actual Promise, opaque preparation/checkpoint/info, refusal and
exception, and the original `hasReferenceCustody` endpoint. The existing original
source reader, creation reservation, context/principal invalidation and release
custody remain; there is no copied Journal store, row, token or owner.

`validatePrepared` performs the original source/native-body/expiry admission.
Private continuity and publication must then be synchronous, with no intervening
external callback or await. Pure custody does not reread TTL/source/disk or grant
permanent expiry admission. Original protected-row mismatch/required cleanup
refuses; cancellation does not undo a completed unprotected write. This forwarding
does not compose the native/Writer/Journal/renderer full refset, grant live/storage
atomicity, native restore, disposal or readiness. Those joins and all runtime
qualification remain HOLD/UNRUN.

The original Writer mounted runtime exposes `sealMountedAuthority(sessionRef)`,
`hasMountedAuthorityCustody(seal)` and `cancelMountedAuthority(seal)`. Its physical
reservation binds the SAME runtime, binding, mounted editor and public session
object obtained through the original mounted source, after real source/native
reads. Tokens are original opaque object identities; copied metadata, unknown or
empty values do not enter its private slot. Release permanently retires that
runtime's physical custody before its FIRST recovery release callback, including
when that callback reenters or throws. Replacement, before-unmount, deactivation,
scope cleanup, context and lifetime changes revoke physical reservations; no
generation can revive an earlier token.

The Writer now consumes the original retained binding's genuine
`ArticleDocumentLifetimeSeal` through its actual seal/has/cancel methods. That
token already joins original Registry membership and private native/context/owner
custody; Writer does not create a second membership issuer. The same binding and
opaque token are pinned before physical reads, rechecked afterward, and canceled
on any physical/generation/lifetime failure or final auth refusal. Local custody
is removed before producer cancellation; actual issuer/token and error remain
retained if cancellation fails, further admission refuses, and recovery/unmount
cleanup is still attempted with actual combined errors preserved.
The original Writer keeps every subsequent cleanup failure after the first and
constructs its final outcome only after independent operations were attempted.
Its own aggregate groups carry private original leaves, so nested release/unmount
groups deduplicate the SAME error identity without reading arbitrary external
`AggregateError.errors`. A sole first failure is rethrown unchanged; multiple
failures preserve that first identity as cause and all distinct later errors.

The Writer also consumes the original admin producer's stable function-valued
seal/has/cancel getters, joining a genuine nominal admin token to that SAME
physical/Document reservation. Fresh `article.write` admission precedes final
private checks, and its possible callbacks are fenced by the original auth epoch.
Both original tokens are canceled independently on failure; each genuine cleanup
failure is retained without skipping the other token's cancellation.

The original observed broadcast preadvance/delivery/disposer/continuation and
queued-cleanup production chain is now consumed from its closed source. A valid
same-principal `article.write`/Document/physical reservation can return a genuine
positive mounted seal and pass its private custody predicate. Missing, changed,
retired, failed, mismatched or foreign inputs still refuse. All tickets and
allocations precede the final original-producer private join; no callback or await
separates that join from returning the local token. The accepted auth store
and private-surface port attests producer-observed local principal/permissions/
session continuity through synchronous publication; it does not attest unknown
remote revocation or exact server expiry during a blocked JS task. Those are not
extra prerequisites for this local guard. Server operations keep original backend
authorization; restore/query require original server permission provenance. No
local auth token substitutes for that query chain. Physical/Document/Auth
candidates are canceled on any failed admission; `hasMountedAuthorityCustody`
returns true only for the same producer-issued token and genuine joined private
custody, never from a local readiness boolean or notification cache. The source
auth/private-surface watches are ONLY
negative physical revocation, including same-id changes; they do not attest
permissions, expiry, step-up or administrative admission. Document's downstream
lifetime listener is also not its early private authority; the actual Document
token supplies that private predicate. Positive local continuity is bounded to
the original observed-event pre-callback retirement path. It does not complete
Main composition, restoration, full host readiness, or qualification. Missing
other producers and original query/permission provenance still refuse those
operations. This producer wiring grants no runtime or
qualification evidence and preserves all existing HOLD gates.

The returned binding exposes `adapter`, `handle`, `inspect()`,
`subscribeLifetime(listener)` and `attachConsumer(factory)`. The original Writer
attaches its actual existing form/effects/runtime object once, using one stable
factory callback. Repeat use returns that SAME consumer, never a cloned form or
another Writer composable. A different factory or reentrant attachment refuses.
Layout borrows the original Writer's commands and view/mount ports. The authority
retains actual consumer references on final invalidation or cleanup failure;
permission/delete/archive blocking does not invoke final consumer release.
If final invalidation returns an actual cleanup promise, the SAME promise remains
in owner custody and `consumerInvalidationState` reports pending/settled/failed;
an asynchronous rejection records failure and preserves the actual reference.
This is producer completion observation, not native disposal or release permission.
Original `adapter.subscribeContext` remains the context-change subscription.

`inspect().registry` reads canonical membership and permission/lifecycle facts;
`registryRevisionMatchesDocument` separately reports whether the canonical
source/draft reference coordinates match the original adapter. Ordinary source
updates advance the adapter's original numeric revision without changing its
identity/epoch. This seam does not add a Registry revision command: the original
Writer/Registry revision-publication owner must refresh those references before
Host restoration/readiness can succeed. A mismatching reference is reported,
never rewritten as current readiness.

Canceled leases stay in their original adapter's `pendingTaskRefs` until the
actual producer calls `lease.settle()` after its real work/cleanup has settled.
Running work cannot be settled. Acceptance, rejection and logical completion do
not settle actual underlying work; the original producer explicitly acknowledges
settlement after its real completion AND cleanup. Original acceptance/stale result
rules remain intact. Terminal envelopes are published before synchronous abort
listeners run, preventing duplicate completion on reentrant cancellation. An abort or
aborted envelope is not completion. Final close, identity replacement and scope
revocation disable old admission and notify consumers while retaining canceled
work and recovery references; they do not prove native disposal or zero resources.
No explicit safe-eviction grant is supplied: the original Host's full snapshot/
recovery/disposal capability must satisfy its original preconditions first.

Multiple unsaved draft IDs have real process-local lifetime here. Persistence and
journal coordinates remain the original Writer/storage owners' obligation. The
shared literal create key cannot be used to overwrite another retained draft;
this authority adds no body/journal store, storage namespace or persistence-policy
change, and makes no multi-draft persistence or cross-restart claim.

Dedicated source controls are `retainedArticleDocumentHandle.test.ts` and
`articleDocumentRetainedAuthority.test.ts`, using the original unit configuration
and actual original Registry/authority source. These and all existing runtime,
test/list/discovery/import, browser/native, security, receipt, race and database
qualifications remain unrun/HOLD in this lane. Pure compiler/style evidence does
not establish product or full Host lifecycle acceptance.

Retained cell/owner/preparation/task custody and the helpers that reach it use
runtime `#private` state, rather than erased TypeScript privacy. Admission reserves
the actual handle and adapter before scope-reader calls, verifies primary release,
scope lifetime, complete current handle observation and unchanged context afterward,
and subscribes before the final read window. Unpublished live admission rolls back
on failure; actual revocation keeps its pending recovery custody. A scope tombstone
lasts for that original member: formal detach ends its incarnation, and an equal-ID
new canonical member may issue a new handle while the old handle remains revoked.

Notification and scope-retirement requests are deferred and drained during
reentrancy. All actual target owners retire before consumer notifications; unbound
preparations also retire. Retirement during preparation/adoption prevents
equal-value scope ABA admission. Another scope request from a consumer cannot be
dropped. These are ownership/lifetime facts, not strings used as permission grants.

Context mutation and task-slot publication reserve their real original state
before external guards. Failed result hashing/getters keep a recoverable lease
and active slot; cancellation can publish a genuine terminal afterward. Digest
preparation precedes ledger removal, terminal commits recheck current ownership,
and cancellation during preparation is retained. Only explicit actual producer
settlement removes pending work. Original Group cell/startup guard/ratio publication,
CAS/idempotency/history, public issuer and server/persistence contracts remain.
These repairs still require independent exact-head review and held qualification.

Document mutation also blocks new task issuance until its actual revision is
published, including a new producer key requested by the final external guard.
Nested retirement closes the actual target owner/preparation admission before
returning; canonical notifications and cleanup remain deferred obligations.
`inspect().admissionClosed` reports that owner fact separately from the Registry's
current member state. Readonly inspection never fabricates a Registry terminal
state to represent queued cleanup. Adapter/consumer admission rechecks local
retirement after external readers. Existing tasks remain pending until real
cancellation/cleanup and explicit producer settlement; stale is not settled.

Consumer attachment reserves its real slot before entry readers, even for cached
consumer access. Admission is revalidated after the factory returns, after the
consumer method property getter, and after every subsequent scope-reader call.
Local retirement is checked alongside canonical facts; a still-live Registry
member cannot authorize returning a locally retired consumer. Rejection retains
the actual created consumer/factory and pending work for the original drain. If
canonical retirement finished before the factory returned, its missed cleanup is
performed against that same consumer, preserving failure and actual promise custody.
Primary adoption's final reader and existing-binding returns also recheck local
retirement. None of these checks grants restoration, settlement or safe disposal.

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

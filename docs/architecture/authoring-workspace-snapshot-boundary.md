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

Original Registry membership seals bind the authentic retained cell, its actual
canonical entry and original publication/revision. `sealRetainedArticleDocumentMembership`
freshly inspects membership; `hasSealedRetainedArticleDocumentMembershipCustody`
joins private original pointers/state without `cell.read`, clone, allocation or
external reader. `cancelRetainedArticleDocumentMembershipSeal` removes that actual
issued token. Registry command/ownership preparation and notification entry retire
the original publication before getters, hashes, clones and callbacks; only the
original stable canonical Map/revision publication can issue a replacement token.
Scope/close/identity/permission/lifecycle and notification failure invalidate the
same original cell. There is no second membership index or downstream boolean
listener cache. Original Group publication guards/CAS/history/ratio remain intact.
These seals prove only original membership custody, not mount/auth/full-ready.
The outermost original membership mutation drains queued notifications on both
successful and exceptional exits. A command getter may revoke a genuine handle
before throwing; that revocation still reaches original Document cancellation and
consumer cleanup. Original operation error remains the error on successful drain;
an unexpected drain error is preserved alongside it, with publication retired and
failure custody retained. Notification is not a success-only wrapper epilogue.

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

The original retained binding also issues `sealLifetimeAuthority()` and exposes
`hasLifetimeAuthorityCustody(seal)` / `cancelLifetimeAuthority(seal)`. Its opaque
seal joins the authentic owner/binding/handle, original membership seal, actual
consumer pointer and the adapter's private context publication. Fresh scope/member
and matching revision inspection precedes issuance. Pure final has only joins
those private pointers and original producer facts; it never calls `cell.read`,
`adapter.context`, a scope reader, clone, observer, or an allocating inspection.
It does not infer mounted/auth/native resource authority from this document seal.
Non-null owner publication and actual consumer are captured before opaque token
allocation. Allocation reentry must leave both exact pointers unchanged, and final
has explicitly refuses a null current publication. Cached attachment retirement
cannot make a canceled/null seal valid again when its temporary phase ends.

Actual adapter mutation/handover/disposal retires the private native publication
before external guards, cancellation or notifications. Owner scope retirement,
notification entry and consumer attachment/release retire original owner authority
before their first external read/cleanup callback. Failure and queued cleanup retain
existing custody; no cancellation or null seal settles real work. A stale source
reference prevents resealing. These producer tokens are not downstream boolean
listener caches or full-ready receipts; all original guards and handover semantics
remain, with new source review and every original runtime qualification held.

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

The original Doc SDK's optional attachment revision transition consumes the actual
original attachment producer's lazy association and the mounted native issuer's
opaque reservation. It reserves the same private attachment lease during the
applying loan, publishes the exact accepted native transaction before its public
source callbacks, and admits completion only in that same transaction's committed
loan. Original task/request/producer/started-context identity remains; the envelope
records the actual completed revision. Other old-revision tasks still cancel.
Ordinary source mutation and ordinary lease acceptance do not acquire this
exception. Explicit cancellation, owner/context revocation, failed readers and
synchronous reentry close its acceptance; actual cancellation/withdrawal failures
remain held for cleanup through the same token or original lease. No settlement,
second completed lease, copied native body/history, mapping logic or full-ready
resource authority is supplied. This source increment and its owning integration
still require independent review and every original held qualification.

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


### Published original journal token versus host reference

The original #1813 producer source in PR #4225 at
`61c156009ee7b2bc540b5efd84071adf171d679e` now provides real asynchronous
`bindCheckpointSource(...).prepare()`, original process-local object custody,
synchronous `inspect`/`validate`, asynchronous original storage `restore`, and
`invalidate`/`release`. Its independent source review and actual Writer reader
integration are pending. These APIs have not been copied into this branch or
executed here; the original journal continues to own persistence and custody.

The published token is a frozen empty object checked by exact object identity in
the issuing binding's existing custody. Its inspection returns owner/version and
storage metadata, with no stable checkpoint reference. The unchanged #2294 host
requires `crashJournalRef:string` matching
`[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}`. Object serialization/hash, mutable record id,
client revision, sourceHash, or a newly allocated factory label cannot establish
this missing producer-owned reference.

The smallest legitimate join requires the ORIGINAL journal binding to issue a
stable content-free reference in its existing completed custody and return it
from inspection of that same original token. The factory can retain the existing
binding/token alongside its original session and compare the inspected reference
to snapshot.crashJournalRef at each capture/restore admission. Original inspection
must still independently validate exact owner/mount/context/version and expiry;
reference equality alone is never authority. A copied reference, foreign token,
retired binding, overwrite/confirm/discard/clear or stale context must refuse.
No second journal, checkpoint producer, token-to-string registry or snapshot
contract relaxation is needed. The original producer must define non-reuse and
collision safety for its reference; this lane does not manufacture that value.

A second seam remains: published inspect/validate compares scalar owner/version
fields, not current content, and original custody deliberately retains no body.
Its prepare verifies source/current/stored content during the actual async write,
but that does not supply synchronous validation of the actual nativeSource inside
the UI capture digest callback. Original journal and Writer must expose a genuine
completed-version/current-content join usable there before retained checkpoint
replacement. Async storage restore/hash, metadata equality, a content echo, or
publishing a second retained body cannot substitute. Async physical restoration
also cannot be inserted into the synchronous host restore. Confirmed/empty journal
custody remains unsupported unless supplied by the actual producer.

Until the reference and content/version joins plus actual Writer integration are
reviewed, full factory capture/restore remains blocked. Panel/draft/full renderer
and complete resource controls are independent remaining dependencies. All source
inspection is static; runtime/list/discovery/mount/storage/crypto/native and all
qualification holds remain UNRUN.


### Concrete Writer checkpoint intake and remaining draft/panel ownership

Original Writer PR #4153 now publishes
`60e2363cbbf2552166041fda331774ad6adf24c8` with the real runtime binding's
`bindRecoveryCheckpoint(editorSessionRef)`. Its reader checks original mounted
editor, registry association/revision, document context, principal, active recovery
client revision, site/draft scope, permission and lifecycle, then supplies actual
recovery-tab/base/server/client/content facts to the original journal. Runtime
release releases that same binding. This is a source offer, not consumed here or
independently accepted: its journal dependency intake is still incomplete. The
factory will join the exact existing session and original Writer binding only
after the original producer reference/content seams and caller source are reviewed.

That recovery binding does not issue draftStateRef. The original Writer's
buildDraftSnapshot/applyDraftToForm already own title/content/summary/cover,
category/tagIds, publish status/schedule, rights, base/client/server revisions and
context digest. A genuine draft checkpoint must use those original primitives and
retain their original immutable snapshot custody, not reconstruct articleForm in
the factory. Its producer must issue its own stable reference and synchronously
inspect/validate the same token against actual principal/site/draft key, original
runtime/mount/association, document identity/epoch/native revision and nullable
source/draft refs. Native-source validation belongs before the existing UI capture
replaces retained custody. Actual form/rights/tag/schedule changes also invalidate
draft custody even when native content/revision is unchanged. Runtime release,
principal/document replacement, real draft/server confirmation and scope cleanup
must follow the original Writer's invalidation rules. saveDraftNow:void and pending
flush/clientRevision do not certify a completed save or immutable checkpoint.
Original restore uses applyDraftToForm and its real native synchronization, with
post-owner/context checks; applying form values alone is not complete session
restore. No second draft/body store or fake async-completion wrapper is introduced.

UI's existing retained viewStateRef resolves only its original partial mode/search/
caret-scroll checkpoint. It cannot be aliased into activeNodeRef, scrollAnchorRef,
outlineRef, searchRef or attachmentStateRef to satisfy the full host refset. Those
original UI owners must capture immutable actual state and resolve/validate their
references in the existing bounded checkpoint custody, then restore through their
existing native operations. Pure outline/anchor planners are not retained state
issuers. Attachment capture/File observation and resource census also do not issue
a recoverable attachment-state checkpoint. Same-byte epoch changes, original owner
replacement/release, unresolved async continuations, IME and real restore failure
must retain the original refusal semantics. Typography and shared expose remain
with their coordinated owners. Full factory stays blocked until the real owners
and caller join exist; all runtime and qualification work remains UNRUN.


### Actual native File observation source available to the original Writer

Local UI #914 source `6a73ad6312091ca782f99393140efc8df0fb4fb6` now integrates the
original public producer971e File bridge onto the same session/attachment owner.
The public `MarkdownAttachmentCaptureObservation` and `MarkdownAttachmentFileConsumer`
types, `upload-image(batch, capture?)`, and
`withAttachmentFile(originalBatch, originalItem, consumer)` are actual source.
The loan returns the identical original File only for the original current job,
batch/item and first-attempt signals. It never performs capture/placeholder dispatch.
The optional observation contains the identical emitted accepted transaction and
original plan/placements. The original Writer must admit THAT already accepted
native transaction into its genuine pending-handle boundary; calling an existing
commitCreated path that dispatches another placeholder would duplicate the edit.
Write/wrapper/runtime changes remain with their original owners, not this factory.

The integration retains real future/attempt/terminal-result proof, unknown legacy
settlement and per-item File revocation. The actual future hook obtains File from
the revocable original record, and its progress/awaited terminal/finally remain with
the same resource owner. It does not emit a duplicate legacy event. Private job
proof reconciles copied job document identity without accepting matching IDs alone.
Public dispatch strips private observer/job arguments. Actual cleanup-stack depth
blocks public resource inspections/controls until the cleanup frame exits; an empty
Map is not release proof. Attachment reviewed=false/full roster excluded remains.
This File/transaction observation is not attachmentStateRef or a recoverable panel,
draft/journal, full snapshot, native receipt or eviction capability.

Same original Web/Vitest projects compile at this source with installed tools and
AST/SFC checks pass. Runtime and all original/incoming File source cases are UNRUN.
Original donor assertions are preserved, including a legacy cancel/retry case whose
positive retry expectation conflicts with current unknown-settlement refusal.
That case needs original actor alignment before execution; no retry gate is relaxed
and historical135/16 PASS evidence is not integrated-head acceptance. Full factory
continues to refuse the absent original panel/draft/journal/full renderer refset.

### Original Writer reference binding joined to actual native retained capture

The reviewed original journal `02cfd1a9919d6008ff203fe377e01d29abb236cc`
and private-storage cleanup postimages are consumed exactly, preserving the same
storage, privacy, invalidation and asynchronous persistence owners. Original Writer
`4fb995cbf11be6cab84299c321a6a3ce6a9079d3` forwards `validateContent`,
`inspectReference`, `validateReference` and `restoreReference` on that SAME issued
binding, with original creation reservation, context/principal subscriptions and
independent release. Its product/composable remains with its original owner;
this branch does not copy or replace that caller. Native/File caller source is
`1400e677752e5c18f1b76b0d0d0ce78518a36ddc`, published with source evidence
`de6df11110b5d060a001fad36bb604627323e32a`; its independent review remains a
separate prerequisite and its retained second-owner issuance/lifecycle is absent.

The same installed factory now implements
`captureArticleWorkspaceRetainedRecoverySnapshot(entry, binding, checkpointRef)`.
The original Writer supplies its actual `bindRecoveryCheckpoint(editorSessionRef)`
binding and, after awaiting original `prepare`, the reference returned by original
`inspect(token)`. No object token is serialized or converted to a reference here.
Capture synchronously checks original reference custody, actual identity, document
epoch, native numeric revision, nullable source/draft revisions and association
revision. Factory delegates the actual original Writer `captureRetainedSnapshot(reference)`
port from reviewed-reference consumer4fb plus native source1400/de6. That original
implementation passes expected document id/epoch/native revision to the sole UI
session; inside its native callback, original `validateReference` verifies the actual
native source before `calculateOpenArticleDocumentDigest(nativeSource)` supplies
the canonical digest. Factory rechecks actual owner/context and returned snapshot
identity/revision. It does not implement a competing native callback or binding.
Native capture owns all transaction/history/selection custody. Callback refusal preserves the prior
native checkpoint. The returned process-local bundle holds the actual original
binding, original opaque native snapshot and original crashJournalRef, with a
canonical digest of these actual retained refs. It retains no article body, second
history, checkpoint producer, host or session index. The ref string alone grants
no authority; original binding invalidation, replacement, expiry and release revoke
the bundle's admission.

Native `validateRetainedSnapshot(snapshot, expected)` also checks the EXACT
original retained object in the factory's same native session before issuing the
bundle and before/after asynchronous journal restore. Same strings/document/revision
from another native instance cannot satisfy this check. It reads existing native
custody without replacing/restoring it and certifies no view/resource restoration.

`restoreArticleWorkspaceRetainedRecoverySnapshot(entry, bundle)` awaits original
`restoreReference`, rechecks the same installed native/session/document owners and
composition admission across the await, validates original journal content and
its canonical digest against the original native snapshot, then delegates the
original native same-owner/same-revision restore. It never applies journal body
outside that owner or recaptures native state during validation. Original journal
storage restore does not apply content. Any stale, released, mismatched or retired
owner refuses; native restore's blocked proof remains blocked. The original Writer
owns release/subscriptions; this composition neither releases nor rebinds its port.

This is an implemented partial retained checkpoint join, not a full
AuthoringSessionSnapshotRefs or complete restoration. The Writer's product call
site must consume these functions through the original bootstrap once its own
source is integrated; this branch supplies the concrete factory/composition API.
Full host capture still refuses BEFORE native capture because actual panel,
draftStateRef, full renderer restoration and complete original resource controls
remain unavailable. No partial viewStateRef aliases those missing references.
Original immediate guard, host/router, registry/group, typography and qualification
holds remain unchanged. All runtime, storage, discovery/list, native/worker,
security/privacy/receipt/race/backuprestore/IME acceptance is UNRUN.

### Real Writer source consumption and final admission before mutation

The session branch now consumes the original Writer de6 eight postimages and 22
actual existing dependency postimages, including original DocContext subscribeContext.
Every source maps to its exact original Git blob. Actual wrappers, Writer/composable,
native/File runtime and mounted-source producer bodies exist in the production tree.
Six additional original upload/preview/markdown helper versions are needed by those
published modules and are consumed separately, without semantic edits. Generated
UploadAssetFacts DTO/route/response-kind producer artifacts are absent from this fixed
baseline; no declarations, route literals, privacy/receipt bypass or authority refresh
substitute them. Original full application compilation stays RED until real dependency
closure and inherited source findings are resolved by the appropriate owners.

Factory restore pins every caller-held bundle field and original checkpoint/native
method before owner operations. The same composition passes its actual assertActive
closure into the factory; after final external getter/reference/content reads and
real native token validation, that admission is checked immediately before the pinned
original native restore call. A recoveryCheckpoint getter, method getter, restored
content getter or original reference callback that synchronously retires the host
therefore cannot make a post-mutation refusal stand in for pre-mutation authorization.
No callback/input getter is read between the final guard and native mutation.
The native validator additionally checks original transaction-store token/history
custody, so document-coordinate ABA cannot revive a released checkpoint. Actual
mutating native/store restore semantics and blocked proofs remain original.
The actual Writer capture port forwards the supplied original factory guard to
the native expected context. Native retain/restore invoke it after their final
renderer/view callbacks, before original store mutation; it revalidates full
original owner/reference/admission, rather than checking a copied boolean. This
small consumer adapter hunk is separate from the exact de6 source intake, and
original transaction mutating restore bytes are unchanged.

createArticleWorkspaceRetainedRecoveryPort borrows the original Layout/Write journal
reader, checks the canonical original registry association and same original port
before/after awaits, and exposes explicit prepareSnapshot/restoreSnapshot through the
SAME installed factory. Creation never binds a journal, persists, captures or installs
a host. The minimal patch in artifacts/article-editor/issue-2295-layout-caller-source
is anchored to original Layout e6bb1b6c and exposes this concrete partial port from
its existing original binding. Product Write.vue is not privately modified here;
Layout consumes its patch, and Rail supplies its exact published ref/installer source
for the consumer hunk. No replacement installation path or automatic prepare on
mount/geometry/document publication is introduced. Missing original caller/native
binding/composition still refuses. Full host/resource and second-owner gates remain
open; all runtime/tests/list/mount/native/kernel qualification remains UNRUN.


### Reference callback precedes final mounted authority read

The bounded P1 rereview found that a legitimate original journal source callback
could withdraw the mounted resolver after the old mounted check while leaving
original binding/native data alive. Capture and restore now finish original
inspectReference and its source/expiry callback FIRST, then resolve the actual
current mounted editor/session/context LAST and compare the original pinned owner.
A null/withdrawn resolver refuses before native retain/history/selection mutation.
No second reference callback is started after this final mounted read.

Because the mounted resolver can itself invalidate/release/replace journal custody,
the original issuer now exposes hasReferenceCustody(reference, inspectedInfo). It
reads ONLY its existing private binding set and current custody's EXACT original
info object; equal metadata/copies/locators cannot satisfy it. No clock/source or
external callback, allocation, index, body, history or second producer is used.
It is a private custody-continuity check, not a source/expiry inspection and never
replaces the preceding original fresh inspectReference. Writer forwards the same
issued method. The factory pins this real method, uses it after final mounted
authority resolution, then checks actual composition admission. There is no
mutually recursive resolve/inspect loop or metadata-issued authority. Native
methods invoke this complete guard after their last renderer/view callbacks.
Original transaction readonly ABA protection and mutating restore bytes remain.
The original journal source case checks exact/copy/invalidation and ZERO additional
source/clock reads; AST-only, UNRUN. Full ref/resource/caller qualification stays held.


## Original draft/native source correlation

The original Writer SOURCE CLOSED full-form runtime now lives in this source
composition, with its actual retained document/native mount/principal/draft
metadata and same single original form. Its bounded immutable draft reference
is issued only by that owner. Original principal ABA retirement, restore
reservation/per-setter admission and real server conflict pause are preserved.
No body/form/history clone owner, new storage namespace or business grant.

The SAME native public session now supplies inspectContentDigest: synchronous
read-only original body callback, current native identity/revision/admission
checks, and immutable digest metadata. It does not capture/restore history or
replace an existing native checkpoint. The original Writer has a callback-free
hasDraftReferenceCustody(reference, originalInfo) method over ONLY its private
current slot/retirement/reservation flags and exact original info object; it
never replaces prior fresh owner/content inspection.

The same installed factory/composition exposes inspectOriginalDraftCheckpoint /
inspectArticleWorkspaceOriginalDraftCheckpoint. Pass only its already issued original reference. The actual runtime is borrowed
through the SAME original mounted Writer source, not a caller-supplied runtime. The
factory pins actual methods, checks original full document/draft/session/epoch/
revision/association, validates native bytes through original validateDraftReference,
then rechecks original draft inspection, final actual mount and genuine private
slot continuity. Return is read-only original info plus actual native digest,
not a complete snapshot, restoration, readiness, pause or safe-eviction receipt.
The actual Root/Write caller forwards readDraftCheckpoint from that SAME original
source. Missing/changed runtime ownership refuses. A caller cannot choose an
arbitrary inspect/validate/self-certification object through this inspection API.

Full snapshot remains refused: complete controlled resources and a qualified
full recovery ref replacement/restoration protocol are not available. In
particular the original draft capture invalidates its prior single slot before
replacement, so the factory must not capture a new draft then discard it after
a later native/render failure while claiming the prior complete snapshot is
intact. This read-only method deliberately validates an already issued reference
without performing that unsafe replacement. All full-factory/resources/disposal/
eviction/cross-draft/storage/security/privacy/receipt/race/backuprestore/IME/native
qualification holds remain, and every source test is UNRUN.


### Same original cache/producer terminal consumption

The Main source now consumes the original Writer170e terminal postimages on the
existing cache, producer, continuity and runtime binding. Cache awaits the actual
getRequestWork(theSameRequest).terminal for both success and rejection, then
performs original transfer/late release before lease.settle. Prompt canceled
receipts, invalid/null results and finished metadata do not settle work. Actual
validation, lookup, cleanup and unknown native/source failures keep error/pending
custody. Continuity.startRefresh and runtime.pendingRefreshWork expose this SAME
cache work; no second render/cache/body/history/authority is created.

Exact seven-path source/protected-blob map, current Main static evidence, original
whole-file zero-execution preflight and remaining real owner interfaces live in
artifacts/article-editor/issue-2295-cache-terminal-intake. Three original supplier
control files are added as UNRUN source only. Cache/producer bounded closure does
not migrate to the caller or Main composite. SourceCompare, Writer body prototype
and Documentad35 handover are not consumed.

Main's installer/resolver accepts actual already-mounted owners. Original Rail
startup must supply genuine handle/preparation before Writer adapter construction.
Public native retained restore requires the original same-owner/identity/epoch/
revision token; changing identity props currently resets revision/history, so it
is not history-preserving adoption. Original full-ref replacement/failure custody
and real loader base/server/client version admission remain separate owner gaps.
Complete host snapshots, resource pause/disposal/eviction and restored-body
readiness remain refused/unqualified. Every runtime and qualification HOLD stays.


### Actual native prepared snapshot receiver

The original native store/session now prepares one genuine pending checkpoint
without replacing its prior retained token. commitPreparedSnapshot validates
original history/selection/document/revision and actual panel/render/admission
custody, allocates before publication and publishes all issued native refs in one
synchronous owner operation. Failure/cancellation discards only the candidate.
Original mutating history restore remains byte-identical; foreign/copied/ABA
candidates refuse. No source/history/body copy owner, new expose or resource ack.

Main prepareArticleWorkspaceRetainedEditorSnapshot forwards the SAME factory's
actual native preparation capability: snapshot, commit and discard. Commit reserves
before reentry and uses final real mounted/composition admission; success invokes
no external reader after native publication. Legacy retained capture uses this
actual producer. Exact source/protected body maps, current original compiler
outputs, source-only matrix and preflight live in
artifacts/article-editor/issue-2295-native-prepared-snapshot.

This is atomic issued-native-ref publication only. Native nullable participants
remain nullable; full host refs/resources/readiness are not supplied. Original
Writer draft capture invalidates its current slot before replacement and needs
its own non-invalidating preparation/private validation/pure publication/cancel
source. Genuine mounted journal/draft custody and renderer future/release join
remain their original producer responsibilities. Full factory refusal and same
identity/epoch/revision native restore remain; no metadata/callback declaration
substitutes for absent production protocols. All runtime qualification stays held.


### Finite original native publication seal (#2295)

The existing actual factory preparation now offers `sealNative()`, returning a
preallocated native-only reservation with `snapshot`,
`scope: 'native-owner-custody'`, `hasNativeCustody()`, `publishNative()` and
`cancelNative()`. It delegates the SAME upstream session's genuine seal/private
custody/publisher/cancel operations. Original mounted/context admission runs
before native seal; no external resolver callback or allocation follows actual
native publication. This does not install joint full-host publication or change
the existing full-factory refusal. Cross identity/epoch/revision still refuses.

The actual Renderer273 custody publisher attests captured private renderer
custody, while live document/projection validation still calls external readers.
The original Renderer producer must issue a reservation invalidated synchronously
by its genuine document/projection/source/pipeline and deactivate/unmount/failed
cleanup events, and expose callback-free exact-token continuity and preallocated
publication under that reservation. Application/document/member/mount/principal
lifetime needs a genuine original synchronous reservation too. Metadata or a
replaceable consumer object cannot certify those authorities. Journal082 and
Writer619 private finite publication protocols remain original; their source/TTL
validation must finish before the final pure joint guard and synchronous publish.
No partial native/Renderer/Writer/Journal sequence is reported as ready or as a
complete retained refset. All runtime/resource/restore/eviction holds remain.


### Private composition admission seal (#2295)

The original successful installed composition supplies
`sealArticleWorkspaceEditorSessionComposition(host)`, pure
`hasArticleWorkspaceEditorSessionCompositionCustody(seal)` and
`cancelArticleWorkspaceEditorSessionCompositionSeal(seal)`. One exact bounded
private token has scope `composition-admission`. Original installation completion
and permanent retirement own it; allocation/reentry/retirement refusal cannot
certify a new token. Final checks do not call resolver, Registry, mount, native or
auth readers. This supplies only that producer's original admission continuity.

Member, mounted subtree/Writer and principal/private-surface authority remain
separate original producer gaps. Downstream Document lifetime notifications can
follow cleanup callbacks; Writer id-only principal watching does not certify
same-id permission/status/step-up changes. Original owners must retire their
private reservations before any such callback and expose pure final custody.
Source events and requested signatures are recorded in
`artifacts/article-editor/issue-2295-composition-admission-seal` as missing APIs.
Missing provider Queryv1/resolveBatch/canonical, startup/fullready/refset/native
restore/auth/security/resource/eviction and cross-identity holds remain refused.


### Actual original Writer mounted-authority consumption (#2295)

The actual original `authoringEditorRuntime.bindEditor` runtime now supplies
`sealMountedAuthority(editorSessionRef)`, `hasMountedAuthorityCustody(seal)` and
`cancelMountedAuthority(seal)`. It consumes that SAME original retained binding's
Document272a/d354 lifetime seal and private has/cancel, preserving failed issuer/
token cancellation custody. Original physical release retires local custody before
callbacks; negative auth/private-surface/context/lifetime events revoke locally.
With original Auth819e inputs consumed, the original Writer91d can return its
genuine seal after the same principal/article.write/Doc/physical private join.
Missing, foreign, retired, failed or mismatched inputs still refuse. This does not
complete Root mounting, provider Queryv1/resolveBatch/canonical, fullready or refsets.

Original Writer cleanup attempts all operations before combining failures. Only
its own private error-group identities are expanded; external thrown objects and
`errors` getters remain untouched, preserving distinct original causes. Exact
Writer final1f148 source is applied through owning hunks against Main's actual
preimage; existing Main mounted/draft/native/private-reference guards and helper
rechecks remain. Source/protection/static evidence and original zero-execution
preflight are in `artifacts/article-editor/issue-2295-writer1f148-authority-intake`.
All runtime/native/auth/security/receipt/restore/eviction qualification stays held.


### Auth continuity bound for synchronous local publication (#2294/#2295)

The final pure application guard attests the original producer-observed local
principal/permissions/session/private-surface continuity, after all fallible reads
and before local pointer publication. It does not prove unknown remote revocation
or exact server wall-clock expiry during a blocked JavaScript task. Original issue
#2294 required restore permission/ref validation and #2293/#2295 invalidation,
blocked/ready and stale-state protections remain mandatory; original qualified
server permission/query provenance cannot be replaced by client-side filtering.

The actual auth producer must revoke on observed replacement/clear/ABA, permissions/
status/step-up, account/site/logout, server auth failures and private-surface changes.
Missing/unadmitted source still refuses. Server operations retain original server
session/permission validation. Backend AdminSessionProjection validates real revoke/
idle/absolute expiry; current validation result/admin-me snapshot exposes no projection
lifetime to this guard. Frontend refresh TTL is not a server deadline. No deadline,
backend write or remote atomic promise is invented. Precise original clauses/DAG and
source refs are in `artifacts/article-editor/issue-2295-auth-publication-contract-boundary`.
The current positive mounted seal proves only this observed-local private join;
all runtime/security/receipt/native/resource/restore/eviction/fullready holds stay.


### Actual original Auth5e pure-port consumption (#2295)

Original admin store/private surface Auth5e source now supplies real function-valued
getter ports for observed-local principal continuity. Writer captures the SAME
store's seal/has/cancel functions before final checks, avoiding Pinia action callbacks
inside the pure join. Fresh original principal and `article.write` admission precede
same auth/Doc/physical reservation checks; both original tokens cancel independently
attempt-all with failed issuer/token/cause custody retained.

The original observed-event successor now consumed is final Auth819e, including
its genuine delivery/disposer/queued-cleanup ownership. Writer91d returns only its
original token after the final private guard; no callback/allocation/await follows
that guard before the return. Dual cancellation and real failed-token/cause custody
remain unchanged. Earlier Auth5e/Writer2cf evidence stays pinned to that earlier
source; current intake proof/checks/preflight are in
`artifacts/article-editor/issue-2295-auth819e-writer91d-intake`. Other Main adapters,
Doc/Registry/Group and native guards are preserved. No server deadline/remote atomic
promise or backend change is included; all fullready/provider/qualification holds stay.

### Original Root/Layout source consumption with retained Main owners (#2299)

The actual Main tree consumes seventeen original Root/Layout postimages from
e3877fc3af4819111cfd6725bc17017183fb72d0 and five required original support modules.
Root startup, authenticated snapshot caller, session source, HTTP connection and
layout outlet now use the existing sole session installer and the original group
owner. Current Registry membership/document handles, composition admission seals,
Writer/Auth pure ports and native factory remain unchanged. No second registry,
host, editor, history, readiness issuer or resource acknowledgement is introduced.
The Separator adapter additionally rejects a missing observation before reading
its scope/ref; no fallback snapshot or synthetic successful interaction exists.

This composite is source-reviewable but not build-ready: the current local FsusUI
alias lacks the original public ResizeSeparator component and its payload/range
types. Original locale schema repair cb7f is now consumed through its exact thirteen
source paths: ten canonical leaf additions, the derived admin entry and original
static producer/controls. No catalog/generated/frozen authority refresh is applied.
Missing provider, mounted authority, original token reservations and
complete resource/refset admission continue to refuse. Precise source identities,
preserved owners, actual failing whole-program delta and zero-execution preflight
are in `artifacts/article-editor/issue-2299-layout-e387-main-intake`. Original donor
closure does not qualify this newer composite. Parent reports Main6f exact source
provenance/adaptation closed; all execution/qualification holds remain, and there
is no package publication or authority refresh.

Original upstream offer d615cc2064c4c14946d341d43f2eebf473d7bd8d now pins the
actual ResizeSeparator a775 source. Its eight new files and five additive entry
hunks check against current UIf253 without overwriting shared entries; actual UI
remains unchanged: original a775 has an unresolved P2; repair candidate
e570e2c82d5f137eefc831fb193dbb6f2764703b awaits independent closure and is not
consumed. Compatibility is not source acceptance. The original locale owner
now supplies a genuine static literal-AST producer deriving the existing algorithm
from all ten schemas. Its real admin check/write fixed point and original static
locale gate pass without evaluating product modules. Ordinary application schema
source is distinct from frozen registrations/fixtures/receipts; all protected
objects and original focused test remain unchanged. Precise intake, output hashes,
raw checks and holds are in `artifacts/article-editor/issue-2299-locale-cb7f-intake`.

Parent reports original Auth819e six-owner local source closure and Writer91d
positive source closure. This Main now consumes those exact original postimages
through their owning patches, keeping newer Registry/Doc and Layout adapters.
Parent also reports Mainb6 exact Auth/Writer source intake independently closed;
the current new locale composite still needs independent review/qualification.
No parallel Auth/Writer, native/resource completion receipt,
or missing provider/refset/resource authority is supplied by this source intake.

Original Root667 now consumes the same Doc7ab pre-retirement and Writer4249
admission-only binding reader through its frame-local reservation consumer.
Startup awaits the original physical prepare, invokes the existing Write seal,
and verifies original Root/Writer/Doc private reservation custody. Original
reader/seal failures and their causes propagate through preparation; healthy Doc
stop is not retried, and retry only uses actual failed pending unsubscribe state.
Both original token cancellations must return true; failed tokens/subscriptions
remain held for retry. Binding inspect/isCurrent is admission-only, never a pure
join or retirement callback. The newer Main native/Renderer/ref admission paths,
Doc/Registry and original host/router remain unchanged by this intake.

The independently closed Doc7ab exact two-file postimages supply synchronous
`subscribeRetirement`, real stop `retry()`/`inspect()`, and `retryInvalidation()`.
Write physical preparation now issues/reuses the canonical Registry handle and
calls the original retained primary adoption on that SAME real Writer/native
mount. It verifies the returned original consumer binding through the admission-only
Writer reader and repeats the existing physical/epoch/association guards before
completion. The actual startup host callback retains and awaits its original
external prepare, then invokes this SAME Frame's seal/admission helper without
repeating physical preparation. Module installation pins that Frame callback
identity alongside its original revoker/retirer; no alternate host is installed.
The original Root helper borrows the adopted binding and registers its real
pre-retirement sources. Preparation attempts its actual watcher/listener cleanup
and propagates the original failure identity or an aggregate preserving all
separate cleanup causes; cleanup failure cannot become successful completion. Root667 source is a real producer join, not full-host resource,
restoration, recovery or ready qualification. Runtime remains HOLD/UNRUN.

### Public native document reservation consumer (#2295)

The same installed factory now borrows `session.documentAuthority` from the
actual public UI session. It registers the original retirement receiver, captures
the original ticket, checks document key/epoch/revision and rereads the same real
mount before returning a native-only reservation. Pure custody checks call only
captured original native/registration predicates and private reservation state;
they do not capture, resolve a mount, read DOM or invoke admission callbacks.

Retirement closes admission and local native reservation custody before original
unsubscribe callbacks. Failed or currently notifying handles remain owned by that
same factory. Cancellation false is no unlink acknowledgement; the original handle
must be retained/retried. Failed receiver obligations retry their real callback,
never become a retired successful noop. Original creation errors are rethrown
unchanged even when cancellation also fails; the actual handle and both causes
remain available through cleanup inspection. Factory retirement attempts every
owned handle, keeps failures and can retry through the original composition host.

This consumes only native document authority and owns subscription obligations,
not a new issuer, realm, document generation or article index. Writer/Doc/Auth
joint Root admission and full refset/resource readiness remain separate original
producer work. Missing public native authority still returns null; no resources,
pause/disposal/restore/eviction or full-host ready receipt follows from this port.

### Original required-reference admission (#2295)

`prepareArticleWorkspaceSnapshotReferenceAdmission` stages required reference
metadata through the SAME installed host/factory. It borrows existing original
Writer draft and journal refs, verifies native bytes and original principal/site/
draft association during admission, and prepares/seals the existing public native
snapshot. Selection direction, history, active node, scroll, outline, search,
attachment and last-valid-render refs come from that actual native candidate;
missing attachment/render refs refuse rather than receive synthetic locators.
The original host snapshot digest function seals only this body-free metadata.

Original draft/journal inspection and Writer binding reads remain admission
operations. The final scoped guard and subsequent `hasCustody()` use only pinned
original native publication/document, draft and journal private custody methods,
plus the same installation's private continuity. The original native retirement
receiver withdraws private publication before external work; it performs no
inspection, capture, issuer cancellation or reactive read. Cancellation withdraws
before attempting both actual native candidate and registration cleanup. Failed
cleanup preserves its real handle and first/latest causes; factory retirement
attempts all original obligations and supports retry through the same host.
Only one pending reference operation is held, with no article/session index.

This candidate has `complete:false` and `recoverable:false`; it is never passed
to host attach/capture or router readiness. The public session now forwards the actual
same-mounted full-document Renderer357 checkpoint handle through the original
MarkdownEditor getter. Admission holds that single handle and its original
preparation/publication, matches document identity/epoch/revision and the exact
last-valid-render ref against the native candidate, and joins its original pure
seal custody. Native seal admission finishes view/render reads before Renderer
seal acquisition. Subsequent pure has never inspects or reacquires the handle;
failed/retired cancellation keeps that actual handle/preparation and requires
original cancellation confirmation while attempting the remaining cleanup.
The candidate exposes the actual Renderer checkpoint ref. The SAME Frame now
borrows the exact original Write-issued Root seal after physical preparation
and Doc/Writer admission. Its one bounded descriptor holds the actual native
editor and session ref; pure has combines original Write private token custody,
Root667 private Doc/Writer custody and Frame private installation/epoch state.
View revocation/retirement withdraws that descriptor before external callbacks.
The existing startup resolver forwards that same descriptor, and factory admission
checks native/session identity plus descriptor continuity before joining its
original pure has. The exposed `rootMountedSeal` is the actual original token,
not a reconstructed marker. Scope is
`native-renderer-root-draft-journal-reference-custody`. Reference cancellation
drops borrowed Root custody only; it does not cancel the Root owner's live seal.
Root alone retains its original cancellation/subscription failures and retries.
Complete resource authority and restoration after disposal remain unavailable.
These missing ports prevent full-host readiness, pause/disposal qualification and
eviction; no component-tree discovery, internal SDK import or substitute issuer
is used to bypass them.

### Closed source paths and remaining owner interfaces

Parent reports finite source closure, with no new P1/P2, for UI357 intake,
actual UI session getter, Main Renderer consumer, Root667/Writer4249 intake,
original void-prepare/one-join startup wiring, and the same Root seal transfer
into the factory. These are distinct from runtime qualification. The independent
startup full-project typecheck has no retained log and remains UNRUN; our own
bound application compiler has 243 existing failures with zero diagnostic delta.

The actual activation path is original prepare -> same physical Writer Registry
adoption -> same Frame seal/Doc/Writer admission -> original host bridge. The
separate reference-admission API joins actual Root/native/Renderer/draft/journal
custody and allocates body-free metadata; it is not called by full host capture.
`createSession.captureSnapshot` still refuses, and full restore still returns
blocked. Atomic full-reference publication and full restore through that host are
additional Main implementation work, not a missing runtime permission or remote
authorization guarantee. The bounded native publisher now provides
`hasPublishedNativeCustody()` using the actual native session's pure published
pointer/generation query, without owner availability or view/source reads.

| Original owner | Actual source boundary | Missing source interface or existing behavior |
| --- | --- | --- |
| Renderer | `markdown-renderer-session-resources.ts`, `markdown-renderer.vue` | Participant inspect/pause/resume currently throw through `requireSourceCensus`; complete census and reversible owned watch/listener/frame/pipeline/heavy controls are missing. Scoped checkpoint prepare/seal/has already exists. |
| Pipeline/worker | `use-render-pipeline/index.ts`, `worker-pool.ts` | Actual pause/resume already exists; adapter resources remain unknown and worker/native/shared attribution must be supplied by the real provider, or explicitly unsupported. Local cancel/settlement cannot claim remote execution reversal. |
| Heavy/activation | `use-markdown-heavy-feature-lifecycle/index.ts`, `markdown-heavy-feature-resource.ts`, activation/gateway loaders | Timer/network cancellation is explicitly unavailable. Original adapter-owned requests, timers, import and continuation lifecycle require local census/control/settlement ports. |
| Native surface/framework | `markdown-editor.vue` | `surfaceResourceOwnerComplete=false` reflects missing reversible Vue/template/IME/input/viewport listener ownership; readonly/disabled does not detach it. Existing imperative controls are partial. |
| Attachment/provider | `markdown-editor.vue`, `markdown-editor-attachment-embed-owner.ts` | Real source participant exists, pending uploads refuse pause, opaque consumer resources lack a control/settlement port. `attachmentResourceOwnerReviewed=false` is a separate review/qualification hold, not proof of absent source. |
| Writer/Root | `useAdminArticleWrite.ts`, existing Root startup/session binding | Original permanent cleanup exists; a retained-session save/draft/image/network/effectScope census and reversible pause/resume port is absent. Root must forward that exact producer port. Server draft pause or abort signal alone is no completion acknowledgement. |
| Native/Renderer restoration | Original transaction/session and Renderer checkpoint owners | Same-owner/same-revision retained restoration exists. After unmount the original transaction pin is released, participant disposal is not recoverable, and validated same-process owner handover/reattach/full-ref restore is absent. No cross-startup memory restoration requirement is introduced. |

### Bounded native handover local continuity bridge

The original native SDK `00e5cee85c82419703c7bfd57a51113747cdaba1`
checkpoint recreation candidate is under independent review. Main's separate
`prepareArticleWorkspaceNativeHandoverContinuity` uses the sole installed host,
original resolver/Writer draft checkpoint, and canonical Registry handle issuer.
It verifies the actual current source editor/session, exact published native
snapshot, document/source epoch and digest, and the original Writer's principal.
It then retains original Admin `seal/has/cancelAdminPrincipalAuthority` tokens and
original Registry membership seals. No copied seal, second principal/document
issuer, body/history store, mount discovery or serialized reconstruction is added.

The borrower carries the same original application guard into native
`prepareNativeHandover`. That guard joins only original local Auth custody,
canonical membership/publication and private composition/attempt eligibility.
Its pure path does not read clock, principal projections, Doc inspections,
resolver/native getters, or reacquire tickets. Admission performs actual original
readers before the final private join, including a late canonical entry digest
check after issuing both seals. These are observed local Auth guarantees; an
unobserved remote expiry/revocation or server-side atomic handover guarantee is
not introduced. Existing server validation and all security/privacy holds remain.

One pending factory operation retains actual native/Auth/Registry handles. The
continuity cleanup owner is saved before original acquisitions, cancellation
withdraws publication before callbacks, and cleanup attempts all owned siblings.
Original native terminal state permits releasing only its completed source loan;
pending/refused cleanup and original first/latest causes remain held for retry.
It never cancels the transferred target checkpoint or fabricates disposal.

This reservation explicitly lacks `root:native-recreation-target-custody`.
The existing mounted resolver does not issue a staging target lease with pure
identity/generation and pre-retirement withdrawal while native revision is still
zero. The original Root owner must lend that actual new editor/session/document
binding before native target adoption; an old mounted/native seal cannot replace
it, and late readers after history transfer cannot promise rollback of old pins.
That target integration is unimplemented, not an interface-only success path.
Renderer candidate and complete panel/provider/resource restoration also remain
independent dependencies. Reservation flags stay `fullRefsRestored:false` and
`resourcesValidated:false`; full host capture/restore/readiness/eviction guards
and all runtime/native/IME/receipt qualification holds remain unchanged.

### Exact original Root/Writer resource-source intake

Original accepted Root `f6e214912ab31c7c8a7368de73bd966682c55551`
and Writer `d80934e854f2dd3b338162fe924cf19e0662f66f` are consumed as
exact owning postimages: reservation helper blob
`12d8b0e74fc23ad4ae9324decbc579a15f3e1f3f` and Writer blob
`e04178efa688b01a07cdfda8a8deec82e0244af6`. The existing Frame only adds
the original `readOriginalWriterResources` expose. Its later same-Frame startup
admission and borrowed Root seal join are preserved; donor omissions of those
Main-owned hunks are excluded. Native/continuity/Registry/Doc/Auth source is not
overwritten. This intake does not consume Root staging or Renderer/Heavy WIP.

The original admission-only resource reader fences current Writer identity before
and after the read and rejects permanent release, replacement, paused/stale loans
and reentry. Already-borrowed original references keep their original settlement
and failed cleanup custody. Original pure join/listener and 667 admission semantics
remain. Writer owns its actual local controls and rollback; the Root resource loan
is not a complete resource/recovery certificate. Full refs/resources/eviction and
runtime/native/IME/security/receipt qualifications stay held. Exact current Main
whole application remains FAIL243 with complete diagnostics added0/removed0;
position-shifted existing Writer timer diagnostics are not a new regression.

Unqualified labels and runtime/list/native holds are not automatically source
gaps, and old diagnostic dependency strings are not interface inventories.
All complete/recoverable/eviction guards remain; unknown resources remain unknown.
### Upload producer request prerequisite and native completion boundary

The application consumes the original upload producer source through
`b58021be2aed3d073f0bb5a1bfd7d8e89532274e`. The bounded intake includes the
upload API, Flow/runtime, binary composition/transport contract and implementation,
decode worker, and image compression/operation owner. At prerequisite intake,
seven production files retained the exact donor postimages. The upload API
additionally preserves the existing
`readCommittedUploadPreview` implementation and dependencies. Binary transport
preserves the original `binaryRoutePolicy` implementation, its single policy call,
and both return branches' private scope and generation policy. These two reconciled
postimages remain subject to the original upload owner's source review.

`requestStartUpload` and `requestResumeUpload` return the actual original
`result`, `settled`, `cancelLocal`, and local resource inspection. Existing
`startUpload`/`resumeUpload` callers still receive that request's `result`.
The Flow's void result is not an article content or business acknowledgement;
handled errors may finish that result without a committed business outcome.
Settlement independently follows the original child producers and local callback
work. Callback code awaits its own work only: enclosing upload, Flow, or SDK
result/settled promises depend on that callback and must not be awaited inside it.

The structured upload census is not the SDK consumer's six-category census.
Unavailable network or shared Wasm terminal observations stay unavailable;
unknown resources and retained cleanup obligations cannot become zero counts or
successful release by projection. No checkpoint, remote cancellation, business
asset cleanup, or full editor resource readiness follows from local settlement.

The actual Writer currently admits an original native capture and observes its
owned upload through `onFileUploaded`, the original session borrow, and
`createArticleAttachmentUploadProvider`. The committed asset observation is a
transport fact, not an article-operation or reference grant.
`ArticleAttachmentContextAdapter.complete` explicitly refuses a native capture
with `attachment-native-completion-unavailable` before content mutation. Its
nonnative path dispatches and commits content itself, so it cannot precede the
SDK's terminal apply without a duplicate mutation. The original article attachment
owner must supply actual native completion composition for the same capture,
pending handle, and original SDK job/attempt before the application can bind
`attachmentRequestDispatch` to an authoritative business terminal result.
No substitute success result, second content owner, or business acceptance is
introduced by this producer prerequisite. Runtime/native/receipt/IME qualification
and full host capture/restore/readiness guards remain unchanged and unrun.

### Canvas receiver binding prerequisite successor

The separate accepted producer successor
`42432fe0a8df3e64490da558d5492bdd4ebd8de4` changes only image compression.
The application consumes its exact `imageCompression.ts` postimage
`a71feabd24498d7d1b9f394322a606af3c622465`: context lookup and drawing bind
the original canvas/context receiver once, then preserve the original cancellation
check before invocation. The original operation helper, other producer leaves,
Main preview/Auth reconciliations, and native business completion refusal are
unchanged. This source fix removes two receiver-binding lint findings; raw
rejection and existing FileReader stringification findings remain WIP. It supplies
no business acknowledgement or runtime/resource qualification.

### Native terminal transaction observation and original task transition gap

The independent local native terminal source exposes a synchronous
`attachmentTerminalObserver` and the same mounted editor's
`withAttachmentTerminalTransaction` loan. Original private result admission and
dispatch reference/attempt precede application; the actual native publication
barrier remains held while the callback and original File release execute. Only
this exact application's in-progress release may defer the original input abort
listener. True cancellation, document/epoch replacement, failed notification and
lost original job/dispatch custody still refuse. The committed observation carries
the accepted terminal event from the existing native dispatcher after synchronous
transaction/model callbacks, never the placeholder capture or progress boolean.

The original Writer forwards this callback through the existing editor components
and lends that exact mounted native port to `ArticleAttachmentContextAdapter`.
The original accepted-capture weak registry retains its actual pending entries;
no second handle/job/lease issuer is added. Applying reserves the same entry for
its own transaction map. Committed verifies the current original document binding
and records the same historical accepted native event through
`readNativeTerminalTransaction`. It never calls generic completion or dispatches
content again. Raw notification causes remain readable on the same handle; no
provider or native work settlement is inferred.

A separate existing SDK/Doc contract blocks completed task qualification:
`ArticleDocumentContextAdapter.updateSource` cancels all tasks from the preceding
revision, and `ArticleDocumentTaskLease.accept` only admits the current exact
context/revision. The real terminal transaction's synchronous source update
therefore aborts the original provider lease before the final observation. The
bridge keeps that same handle/entry/lease, records its actual envelope with
`taskCompletion: 'unavailable'`, and finishes it cancelled with
`attachment-native-task-transition-unavailable`. The original SDK/Doc owner must
supply a controlled same-lease revision-transition completion capability; a new
completed successor lease or a copied receipt cannot substitute for it.
`transaction-committed` qualification, the rich business request adapter, full
resource/ready/recovery/eviction and runtime/native/receipt/IME holds remain open.

This source depends explicitly on the isolated UI terminal draft based on accepted
UI914, while UI943 atomic retry remains separate. Static checks use the exact local
UI terminal root; no package is published or default source authority refreshed.

### Original physical native staging producer intake

The separate physical staging prerequisite consumes accepted original Root source
`1612fb9aee0b9e4a3e2e50698c0e544c6b8f02ee`.
`articleNativeRecreationStaging.ts` and its layout-context API retain exact donor
postimages. The original Write staging implementation retains the newer Main
terminal observer attribute. Frame takes the exact original staging holder,
first/latest failure handling, real cleanup and borrowed-lease methods additively;
its newer mounted-authority/startup admission and original resolver join remain.
The entire current Writer and original native terminal adapter source are unchanged.
No Registry/Group, Auth, SDK Doc, typography, frozen authority or generated
closure is replaced by the donor's older branch tree.

The original production slot mounts a genuinely new native leaf, obtains its
original physical birth/lifetime, and borrows actual Auth/membership/Writer/native
subscriptions into one staging lease. Withdrawal occurs before callbacks; actual
failed handles, raw first/latest causes including undefined, and pending cleanup
remain on the original holder. Successful cleanup clears real debt without
restoring withdrawn authority or erasing failure history. The staging lease owns
only these real subscriptions/tokens and never disposes the target editor.

This intake is a physical prerequisite, not the Main handover composition. The
subsequent path must use the original source offer/principal, this real staging
lease, original native adoption/receiving cleanup, staging release, and ordinary
Root preparation/readmission of that SAME target. It cannot clone native history
or issue a new document/principal authority. Full references/resources/readiness,
restoration and runtime/native/IME/receipt qualification remain incomplete and
unrun. Main Frame/Write reconciliation remains independently reviewable.

### Original native adoption and same-target Root readmission composition

The sole installed session composition receives an actual Frame-owned native
recreation port through its original startup and group/session source. It is not
caller-selected mount discovery or another host. The port keeps Frame's original
startup signal and real reserve/ordinary prepare/admission functions.
`recreateArticleWorkspaceNativeSession` uses that SAME installed factory to
prepare the existing original source offer and Auth/Registry principal, then
borrows Root's real physical target lease.

The driver preserves source/target/document/offer identity and subscribes to the
real target lease's pre-invalidation withdrawal. Revocation withdraws the original
source/principal before native transfer can continue. The actual target session
performs original `adoptNativeHandover` and original receiving cleanup. Only after
real accepted native proof/current custody does it cancel the staging lease's
subscriptions/tokens, then invoke original Root preparation and admission for the
SAME target editor/session. It compares original mounted authority and physical
target before/after readers. No duplicate native history, document/principal
issuer, disposal or host-ready receipt is introduced.

One driver operation retains original source/staging/target receiving-cleanup
holders and raw first/latest failures for actual retries; cleanup attempts all
owned siblings. Accepted native content/history is not rolled back by Main after
a later Root failure. Full reference/resource validation/readiness/recovery and
native/IME/receipt/runtime qualification remain false/unrun. This newly composed
source is independently reviewable; real execution and all authority refresh
remain held. Same-lease attachment transition is a separate SDK lane.


### Original attachment revision association producer

The original Writer forwards getAttachmentTerminalRevisionIssuer from its actual bound mounted editor. Its existing ArticleAttachmentContextAdapter owns one stable getNativeRevisionProducer capability; this is a producer seam for the original Doc SDK, not a new document/task authority. reserve(lease, custody) uses the same private accepted-capture registry, original PendingInput and exact entry.lease/nativeCompletion references inside the authentic applying loan. It lazily calls the actual mounted native issuer and retains its opaque reservation with those same references. The SDK must bind this producer through the original trusted Writer/attachment/Doc composition and independently prove its own private lease/slot; structural objects, arbitrary true callbacks and metadata are insufficient.

The producer verifies its own private association plus the actual native issuer's applying/accepted/committed phase and same transaction event. Original entry/lease abort withdraws the native association. Failed cancellation retains its real holder and first/latest raw cause, including undefined, for attempt-all retry; successful cleanup withdraws debt without deleting failure history or restoring authority. inspectCleanup reports only this producer's cancellation obligations, never a full editor resource census or readiness grant.

An unavailable `accepted` publication response retains the SAME nativeCompletion and ownedOperations until the original native owner's final `refused` observation. That final observation records its actual raw cause and uses the original pending entry finish path to cancel the SAME lease and release its actual File before clearing custody. Intermediate accepted refusal cannot discard the deferred original input-release obligation.

No original SDK controlled same-lease transition consumer is installed by this source stage. The producer is available but reserve is not called automatically. The existing Main observer explicitly refuses an armed accepted phase until that original SDK publication API exists. Ordinary updateSource/accept/isCurrent, task settlement, native generic-complete refusal and taskCompletion unavailable remain. Accepted native content cannot confer business/reference/full-resource/recovery/eviction authority. The isolated native issuer source dependency is separate from the accepted native/retry composite; source availability is not runtime qualification.


### Main controlled native attachment consumer

The original Main attachment observer uses the actual original Doc SDK ports inside the same authenticated native loan: applying identifies its original private accepted capture/PendingInput.lease and asks SDK reserve to invoke the installed genuine producer; accepted publishes the SAME real event through SDK before public source callbacks; committed accepts that SAME token/event using the existing transaction/provider-result digest proof. No direct producer auto-reserve, second loan/lease, copied native body/history/map or generic second dispatch is used. The actual SDK source and actual UI composite are explicit local-source dependencies, not interface substitutes or package publication.

After SDK accepted publication returns, Main stores that original event and exact returned current context in the SAME private entry. The original Writer's equal-revision form guard admits synchronization only when this private publication matches the actual event/context/live entry; ordinary source equality/revision guards remain. Later public transaction/model/source callbacks use their original path.

Actual successful SDK acceptance stores the historical SAME task envelope and transaction. Original lifecycle proof fields use actual event/result digests and preserve the original started context. SDK failure after lease finalization retains that real completed historical envelope with historical acceptance status, never fabricating an aborted completed lease or replacement completion. Original entry cleanup attempts SDK association cancellation, original lease cancellation where still running, actual File release and controller revocation independently. False/throw, including raw undefined, retains the SAME original pending entry as cleanup custody; only confirmed duties remove it. Completed cleanup-only rows cannot enter ordinary rebase/retry/new-lease paths. Public original-handle cleanup retry and inspection expose real pending duties. An SDK cancel false after failure is kept unconfirmed, not inferred as zero cleanup.

Writer resource observation includes these real cleanup holders and the original Doc adapter's pending tasks; completed task publication never calls settle or confers full settlement. Existing full-resource/host/recovery/eviction/readiness and business-grant guards remain. The dedicated rich upload request adapter, real AssetId and complete original File/batch/item/intent/lease binding, own-work-only result/settled/cancel futures and absence of direct/indirect self-await are separate original-owner integration requirements. URL/void fulfillment is not business identity or completed cleanup. All runtime/security/privacy/receipt/race/backuprestore/IME qualifications remain held.


## Original Rich Upload Request Boundary

`requestArticleAttachmentUpload` in the dedicated
`articleAttachmentUploadRequest` module is an unactivated request adapter for the
original FsusUI rich attachment contract. Main must supply the actual admitted
native File, batch/item, same pending intent and lease, configured upload runtime,
and its own `requestProviderResult(completion)` producer. The adapter probes the
accepted Main owner's actual `matchesCapturedFile` method; an older owner without
that capability fails closed. It does not capture another job, issue a task lease,
dispatch a native transaction, publish a Doc revision, or activate caller wiring.

The adapter starts one original `requestUploadFile` with that File/options/binding.
Inside the actual ACK-time bounded session loan it binds Main's returned original
`MarkdownAttachmentConsumerRequest` and awaits only that provider's result. The
returned rich result is the provider's original value, correlated with the native
batch/item/document/revision; resolved content must carry its actual AssetId and
the correlated ACK URL. Upload URL or Flow `Promise<void>` fulfillment cannot
substitute for provider acceptance, native committed application, original Doc
task completion, business reference receipt or asset release. Provider result,
full-settled and cancellation-cleanup work must not await this request's or the
upstream upload's futures, or native committed application that depends on its own
rich result, directly or through async/then chains. Direct upstream-future identity
cycles are refused; those checks do not establish indirect independence. Main's
actual provider implementation must satisfy that separate consumer contract.

The original upload and provider requests remain inspectable by their invocation
owner. Full settlement is a separate Promise that waits for actual upload and
provider full-settlement observations, closed provider acquisition, finished
adapter execution and fulfilled original consumer cancellation cleanup. Failed or
unobservable settlement/acquisition stays unresolved. Cancellation permanently
records the first request before independently attempting both original owners;
failed cleanup can be retried without repeating upload or provider creation, and
raw failures including undefined remain separate from content result. Asynchronous
cancel rejection is appended to the adapter's historical failure record before
reconsidering settlement, with an explicit cause property even for undefined. A
successful retry may replace the original UI binding's current cleanup slot, but
cannot erase that history; historical failure alone does not prevent settlement
after actual successful cleanup.

The upload census has no authoritative complete numeric network/memory totals.
The UI's six-number `inspectLocalResources` contract therefore explicitly throws
`ArticleAttachmentUploadResourcesUnavailable`, carrying the actual upload census;
the canonical FsusUI binding reports inspection unsupported. It never converts
unknown network/shared-Wasm work or retained File state to zero. No checkpoint is
offered. Main's private binding/provider hookup, full numeric resource capability
and genuine receiver/native/SDK integration remain separate unresolved gates;
this source adapter does not establish runtime or migration qualification.


## Main Native Rich Request Consumption

Main forwards the actual `attachmentRequestDispatch` through ArticleWriteEditor,
MarkdownEditorAdapter and MarkdownTextEditor to the sole mounted FsusUI editor.
The rich dispatch does not emit the legacy capture event. Main therefore borrows
the SAME native capture through the existing mounted `withAttachmentFile` port
and calls the original accepted-capture admission once. The private pending
owner returns the original handle, File and SDK lease; no replacement capture,
history, task, placeholder dispatch or parallel upload is created. The legacy
capture callback only admits and no longer starts useImageUploadFlow. Original
explicit operations keep their existing Flow path.

The configured requestUploadFile receives that same original binding. In its ACK
loan, requestArticleAttachmentCommittedFacts opens a bounded nested scope and
calls the existing transport provider's observe method. Its named session fields
remain private; real committed facts supply AssetId and must match the ACK URL.
The provider's own result never waits for upload, adapter, SDK acceptance or native
application. Its separate settlement observes genuine callback completion and
original scope cleanup. A rejected scope is unconfirmed until callback work has
ended and actual original loan release retries cleanup successfully. Cancellation
attempts controller abort and original loan release independently, preserving raw
causes including undefined. No guessed AssetId, success ACK, numeric zero census
or checkpoint is supplied.

Main retains each original request until its actual full-settlement observation,
exposes same-handle cancellation retry and includes real upload census and failure
history in Writer resource inspection. Pause/release cancellation attempts every
retained request. This does not settle the SDK lease from terminal content: SDK
producer settlement, numeric full network/memory census, references, recovery,
eviction and host readiness remain separate unsupported or unqualified gates.
Whole application diagnostics and every runtime/qualification execution hold
remain; this source composition is pending independent review.


## Accepted Root Cancellation Consumption

Main takes the three original Root owning postimages exactly from independently
accepted a4f28e43a8608914264a38fca596a7edb4ad2917: Frame, session composition and
native recreation driver. Real operation cancellation reaches the same source
principal and original physical operation. Synchronous issuer notification
withdraws authority before deferred cleanup; queued/closing public lease retry
retains the original pending holder and raw firstCause, including undefined,
before delegate cleanup. Failed late acquisition and receiving cleanup remain
unconfirmed. Same staging target adoption, explicit stage release and ordinary
Root readmission ordering are preserved. SDK, Writer, registry, factory and
continuity source are unchanged by this dependency consumption. The three exact
source postimages do not qualify actual native work, resources or readiness.


## Native Cleanup Debt After SDK Cancellation

The original pending entry retains an independent nativeCleanupPending duty once
its real attempt-all cleanup starts. SDK cancellation success only completes the
SDK duty; subsequent File/controller/lifecycle cleanup failure keeps the SAME
entry and remains counted in native cleanup inspection. Retry continues through
finishNativeEntry even after SDK pending is false and no finalization exists.
Ordinary retry/rebase cannot replace a cleanup-only entry. Only actual success of
all original duties clears this marker; raw first/latest failures, including
undefined, remain. This does not call settle, attest producer completion or lift
native/resource/readiness/qualification holds.


## Serialized Main Native Upload Admission

Main reserves one real queue slot synchronously before the shared original upload
runtime begins compression/hash. Original accepted File/handle/lease and selected
options stay in that plan; the queued request exposes its original started
adapter when available and never creates another task or capture. Subsequent
plans start FIFO only after actual original adapter full settlement and result
relay completion, with queue-owned listener cleanup complete. Content result is
forwarded independently and never releases runtime admission. The provider,
upload and queue futures do not await native/SDK application or acceptance.

Batch/item/intent/lease revocation cancels the same admission plan. Never-started
plans physically leave the queue and release their start closure/listener without
calling the runtime; active plans cancel their original request. Real cancellation
and listener cleanup are attempt-all, caught reentry retains debt, and raw
failures including undefined remain. Acquisition without an escaped original
request stays unconfirmed and blocks competing generations. Numeric complete
queue census is explicitly unavailable; an absent started request is not a
zero-resource original upload receipt. Original upload census remains inspectable.
Existing explicit Flow start/resume refuses while native requests own admission.

This fixes runtime supersession during multi-item compression/hash startup. It
does not establish multi-item native revision publication: the original SDK
controlled publication still cancels all other leases. Queued original leases
that are revoked remain cancelled; no stale guard is weakened, lease revived or
replacement minted. Actual same-batch cohort publication and original native
application-ended cleanup acknowledgment require their original SDK/UI owners.
No content/accepted/committed/terminal event is converted to settle or readiness.


## Shared Runtime Cover and Flow Admission

The original Writer cover, explicit attachment Flow and resume entrypoints now
share one native admission check. It reads the actual queue's synchronous slot
and retained native request holders before any Flow start/resume; the slot also
covers acquisition before its request is written to the map. Native enqueue
refuses an existing explicit attempt or Flow pending context. The original
Flow/runtime owner keeps its own admission/recovery controls. No parallel runtime
is created. Write's original abandon and scope pause/release remain real cancel
operations; the Settings uploader belongs to its separate owner and is unchanged.
FIFO still releases only on original full settlement, relay and listener cleanup.
These admission facts do not acknowledge full resources, SDK/native cleanup or
any qualification hold.


## Queued Upload Scalar Options

At native enqueue, Main reads format, quality, scaleRatio, maxEdge, preserveAlpha
and wasmOnly into frozen ordinary scalar values. The selected reactive options
object is not retained by the start closure; later preference mutation/reset
cannot change the already selected plan. The five compression values match the
existing ImageCompressionOptions contract. Original File, batch/item, intent,
lease, runtime and getBinding provenance remain the same objects; no document
or authority snapshot is manufactured. Admission, real FIFO settlement/relay/
listener cleanup and cancellation/raw-failure debt are unchanged.


## UI954 and Accepted Main Source Composition

The isolated Main composition retains the exact accepted cleanup58dc and FIFO
final2cc owning postimages, including cover/Flow admission and enqueue scalar
snapshots. It consumes the exact accepted Config conventions114 two-file
postimages. The installed frontend alias uses the actual detached local UI954
52269303b48eddc545fc901cd170eba7e6fb581e through the original alias producer,
with FSUSBLOG_LOCAL_FSUSUI_ROOT set to that checkout; it does not build/publish
or recreate UI source. App's producer export, ElConfigProvider and the renderer
feed all resolve the original shared config-provider hook/registry.

UI954 success-content and retry-canonical-custody fixes are source dependencies,
not Main runtime/qualification acceptance. Original provider/File/lease/event/
history/document identity and epoch guards stay unchanged. c50 and every earlier
review checkpoint remain fixed. Full compiler comparison uses SAME UI954 for
both prior2cc and current composition; old UI949231FAIL is a separate historical
profile and is never substituted as this baseline. No producer settle is inferred
from content, accepted or committed; native cohort/application-ended confirmation,
full census/recovery/eviction/readiness and all execution/qualification holds
remain separate unresolved original-owner capabilities.


## UI957 Native Application-End Dependency

The isolated successor of accepted Main428054e354 uses actual read-only local
UI957903db034a14254fb162f51b9c25d3703ea20ccb5, exact original955f2cee/95698e
parents, through the existing explicit source alias. Both public package names
resolve the same original source index; ConfigProvider/native render feed share
the original public hook/registry. Upstream source is not rebuilt or published.
Its original application-end issuer reserve/inspect/hasEnded/retry binds the SAME
single reservation and lease. Running/cleanup-blocked, unknown returned work or
unconfirmed cleanup is not ended; ended is only original native stack/cleanup
proof and never full upload/network/SDK/resource settlement or readiness.

The separate Main consumer commit reserves the actual public end handle inside
the original applying loan, retaining it on the same pending entry before fallible
owner reads. Inspect validates original handle/custody/reservation/lease and the
exact publication event; only the issuer's exact observation/hasEnded proof can
release the native application duty. Main's synchronous committed admission
acknowledges its own cleanup only and keeps the entry while native cleanup is
running, blocked, unsupported or unknown. Explicit retry attempts the same native
cleanup cursor and Main duties independently without replaying publication; raw
first/latest failures, including undefined, and failed holders remain retained.
This does not settle SDK tasks or upload/network work.

SDK4288 exact78a6b8627f56a238e55af3dba851cdbfe66c9d94, Doc blob
adb0ca27c62fa20f971d581c61bc35b6730c09f1, is bounded source accepted per parent
but is not consumed here. Actual cohort/anchor/File/original-lease continuity is
a separate stage; ordinary context/stale/rebase/replacement remain unchanged. c50 and accepted54e354 checkpoints stay fixed. Every runtime,
import/test/collection/list/discovery/native/security/privacy/receipt/race/
backuprestore/IME and qualification hold remains.


## Original SDK Cohort Source Intake

A separate successor preserves Main application-end checkpoint7bb7bb769 unchanged
and imports only the original SDK4288 ArticleDocumentContextAdapter source from
78a6b8627f56a238e55af3dba851cdbfe66c9d94, exact Doc blob
adb0ca27c62fa20f971d581c61bc35b6730c09f1. Its native-backed cohort membership,
continuation, exact published-event and SDK producer-frame bindings do not change
ordinary context/current/stale predicates or issue replacement leases. The
notification/retirement exclusion and final native proof follow the reviewed
original source. No donor authority, fixture, schema, generated output or claimed
runtime evidence is imported.

This owner intake does not yet activate Main cohort consumption. That separate
consumer must use the original ordered capture entries, File, anchor, pending
handle and same original lease; preserve original started envelopes; suppress
only exact private source publication re-notification; and retain genuine
cleanup debt. Physical application-ended and SDK cohort source acceptance do not
settle upload/network tasks or grant complete resource/readiness qualifications.
All existing execution HOLD/UNRUN remains.


## Main Original Cohort Reservation and Peer Anchors

The separate consumer forwards the mounted native cohort issuer through existing
editor ports. During the first authentic applying loan it binds the complete
ordered original capture item/job/lease roster through the imported SDK owner,
retaining acquisition custody before fallible reserve. Subsequent applications
pass the same SDK cohort and original lease. The Main producer accepts the SDK's
frozen continuation only after its actual producer-frame binding and original
private capture/entry/custody checks; ordinary isCurrent remains strict.

After actual SDK publication returns, peers map their original anchors through
the same public position map and exact SDK event/context publication proof. Main
keeps original File, handle, job, lease and started envelope; generic peer rebase
cannot replace them. Foreign map/anchor readers precede the final proof and
private entry checks. The original synchronous form watcher suppresses only the
exact private publication frame and event/context, preserving ordinary source
updates and recovery writes. Failed cohort withdrawal remains an independent
original cleanup duty; successful metadata cancellation does not settle tasks.

Fresh native-backed upload continuation is available on the original pending
owner, but the existing upload runtime's ordinary envelope guards still require
separate consumer wiring. This reservation/anchor source stage is not complete
upload, full settlement, resource or qualification acceptance. All HOLD/UNRUN
remains, and application-end checkpoint7bb7bb769 is inherited pending review.


## Original Upload Continuation Consumer

The next isolated successor consumes fresh native-backed continuation in the
existing upload runtime and ACK-time request adapter. The original File pointer,
private pending handle, same document owner, original lease/envelope, current
peer anchor and real source map must agree before the final SDK/native proof.
The generic owned-intent observation keeps its ordinary stale result and valid
started lifecycle history. The private mapped continuation anchor is checked
against the actual public source map before final proof, never as permission.
A native cohort holder always takes this restricted route: null, revoked,
in-flight or failed continuation cannot fall back to ordinary lease currentness.
Generic/legacy admission retains its original strict envelope/context checks.

Each runtime boundary and the ACK loan rechecks original custody through the
same adapter. No caller-supplied Boolean callback, rewritten envelope, replacement
lease, new job/File/history/body or hidden application-ended wait is introduced.
The real upload/provider/queue settled futures remain independent of native and
SDK completion. This consumer adds no settle call, full census, pause/zero/ready
or recovery acknowledgment.

Zero-execution preflight reads the original src/frontend/vitest.config.ts,
vitest.shared.mjs, package scripts and tests/matrix.yml only. The existing full
package entry is npm run test:unit:fast from src/frontend with the explicit local
UI957 alias; it runs manifest synchronization, original HTML sink checks and the
original complete Vitest unit config. The canonical matrix entry remains
./tools/test.sh fast. Neither command, help/list/discovery, product import nor
collection has run here. Parent confirmation of original entrances and ordinary
cases is required before any execution; no alternate runner/config/filter exists.

Ordinary source review cases, all UNRUN: original two/three-file capture with
peer anchor shifts and unchanged started envelopes; same-original File/handle/
lease after the first real publication; null/in-flight native continuation;
wrong File pointer with identical metadata; copied/foreign handle or lease;
ordinary equal-source update and unrelated edit; lost exact publication prefix;
revocation inside map/anchor/admission readers; failed cohort acquisition and
withdrawal; original ACK loan invalidation; raw undefined and caught cleanup
reentry; genuine producer settled before native application ends. Original unit
sources are articleAttachmentAcceptedCapture.test.ts, articleAttachmentContext.test.ts
and articleDocumentContext.test.ts under tests/frontend/unit/authoring, plus
composables/useImageUploadRuntime.test.ts in that unit tree. Existing tests are
unchanged and do not themselves establish this new composed capability.


## Finite Original Native Producer Settlement Consumer

A separate successor reuses the original nativeUploadRequests holder and the
existing original request.settled fulfilled callback. It retains the same request
and SDK lease plus the actual fulfilled future identity, not a new promise, timer,
status/digest or Boolean settlement receipt. The original failure observation is
read before final native/Main proof; a failed reader retains that same holder
until actual retry succeeds. A rejected or unknown future supplies no permission.

The attachment owner can return only the original accepted completed lease after
its real SDK transition cleanup, File/listener/controller cleanup and pending-row
retirement have succeeded, and the stored original end issuer proves the exact
handle/custody/reservation/lease observation ended. This partial cleaned-lease
observation alone is not upload settlement. Writer requires BOTH it and its
private original fulfilled request future before calling that same lease.settle.
Only successful acknowledgment releases the same request holder. Existing
producer cancel and native-end cleanup retries attempt their original duties
independently; failures retain raw causes including undefined and do not discard
the holder. No generic envelope currentness, replacement lease, copied body/
history, new host or port, resource completeness or ready guard is added.

This increment intentionally handles only the real accepted/cleaned original
native application path. Producer fulfillment before physical application end
keeps custody until an existing explicit end-cleanup retry; no end timer/event/
future is invented. An unstarted or cancelled path without that physical end
proof, failed Main cleanup, unknown returned work or SDK retirement refusal stays
pending. Complete network/timer/subscription measurements and PoW shutdown/
recovery-channel acknowledgments still require their original owners. UI
attachment resource source and Writer inspection retain complete:false and
unknown network usage; settled task references do not grant full pause/zero/
readiness/recovery/eviction authority.

Original source-review cases, all UNRUN: real producer fulfilled before and after
physical end; original end/Main retry followed by same-lease settle; foreign
request/future/handle/lease; accepted content with still-pending/rejected settled
future; failed failure-observation reader; raw undefined cleanup or SDK settle
failure; original SDK retirement in progress; original completed historical
envelope retained through failure; no physical end proof on unstarted/cancelled
work. The existing original CLI/config preflight above remains unchanged; all
runtime/tests/import/collection/list/discovery/native/browser and qualifications
remain HOLD. Independent physical alias remains UNVERIFIED; author static
compiler evidence and bounded Git source acceptance remain separate.


## Original Cohort Dependency Three-P2 Repair

The original Main4298 dcc88f7ad has three static counterexamples and is not source
accepted. Upload4299 20eb128e is only conditionally bounded-source accepted on a
correct cohort dependency; settlement4300 220784b1 is separately pending review.
This isolated successor inherits their actual production source without changing
the fixed checkpoints, original accepted SDK Doc, UI source, public validators or
authority. Later stage acceptance does not accept the defective earlier dependency.

Peer publication now retains the real mapped anchor, original lease and exact
publication event on the same private pending entry. It maps from the previous
private anchor for each real event and updates the original job range. It never
writes a mapped after-context anchor into a lifecycle containing the original
started task context. Original lifecycle/envelope/history stays valid under the
unchanged task/anchor contextDigest equality validator. The applying producer,
native continuation and source-map checks read that private anchor; generic
owned-intent/currentness and preview history validation remain unchanged.

A non-applying cohort peer now enters the same attempt-all native cleanup path.
Failed SDK/native/lease/File/controller duties retain the original pending entry,
raw first/latest causes including undefined, and the same-handle retry entrance.
SDK permission revocation alone does not remove Main cleanup custody. False
cancellation is not success: only the original SDK single-holder inspection can
confirm that its metadata holder is already absent after actual withdrawal or
pre-holder refusal. Pending/failed inspection keeps custody. This partial metadata
observation never supplies producer, native application or full-resource settlement.

The complete ordered original roster and reserve method are obtained before
creating cohort acquisition custody. A cancelled peer causing roster failure
therefore has no invented cohort debt: SDK cohort reserve was never called. The
existing genuine single-application transition cleanup still runs. Immediately
before the actual cohort call, a holder is retained using only held local
arguments; entered/unescaped failures preserve it and use original SDK cleanup.
There is no ready/zero ACK, alternative SDK token, replacement lease or history.

The successor directly carries the original4299 runtime/request source and4300
Writer settlement source unchanged; only their shared attachment owner is repaired
to consume the lawful private anchor and cleanup holder. The composed successor
requires fresh original review of these dependencies; all execution, imports,
collection/list/discovery/native/browser/receipt/security/privacy/backuprestore/
IME and qualification HOLD/UNRUN remain. Physical alias is independently
UNVERIFIED and author compiler evidence is not independent execution acceptance.

Static review cases, all UNRUN: two/three real peer publications with valid
started lifecycle history and mapped private anchors; cohort-only peer cancel
with SDK withdrawal false/throw or File cleanup failure and same-handle retry;
cancelled peer during roster construction before SDK reserve; entered reserve
failure before token escape; actual already-withdrawn metadata versus a retained
SDK holder; raw undefined and caught cleanup reentry; downstream ACK/settlement
consumers preserve original File/handle/lease and do not treat content as settled.


## Exact Original SDK Withdrawal Source Intake

A successor of fixed Main4301 67b63670d966cc6a337b44c6246508f9e19aea99
imports only accepted original SDK4302 0c98ff6b3b61d8726190e937d5aba46a6296be25
Doc source, exact blob6c0fb4579b5577c6bb1d0c15221d9bd1004952ef. Its owner-local
weak token/lease pairs record actual association withdrawal and confirmed required
cancellation/completion; foreign/copied/unknown/mismatched or rearmed pairs and
reserve failure before association capture receive no positive confirmation.
Cancel semantics remain unchanged. This historical proof does not grant current
permission, cohort cleanup, native end, producer settlement or full resources.

Intake is a separate source commit; Main's false-cancel consumer follows in its
own checkpoint. Original4301 history/cohort-peer cleanup and pre-call roster
repairs are bounded-source accepted per parent; the entered-reserve token-removal
P2 still requires actual Main consumption and composed review. Original4299/4300
increments remain conditionally bounded-source accepted on that dependency. No
donor evidence/authority artifacts, validator, aliases or complete-resource/ready
guards are changed. All execution HOLD/UNRUN and independent physical alias
UNVERIFIED remain.


## Main Exact Withdrawal Confirmation Consumer

The separate Main consumer captures entry.nativeTransition and the same original
entry.lease inside the existing attempt-all SDK cleanup duty. It first calls the
unchanged original cancel. Only a false response consults the actual new SDK
hasWithdrawnAttachmentRevisionTransition(originalToken, sameLease) proof, or its
sameLease overload if a genuine reserve never returned the token. Positive exact
proof and unchanged private binding permit clearing only nativeSdkCleanupPending
and that old token. Unknown/foreign/copied/mismatched/rearmed or pre-association
acquisition returns no permission; false or missing holder alone is insufficient.
Original cancellation throws bypass the query and remain raw failures.

This is a single original-owner cleanup branch. Cohort cleanup, required original
lease cancellation, lifecycle validation/history, File/controller duties, native
end and producer future/settlement still run or remain held exactly as before.
The withdrawal marker never grants currentness, producer stopped, paused, full
resources or ready. Dependency source acceptance is not consumer P2 closure; the
composed fixed successor requires original Main review, all cases below UNRUN.

Three original static counterexamples:

1. Peer publication maps a real after-context anchor while started envelope stays
   original. The inherited private continuation retains that anchor; this consumer
   does not touch snapshot/history/validator. task/anchor history equality remains
   lawful and ordinary currentness unchanged.
2. Non-applying cohort peer cleanup fails. The inherited original finish path
   retains the same pending entry and retry; transition proof clears no cohort,
   File/controller, native end or producer duty. No new snapshot/job/lease exists.
3. Complete roster enters genuine SDK cohort reserve, then throws; SDK successfully
   withdraws the actual original transition and deletes its old token. Main's
   unchanged cancel returns false, exact SDK pair proof true now discharges that
   transition duty. If transition token never escaped, only an actually recorded
   same-lease pair confirms. Pre-call roster failure still creates no cohort debt;
   failed actual withdrawal or reserve before association capture remains false
   and held. Same-handle retry continues real remaining duties independently.

These are source walkthroughs, not execution or qualification evidence. Original
full CLI/config preflight remains unchanged; runtime/tests/import/collection/list/
discovery/native/browser/security/privacy/receipt/race/backuprestore/IME and all
qualifications stay HOLD/UNRUN. Physical alias remains independently UNVERIFIED.


## Reviewed Independent Compiler Leaf Intake

An isolated successor of accepted Main4303 70f6720f5037ac8756bce0e47886168d047b0053
compares original accepted History4261 0f4c13b45e771037287c8d0c4ad067aedf9183b7
leaf patches against actual Main source. History's UI953 compiler26/19 FAIL
(Blog1/UI25, per parent) is a different source profile and never a UI957 Main
baseline. Original complete application before/after checks use the SAME actual
UI957903 source alias and unchanged compiler configuration and program.

Batch one takes exact same-preimage reviewed Home6d0eaa0f1 readonly array
candidates/predicate with unchanged mutable-copy and empty-array priority;
Identity7f741d8df computed.value route keys, actual own-key predicate/fallback and
unused private type bindings; Slider13db592f1 three real number/number-array
handlers that forward scalar numbers and refuse arrays. Each selected patch is
applied to its exact full original preimage and yields the exact original leaf
postimage. Templates and actual UI references are unchanged. No whole History
tree, public export, runtime assertion/validator, enum conversion or configuration
is substituted to force diagnostics away. Donor skip-ci metadata is not copied;
normal original hooks/push/readbacks apply.

The ordinary source-WIP inventory records56 leaf/path observations:42 exact
preimages not yet consumed,3 already exact postimages and11 divergent current
preimages. These are Git observations, not approval of global compatibility.
Known already-included preview/session-host/client leaves are not repeated.
Divergent Writer/router/outline, recovery/storage/MTA/locale/transport/notification
owners require separately reviewed compatible hunks; their full old snapshots
are not imported. Generated contract/catalog/authority surfaces remain held.

The batch leaves every original Document/attachment/Writer/SDK/upload/FIFO/
cohort/native-end/settlement owner and actual local alias untouched. New source
intake needs composed review; compilation is author evidence only, physical alias
independently UNVERIFIED, and no source acceptance implies runtime or full resource
qualification. Every runtime/tests/import/discovery/native/browser/security/
privacy/receipt/race/backuprestore/IME/frozen/qualification HOLD/UNRUN remains.


## Reviewed Independent Core Source Leaf Batch

A successor preserves fixed Main4304 7af63ad6c897430c46410f41b8dc3e22ecf63195
and consumes16 additional exact same-preimage independent History4261 leaf/path
postimages. The type/import/signature group is a separate12-path source commit:
comment/message/stats private type bindings, two locale imports (divergent
registry not taken), public seed type, account/router/search/service-worker unused
private types, actual resolved navigation parameter and owned ICO return buffer.
Original public exports/value imports/runtime bodies remain; complete12-module
static emits are byte-exact using original resolved app options. This extra
source observation never substitutes for the original full application compiler.

A separate four-path boundary group takes the accepted real prewarm failure
observation carrier preserving nullish first-write/stage/raw cause identity;
two canonical existing ProtocolFailure consumer references for unknown kinds;
one identical site ogImage default (original duplicate removed); and the unused
private no-read-point article challenge computed, preserving the real challenge
context/route/attributes. No enum declaration is converted, no new cancellation
acknowledgment/permission/ready state or producer promise is supplied. No actual
UI template/reference, assertion, validator, alias or compiler config is changed.

The ordinary batch WIP records original leaf commits and exact current full
preimage/postimage for each path.11 divergent owner paths, original protected
authoring/Document/Writer/SDK/upload/FIFO/cohort/end/settlement, frozen catalogs/
authority and held enum/template/config surfaces remain untouched. Previously
included three postimages and batch4304 are not repeated. New composed source
review is required; every runtime/tests/import/discovery/native/browser/security/
privacy/receipt/race/backuprestore/IME/frozen/qualification stays HOLD/UNRUN.
Physical alias is independently UNVERIFIED, compiler/static evidence author-only.


## Reviewed Privacy Source Leaf Batch

The next isolated source batch retains five exact same-preimage History4261
leaf/path postimages: actual issuer expiresAtUnixMs while preserving min(root expiry, issuer
expiry); RSA actual owned view-range SPKI snapshot used by BOTH hash and import,
owned opening allocations and nested-finally snapshot wiping; revocation digest
owned ArrayBuffer types; unread private prover int64 writer removal; and unused
local notification PowParams type binding with unchanged public reexport.
RSA allocation/runtime changes are real, not an emitted-JS equivalence claim.
No borrow view is cast into owned memory and no crypto/privacy guard is weakened.

The original notification queued-mode annotation is not taken alone: its later
post-await read dependency was in the original divergent list and remains
separate rather than assuming combined compatibility. All11 divergences remain
listed and no old current-owner snapshot is imported. Protected Document/Writer/
SDK/upload/FIFO/cohort/end/settlement, actual UI957 alias, enums/templates/config
and frozen output remain original. All runtime/crypto/WASM/network/tests/import/
discovery/security/privacy/receipt/race/backuprestore/IME/qualification HOLD/UNRUN
and independent physical alias UNVERIFIED remain. Source review/author static
evidence do not certify privacy or complete resource/settlement qualification.


The actual six-leaf full compiler first run exposed credentialEpoch forwarding
incompatibility with Main's frozen AnonymousCommentTicketRequestDto (TS2353).
That one original hunk is explicitly reversed; Main privacy adapter remains
byte-exact to base and the five other original postimages remain. The original
leaf and failed diagnostic evidence stay in ordinary WIP as a real dependency
blocker, not a compatible-intake claim. Only an original canonical contract/
producer dependency may resolve it; no local cast/DTO/config/schema/frozen refresh
is introduced. All original fail-closed guards and execution holds stay intact.


## Reviewed Field and Public Model Source Batch

The next independent batch applies exact same-preimage accepted font-theme
WireReader/BlobCursor and theme error explicit readonly fields with original
initialization order; complete two-module original-options static JS emits are
byte-exact. The divergent recovery journal part of that donor is not taken.
Taxonomy uses actual public FormRules/FormItemRule and finite rules Pick, keeping
real validation body. Assets uses actual existing public TableV2 columns/sort
constants, with template/styles byte-exact; no enum declaration is converted.

The original Assets leaf requires the original public fsusui/tableV2 reexport
bridge, absent in Main. Exact History accepted bridge from original b8e8f8565 is
intaken independently as a five-source dependency set; actual UI957 original
index still exports all names. No local table interface/enum/implementation is
created. The initial missing-module diagnostic is retained in ordinary WIP;
original actual source dependency resolves it without config/cast weakening or
frozen authority changes. All protected authoring/SDK/upload/Writer/FIFO/cohort/
end/settlement and alias remain current; all execution/qualification HOLD/UNRUN
and independent physical alias UNVERIFIED remain.


## Reviewed Local Hunk Compatibility Batch

An isolated successor of fixed4307 0b4e606f21ee90a9cb113ead80df3c36b76f793b
records13 remaining original candidate paths and11 original divergent leaf/path
observations with actual current blobs, missing prerequisites and complete
current150FAIL diagnostic blocks. No direct diagnostic means no compatibility
claim; frozen credentialEpoch DTO mismatch remains explicitly blocked. The
privacy WIP statuses are marked as pre-intake observations with final5afd exact
consumed state, preserving original failed TS2353 evidence and source untouched.

The four-source compatible group consumes both original notification consecutive
leafs: queued nextMode type followed by actual pendingInitMode getter at the
existing post-await comparison. Each sequential full preimage and original final
postimage is exact; early annotation-only TS2367 is never a final consumer. The
getter is a real synchronous read, not cast/state fabrication or readiness.

Three bounded adaptations transplant only original accepted hunks: storage's
explicit runtime-medium discriminant, retaining Main recovery journal import and
checkpoint invalidation prefix plus real cleanup/retained handlers; locale's
first readonly registry/default/assignment-before-validation, retaining Main
admin schema digest (complete original-options JS emit byte-exact); transport's
string auth argument and explicit anonymous/unknown-ProtocolFailure mapping,
retaining real Main local owner/worker/cleanup/failure/terminal implementations,
policy callers and already-present unused generic fix. The no-longer-read private
descriptor type binding is removed, while value imports/exports remain. All44
nonselected transport and12 storage function/class declarations are byte-exact.

Main MTA already contains the actual completion/forwarding hunk plus stronger
reservation, authority epoch/seal and reentry/supersession safeguards; no source
change is made there. Full old History files would remove those real Main owners
and are not imported. Public API/ABI, actual template refs, enums/config/frozen
authority, protected authoring/SDK/Writer/upload/cohort/end/settlement and actual
UI957 alias remain original. Every runtime/tests/import/discovery/qualification
HOLD/UNRUN and physical alias independent UNVERIFIED remains. Author static
checks and source-local compatibility do not certify whole-tree or runtime state.


## Reviewed Non-Authoring Business Template Batch A

Parent explicitly permits the original independently accepted non-authoring
business template fixes from History4261; the temporary prior grouping exclusion
is not a validation hold. Five exact full-preimage original patches are consumed:
moderation queue copies only readonly array containers and uses canonical id keys
while retaining original row objects/events/authorization; public comment island
uses actual node/childrenPreview/string IDs/server pagination with genuine preview
array memo; audit uses original Date-pair clear/invalid payload boundary, real
string IDs and actual public TableV2 types/constants; settings maps nullable
copyright clear without a fabricated year; cluster uses actual task-status labels
rather than node-status labels. Postimages exactly equal original reviewed source.

This changes only those actual business bindings, not compiler/template codegen.
No used ref is removed, no void fake reference/type assertion or fake row/thread
is added. Actual source prerequisites were checked against Main canonical API
contracts/bridge and actual UI957 source. Original18 held UI template/codegen
diagnostics,7 enum diagnostics and Blog Analytics regionChartRef remain unchanged;
protected authoring/Writer/SDK/upload/FIFO/cohort/end/settlement and alias/config/
frozenDTO/schema/authority remain original. All runtime/tests/render/import/
discovery/browser/security/privacy/receipt/race/backuprestore/IME/qualification
HOLD/UNRUN and physical alias independent UNVERIFIED remain. Author compiler and
source compatibility evidence are not rendered/business/runtime qualification.


## Reviewed Non-Authoring Business Template Batch B

The second business source batch consumes the exact accepted History4261
ModerationRegions, SecuritySimulator, PluginAdmin and page-private
pluginConfigEnum source postimages on the preceding five-path business batch.
The ordinary WIP records each complete original preimage and postimage.

ModerationRegions passes only canonical product keys through the generic public
DataList and resolves business fields from the existing original region objects.
Unknown rows and mismatched keys fail instead of acquiring a fabricated region.
SecuritySimulator preserves the real API's nullable inputs; clear events retain
absence, invalid choices are refused, and cleared subject/action/identity cannot
silently acquire backend defaults. Original backend and bridge owners remain.

PluginAdmin renders canonical decoded JSON enum choices, including null and
nested arrays/objects, using fieldset/radio semantics. DOM choice symbols never
replace canonical values. The private helper validates finite JSON and compares
object keys without imposing order while preserving array order. The actual
original plugin save, MFA and version functions remain unchanged. The decoder's
existing type overprecision remains outside this source batch.

The parent authorized these business template bindings only. Shared FsusUI
template/codegen mechanisms, the original eighteen template diagnostics and
seven enum diagnostics, Blog Analytics regionChartRef, all protected authoring
owners and frozen contracts remain unchanged. Full-program static checking is
not rendering or keyboard acceptance. All runtime, render, tests and security,
privacy, receipt, native, race, backup/restore and IME qualification holds remain.


## Plugin Enum Selection Unknown Receiver Boundary

A separate successor to the exact business B checkpoint changes only the local
PluginAdmin selection receiver to `unknown`. The existing draft record's `any`
field propagates through Vue's actual generic `toRaw` return; explicitly holding
that result as unknown prevents its propagation. The original own-property
guard, identity lookup and page-private finite JSON comparison/validation stay
unchanged. All existing values, including null, false, zero, empty strings and
nested arrays/objects, follow the same selection and schema refusal behavior.
There is no replacement validator, cast, new default or runtime branch.

The original full application compiler options produce byte-identical complete
SFC script JavaScript; template/style contents and attributes and the original
JSON helper are unchanged. This is static source equivalence, not behavior or
rendering qualification. The exact donor checkpoint and its newly introduced
unsafe-assignment failure remain preserved in the preceding ordinary WIP. All
protected owners, frozen contracts and original execution qualifications remain
held. Residual original plugin lint findings remain separately disclosed.


## Audit Picker Payload P2 Successor

The original business A Date-only AuditLog boundary rejects the actual public
picker's legitimate manual-edit Dayjs pair. Its earlier Date-path source
acceptance was too broad and is corrected; the same original History postimage
shares the defect. The Audit portion of business A and its dependent consumer
checkpoints remain conditionally held pending independent source review of the
separate successor. Original checkpoints and failure records remain preserved.

UI957 manual start/end edits pass valid Dayjs values to emitInput. Without
value-format, its formatter returns those values unchanged and the public
date-picker forwards them. The consumer now accepts finite native Date values
and valid Dayjs values through the existing library predicate, validation and
toDate conversion. Both endpoints normalize before the original atomic pair
assignment; clear stays null and invalid values retain the rejection boundary.
No string or number is parsed, no date or default range is invented, and no
shared producer/type declaration is changed. Canonical audit IDs, permission
actions, request payloads and pagination owners remain unchanged. This is a
source repair candidate; actual manual editing/rendering remains UNRUN and every
existing execution qualification hold remains.


## Original App And Bootstrap Source Boundary Intake

A separate source group takes only the actual strict-bootstrap donor boundaries:
the existing router current-route Ref, finite timestamp type narrowing, genuine
awaited activation completion, fulfilled route/core settled values, non-null
config binding inside the valid branch and actual script element verification.
The Main ConfigProducer binding, release and application lifecycle remain.

The donor's wider optional warm-source API removal is excluded because current
callers and frozen cases still pass the argument. The original optional string
signature is retained as an overload while the single real implementation uses
the donor's no-argument header and unchanged body. No resource work depended on
the removed unused literal default. This neither creates a source acknowledgment
nor rewrites callers/tests. Original failure
selection, timing, activation generation and terminal owners remain unchanged.
The ordinary WIP records full current/donor source identities and exact selected
hunks. These source corrections do not qualify runtime or release. All original
execution holds and upload/frozen/shared UI gaps remain.


## Original Snapshot Constructor Field Source Group

A separate source group replaces fourteen constructor parameter properties with
their original explicit readonly fields and original assignments across the
existing Graph, panel binding, cache, IndexedDB and reset owners. All original
parameter defaults, object identities, field initialization order and assignment
order remain. The complete JavaScript emitted with original full application
compiler options is byte identical for each of the four source files.

The real Graph donor supplies the same constructor values and assignments, but
its field declarations appear after existing initialized fields. The consumer
keeps those fields at the original compiler-emitted position to preserve property
order and exact emitted bytes. Panel/cache/status use their existing constructors
and owners, not new snapshot or reset implementations. No method, subscription,
CAS, digest, admission, cleanup or restore-completion semantics change. All
original runtime and frozen-contract qualifications remain held.


## Original Timer Handle Type Boundary

A separate source group corrects only the existing timer holder types under the
actual local full application's browser and Node ambient declarations. Writer
draft/retry, page debounce and router progress keep their exact window timer
producers and use the genuine browser number handle. Their null/undefined states
and all existing delay, callback, clear and settlement paths remain unchanged.

The browser task scheduler retains its original globalThis timer producer. Its
existing set/clear ports and original local holder carry the actual global return
handle together with original numeric browser/injected handles. The original
zero initializer is unchanged. This explicit typing boundary creates no timer,
resource acknowledgment, readiness or cancellation success. All four complete
original-options JavaScript emissions are byte identical. Actual original source
callers are checked by the full compiler; test/render/runtime qualifications
remain held, and the optional environment handle typing is reviewed explicitly.


## Exact Final Business Source Composition Candidate

The composition candidate starts from the accepted App/bootstrap, original
constructor-field and timer-type source chain. It consumes only the exact
original business source patches for the user table, canonical motion names,
PoSpace imported annotations, declared comment event and absent moderation date
presentation. Each sequential complete preimage and postimage is verified.
The original Audit Dayjs repair is already identical and is not rewritten.

At intake, the user-table successor had limited source acceptance and later
business source review remained pending. That intake observation is preserved in
the ordinary WIP. The parent subsequently independently accepted the complete
fixed business source head with no new P1/P2. A read-only bounded combination
review found no new P1/P2; the parent later independently accepted the exact
fixed combination as limited SOURCE. This unchanged production grants no runtime
or ready qualification; the ordinary user handoff preserves all remaining
compiler, producer and verification blockers. The
ordinary WIP preserves both source heads and original commit/path identities.
No donor roots, tests, documents, configuration or skip-ci directives are imported.
All existing public editor/host/router, document, ConfigProducer, snapshot/reset,
timer and actual native producer lifecycle owners remain the accepted Main
source. Upload/frozen projection gaps and all runtime, rendering, tests and
qualification holds remain; physical alias independent verification is unchanged.


## Original Bootstrap Style Residual Source Batch

A separate successor consumes the remaining two actual strict-bootstrap donor
source hunks. Recoverability still returns the same boolean for Error messages,
non-nullish native String inputs and absent causes; no rejection reason changes.
The sidecar reader retains native string marker precedence, including whitespace
and empty/absent marker fallback, and the same trim/URL and script validation.
Both complete source files now match the original owning donor postimages.

The ordinary WIP preserves the earlier style failures, current full-program
diagnostics and bounded source comparison. Two-file style PASS does not qualify
whole-project style, recovery behavior, runtime or resource readiness. All
original execution, frozen authority and independent physical alias holds remain.

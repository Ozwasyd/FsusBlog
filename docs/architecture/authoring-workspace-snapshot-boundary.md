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

## Snapshot ratio conversion source

The independent snapshot consumer imports the actual sole ratio owner from
`a4212c5739c74381a3b9ecbe2942c6d0bbf9277b` without modifying its source.
This replaces the earlier `c1141feb` dependency; the runtime-private issuer
correction is statically reviewed, while all 21 declared controls remain UNRUN.
`projectAuthoringWorkspaceSnapshotRatio(scope, ratioRef)` resolves the exact
current ref and returns only its requested `splitRatioPermille`. Missing,
foreign, staged or disposed refs never fall back to current/default or an
effective geometry clamp. No opaque scope/ref/change is serialized to the server.

`prepareAuthoringWorkspaceSnapshotRatio(plan, scope, expectedRatioRef)` requires
the original prepared server-plan provenance before delegating the scalar to
the real owner's `prepare`. It returns that owner's change directly: no new
ratio owner/ref, wrapper receipt or local/cache restore authority is created.
Workspace lifecycle still owns opening and releasing the genuine ratio scope.

The original group transaction must consume the real `readPrepared` result:
`expectedRatioRef`, `ratioRef`, `revision` and `splitRatioPermille`. It must stage
all fallible group/registry publication, then jointly publish synchronously
without callbacks/await, or discard the proposed ratio on cancellation/refusal.
This ratio conversion module does not call `commit`, `discard`, `applyGroups` or any runtime
factory and does not claim cross-owner atomicity or readiness. The original
#2298 joint-publication contract remains a dependency to be supplied through
root. At exact original head `4b19fca33b145a0c8af4b93a8ee20a1029be2721`,
the replay-before-count repair is reported statically closed, but
`authoringTabGroupRegistry.ts` still declares `AuthoringSplitRatioRef = string`,
validates ratio refs with `isRef`, and clones command/projection state through
`structuredClone`. These paths cannot preserve or verify the real opaque ratio
capability. No string encoding, copied handle or substitute group owner is
admitted. The original owner's proposed opaque integration is not published
at that head and is not consumed here.

The real group bootstrap must explicitly accept the restored one/two group IDs:
the official router opens restored tabs into those saved owners before
`applyGroups`. The common transaction's exact article Registry +1 transition
must also be bound to a genuine verified group receipt before the snapshot
restore advances its revision guard. The present digest-only `applyGroups`
port does not provide that binding; reading the latest Registry revision or
trusting a ratio-only commit cannot substitute for it. Existing
transport/factory/restore source is unchanged. All held behavioral/receipt/
restore/DB/race/native qualification and the upstream declared controls remain
UNRUN; static compilation is source-only.

## Snapshot group receipt source composition

The subsequent source composition consumes exact original group offer
`418611fa6bedf623823b33c415b491215b746c7d`, including the original
`68e4cdd4` R5/R6/R7/R8 source repairs, instance `verifyBinding`, and typed receipt interface
first supplied by `f44c8196` and the unchanged corrected
ratio issuer from `a4212c57`. It supersedes the missing opaque interface described
at the earlier `4b19fca33` checkpoint above. The real group owner now supplies
explicit one/two-group bootstrap, `createSnapshotAdapter`,
`applyGroupsWithReceipt`, and `verifyCommittedTransition` against its own private
committed cache. No original group, Registry, ratio or integration source is
modified by this consumer.

Snapshot restore retains the compatible digest callback field but never uses
it to authorize group restoration. After the existing server provenance,
operation guard, empty-workspace and refreshed permission/lifecycle checks,
absence of the concrete original group owner or typed receipt callback blocks
before any session creation. The typed callback returns the original command
and genuine receipt; serializable receipt coordinates are copied once without
copying any opaque handle. Restore binds the real owner's committed-cache
verification and independent result verifier to Registry snapshots captured
immediately before and after the call. It also checks the exact group revision,
ordered requested groups/tabs/active refs, requested ratio, current owner result,
and precisely one article Registry revision increment. Only that verified +1
advances the local guard; a latest-revision read, replay, digest-only result or
ratio-only commit cannot authorize it. Server provenance, operation epoch and
abort guards remain active throughout the asynchronous boundary.

The callback receives a copied, recursively frozen group request, including
ordered tab arrays and active refs. Digest verification and subsequent
activation both consume this same request; callback code cannot substitute an
activation target after the receipt has been verified. No callback-owned
mutable group projection is read again for activation.

This is source wiring, not restore readiness or a runtime receipt witness.
Original group R5/R6/R7/R8 repairs are independently statically closed for this
exact dependency; behavioral qualification remains UNRUN. Independent review
of snapshot `2d6c15d5` closed the old +1 guard P1 and found two consumer P2s:
callback request mutation (addressed by the frozen copy above) and Registry
instance binding (addressed in source by the original `418611fa` capability).
Independent review of `fefa4f618` statically closed those consumer paths;
runtime remains UNRUN. `instanceof`, identical snapshots and a genuine
foreign owner's cached receipt do not prove that the owner belongs to the
router's Registry instance. Restore captures the actual router and Registry
before caller callbacks and uses that instance for all entry/state
reads. The authority guard rejects router/Registry replacement and invokes
the actual owner's `verifyBinding` against that captured instance before any
restore mutation and after callbacks, including the typed group transition.
This original method compares private object identity and the canonical unique
owner registration, returning false for a foreign instance; no string, digest,
getter reconstruction or local owner map substitutes for it. The earlier
missing-API checkpoint at `68e4cdd4` is superseded without introducing the
proposed duplicate `isBoundToArticleRegistry` method. The
concrete runtime capability gate is retained;
shell commands/receipts and production bootstrap still require original-owner
integration and qualification. All 21 ratio controls, original group/ownership
controls, the added digest-only/foreign-owner refusal source controls and all held runtime,
restore, DB, race, security/privacy and native execution remain UNRUN. The old
57-case results and earlier 256-diagnostic comparison apply only to their old
candidates and are not inherited by this composition.

### Ratio lifetime at every restore boundary

The subsequent consumer correction distinguishes instance binding from ratio
lifetime. It pins the original owner's live scope/ref and Registry predecessor
before `assertRuntimeCapability`. Every ordinary boundary resolves the same
real owner projection and checks the same expected opaque ref; missing/disposed
scopes or a separately published ref fail closed, even if the numeric ratio is
unchanged. There is no current-ref fallback or silently adopted replacement.
The final shell boundary and the final return guard repeat this check.

| Caller boundary | Check after return / before further restore work |
| --- | --- |
| `assertRuntimeCapability` | Server/epoch/abort, fixed Registry binding, pinned live ratio/ref and Registry predecessor |
| `isCurrent` in each guard | Recheck server provenance/abort, binding and real owner ratio resolution after the callback; exact expected ref at ordinary boundaries |
| Refreshed `resolveBatch` await | Same ordinary guard before session creation |
| Each `openOrActivate` await | Same live ref, verified session result, exact expected Registry +1 |
| `applyGroupsWithReceipt` await | Real live scope, unchanged Registry instance, committed cache/original command/request and before/after +1 proof; only this proven transition may advance the expected ratio ref |
| `activateTab` await | Same newly bound live ref and exact expected Registry +1 |
| `applyShell` await | Same live ref and Registry revision, regardless of the returned digest |
| Final return | Same ordinary guard after building the immutable result |

The typed group transition's live projection is validated against its actual
committed receipt state before the ref is rebound. Reading a newer projection
does not by itself authorize adopting its ref. The two shell refusal source
controls use genuine empty-workspace group commits, then revoke the actual
scope or publish another genuine same-value ref. Their shell digest is
untrusted refusal input, not a qualified runtime receipt. They explicitly do
not fabricate rollback of already committed state. Both controls and all 21
ratio controls remain UNRUN; the lifetime correction requires independent
static review and actual admitted qualification.

### Original-chain bootstrap source and remaining host ports

Independent review statically closed the lifetime correction at exact
`14d34f2e0aec3577af9665e6901d9fb2fedc5e32`, with no new P1/P2 in that reviewed
scope. This does not qualify later bootstrap source or actual restoration.

`authoringWorkspaceSnapshotBootstrap.ts` connects the existing sync/restore
chain without another read pipeline or authority store.
`prepareAuthoringWorkspaceSnapshotBootstrap` consumes only
`sync.getServerObservation()`, rejects absent/offline/cache-only observations
and dirty/resetting startup state, and delegates to the original immutable
server-plan preparation. It rechecks exact observation identity and the
original plan's provenance after the permission/lifecycle await.
`bindAuthoringWorkspaceSnapshotBootstrapGroups` takes an already constructed
original Group owner, verifies its exact router Registry binding and live
projection, requires an empty workspace with the explicit reconciled one/two
group IDs in order, and returns that owner's actual snapshot adapter. It does
not create groups, ratio scopes, sessions, operation identities, shell state,
receipts or success digests. The original caller still supplies its real
operation identity source and runtime/epoch guard.

Read-only upstream source checkpoints:

- Session receiver `cb154e1001f4d45977e1529b6c72cc59d0d02049` supplies
  `ArticleWorkspaceMountedEditorSource` and
  `createArticleWorkspaceMountedEditorResolver` in
  `articleWorkspaceMountedEditorResolver.ts`, and the sole
  `installArticleWorkspaceEditorSessions` in
  `articleWorkspaceEditorSessionComposition.ts`. Writer must supply actual
  retained `readMountedEditor` / `readDocumentBinding`; no mount map is invented
  here. `fsusUiEditorSessionFactory.ts` still throws at full capture and returns
  blocked at full restoration for absent panel/renderer-restoration/draft/
  crash-journal owners. Same-mounted renderer support is not full hydration.
- Actual UI source `8afe8523b35f296a0131951b55b7e466a7a0f486` supplies public
  `inspectDocumentState` from the original editor owner. It is read, not promoted
  to factory readiness or used as replacement for the pinned static UI baseline.
- Layout source `722b29f401226f5abf31ce6a541d37d27759bf74` supplies
  `createAuthoringWorkspaceGroupLayoutPorts` in
  `authoringWorkspaceGroupLayoutPorts.ts` using the actual Group/ratio. Its
  `AdminWorkspaceFrame.vue` still has route/tab-strip composition without the
  session installer or snapshot startup call. Those application-owned files
  are not changed by this snapshot receiver.

The minimum real shell dependency belongs to original host/Writer/layout:

1. A live view owner bound to the exact workspace Registry/ratio scope and
   active session, with bounded shell revision and readable current
   `libraryOpen/libraryView/outlineOpen/inspectorOpen/inspectorView` state.
2. A cancellable official shell command accepting the prepared plan's
   scope/source/server revision/operation epoch plus the owner's expected
   revision, returning the original command and its genuine committed shell
   transition. It changes only product view/open state, without restoring
   article selection/scroll/history or writing legacy preferences.
3. Actual owner instance/cache verification and independent before/after
   verification, followed by a live-owner check across loaders/render awaits.
   A returned 64-character digest or `nextTick` alone is insufficient.

These are required capabilities for the host owner to publish, not an invented
implemented shell schema/API. Current `useArticleWriteInspector.ts` exposes
local view refs plus `open/switchTo/close` with asynchronous loaders/scroll/focus
effects, and `ArticleWriteInspectorShell.vue` exposes props/events. Neither
provides this typed committed transition or view-owner revision/custody.
`AccountRouteFrame.vue` has navigation sidebar composition, not an authoring
library state owner. No direct ref/store/DOM hydration or success wrapper is
added. The original backend also still must bind the production
`AuthoringWorkspaceSnapshotResolutionPort.resolveBatch` to one current
permission/lifecycle/draft query; no per-article body fetch substitutes for it.

Production startup additionally requires the original authenticated user/site
and current server source/build binding for the existing HTTP API factory,
actual retained Writer mounts, the complete session factory and shell command
owner. The new helpers are callable source composition, not an installed
application bootstrap, restore-ready claim or a receipt witness. Their source
controls and all runtime/list/native/receipt qualification remain UNRUN.

## Authenticated HTTP connection source

`connectAuthoringWorkspaceSnapshotHttp(signal)` is a callable original HTTP
consumer, not an installed startup or runtime admission. It obtains the real
independent admin principal from `getAdminMe`, requires an active non-step-up
session with `article.write`, and binds its safe integer ID to the snapshot
endpoint's returned `scope.userId`. That wire field denotes the independent
admin principal here, never the account-user store. The site ID and SourceDigest
come from the actual authenticated snapshot GET; the frontend supplies neither
a hard-coded site nor a Git/fixture/local digest. The original Server derives
that digest from its stamped Server/Shared artifacts.

One initial GET discovers coordinates without minting an observation. A second
real GET must pass the unchanged complete `AuthoringWorkspaceSnapshotApi`
verifier with that same scope/source binding and a current/missing result. Drift,
blocked state, abort and auth changes refuse the connection. This sequence writes
no snapshot or cache, resets nothing and never adopts the first payload as a
cached authority. The existing Sync must obtain its own current API observation.

The connection retains one original admin request lease and a synchronous watch
of the original private-surface auth generation. Auth invalidation or `dispose`
revokes API observations, aborts connection work and releases the lease/watch.
Each later original transport operation checks that lifetime before and after
the await and combines its caller signal. The sole host must propagate its abort,
call `assertCurrent` in its existing epoch guard, dispose on replacement/unmount,
and construct/start the existing Sync once. No host SFC, second store, session
installer or full-factory/shell admission is supplied by this connector.

The typed HTTP source still directly consumes the original named Snapshot
request/response frames. Rail #4227 at `f906f5e42f5f7e779ba6d8651a5b1dfef0965efa`
uses a current canonical 244-frame source missing both names. Its five HTTP
unsafe-assignment/argument findings are consequences of those missing members,
not corrected by source-only import formatting. The original Shared owner must
join both feature families and produce the real enum/decoder/endpoint closure;
no numeric/string lookup fallback, generated edit, generator, golden-order
allocation or frozen SOURCE refresh is performed here.

`resolveBatch` remains missing its real producer. It needs one bounded current
permission/lifecycle/draft batch bound to scope, artifact SourceDigest and
snapshot revision/digest, with exactly one fact per requested tab. Admitted
facts require actual current identity, document epoch, source/draft revision and
permission reference; missing/deleted/archived/denied/replaced facts carry only
closed reasons. Existing query/pin/Canvas metadata or permission batches do not
publish that complete contract or the original document/session bindings. The
integration and document/draft owners must supply it; no per-article body fetch,
saved permission, invented endpoint/wire contract or local resolution list is
implemented. All auth/security/test/list/runtime/native/receipt qualifications
remain HOLD/UNRUN.

## Snapshot API issuance custody correction source

The authenticated connection source at `6efe4eddda4fed46e270d3938a01cd30ba4d0922`
received independent bounded source review with no new connector P1/P2, but
inherited an API P2: TypeScript-private transport/lifecycle/verify fields could
be replaced at runtime, allowing a retained genuine response to be reissued
after connection disposal. That finding is not a fake-digest or cache case and
is not closed by freezing only the connection's outer object.

The API now keeps fixed constructor-captured transport functions, scope/source,
clock, connection guard, lifecycle/ticket counters, validation and issuance in
native ECMAScript private slots/methods. Its instance and public prototype are
frozen, and subclass construction is refused; reflective old names cannot
replace those bindings. The real connector passes its original lifetime guard
into that custody and calls `close()` on disposal. Close permanently latches
the instance; later invalidation or a guard ABA cannot reopen it. Ordinary
`invalidateObservations()` retains the original authenticated reconnect use.

Read/write/reset check the fixed lifetime and operation ticket before/after
transport invocation, await settlement and exceptions. Caller layout validation
and cloning are fenced, and the owned proposal is revalidated before dispatch.
Receipt validation, clock callbacks and cloning are also fenced; the owned
receipt is validated again and a final live check precedes the synchronous
original provenance publication. A competing reentrant operation cannot silently
adopt another ticket. Confirmation generation has the same live boundaries;
close/invalidation perform only internal revocation.

The single original process-local provenance registry becomes a WeakMap of
observation to its fixed live check, rather than an unchecked WeakSet. Requiring
an observation verifies that original instance/lifetime and unchanged registry
membership. New issuance and every later consumer lookup therefore require
live custody; no serialized receipt, saved valid response, reset or second store
reconstructs it. A late rejected write may already have committed at the server;
this correction fabricates neither rollback nor whole-workspace success.

Pending ordinary source counterexamples cover captured-port/reflection attempts,
retained response/dispose/ABA, all three pending transport entries, clock/cloning
and exception reentry, guard failure and a newer read ticket. The existing reset
interleaving fixture delays inside its original method instead of replacing that
method after binding; its CAS and assertion sequence is preserved. These bodies
are only static source declarations: no attack, candidate import, tests/list or
auth/security/runtime/native/receipt qualification runs. Independent correction
review, canonical frame join, real batch/host/session/shell and full restore
acceptance remain WIP.

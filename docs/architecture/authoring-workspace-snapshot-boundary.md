# Authoring workspace snapshot source handoff

This source capability implements #2302–#2305 domain code under #1856. It is not
terminal #2306 acceptance. The integration owner retains shared wire/DI/endpoint/
migration registration, article/session/router/group owners and the live shell.

## Provisional source navigation observation

The Write host can borrow the original public source view through
`ArticleWriteEditor → MarkdownEditorAdapter → MarkdownTextEditor`, using FsusUI
source `b915bf6d79635d2226f98b1f3b671c558916c94a` (#1073). The wrapper keeps the
exact issued object and binds its product surface/tool to the original wrapper
generation. It adds no native measurements, capture defaults or admission authority.

The host's bounded `capture` uses the original retained Document/Anchor/session
association and checks one issued spatial observation around selection and original
Anchor capture. Its bounded `reveal` uses the original owned factory/public native
completion, rechecks lifetime/admission after await, then obtains and fences a fresh
spatial observation. Deliberate selection/scroll changes do not preserve old tokens.
Trusted native source gestures reach the original Anchor manual policy; programmatic
scroll does not imply manual intent, and timer expiry does not resume it. Resume is
an explicit call to the same original Anchor policy.

This remains a provisional source integration. General navigation `current/wait`
still refuse: the frozen original navigation factory lacks a scoped capture and
post-reveal observation boundary, and its private issued-object custody cannot be
replaced with a proxy. These bounded host operations install no router, History
executor or full snapshot owner. Source-reader, package, original-lock, full Write
auth/backend, native/IME and independent UX qualification remain separate holds.

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

## Workspace ratio source boundary

The sole `authoringWorkspaceRatioOwner` in
`src/frontend/src/services/authoring/authoringWorkspaceRatioOwner.ts` issues
process-local workspace scopes, ratio refs and staged changes. Its closed
200–800 permille bounds and default 500 match the existing Shared snapshot
validator/default. Scope and ref authority use exact object identity and private
WeakMap membership; copying symbol properties, serializing a ref or inventing a
string cannot reconstruct that authority. State lookup and ref issuance use
ECMAScript `#requireScope`/`#issue` methods, not erased TypeScript `private`
methods; callers cannot reflectively obtain the mutable internal ratio state.
The earlier `c1141feb` source offer had this runtime-private boundary defect and
must not be accepted as a closed issuer. The correction adds ordinary reflection/
observation/staged-CAS source controls; they remain UNRUN until root approves
the exact ordinary CLI. Revision CAS cannot accept an old ref
after a ratio changes back to the same number. Disposing the workspace scope
revokes its current and pending refs. Collapse/re-expand must keep that same
scope/ref; there is no browser/server storage or across-restart persistence in
this owner. Existing signed snapshot storage is a separate authority and is not
changed by this source offer.

`read(scope)` observes the owner's current ref for bootstrap. Projection
consumers use `resolve(scope, projection.ratioRef)` with a required exact ref;
missing, cloned, foreign, revoked or staged refs fail closed. There is no optional
projection ref that silently falls back to the owner's current value. Opaque
handles must not be serialized as receipt coordinates; the group receipt binds
the validated ratio policy/revision/value and original workspace coordinates
while runtime admission separately checks the exact process-local handles.

The original snapshot `applyGroups(..., splitRatioPermille, ...)` integration
must stage the validated number with `prepare(scope, expectedRatioRef, value)`
and pass the returned opaque `ratioRef` to the real group transaction. The
group owner validates that proposal with `readPrepared(scope, change)` while
both owners' current state remains unchanged; its observation includes the
exact expected ref, staged ref, next revision and validated value. The
staged ref is not readable as current until synchronous exact-ref CAS `commit`
succeeds. Refusal/cancellation calls `discard`; neither action creates groups,
moves tabs, focuses an editor or changes a session. All fallible group preparation
must finish before a callback-free synchronous joint publication. This source
does not supply that cross-owner transaction or a fabricated group receipt.

The group owner must supply its exact versioned projection/export path and
source SHA: registry revision/content digest, at most two ordered exact group
IDs, focused group and bounded focus history, active tab refs, real tab/session/
document-epoch/restore refs, and this owner's opaque ratio scope/ref. An admitted
effective-state CAS must change only the viewport projection and preserve group,
tab, focus-history and session identities. The earlier single-target article
ownership port is not this group interface. Snapshot/group/layout consumption
is blocked until that complete original source and the real host retention
capability are available. No runtime/browser, race, tamper, security/privacy,
IME or native qualification follows from source parsing or TypeScript checks.

`authoringWorkspaceGeometryPolicy.ts` is an independent pure plan calculator,
not a rendered layout owner or a registry projection. It accepts measured frame
and visual viewport rectangles, current CSS viewport/zoom metadata, disjoint
Rail/inspector/page chrome, safe-area/scrollbar and each group's editor-chrome
footprints. All coordinates use the same current CSS-pixel space; actual browser
zoom changes those measurements, so the policy does not divide them again.
It intersects the unobscured visible rectangle and rejects invalid, zero-area,
offscreen or unusably narrow observations. Group chrome is deducted before
testing usable editing width, rather than calling an outer box usable content.

The source offer chooses minimum usable widths of 384 CSS px per group in
two-group mode and 128 CSS px for the focused single group. These are reviewable product engineering choices based on the active FsusUI
public `space.4` step (24 and 8 multiples), not previously specified editor
contracts or new FsusUI tokens. Separator width is a required actual CSS-pixel
measurement, separate from workspace scrollbars and editor chrome. UI921's public
handle reserves `--fsus-icon-target`, whose default is 40 CSS px; this supersedes
the earlier proposed 16 CSS px footprint. The calculator exposes 40 as a default
token coordinate, not a substitute for current measured extent. It rejects
nonfinite/nonpositive footprint and subtracts the real value exactly once. The canonical 1024 CSS px task tier gates two
groups. Mobile, soft keyboard, narrow viewport and insufficient two-group space
plan a focused single group; width below the single minimum is blocked. No font
shrink, width animation, tab move, article switch or session reconstruction is
performed. Effective ratio clamps round inward against both minima while
preserving the owner's requested ratio/ref for later expansion.

The exported required matrix includes 375/768/1024/1366/1440 viewports,
100/150/200% browser zoom, Rail/inspector combinations, soft keyboard and
appearance/input states. It records coverage requirements, not observations.
`tools/frontend/check-authoring-workspace-layout-source.mjs` parses the five
delivered product modules without importing them. Its AST guard checks their
closed layout vocabulary, absence of DOM/storage/editor/group-model dependencies,
sole private ratio owner and exact-ref CAS source, and canonical snapshot bounds.
The adapter guard also rejects standalone ratio commit/lifecycle calls and
asynchronous publication. It explicitly does not cover the not-yet-wired SFC,
actual retention, separator runtime, receipt/verifier or geometry/tamper qualification.

`tests/frontend/unit/authoring/authoringWorkspaceLayoutPolicy.test.ts` declares
ratio/CAS/proposal controls and synthetic geometry/zoom controls. They remain
UNRUN pending root's exact ordinary CLI approval. The original Vitest setup
creates DOM/Wasm mocks and dynamically activates the real locale runtime/font
graph; listing tests is not treated as harmless module inspection. The proposed
ordinary command, after dependency and hook preflight, is:

```sh
cd src/frontend
node_modules/.bin/vitest run ../../tests/frontend/unit/authoring/authoringWorkspaceLayoutPolicy.test.ts --maxWorkers=1
```

This command has not been executed. All actual browser geometry, hidden editor
identity/restore, pointer/keyboard/screen reader, forced colors/reduced motion,
receipt tamper/race/security/privacy/IME/native qualification remains UNRUN.


### Controlled public separator source adapter

`src/frontend/src/services/authoring/authoringWorkspaceSeparatorAdapter.ts`
consumes the documented root-exported UI921 payload/coordinate types. Its public
source is pinned to FsusUI `a775a075785b8fec580b6c44eb19a72116773ae4`, based on
`8db0ac8f49749e3e5f28be5051bb3d3ed71ada71`. It does not import a private Slider,
Scrollbar, Carousel, hook, DOM node or listener. Capture and keyboard/ARIA stay
inside ElResizeSeparator/FsusResizeSeparator. Only the public instance `cancel()`
is called through the required host port. Before changing any consumer identity,
accepted source state or measurement configuration, the host must call adapter
`invalidate()` in the same synchronous stack, which clears its interaction before
calling the public handle's `cancel()`. No UI921 author execution result is
admitted as qualification. Root reports the Escape propagation and fractional-step source fixes independently
closed at the pinned UI head, with no remaining bounded source P1/P2. Its number
contract converts Number.toString decimal coordinates to rational arithmetic and
returns Number, with finite span/scale and step/2 >= ULP admission guards; it is
not arbitrary-number infinite precision. This consumer uses integer permille
step 1. Source closure does not qualify native capture, geometry or receipts.

The factory is generic over the original group's `AuthoringTabGroupProjection`,
not a second local group shape. Required ports read that genuine projection,
extract its owner-issued ratio scope/ref, check original current projection,
supply real geometry measurements and synchronously publish a prepared ratio
through the original group transaction. The adapter never calls ratio commit,
opens/releases a scope, manufactures a command ID or owns group/session state.
A missing/refused port, single/collapsed plan or zero resize span blocks binding.

For the original `authoringTabGroupRegistry.ts` inspected at
`f44c8196a0420d4471215607b52c18416e0d4ecd`, the host binds:

- `readProjection` to `exportProjection()`; `ratioScope` and `ratioRef` to its
  `ratioScope` and `splitRatioRef` fields, preserving exact object identity;
- `isCurrentProjection` to the original owner/current source comparison: group
  and article revisions, content digest, authentic live scope/ref, physical and
  effective horizontal-two state, exact group/tab/session/focus/epoch projection;
- `measure` to the current consumer-owned frame/viewport/chrome/scrollbar/safe-area
  measurements, including the public handle's reserved CSS extent; it must not
  query private component DOM;
- `publishPreparedRatio` to the original `execute(command, change)` path with
  `set-split-ratio-ref`, original operation command/idempotency identities,
  captured group/article revisions, and `readPrepared`'s ratio revision/value.
  Return the genuine new `exportProjection()` only after applied joint publication,
  otherwise null. This source adapter is not itself the publication owner.

Accepted props use integral permille `step=1`, vertical separator orientation,
real distinct region IDs and label. Coordinates map geometry's inward-rounded
min/max through the content extent plus the handle's half-width, in viewport
clientX units. Initial/effective ratio is read from genuine owner-derived
geometry, never written back just because it was clamped. A stationary gesture
is unchanged. Effective equality of min/max leaves two-group geometry valid but
provides no resizable handle.

Start captures input source/pointer identity, exact current ref/projection and
numeric measurement coordinates. Each valid proposal rechecks all of them,
prepares through the sole ratio owner and delegates the joint transaction.
After a verified success it advances to the actual new projection/ref while
retaining the same measurements. Group/source or measurement drift cancels the
public handle. Refused staging is discarded; an unexpected changed current
ratio after a refused/failed publication reports recovery-required. End never
commits again because the public primitive samples its last proposal before end.
Cancel retains previously accepted proposals and does not roll back them. Dispose
cancels the interaction, leaving scope disposal to the actual workspace lifecycle.

This is unmounted source composition. Actual group-host wiring, retain/suspend,
responsive effective-state publication, rendered layout, native capture and all
browser/receipt/race/security/privacy/IME qualifications remain blocked/UNRUN.
Bounded static type checks may extract only the exact pinned public type aliases
into a temporary declaration envelope; this does not change dependency pins,
replace test/config entrypoints, or establish installed-source/bundle readiness.
The 21 existing ordinary controls remain UNRUN; the new adapter has no executed
behavioral or native qualification.


The separator adapter now fences synchronous invalidation with a nonserializable
operation context (captured bigint invalidation epoch plus exact interaction
identity). A lock covers binding/start/proposal/end, including observation and
measurement, not only publication. Every external read/publication port checks
that context before and after returning. Prepare and publication have additional
pre-mutation guards; binding/start/final acceptance also refuse a revoked context.
Invalidate/cancel/end advance the epoch; disposal permanently blocks admission.
The public cancel callback runs while locked, so it cannot synchronously start,
bind or propose a replacement interaction. Valid later explicit interactions
remain possible after invalidation; disposed adapters never revive. Genuine
ratio CAS, staged discard, no repeated end commit and no cancellation rollback
are preserved.

`tests/frontend/unit/authoring/authoringWorkspaceSeparatorAdapter.test.ts` adds
nine UNRUN ordinary source regression cases for callback invalidation/disposal,
all prepublication read ports, nested proposal refusal, start/binding admission,
final acceptance revocation, cancel callback reentry and staged cleanup/end/cancel
semantics. Its fixture supplies synthetic adapter ports and a ratio-only publisher;
it is neither a second production group model nor a real joint receipt/host
qualification. The original 21 controls remain UNRUN. All 30 declared cases,
including original locale/setup import effects, still require root's exact CLI
approval before any execution or listing.


### Original group ports and production-host boundary

`authoringWorkspaceGroupLayoutPorts.ts` is the concrete #2298 consumer for
`createAuthoringWorkspaceSeparatorAdapter`. It imports the original group
projection/class/command schema and article digest producer, not reconstructed
interfaces. The current consumed owning source is Group31d
`31d1bc0456152976917c7cbc7587dfedb288fbf8`. The caller supplies its actual existing
group instance, original operation identity allocator, measurements and public
separator cancel. The factory creates no registry, scope, editor, session or
additional group model.

Each guarded read returns the original `exportProjection()` with genuine live
scope/ref, and reserves a command identity in a private WeakMap keyed by that
exact exported projection. Allocation is inside the adapter's guarded read,
so reentry/invalidation is rejected by the reviewed adapter. Current checks
compare original group/article revisions and digest, live ratio identity and
coordinates, and physical/effective two-group state. The producer digest is
checked against the supplied serial state; authority is still the live ref.
Measurements derive requested layout from the original projection.

The publication callback calls no configured allocator/measurement/host callback
and uses no await. It validates the exact current projection and prepared ratio,
then invokes the original `execute(set-split-ratio-ref, preparedChange)` once.
That owning source performs the synchronous callback-free ratio/group/article
joint commit. Only an applied result with the actual exported next scope/ref and
expected revisions/value is returned to the adapter. This is concrete source
consumption, not a new atomic implementation or an acceptance receipt.

The earlier bounded static checking used the exact original source/import graph extracted without
changes, with this task's modules added. No original group interface is virtualized.
The source graph currently has five diagnostics also observed when checking only
the exact original group entry: snapshot constructor parameter properties at
75:24 and 263:24/129/167 (TS1294 under repository erasableSyntaxOnly), and original
article registry 1759:31 (TS2345 unknown spread passed to entry sealing). The new
ports file has no additional diagnostics in that check, and repository-config
ESLint passes on the exact-source graph. The whole graph remains FAIL; exact
public UI alias declarations still do not establish installed/full local readiness.

Actual production layout ownership chain is AdminWorkspaceFrame.vue ->
AccountRouteFrame.vue -> views/admin/article/Write.vue. The before-content slot
currently mounts only tabs. The current Write.vue editor is a single
ArticleWriteEditor at the write-editor-panel; MarkdownEditorAdapter exposes
insert/palette/reveal operations but no production snapshot/resource lifecycle
bridge. The #2294 `FsusUiPublicEditorSessionFactory`/capture/pause/resume/restore
interfaces exist in `authoringSessionHost.ts`, but no production createSession
implementation or exact retained-DOM admission was found. Its current budgets
permit one active renderer; visibility and retained/suspended behavior for two
groups require that owner's actual contract, not two cloned Write editors.
AccountRouteFrame keys its routed outlet by route/article ID, so a stable
session-host placement also needs coordination with the original host/router
owner. This task does not alter that lifecycle or remount policy.

The layout owner will own an independent AuthoringWorkspaceLayout component and
its geometry/separator consumer. Planned mounting touches Write.vue's editor
panel; any AccountRouteFrame/AdminWorkspaceFrame persistent-host/rail placement
must be coordinated separately before editing those files. Drawer, outline and
inspector retain their existing authorities and compact policies. Rail's readonly
currentArticleId comes from useArticleWorkspaceTabs().activeTab.articleId;
missing real query response never becomes ready state.

At Group68e4, focus-group changes focusedGroupId independently of activeGroupId,
but set-effective-single derives effectiveFocusedGroupId from activeGroupId.
When those identities differ, this cannot satisfy this layout task's focused
collapse contract. The gap is reported to root/original #2298 owner; no activation,
focus command or local overlay is used to conceal it. Host retain/suspend
admission and the corrected focus projection are required before production
mounting/collapse. All 30 existing source cases and all host/layout/browser/native/
receipt/race/security/privacy/IME qualification remain UNRUN.


### Original mounted-session provider source

The earlier production-host discovery was superseded by the actual offered
Blog4210 `cb154e1001f4d45977e1529b6c72cc59d0d02049` and UI914
`8afe8523b35f296a0131951b55b7e466a7a0f486` source. Original
`articleWorkspaceEditorSessionComposition.ts` exports the unique
`installArticleWorkspaceEditorSessions(resolveMountedEditor)` entry: the same
resolver returns the already installed host; a different resolver is rejected.
Original `articleWorkspaceMountedEditorResolver.ts` reads Writer-owned mounts and
document bindings, obtains the public getSession/inspectDocumentState owner,
and rechecks actual editor/session identity and document revision after reading.
It does not derive identity from route/component order or echo router entries.

`authoringWorkspaceSessionSource.ts` consumes that exact existing install entry
with the original stable mounted resolver and actual group instance, and forwards original host.getSession
and exportState reads. It creates no host/registry, resolver cache, editor state,
ready flag, attachment or lifecycle action. It is only source composition: no
installation or product import was executed in this task. Original Writer must
supply its genuine mount/document read callbacks; this consumer does not modify
shared .vue/session files or fabricate those callbacks.

The offered full factory still explicitly throws
public-editor-full-snapshot-owner-unavailable:panel-state,renderer-restoration,
draft,crash-journal from captureSnapshot, and restoreSnapshot returns blocked.
The composition source does not conceal those refusals. Panel/draft/journal,
resource controls and retained-DOM/restore admission remain original owner work.
Until complete admission exists, this source connection cannot make hidden
sessions or production two-group layout ready. Existing 30 cases do not execute
this provider or the genuine group connection; all runtime holds remain.

### Actual candidate dependency integration and pairing

The candidate now contains the necessary original product dependencies, instead
of relying on their presence in a temporary review overlay. These files are
copied byte-for-byte from their original owners; this task authors no changes
inside them and does not take over either registry or editor/session ownership.

| Original repository / exact source | Candidate file under src/frontend/src/services/authoring/ | SHA-256 |
| --- | --- | --- |
| FsusBlog `31d1bc0456152976917c7cbc7587dfedb288fbf8` | authoringTabGroupRegistry.ts | `0c3442c06a7be13245d66828c74cbeaa2b98b3554dc308805a29ea69c7e80870` |
| FsusBlog `31d1bc0456152976917c7cbc7587dfedb288fbf8` | openArticleDocumentRegistry.ts | `2d3a7bb9c30807f7d2877bc4221c4a4b1889af3dcbed997724e33e1ab1586fb9` |
| FsusBlog `cb154e1001f4d45977e1529b6c72cc59d0d02049` | articleWorkspaceEditorSessionComposition.ts | `83b6e9dc3018d84917ad447d5db7e6a2e35a33bd931600043eb0626ee3e6429c` |
| FsusBlog `cb154e1001f4d45977e1529b6c72cc59d0d02049` | articleWorkspaceMountedEditorResolver.ts | `b24a3d5bc1f1c71caf9f1cdfe690330e430292cac676bc7a8accc4d26a7be247` |
| FsusBlog `cb154e1001f4d45977e1529b6c72cc59d0d02049` | fsusUiEditorSessionFactory.ts | `5553fd87dbc83e4a704de7719cc82e935f32ec0281a5bedc2a754734cf3ee657` |

Before the sole session installer can modify the router port, the consumer calls
the original `groups.verifyBinding(articleWorkspaceTabRouter.getRegistry())`.
That verifies exact article-registry object identity and its unique owning group;
matching receipt coordinates/digests cannot replace it. A foreign group throws
authoring-workspace-group-session-registry-mismatch before installation. The
consumer rechecks after installation and before forwarding host reads. Group
ports also check the same exact canonical binding on construction and each
current-projection validation. No alternate installer/host/router is introduced.
The source guard checks real dependency presence/parsing and the binding check
before installation; it is not a runtime pairing qualification.

Actual-source static resolution uses the existing local FsusUI alias producer
against an isolated UI914 source checkout at
`06d6303f98c0d3f915a19cb777028b2fd9d914d4`, with the exact UI921 Vue source patch
from `8db0ac8f49749e3e5f28be5051bb3d3ed71ada71` to
`a775a075785b8fec580b6c44eb19a72116773ae4`. All 14 UI921 Vue files match the
offered head byte-for-byte. The checkout uses existing frontend dependencies for
static resolution, has no UI build/publication, and does not replace the active
product baseline. UI914 is still under independent review. No ambient SDK or
registry interfaces substitute for actual source in this check.

The actual candidate focused graph has **26 TS diagnostics**, with none in the
five owned modules. It remains FAIL: four snapshot TS1294 parameter-property
diagnostics; host TS2322 resource-policy tuple inference at 80:14 plus TS1294 at
589:9/590:9; original article registry TS2345 at 1759:31; and 18 actual FsusUI
graph diagnostics (15 TS1294, two TS7031 and one missing type-fest TS2307).
The host bytes are unchanged and also byte-identical to Blog4210. These are
reported dependency/configuration blockers, not waived checks or proof of full
application/bundle readiness. Repository-config ESLint and bounded AST checks
cover the changed consumer source only. Tests/list, product imports, installation,
mounted DOM and all browser/receipt/race/security/privacy/IME/native qualification
remain UNRUN. The existing 30 source cases do not exercise the new pairing.


### Integrated layout component and original Writer prerequisites

The current source now contains AuthoringWorkspaceLayout.vue, its concrete
controller and a readonly Vue injection key for the original composition root.
Write.vue actually wraps its existing editor panel in this component and borrows
the original mounted-source binding lifetime; it does not construct a second
editor, group, session host, installer or body/history store. With no provided
source, the existing default editor slot remains mounted and source status is
unavailable. The leading/trailing region containers and their slots are stable;
collapse never uses v-if on either editor region. Only the public separator may
be mounted/unmounted. Pointer/keyboard events delegate to the reviewed adapter.
The public cancel capability is checked on the real component ref; no SDK module
facade or private DOM selector is introduced.

One live controller can own a genuine group instance. Its private WeakMap stores
only a layout ownership token, no alternate group/article/session state. It
checks the original canonical group binding, opaque ratio identity, true host
state/entry digests and original mounted resolver/document associations. A
measured-input fingerprint fences observations; the operation lock and captured
epoch refuse reentry and invalidation. Component configuration/disposal has its
own generation fence. A source invalidation disables input synchronously and
defers rereading until the next Vue tick; before-change callbacks cannot
synchronously re-admit. Own frame/footprint DOM measurements must be positive
and contain the proposed geometry. Revocation and every blocked refresh clear
projection/geometry/separator presentation and offsets; with no render projection,
the leading default editor is visible and usable, trailing is hidden/inert, and
the public separator is unavailable. Stable region DOM does not depend on a
cached authority observation. Blocked recovery and overflow behavior still need
actual host/native qualification.

For a real geometry change, the controller stages an original operation identity,
checks live host/mount/measurement/group state, then calls only the original
set-effective-single command. The proposed viewport receipt coordinate is
viewport:<measured-input-digest>; it is a serial measurement coordinate, not a
runtime capability or a substitute for the genuine ratio ref. No callback/await
is inserted into the original group transaction. The actual next group/article
revisions, unchanged active/focused identity and exact ratio scope/ref are
checked. Host records must then actually match the new entry digests before a
planned render observation is returned. Group publication alone does not issue
a host/retention/layout receipt. Full factory capture/restore remains blocked;
this source cannot qualify hidden DOM, resource suspension or restored state.

The earlier focused-collapse finding concerned exact Group418: focus B with
active A followed by set-effective-single produced effective focus A at group
lines 633/788/853/1173 and Registry joint validation. This was distinct from R7,
which preserves canonical activation. The actual candidate now consumes the
original fix through Group31d 31d1bc0456152976917c7cbc7587dfedb288fbf8: all five
rules select focused B while active A remains unchanged. Root reports independent
source closure for this increment and its original type/lint repairs. No runtime
or full PR acceptance is borrowed. Both group/Registry files remain byte-identical
to that owner. The old focused-collapse mismatch is superseded, not a current
blocked finding.

The initial original Writer package f34b0d3ad4c7b919a5a21f228d5540610b627a0d was actually
applied to this candidate: 34 complete supplied source postimages and the adapted
Write consumer patch. Thirty-three files match original source
5b6b905a9458caec2fde8c8046c7357fa75d71f5 byte-for-byte; the supplied index patch
is the original additive preview export preserving existing owner exports.
Writer's mounted-association correction is independently source-closed per root.
The Write consumer now forwards actual native/session ports, binds the real
document owner, fences generation and exact boundEditorPort identity, clears the
mounted source on release and uses public validation callbacks/product-owned
field roots. Original Group/Registry/session modules are preserved; no broad PR
ancestor history or shared generated/wire contracts are copied. Known producer
gaps include UploadAssetPreviewViewModel, UploadAssetFactsViewModel, actual facts
frame 285/route/security/decoder/backend definitions and the genuine UI root
attachment observation/file-consumer exports. They remain blockers; no fake
exports, DTOs, JSON transport or grants are introduced.

Snapshot source 1df8314c8000130448d798e7bf5d38f50e7f1ecd is consumed verbatim
for its API/HTTP transport and Bootstrap/Cache/Restore/Status/Sync modules. Root
reports independent source closure of its explicit-field and lint changes. Its
old parameter-property diagnostics are superseded after integration; no previous
compiler or runtime result is inherited. Static resolution now uses genuine
UI914 673c342ae42967b9f505d749b3a91f5d261315e6 plus the same exact UI921 Vue
files. This new public observation source remains under review; the full Blog
factory is still partial. Original package/default baseline admission and native
qualification remain pending.

Concrete original-root handoff: provide authoringWorkspaceLayoutSourceKey with
a readonly shallow ref containing the actual source. groups and sessions must
come from the same original workspaceStarted result; mountedEditors must be the
original startup/Writer source; reserveOperationIdentity must delegate to the
original createGroupIdentity. measure must read actual frame, public reserved
separator footprint, Rail/inspector/chrome/safe-area/scrollbar/zoom and editor
chrome in the same CSS space. subscribeInvalidation must revoke synchronously
before identity/measurement changes and notify again after committed changes.
AdminWorkspaceFrame/AccountRouteFrame remain their original owner's files; the
a16b799 host scaffolding is read but not copied while its imports/startup ports
remain incomplete. Without these ports, the injection stays unavailable.

SFC script/template source compile passes for the new component and actual
patched Write; the bounded source guard does not import or mount them. Three
accessible names are supplied through all ten real locale catalogs. All 30
existing cases, tests/list, browser geometry, receipts/verifier/tamper, races,
security/privacy, IME and native qualifications remain UNRUN. Source observations
use planned/blocked, never a fabricated ready flag or accepted product receipt.

The Write view now exposes getAuthoringWorkspaceLayoutPort(), returning its
actual AuthoringWorkspaceLayout component ref or null. The component's existing
refresh/invalidate/readFrameRect/readSeparatorRect implementations satisfy the
explicit AuthoringWorkspaceLayoutPort interface. The original root can read its
own current frame/separator observations and revoke synchronously through this
public ref, without child DOM discovery or a substitute measurement callback.
The port neither stores a geometry result nor certifies readiness/retention.

The actual persistent outlet owners are Write.vue for the component host and
useAdminArticleWrite.authoringEditorRuntime for document/runtime binding.
ArticleWorkspaceMountedEditorSource reads an already mounted native editor and
document binding; createArticleWriterMountedEditorSource borrows one existing
Writer mount. AuthoringSessionHost getSession/listSessions/exportState returns
record snapshots, not Vue mounts. Its factory resolves an already mounted editor.
The original composable currently acquires one document binding and permits one
runtime bind. Those are concrete Writer producer limits, not an undiscovered
external host. Another Write acquisition must not stand in for retained sessions.

The independent review of 76850 found two new presentation defects, now corrected
in source. P1 counterexample: collapse to focused trailing B, then replace/revoke
source (including source=null). The old blocked branch carried B's projection and
geometry forward, leaving the Write default leading editor hidden/inert. Both
invalidation and blocked refresh now select one empty frozen fallback render
state, before public cancellation or other callbacks; no old widths/offsets/ref
markers remain. Both region containers stay mounted. A new authority must supply
a newly admitted planned observation before its presentation is used.

P2 counterexample: an observation listener or group slot writes group IDs, focus,
layout or arrays in projection.state after planned publication, thereby changing
the component's shared render object without any original-owner publication.
The controller now freezes the original exportProjection value state's complete
mutable graph before lending it: tab refs, tab arrays, groups/group array,
activation refs/history, focus history, split ratio coordinate and state root.
The original producer already clones state on export; its canonical storage is
not mutated. Public observation and slot consumers receive separate frozen value
copies, and the public projection type is deeply readonly. Only state is cloned;
ratioScope/splitRatioRef stay the exact opaque owner-issued objects. These views
issue no model, owner, command, CAS capability, ready flag or receipt. The geometry
and separator graphs already consist of frozen records. Both counterexamples are
source-reasoned, not executed regressions or qualification results; all 30 cases
and runtime qualifications remain UNRUN.

The owned host now includes AuthoringWorkspaceSessionOutlet.vue. Write mounts its
existing ArticleWriteEditor once under this stable slot subtree, outside group
region ownership. Public Vue Teleport places its DOM into either actual owned
region, without group-dependent keys, conditional child destruction or rebinding.
The layout's retained slot supplies frozen render projection and the actual
leading/trailing region elements. Placement reads a fresh original registry entry
through the existing native mounted-source/document owner, checks canonical
registry identity/revision and unchanged mount/tab/context, then matches real
group/tab/session/epoch/lifecycle association. Inactive tabs stay hidden/inert;
revoked/unavailable projection restores the existing primary leading fallback.
Missing or rejected native reads do not invent another association. This is a
host source increment, not executed Teleport/selection/IME/focus retention proof.
No parallel mount map, editor content/history copy, session factory, capture,
pause/resume, move/open/focus command or readiness issuer is introduced.

Writer must supply stable per-session bindings from its actual ownership, so the
same host can render a second editor and retain hidden tabs. The consumer needs
an original owner-held binding identity with its real editorSessionRef and
documentContext; direct original content/loading/saving accessors; native
transaction/selection/focus/attachment/save callbacks bound to that same owner;
one-time actual mounted editor binding returning the original runtime and mounted
source; original-custody current checks; and explicit close/evict/scope release.
The existing primary binding must be adopted, not reacquired/rebound. Listing is
the original Writer owner's retained binding list, never a layout-side session
index. Group moves/active/focused changes only alter placement and visibility;
they cannot change document/native editor/binding identity or release ownership.

Precise lifecycle blockers remain. AccountRouteFrame article-ID keys currently
destroy Write. Removing the key alone is insufficient: useAdminArticleWrite's
articleId watcher calls switchDocument, clears form state and reloads; its
unmount releases runtime/document binding and clears source. The Writer owner
must preserve retained per-session ownership and let route changes select a
binding rather than overwrite it. The Rail owner controls frame placement and
route destruction. The original Writer de6 source now offers public textarea,
labelled-by and outline panel/title ID props through the real native wrapper.
Write supplies its existing primary IDs explicitly; another wrapper still needs
IDs from its genuine separately issued binding. Parameterized IDs do not issue
that binding. The actual mount remains one primary editor; second binding and
retained route lifetime remain blocked and all runtime qualification stays UNRUN.

The independent 3cd15 outlet review found three new source defects. Their
counterexamples are source-reasoned only, never executed qualification:

- A group/registry publication advances revisions while this entry's coordinates
  stay unchanged. The old no-argument reader accepted the current stable read
  against stale rendered projection. Placement now carries the actual captured
  group and registry objects with the frozen projection. Write checks exact
  canonical instance binding, expected article/group revisions, state digest and
  opaque ratio scope/ref before and after native reads. Equal entry fields cannot
  admit a different owner or advanced publication.
- Native/Write context is newer while registry entry still has old document
  coordinates. Comparing native only to Write previously missed this. The reader
  now additionally compares entry/native article/draft/document identity and
  document epoch/source/draft revisions; Write context/mount/entry owner and
  expectation remain current across the call. Old entry/new native is refused.
- A captured target is removed, reparented or replaced during/after the reader
  callback. A nonnull node used to remain accepted, including detached leading
  fallback. Layout now verifies its actual connected region refs, owner document,
  configured region ID, parent container/frame and containment. Outlet captures
  target/root/parking/callback identities and checks them before and after calls.
  A real DOM observer revokes invalid targets and the old layout observation even
  when props retain node pointers. The same Teleport subtree parks in its own
  connected in-frame origin when no valid region remains; if the entire frame is
  disconnected, it is hidden/unavailable while its component identity is retained.

These guards issue no ownership, permission, session, native retention or geometry
receipt. The existing 57b3 frozen state and cross-authority fallback remain intact.
The second genuine Writer binding and original frame/route lifetime are still
producer blockers. All 30 controls/tests/list/browser/selection/
IME/native/race/privacy/security qualifications remain UNRUN.

The later Writer increment de6df11110b5d060a001fad36bb604627323e32a is consumed
as eight exact original postimages: ArticleWriteEditor, ArticleWriteOutlineRail,
MarkdownEditorAdapter, MarkdownTextEditor, useAdminArticleWrite,
articleEditorContinuity, articleRecoveryJournal and privateStorageRegistry.
The original journal checkpoint implementation and its private-state invalidation
are dependencies, not a second layout journal or a local repair. SourceCompare's
unrelated constructor increment is outside the supplied minimal graph and is not
copied. The public upload-image observation and optional original withAttachmentFile
loan now travel through the real wrappers. The active source SDK still lacks the
attachment observation/file-consumer exports; no declaration facade supplies them.

Write retains the actual return value from its existing authoringEditorRuntime
bindEditor call. A host watcher calls that original binding's
bindRecoveryCheckpoint(entry.editorSessionRef) only after the actual mounted
document coordinates match the canonical entry, with exact registry revision,
entry digest, mount/tab/binding and generation checks across external reads and
allocation. Public getArticleWorkspaceRecoveryCheckpoint returns that same
original checkpoint port or null and independently rechecks current native/entry
coordinates. The host releases original checkpoint custody on native replacement,
session reassociation or unmount; hiding or moving the retained subtree does not
release it. Unloaded draft/auth/native custody stays unavailable. There is no
automatic prepare/persistence on layout, document or geometry updates.

The checkpoint port's original prepare/inspect/validate/restore and reference
operations retain original journal authority. Its captureRetainedSnapshot(reference)
validates the actual native digest callback body against that same binding's
journal reference, passes actual expected document identity/epoch/revision to the
public native capture, and rechecks mounted/session/reference custody afterward.
This is native retained capture source only. No complete application factory
checkpoint, panel/renderer/draft custody, session suspend/retain readiness or
accepted journal/native/security proof is issued; the original factory refusals
remain unchanged.

Actual strict vue-tsc against the same UI673+a775 source reports 217 diagnostics,
with no added diagnostic versus the 218-diagnostic pre-join candidate and no
owned layout/Write diagnostics. Original OutlineRail removed one type finding.
Repository source AST/SFC and owned layout/static style checks pass. Verbatim
Writer dependencies retain their original style findings and missing public SDK
type findings; they are not repaired or waived here. These are static source
results, not import-side-effect or product acceptance. All tests/list and native,
geometry, browser, receipt tamper, race, privacy, security, selection and IME
qualification remain UNRUN; independent rereview of the three outlet corrections
and this host journal increment remains open.

The later parent checkpoint reports bounded independent source closure of the
placement and journal-host increments. Their code is preserved byte-for-byte in
the caller increment; that closure does not qualify runtime or the new factory.
Original Main offer 86b4f2954701792ca8b1711751fa7852131859bf supplies a minimal
Write patch anchored to e6bb1b6c803a20da0bb047c96d0e86a5715fc73a. The actual Write
consumes that exact patch and equals the complete offered postimage (SHA256
8ff92877bf5b19e7cffdf610246392ba204fa801e191fa1837acf7c164716f07).
Its composition, factory, partial retained snapshot contract and three-line
original Writer admission-parameter increment are consumed as exact original
postimages. All six original helper dependencies at55458 already match current
source; no helper, generated API or transport facade is added.

Write.getArticleWorkspaceRetainedRecoveryPort returns the original stable partial
port or null, borrowing the existing getArticleWorkspaceRecoveryCheckpoint result
and canonical registry entry with mount/tab/registry revision checks across reads.
It does not bind again, install another host or automatically prepare/restore.
Only an explicit request through that port can call prepareSnapshot(signal) or
restoreSnapshot(bundle). Those operations use the same installed original
composition/factory and genuine Writer/journal/native custody. A partial bundle
does not become a complete host snapshot or a ready/paused/disposed/evicted receipt.
The current original full factory still refuses panel-state, renderer-restoration,
draft and full-recovery-refset. Main00240 factory/validator independent review is
pending and all runtime qualifications remain held.

Original Rail a4b4aaa69773e0039ce1acdb525bb7aef3d8b330 was fetched and read only.
Its root creates the original resolver from supplied mountedEditors, calls
connectAuthoringWorkspaceSessionSource(groupOwner, resolver), and before publication
checks that installArticleWorkspaceEditorSessions(the same resolver) returns the
same host. It provides the existing shallowReadonly layout injection and borrows
the actual public Write layout ref. The new Write getter uses that exact composition
module; no alternate bootstrap or Frame edit is supplied here. Rail's explicit
partial-operation consumer/task-retirement path remains its owner's responsibility.

Current static checks use actual UI9f92c8734409cef0c1984d4f512cb7477c9a77e4 plus
the fourteen exact original a775 separator postimages in an isolated source tree.
This supplies actual attachment File/observation and native store/admission APIs;
it does not install/publish a package or admit the active baseline. Strict actual
vue-tsc reports 211 diagnostics, with zero in Write/layout and the original factory,
composition and partial snapshot modules. The comparison to the previous 217 uses
a different actual SDK dependency and is not a same-SDK regression control.
Write/factory repository ESLint, source AST/SFC and owned SCSS checks pass.
Original API/codec/route failures, inherited source findings and missing type-fest
remain visible; every tests/list/browser/native/security/privacy/race/IME/geometry
qualification remains UNRUN.

The actual Layout caller tree now consumes the original Main75 increment
75fec0866f5846339261847f88a421ed207fd31c with UI9f92 source. Parent reports its
bounded factory P1 rereview independently SOURCE CLOSED with no new P1/P2.
Capture/restore finish original reference/source/expiry callbacks before reading
the real current mounted editor, session and document coordinates. After that
final mounted read, the original journal issuer's hasReferenceCustody method
checks exact original inspected-info identity in existing private custody without
calling the source or clock. Native admission guards retain the original fresh
inspectReference before this private continuity check; neither a copied proof nor
an equal locator supplies authority. The original Writer forwards that issued
method. Existing native mutation and original readonly transaction-store custody
remain under the same owners. Write/placement/ratio code is unchanged.

The journal file combines only the original Main75 custody addition with original
e788d215448c417c214d2c3399352ea173004159's explicit flush-writer field/constructor
assignment. privateStorageRegistry retains the same owner's runtime-medium type
narrowing. Neither type correction is overwritten by an older journal postimage.
The original Main75 new journal source case is transplanted verbatim with its
original checkpointSource fixture and type import; the current test file otherwise
stays intact, without copying 814 lines of unrelated ancestor test history. This
case and fixture are source/AST only, never executed tests or custody qualification.
Complete recovery refset, second retained owner, resource/lifetime admission and
every tests/list/runtime/browser/native/security/privacy/race/IME/geometry gate
remain open and UNRUN. The partial getter does not become a complete host receipt.

Current actual static vue-tsc using the same UI9f92+a775 source reports 209
diagnostics versus the prior211: zero added, with only the two original journal /
private-storage type findings removed. Write/layout/factory/journal/private-storage
have zero diagnostics; the original Writer retains its two inherited timer-type
findings. Runtime source ESLint and existing layout AST/SFC guards pass. The new
original case parses with zero AST errors and no local hooks; its real imports
remain fake-indexeddb, vitest and the original articleRecoveryJournal. The original
Vitest config/shared setup/hooks are unchanged. Its shared beforeAll still reaches
locale/auth/private transport/font and happy-dom/WASM globals; source parsing
does not qualify import side effects. The exact targeted journal CLI is pending
parent confirmation and has not run or listed tests.

The Layout owner now supplies Write.getArticleWorkspacePrimaryMountPort(), returning
its actual AuthoringWorkspacePrimaryMountPort or null after disposal. Its
prepareMountedEditor(entry, signal) waits for the original single native editor
under the stable Teleport subtree, with actual owned connected DOM refs and original
Writer/native binding. It checks the canonical Registry instance/revision/entry
digest, original current context object and identity/epoch/revisions, mount/binding
generation and document ownership across native reads. Abort/unmount removes its
watchers/listeners and rejects; concurrent operations refuse. It acquires no editor,
copies no body/history and invokes no open/move/focus/host attachment. Physical
completion alone does not satisfy original factory resources or complete refset.

The original Root must provide authoringWorkspacePrimaryMountOnlyKey from its actual
startup phase. During that phase Write remains physically mounted/inert and its
existing route registration/status publications are suppressed. The source-only
four-file Root offer is pinned to62564bb29270a2bfc53e0ba5c24a2f30f24ecb42 and depends
on Main07ea5048bc8c01eaf3dd9b95dc22434016ae4dc5. It removes the Root's starting
RouterView destruction gate and forwards the real mount operation through the same
authenticated caller/session installer. Root/composition/session/native production
files are untouched in this Layout branch. At that Root head, the snapshot connector
has only its declaration in the entire frontend; the real startup capability producer
and actual route-outlet-to-Write operation binding remain absent. The original Writer
also lacks a consumed restored-handle/full-form/body adoption API, so nonmatching
or read-only entries explicitly refuse. A second owner is not reconstructed.

These are concrete producer gaps, not an accepted production mount chain. The exact
offer and blockers are in artifacts/article-editor/issue-2299-primary-physical-mount-source.
Owned strict ESLint/SCSS and AST/SFC checks pass; the same actual UI9f92+a775 strict
graph remains FAIL209, zero added and zero owned diagnostics. Root offer syntax and
exact patch application are static checks only. All tests/list/mount/browser/native/
auth/receipt/security/privacy/race/IME/resource/full-refset qualifications stay HOLD/
UNRUN. No factory resource refusal or startup final-publication order is weakened.

The same physical port now has a bounded Root mounted seal with pure private
has, exact-token cancellation, pre-read/pre-change revocation and permanent startup
retirement. Actual Write/Layout/outlet/ref/context/route/DOM boundaries revoke
before original external callbacks; Root must connect its private route/retained
identity/startup changes through the published port before callbacks. Source data
is not an auth boolean cache: the optional Root source must supply actual original
Membership/Document/Writer/Principal opaque reservations with private pre-mutation
revocation. Those producers are absent in this branch; default null refuses seal.
Main36's composition admission token does not fill those missing authorities.
The exact Root-only offer against bb9 uses its same sessions.retire(), with pinned
pre-revocation first. Root author product files remain unchanged here. See
artifacts/article-editor/issue-2299-root-mounted-authority-seal for the concrete
required interfaces and unimplemented producer joins. Pure has AST/source checks
are not native/DOM/auth or joint-authority qualification. All existing HOLD/UNRUN
and complete provider/full-refset/second-owner boundaries remain open.

The56961 independent review left P1/P2 open. Their source correction uses a distinct
pinned Root retireMountedAuthority capability before same original custody/session
retirement; temporary beforeMountedAuthorityChange is not permanent admission
retirement. The preparation entry now checks sealing/pending before callbacks and
assigns its pending cancellation slot before revoking producer custody, refusing
synchronous cancel/reserve reentry. Actual Root product files stay with their owner;
only the exact source offer changes here. Source AST/order checks and strict owned
lint pass; runtime/race controls are UNRUN and independent rereview remains pending.

The coordinating parent subsequently reports e581 P1/P2 and original Root8426
bounded Frame retirement separately SOURCE CLOSED. The Layout branch now consumes
the exact Root8426 Frame/source implementation and minimum genuine dependency
closure (16 original postimages), while preserving all four closed Layout files
byte-for-byte. The exact original source map is in
artifacts/article-editor/issue-2299-root-layout-source-combination. The actual
combination retains the same physical phase/installer and separately pinned
temporary/permanent retirement capabilities; it is awaiting its own independent
review. Docd354/Main292 membership/lifetime interfaces are read only; no Writer,
Doc or unaccepted Auth parallel source is copied. Missing authority/provider joins
still refuse. Actual static strict lint/SCSS/AST PASS; the same real local-alias
whole imported graph remains FAIL209, zero new/removed and zero Root/Layout findings.
All existing runtime/qualification/second-owner/full-refset/frozen holds remain.

Correction of the4431 static report:16-file TS/Vue/template parsing and component
guard passed, but the actual core guard exited1 on original session-source
AggregateError, misclassified by its Error-only constructor check. Original FAIL
output/source hashes remain preserved. The narrow later tool policy permits only
the actual unshadowed standard aggregation/catch/errors/message/cause shape; other
constructors/aliases/shadows/locations remain forbidden. Static AST controls cover
one original positive and22 negative source variants without product evaluation.
Core/component/tool lint now pass, with all16 production postimages and Layout
files unchanged. This corrects the inaccurate prior all-AST-green statement; no
runtime/qualification/frozen authority/evidence was run or refreshed.

Follow-up review of8894 accepted the exact standard aggregation but found seven
mutation-check bypasses. The preserved before-write-policy-controls-fail.json records
seven locally reproduced write syntax variants with the original23 still passing.
The bounded AST policy now follows object/array assignment targets/defaults and
module identifier aliases, checks the listed Object/Reflect write calls, and refuses
unresolved relevant keys/sources/spreads within those forms. It is not a general JS
security proof. All41 source controls and core/component/tool lint pass; original
cause, all16 production files/four Layout sources, prior FAIL records and every
runtime/qualification/frozen hold remain unchanged. Independent review is pending.

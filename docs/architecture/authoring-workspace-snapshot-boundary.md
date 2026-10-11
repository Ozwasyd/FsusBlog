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
interfaces. The current consumed owning source is Group418
`418611fa6bedf623823b33c415b491215b746c7d`. The caller supplies its actual existing
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
| FsusBlog `418611fa6bedf623823b33c415b491215b746c7d` | authoringTabGroupRegistry.ts | `3060b76ac4fae0e81f25fad30834b44debbde41e6093bc3b3d2a57d9e5dd1ced` |
| FsusBlog `418611fa6bedf623823b33c415b491215b746c7d` | openArticleDocumentRegistry.ts | `e05f8fa46686e1778cea889e0666de04fd5349b6fde37a637d0d08ea0018a41d` |
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

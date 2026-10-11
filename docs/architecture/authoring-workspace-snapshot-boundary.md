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
`tools/frontend/check-authoring-workspace-layout-source.mjs` parses the three
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
source is pinned to FsusUI `baf1334f19f938011ad0dd8c86905c91fef83979`, based on
`8db0ac8f49749e3e5f28be5051bb3d3ed71ada71`. It does not import a private Slider,
Scrollbar, Carousel, hook, DOM node or listener. Capture and keyboard/ARIA stay
inside ElResizeSeparator/FsusResizeSeparator. Only the public instance `cancel()`
is called through the required host port. Before changing any consumer identity,
accepted source state or measurement configuration, the host must call adapter
`invalidate()` in the same synchronous stack, which clears its interaction before
calling the public handle's `cancel()`. No UI921 author execution result is
admitted as qualification. At the inspected UI head, independent source review
has reported Escape propagation and fractional half-step quantization P2 fixes
pending with that owner; this adapter does not fix either in Blog. It uses
integer permille step 1 and awaits the upstream corrected source head.

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

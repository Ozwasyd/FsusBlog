# FsusBlog Architecture Overview

FsusBlog is a personal content system built around a cache-aware public read path, consistent runtime contracts, and a single-process deployment baseline. It is not a generic CRUD blog template: binary API contracts, AOT rendering, cache strategy, moderation, and anti-crawler controls are all first-class architecture concerns.

## Current Status

FsusBlog is in Public Preview. It is suitable for development, evaluation, code review, and personal self-hosting experiments. It should not be treated as stable production software. Internal APIs, deployment internals, data models, admin workflows, and performance profiles remain experimental unless a dedicated contract document explicitly classifies them otherwise.

## Repository Layout

| Area | Purpose |
| ------ | --------- |
| `src/backend/` | ASP.NET Core / Kestrel application, Binary API endpoints, Public AOT, cache, security, moderation, notification stream, admin operations |
| `src/frontend/` | Vue SPA, public hydration, admin UI, AEDS client adapters, Web Workers, Wasm integration, service worker |
| `src/shared/` | DTOs, POD contracts, AEDS metadata, shared validation rules, OpenAPI artifacts |
| `src/core/` | POD binary codecs, shared projection logic, cache key helpers, algorithm-level contracts |
| `docs/` | Public and internal architecture, API, security, operations, testing, and development documentation |
| `tests/` | Backend, frontend, contract, static governance, visual, security, and release gate tests |

The application is modular inside one repository and one default process. Multi-node work belongs to the [Distributed Runtime](../../ROADMAP.md#distributed-runtime) capability stage and has not entered the supported deployment baseline. Its invariant is the [monolithic distributed boundary](monolithic-distributed-boundary.md): every node runs the same application artifact rather than a fixed business service split.

## Runtime Baseline

The internal project baseline is:

```text
Kestrel-only
single process
PostgreSQL + Redis dependencies
no required nginx / CDN / service mesh
```

Reverse proxies, CDNs, WAFs, and deployment-layer acceleration are allowed in real deployments, but they are optional. A reverse proxy or CDN must not be counted as the internal FsusBlog performance baseline unless the benchmark explicitly says so.

## AEDS Binary Protocol

AEDS is the internal binary frame protocol used by the main runtime API. The client receives typed frames and decodes them through TypeScript and C++23/Wasm paths. This keeps hot public and admin routes on a compact binary contract and avoids maintaining old text API fallbacks for the core application surface.

Internal AEDS frame contracts are experimental unless explicitly documented as stable. See [API stability](../api/stability.md).

## Public HotRead

Public HotRead is the optimized read path for hot public content. It exists to serve common public article/list reads without forcing every request through the full dynamic application path. HotRead artifacts must preserve the same semantic contract as runtime public data while using cache-friendly representations.

## Public AOT

Public AOT pre-renders public pages so first visits can receive indexable HTML before SPA hydration. If an AOT artifact is missing, the request can fall back to the SPA shell and hydrate on the client. AOT output is a public reading optimization, not a separate content model.

## Cache Layers

FsusBlog uses layered cache behavior:

| Layer | Role |
| ------- | ------ |
| In-process cache | Fast local reuse for hot computed data and policy snapshots |
| Redis / distributed cache | Shared cache, notification backlog, rate-limit and PoW state |
| Public HotRead artifacts | Optimized public binary/read artifacts |
| Public AOT shell cache | Pre-rendered public HTML artifacts |
| Browser and service worker cache | Public shell and static index reuse where privacy boundaries allow it |

Cache invalidation is part of the application contract. Article, taxonomy, public shell, and admin-side mutations must invalidate the matching public and internal caches instead of relying on stale TTL behavior alone.

Article source/render positioning has one command owner in
`services/authoring/articleAnchorContext.ts`. It consumes FsusUI public semantic
maps and committed transaction position maps, with the existing document context
as its identity and revision authority. Snapshots and receipts bind source ranges,
semantic nodes, affinity, direction, viewport offset, surface/tool identity, and
user intent. Restore orders exact, rebased, semantic-neighbor, then explicitly
approximate percentage outcomes. A revision transition without a contiguous
public transaction chain fails closed. Disposing the canonical owner makes
`isCurrentContext` reject every snapshot, including its last historical context,
so surviving runtime handles cannot capture new semantic anchors after teardown.

Manual wheel, trackpad, touch, drag, or selection pauses automatic positioning.
Input and explicit navigation resume immediately; idle resumes after 1200 ms.
Optional synchronization defaults off, follows the user-selected pane, and ignores
programmatic generations and events within 16 ms. Commands clamp viewport offsets
to the current viewport height and use instant positioning for reduced motion.
Surface/tool consumers execute these commands; the adapter owns no DOM, parser,
render cache, preference persistence, or product entry point.

The attachment input boundary in `services/authoring/articleAttachmentContext.ts`
consumes the public FsusUI picker capture and clipboard priority policy. Its
created-stage handles seal file metadata, ordered public item identity, provider
version, the shared anchor context and the canonical task envelope; runtime
signals cancel on document/source changes or disposal. Pending insertion plans
come from FsusUI and carry the current expected revision and document identity.
Created and provider-pending handles share a bounded capacity of 100, allowing
one 100-image writer batch while rejecting further captures atomically. They
never execute upload IO; the lifecycle receipt log remains separately bounded.

Created-stage handles are not provider completion admission. Insertion cancels
the created lease and establishes a new anchored provider request. The adapter
subscribes to the canonical document owner, consumes public transaction maps,
and renews context-bound leases while preserving each independent provider
signal. Missing maps, partial deletion, removed nodes and document switches
reject late completion; undo/redo cannot revive a cancelled request. Resolve,
remove and replace use public FsusUI plans; retry creates a fresh request and
signal. Closed lifecycle receipts retain predecessor and transaction identities,
never file bytes or upload tokens.

`useAdminArticleWrite.authoringAttachmentRuntime` is the controlled entry on the
existing document binding. It commits accepted public transaction revisions before
the later model-update event, creates semantic bindings through the public anchor
map factory, and cancels requests when the bound editor is released. This data
boundary does not upload files, parse captions, or migrate legacy placeholders.
Native product input composition, redo successor admission and independent
full attachment acceptance remain outstanding.

The original image-upload runtime keeps initialized upload facts private to its
actual owner, pending intent, document lease and generation. Before completion,
these remain operation-owned locals and cannot be borrowed. After the original
successful complete acknowledgement, `onSessionReady` acquires a session loan
while the original operation and binding are still current, before public session
cleanup. A loan is issued at most once per attempt and expires 30 seconds from
that actual acquisition; release, expiry or an inactive operation cannot remint
or refresh it. Each `withSession` invocation has a separate
access object and signal; getters are revoked and that signal is aborted when
the awaited callback settles or its 30-second scope expires. Concurrent scopes
do not revoke each other or extend the loan deadline. Slow chunk IO grants no
precompletion loan. Raw upload failure grants no loan. A current operation's
successful complete acknowledgement is kept separately from loan access. If the
runtime completion callback fails, is cancelled, or is disposed, the runtime
revokes access and resets public transport without sending abort. Repeated
abandon also sends no abort after an acknowledged completion. It retains the
original recovery snapshot, acknowledgement response and callback error privately
and reports `upload_completion_recovery_required` through its existing error and
cleanup state. This acknowledged operation cannot resume, recomplete or be
overwritten while recovery is required. No canonical recovery receiver is wired
here, so local reset does not acknowledge recovery or committed-asset cleanup.
Successful raw upload still returns its original URL and clears transport as
before. Its successful callback is not a canonical recovery or asset-cleanup
receipt. Only the current operation's generation, upload ID and actual ACK history
remain privately until replacement or instance release; successful transport
does not retain snapshot credentials. Later flow consumer failure is a separate
recovery boundary whose integration remains open. Pre-ACK cancellation captures a private context from the actual original init
promise before invalidating its generation. Cancellation before init ACK awaits
that same promise; retries retain the same obligation and forward its token only
to the original upload ID through the existing abort API. Public session or stored
snapshot mutation cannot change this authority. Only an actual same-ID
`aborted` status response clears local transport and recovery state. Network,
decoded API errors, wrong IDs and other statuses retain the original obligation.
A cold stored resume cannot reconstruct private init authority and therefore
cannot authorize abort here. In-flight or unknown completion still refuses abort;
acknowledged completion follows the separate recovery boundary above. Stored
snapshots cannot mint replacement loans, and unknown commit state never grants deletion.

`useImageUploadFlow.startUpload` accepts an optional `attachmentInput` containing
the real selection anchor, original attachment/document owners and transaction
port. It calls their existing capture/commitCreated before starting its original
task lease and preserves each exact File reference with the corresponding
original pending handle. The per-call `onFileUploaded({ file, intent, borrow, url })`
(or flow option when supplied) is awaited
after each raw upload and before starting the next file; the flow releases that
loan on callback success or failure. Consumers observe within `withSession` and
pass its callback signal to awaited operations. Batch `onSuccess` does not retain
earlier loans. An original document transaction invalidates its current lease and
intent; observed upload facts grant no reference, cleanup or document permission.
This source API alone does not qualify Writer wiring or product endpoints.

`useAdminArticleWrite.authoringEditorRuntime.bindEditor` composes the existing
anchor, attachment, render-cache and continuity owners on one actual public editor
port. The returned `binding` keeps live canonical context, render-state and pending
attachment-lease getters. Transactions enter the document owner before model
updates; selection and focus enter the existing continuity adapter. Automatic
refresh uses the sole render-refresh policy and the actual FsusUI render producer.
Preview and compare tasks use canonical document leases; release cancels the
owned tool, continuity, cache and attachment work without releasing borrowed
owners. Tool-result admission still requires the current live binding context. Commands may use the binding's guarded
`dispatchTransaction(context, transaction)` with the exact current context,
public document identity and expected source revision. The existing native port
owns dispatch and history; accepted results enter the same attachment and
continuity consumers. Stale or disposed handles are rejected before dispatch.
The operation does not promise persistent-save rollback or viewport completion.

The production Writer now binds that same port after mount and consumes its public
transaction, selection and host-focus events. It does not dispatch initialization
on mount because the native transaction restores focus asynchronously and would
steal initial title focus. Inspector commands opened without a rail trigger retain
one return action in the existing inspector owner: it dispatches a public no-change,
history-skipping transaction on the captured live port only while the document
digest, bound instance and availability remain current. Explicit rail triggers
retain their own focus target, and reopening invalidates delayed close restoration.
No private editor element, copied selection/history store, or viewport completion
receipt is introduced.

Writer submit validation captures the first invalid property through the public
FsusUI Form validation callback and scrolls with its exposed `scrollToField`.
Product-owned field markers locate the corresponding focusable control when it
has no invalid-state attribute. No private Form field array or field element is
read; each submission clears the previous invalid-property observation.

The publish inspector borrows the canonical `ArticleMetadataRead` consumer and
its original typed model. It uses the live Writer binding context, persisted
article identity and explicit global definition scope (`null`), never the actor
as a definition owner. The canonical site scope is `primary-site`. Actor changes,
permission loss, close, save and binding release invalidate pending reads;
ordinary body/source-revision updates do not trigger metadata requests. The
read-only panel preserves decimal96, Int64 and UTC tick precision and shows
localized unavailable/reconciliation states without raw wire reasons. Its refresh
button calls the same canonical no-store read. External definition-schema change
notification has no current public source and remains an explicit integration gap;
this composition does not claim authenticated database or migration acceptance.

The Writer's product surface is typed only as `ArticleEditorSurface` (`live` or
`source`). Temporary source-compare mapping to the native generic editor belongs
to `MarkdownEditorAdapter`; it is not a persisted product surface. A supplied
surface preference is admitted only through the existing closed preference
contract and the actual document's user/site scope. Without that source, the
current choices remain session-only and do not write an invented preference.

The existing `authoringEditorRuntime.bindEditor` handle exposes
`bindSurfacePreference(readPreference)` to compose the canonical surface runtime
from the supplied owner source. It refuses a missing, corrupt or foreign-scope
snapshot before construction, keeps capability pending until a full typed result
is supplied, and disposes surface work before releasing the same editor binding.
The production preference snapshot getter is not yet available, so this controlled
entry is not activated by a guessed default. Native typed capability delivery and
real focus/viewport acknowledgement remain required before qualified restoration;
public initialization and `awaiting-ack` are admission only.

The Writer's inspector command entry sits above the body surface, keeping it
reachable when the native selection toolbar is open. The same public command
palette and editor instance remain in use; the native toolbar remains enabled.

Writer consumer retention is bounded to 4 MiB per retained result, 60 seconds and
64 receipts. These are storage bounds, not automatic-render eligibility thresholds
or a performance qualification. The existing refresh-policy owner still decides
render eligibility. This event hookup does not yet present a retained result on
the native editor surface, invoke automatic rendering, acknowledge viewport offset,
or complete surface/tool continuity acceptance.

The canonical producer retains one frozen render/projection pair per admitted
entry. Each guarded resolve returns the same pair by reference while that entry
is retained. The pair shares the original public FsusUI objects and follows the
existing result verification, replacement and release lifecycle.

Selection events retain the native producer's identity without adding current
wrapper props. A missing identity cannot establish a document binding and retires
an unobserved authoring intent; a known foreign document cannot update the current
binding. Selection and accepted transaction observations cannot move the current
intent binding to an older revision. Native producer identity and revision
evidence remain required for full selection/outline continuity acceptance.

Initialization uses a public selection-only transaction with the current document
identity and expected revision. A fresh FsusUI editor at revision zero cannot bind
a retained advanced document owner and fails closed. This composition neither
resets the canonical epoch nor synthesizes revision/history initialization,
viewport observations or focus acknowledgements. Those public runtime gaps and
product event wiring remain acceptance limits; successful restore admission alone
is not completed focus or viewport restoration.

The three production wrappers expose `getAuthoringEditorPort()`, returning the
same actual FsusUI exposed instance or null while unavailable. The writer wrapper
forwards admitted transaction and identity-bound selection events and native host
focus events. Consumers can bind these to `authoringEditorRuntime.bindEditor`
without reaching into child DOM or constructing another editor. These hooks do
not manufacture viewport observations, revision seeds or restore completion.

The writer mounts `useArticleAuthorCommandPalette` once on the editor panel.
Its scoped Mod+P listener and `ArticleAuthorCommandEntry` secondary action both
call the existing `ArticleWriteEditor.openCommandPalette` public method. Loading,
saving and the existing modal predicate suspend entry; command availability and
execution remain in the unchanged inspector registry and handlers. The visible
label uses the current locale owner. Delegation is not a business-completion or
palette-visibility receipt, and this entry provides no search query authority.

The same Writer binding owns `ArticleEditorSearchRuntime`. It creates search
leases through the existing document task registry, never through preview or
compare tasks. Canonical search-origin anchor commands are projected against the
current editor binding and that exact running lease; raw index/range inputs
remain rejected. Commands, cancellation and context transitions notify the host,
and each projection read rechecks the current binding. Closing search, replacing
its task, changing the document or releasing the editor clears the projection
and cancels the lease before editor disposal. Availability remains distinct from
native navigation acknowledgement and recent-history persistence. Admitted
server packages, raw UTF-8 digest and string-epoch bridging, the workspace search
entrypoint and the canonical recent-history transport remain separate inputs;
this lifecycle neither coerces epochs nor invents permission or visit receipts.

## Security, Moderation, And Anti-Crawler

Security is built as infrastructure, not only endpoint code:

- PoW and rate limits protect high-risk anonymous and auth flows.
- MFA, Passkey, session isolation, HttpOnly cookies, and RBAC protect identity and admin workflows.
- Anti-crawler controls classify verified crawlers, social preview bots, unknown bots, and risky public reads.
- Moderation combines content filtering, region policy, built-in model signal integration, audit evidence, and admin review workflows.
- Public telemetry and read proof avoid collecting account, token, cookie, raw IP, or private content payloads.

Security changes should be checked against [docs/security.md](../security.md).

## FsusUI Boundary

FsusUI supplies the visual system and reusable UI foundation. FsusBlog owns application semantics: API behavior, data contracts, admin workflows, public content model, security decisions, and domain-specific UX. Reusing FsusUI components must not move FsusBlog business rules into the UI library.

The frontend fast gate runs `check:fsusui-boundary` in strict-by-default mode, so any FsusUI boundary warning fails before merge.

### Article last-valid render lifecycle

`ArticleRenderCache` consumes the existing `ArticleDocumentContextAdapter` and
retains one closed, versioned render-reference entry per owning document/session.
Article, draft, epoch, user, site, session, renderer, projection, feature, theme,
and locale changes invalidate the entry. Only an older source revision in the
same document can be stale; the machine state retains its content reference
alongside refresh actions, failure reason and last-valid time. It never writes
HTML or projection data back to the draft. Entry bytes, age, canonical result
bytes and receipt count have explicit caller-supplied bounds.

`ArticleFsusUiRenderProducer` consumes the public renderer/projection APIs through
the existing FsusUI boundary. Its canonical result references are released on
replacement, expiry, context switch and disposal. Every refresh registers a
context task and checks its request, source and configuration identities again
before commit. Cancellation settles immediately and rejects late results. The
public FsusUI renderer currently has no signal argument, so this does not claim
interruption of its underlying computation. Render source identity includes
mode/features/base URL; projection source identity uses the public source-only
contract. Both are verified separately without rewriting either identity.

`evaluateArticleRenderRefreshPolicy` is the single automatic refresh threshold
producer. The source gate remains 80 × 1024 and the estimated-node gate remains
3000; equality allows automatic refresh. The source unit is original source
UTF-8 bytes, measured with a fixed 81924-byte buffer. Oversized inputs report a
lower bound and skip projection. The former shell compared JavaScript UTF-16
length under a bytes label; this branch's explicit compatibility assumption
uses actual bytes, so multibyte source may pause earlier than that old shell.

The node unit is a historical weighted resource estimate, not a DOM count or
projection node count: raw LF-delimited lines (empty source has zero), plus
2 per public heading, 2 per distinct public list/task marker, 3 per public table
row (including separator), and 30 per code/Mermaid marker range of at least
three source units. Public unclosed-fence diagnostics contribute one 30-unit
opening fence. Syntax facts come only from the FsusUI public projection. This
preserves the old weights without restoring a Blog regex parser. Canonical
recognition of setext headings, ordered lists, tilde fences and malformed syntax
can differ from the former lexical guesses; this is a reviewable measurement
assumption, not proof of product or performance acceptance. Once the line base
or accumulated estimate exceeds the gate, remaining work is skipped and the
reported node estimate is explicitly a lower bound. Projection failure denies
automatic refresh with an explicit reason; it does not select a product surface.

Closed decisions bind context, revision, source digest and projection version.
Cache admission requires an immutable decision produced by this authority;
copied, serialized, forged or stale decisions cannot authorize work. A denied
automatic refresh retains last-valid content and exposes the reason. Explicit
manual refresh still uses the bounded, cancellable lifecycle. Product surface
and stale-banner wiring, heavy-feature activation and position mapping remain
with their respective owners. The threshold service changes no capabilities or
surfaces; an unobserved layout or long task has no fabricated observation ref.

### Draft responsibility in the public reading composition

`createArticleDraftResponsibilitySnapshot` projects the existing authoring
responsibility draft/revision fields into immutable display data, binding the
document context digest, source revision and responsibility input digest.
It retains the current public responsibility composition and its display
filtering rules (public people and sources, bounded lists and update notes).
Private sources are omitted; incomplete responsibility remains explicit.
Display filtering is not asset verification, prepublish qualification or URL
reachability evidence. The snapshot contains no publication or proof coordinate.

An explicit `draftResponsibility` input to the existing reading assembly selects
draft authority. The disclosure accepts only a producer snapshot matching its
supplied current context, does not read the published manifest, and does not
render a publication verification link. `bindArticleDraftResponsibilitySnapshot`
also binds the expected digest from current responsibility/site-author inputs;
metadata-only edits reject an older result even when Markdown/context is
unchanged. Missing, stale or forged inputs never
fall back to published authors. The public path retains its existing fetch and
verification behavior, with aborted and late requests discarded on authority
change or unmount. The enclosing preview request must still verify the supplied
context against the existing editor owner before admitting this input; the
display projection does not create another document owner or prove route
authorization, complete draft composition or editor continuity.

## Standalone document export boundary

Document export freezes the caller's source, metadata, properties, assets, required fonts, canonical renderer identity, and reading-style authority before provider selection. The closed catalog declares `self-contained-html`, `pdf`, `docx`, and `epub`; only `self-contained-html` has an implementation in the current slice. Unknown formats, per-call tools, parser substitutions, provider fallbacks, floating tool versions, and caller-selected commands fail closed.

Task admission binds frozen renderer ID/version to that format's sole catalog provider.
Result admission binds the supplied provider to the task and reuses complete catalog
identity validation before accepting its budgets or delivery policy; tool ID/version
must also equal that provider's registered toolchain. Recomputed artifact digests do
not authorize provider, renderer or policy substitutions.

The provider registry is the sole composition point for the implemented provider. Its replaceable canonical-renderer adapter invokes the exact sandbox-registered renderer with the fixed `render` argument. The HTML provider does not parse Markdown: it accepts the canonical renderer's digest-bound semantic fragment, applies a closed streaming HTML/SVG sanitizer, embeds frozen images and fonts, and independently verifies the completed document and receipt. The artifact carries a hash-bound CSP, has no script or runtime network dependency, and uses private authorized delivery with a 24-hour cleanup TTL; it is not a public static-root artifact.

Sandbox finalization preserves the first observed budget or execution failure if caller cancellation arrives during cleanup. With no earlier failure, requested cancellation is still recorded. Physical cleanup must independently qualify the empty process tree, removed run directory, transient unit and cgroup; an unqualified cleanup remains fail closed and cannot become a qualified budget or cancellation receipt.

Cgroup drain requires both an observed zero business-process count and an unpopulated cgroup. Finalization reobserves a still-positive count within the existing bounded cleanup polling schedule even when population is already empty; authority cleanup refuses either nonempty signal and never substitutes a synthetic zero count.

Each export transient service belongs to one exact run-private accounting slice under `app.slice`. The same authority binds the service, run and slice before accepting any counters, refuses direct parent processes or foreign child cgroups, and reads the parent's retained native pids peak/events after the service cgroup retires. Service hard limits still apply before `ExecStart`; no keeper process or larger budget is introduced. Physical cleanup removes both the service and its private accounting cgroup. A terminal service without its exact retained accounting owner cannot qualify process accounting.

Prelaunch service, accounting slice and fixed parent identities are inspected in one closed multi-unit response; missing, duplicate or foreign records fail closed. Caller cancellation does not kill the original dispatch CLI before its manager reply: that reply fences a potentially late accepted transient-service request within an owned ten-second dispatch control-plane deadline. A control timeout, transport failure or unsuccessful dispatch reply cannot qualify admission-failure cleanup merely from a later empty snapshot. Recovery has its own owned ten-second deadline, binds and cancels only the exact numeric start job, kills the owned service, and retains its native process identity; a running start job requires another kill after identity admission. A retired job is reconciled through the exact service's fresh closed snapshot rather than treated as permanently lost process identity. Cancellation may be classified as never started only while the exact transient service remains loaded and quiescent with no pending job or process start/exit identity, no previously observed execution or accounting activity, and independently qualified physical cleanup. An existing parent requires zero retained raw pids counters; an absent parent additionally requires an exact unconfigured inactive implicit slice with empty cgroup/job and zero activation timestamps, which supplements the retained service evidence and is not an independent historical-zero proof. Missing/retired service metadata, a positive historical peak (including the broker), or unrecoverable started identity refuses qualification and performs owned cleanup. The bounded control-plane deadlines neither extend the service's original wall budget nor permit a replacement workload.

This boundary does not register an endpoint, admin workflow, storage implementation, or production renderer deployment. The local test executable is an explicit deterministic simulation of the unavailable canonical renderer boundary and proves sandbox/protocol/package behavior only. Production activation must supply the exact registered canonical tool and must not reinterpret this test fixture as renderer integration evidence.

Sanitization consumes the complete renderer fragment through its wrapper EOF. A renderer-supplied premature closing tag cannot silently hide later markup, text, or comments; the fragment is rejected. Complete legal fragments retain their allowed tail and surrounding whitespace.

## Standard Protocol Exemptions

Not every public output is an internal AEDS API. The following are standard external protocols or operational outputs and are documented separately from internal binary contracts:

- RSS
- Atom
- JSON Feed
- Sitemap
- `robots.txt`
- health probes

These outputs should remain standards-compatible even while undocumented internal APIs and AEDS frames remain experimental.

## What Is Stable Today

The stable project direction is single-process FsusBlog with Kestrel, PostgreSQL, Redis, public AOT/HotRead, AEDS runtime API, moderation, security, and admin console baselines.

The exact internal API shape, AEDS frame layout, database schema, admin routes, deployment configuration, and third-party client compatibility are not stable unless explicitly classified by a dedicated stability document.

## Current test dependency edges

<!-- fsus-doc-claim
claimId: browserless-production-correctness.dependency-edges
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: testing.dependency-edges
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN testing.dependency-edges -->
- `aeds-compression-profile->release-evidence`
- `aeds-frame-cost->release-evidence`
- `backend-api-integration->backend-fast`
- `backend-api-integration->backend-nightly`
- `backend-api-integration->coverage-backend`
- `backend-auth-state-machine->backend-fast`
- `backend-auth-state-machine->backend-nightly`
- `backend-auth-state-machine->coverage-backend`
- `backend-benchmark-regression->performance-evidence-summary`
- `backend-build-governance->backend-api-integration`
- `backend-build-governance->backend-auth-state-machine`
- `backend-build-governance->backend-concurrency`
- `backend-build-governance->backend-fast`
- `backend-build-governance->backend-golden`
- `backend-build-governance->backend-property`
- `backend-build-governance->backend-unit`
- `backend-build-governance->coverage-backend`
- `backend-build-governance->distributed-contract-fast`
- `backend-concurrency->backend-fast`
- `backend-concurrency->backend-nightly`
- `backend-concurrency->coverage-backend`
- `backend-golden->backend-fast`
- `backend-golden->backend-nightly`
- `backend-golden->coverage-backend`
- `backend-mutation->backend-nightly`
- `backend-mutation-changed-critical->behavior-evidence-pre-runtime`
- `backend-perf->backend-nightly`
- `backend-perf->release-evidence`
- `backend-property->backend-fast`
- `backend-property->backend-nightly`
- `backend-property->coverage-backend`
- `backend-test-governance->backend-nightly`
- `backend-unit->backend-fast`
- `behavior-doc-static-admission->aeds-compression-profile`
- `behavior-doc-static-admission->app-config-local-tuning`
- `behavior-doc-static-admission->backend-benchmark-regression`
- `behavior-doc-static-admission->backend-build-governance`
- `behavior-doc-static-admission->backend-mutation`
- `behavior-doc-static-admission->backend-mutation-changed-critical`
- `behavior-doc-static-admission->backend-perf`
- `behavior-doc-static-admission->backend-test-governance`
- `behavior-doc-static-admission->behavior-evidence-pre-runtime`
- `behavior-doc-static-admission->behavior-test-evidence`
- `behavior-doc-static-admission->browser-performance-regression`
- `behavior-doc-static-admission->coverage-frontend`
- `behavior-doc-static-admission->cross-stack-contract`
- `behavior-doc-static-admission->csrf-browser-matrix`
- `behavior-doc-static-admission->current-schema-bootstrap-integration`
- `behavior-doc-static-admission->data-scale-m`
- `behavior-doc-static-admission->frontend-build`
- `behavior-doc-static-admission->frontend-property-model-perf`
- `behavior-doc-static-admission->frontend-runtime-contracts`
- `behavior-doc-static-admission->frontend-unit-shard`
- `behavior-doc-static-admission->homogeneous-two-node-fixture`
- `behavior-doc-static-admission->legacy-20260517-real-dump`
- `behavior-doc-static-admission->markdown-preview-release-performance`
- `behavior-doc-static-admission->native-fuzz-sanitizer`
- `behavior-doc-static-admission->native-smoke`
- `behavior-doc-static-admission->perception-character-v3-release-gate`
- `behavior-doc-static-admission->perception-v2-redteam-nightly`
- `behavior-doc-static-admission->perception-v2-redteam-pr`
- `behavior-doc-static-admission->perception-v2-test-matrix`
- `behavior-doc-static-admission->privacy-zk-comment-matrix`
- `behavior-doc-static-admission->production-build-artifacts`
- `behavior-doc-static-admission->production-correctness`
- `behavior-doc-static-admission->public-hydration-fast`
- `behavior-doc-static-admission->public-hydration-nightly`
- `behavior-doc-static-admission->release`
- `behavior-doc-static-admission->release-data-scale-m`
- `behavior-doc-static-admission->release-final-flaky-governance`
- `behavior-doc-static-admission->release-load-burst`
- `behavior-doc-static-admission->release-load-peak`
- `behavior-doc-static-admission->release-memory-leak-budget`
- `behavior-doc-static-admission->release-mutation-critical-slice`
- `behavior-doc-static-admission->release-open-handle-budget`
- `behavior-doc-static-admission->release-reliability-fresh`
- `behavior-doc-static-admission->release-soak-min`
- `behavior-doc-static-admission->risk-control-test-matrix`
- `behavior-doc-static-admission->runtime-cache-article-detail-l1`
- `behavior-doc-static-admission->runtime-cache-cache-miss-singleflight`
- `behavior-doc-static-admission->runtime-cache-distributed-invalidation`
- `behavior-doc-static-admission->runtime-cache-hot-featured-frame`
- `behavior-doc-static-admission->runtime-cache-l1-residency`
- `behavior-doc-static-admission->runtime-cache-pagination`
- `behavior-doc-static-admission->runtime-cache-public-hot-read`
- `behavior-doc-static-admission->runtime-cache-redis-fault-classes`
- `behavior-doc-static-admission->runtime-cache-related-reading`
- `behavior-doc-static-admission->runtime-cache-revocation`
- `behavior-doc-static-admission->runtime-cache-security-projections`
- `behavior-doc-static-admission->runtime-cache-sitemap`
- `behavior-doc-static-admission->runtime-cache-telemetry`
- `behavior-doc-static-admission->security-authenticated-dast`
- `behavior-doc-static-admission->soak-long-evidence-import`
- `behavior-doc-static-admission->soak-long-scheduled`
- `behavior-doc-static-admission->static-governance`
- `behavior-doc-static-admission->test-quality-lint`
- `behavior-doc-static-admission->ux-viewport-plan-progress`
- `behavior-doc-static-admission->wasm-build-artifacts`
- `behavior-evidence-post-runtime->behavior-document-consistency-final`
- `behavior-evidence-pre-runtime->behavior-evidence-post-runtime`
- `behavior-evidence-pre-runtime->bootstrap`
- `behavior-evidence-pre-runtime->production-correctness`
- `behavior-test-evidence->backend-mutation-changed-critical`
- `behavior-test-evidence->behavior-evidence-pre-runtime`
- `bootstrap->article-private-preview`
- `bootstrap->browser-diagnostics-manual`
- `bootstrap->browser-diagnostics-nightly`
- `bootstrap->browser-runtime-risk-diagnostics`
- `bootstrap->data-scale-nightly`
- `bootstrap->data-scale-s`
- `bootstrap->data-scale-xs`
- `bootstrap->endpoint-depth`
- `bootstrap->fault-injection`
- `bootstrap->integration`
- `bootstrap->load`
- `bootstrap->load-2x-peak`
- `bootstrap->load-baseline`
- `bootstrap->load-burst`
- `bootstrap->load-peak`
- `bootstrap->production-correctness`
- `bootstrap->release`
- `bootstrap->release-evidence`
- `bootstrap->resilience`
- `bootstrap->runtime-cache-evidence`
- `bootstrap->security`
- `bootstrap->soak-short-runtime`
- `bootstrap->ux-viewport-boundaries`
- `bootstrap->ux-viewport-smoke`
- `bootstrap->ux-viewport-visual`
- `bootstrap->visual-console`
- `bootstrap->visual-public`
- `browser-contract->behavior-evidence-post-runtime`
- `browser-diagnostics-manual->browser-diagnostics`
- `changed-code-coverage->coverage-gate-strict`
- `coverage-backend->coverage-merge`
- `coverage-frontend->coverage-merge`
- `coverage-gate->coverage-gate-strict`
- `coverage-gate->production-correctness`
- `coverage-gate->release-evidence`
- `coverage-merge->changed-code-coverage`
- `coverage-merge->coverage-threshold`
- `cross-stack-contract->release-evidence`
- `csrf-browser-matrix->release-evidence`
- `data-scale-evidence-summary->release-evidence`
- `data-scale-s->data-scale-evidence-summary`
- `data-scale-xs->data-scale-evidence-summary`
- `distributed-contract-fast->backend-fast`
- `endpoint-depth->production-correctness`
- `endpoint-depth->release-evidence`
- `fast->acceptance`
- `fast->production-correctness`
- `fast->release-evidence`
- `fault-injection->release-evidence`
- `frontend-build->aeds-frame-cost`
- `frontend-build->frontend-static-governance`
- `frontend-build->wasm-fuzz-regression`
- `frontend-render-structure->production-correctness`
- `frontend-render-structure->release-evidence`
- `frontend-static-governance->frontend-render-structure`
- `integration->acceptance`
- `integration->browser-diagnostics-manual`
- `integration->browser-diagnostics-nightly`
- `integration->production-correctness`
- `integration->release-evidence`
- `load->production-correctness`
- `load->release-evidence`
- `load-baseline->performance-evidence-summary`
- `load-peak->performance-evidence-summary`
- `native-smoke->production-correctness`
- `perception-character-v3-release-gate->release-evidence`
- `perception-v2-redteam-pr->production-correctness`
- `perception-v2-redteam-pr->release-evidence`
- `perception-v2-test-matrix->release-evidence`
- `performance-evidence-summary->release-evidence`
- `pr-smart-gate-plan->backend-mutation-changed-critical`
- `privacy-zk-comment-matrix->release-evidence`
- `production-build-artifacts->browser-contract`
- `production-build-artifacts->browser-diagnostics-manual`
- `production-build-artifacts->browser-diagnostics-nightly`
- `production-build-artifacts->production-correctness`
- `production-build-artifacts->production-xss-fast`
- `production-build-artifacts->production-xss-release`
- `production-build-artifacts->runtime-order-equivalence`
- `production-correctness->behavior-evidence-post-runtime`
- `production-correctness->production`
- `release->acceptance`
- `release->browser-diagnostics-manual`
- `release->browser-diagnostics-nightly`
- `release->browser-runtime-risk-diagnostics`
- `release->cross-browser-smoke`
- `release->production-correctness`
- `release->release-evidence`
- `release-evidence->production-correctness`
- `release-evidence->release-closeout`
- `release-evidence->release-final-shard-completeness`
- `resilience->production-correctness`
- `resilience->release-evidence`
- `rights-v3-test-matrix->release-evidence`
- `risk-control-test-matrix->release-evidence`
- `runtime-cache-article-detail-l1->runtime-cache-evidence`
- `runtime-cache-cache-miss-singleflight->runtime-cache-evidence`
- `runtime-cache-distributed-invalidation->runtime-cache-evidence`
- `runtime-cache-evidence->production-correctness`
- `runtime-cache-evidence->release-evidence`
- `runtime-cache-hot-featured-frame->runtime-cache-evidence`
- `runtime-cache-l1-residency->runtime-cache-evidence`
- `runtime-cache-pagination->runtime-cache-evidence`
- `runtime-cache-public-hot-read->runtime-cache-evidence`
- `runtime-cache-redis-fault-classes->runtime-cache-evidence`
- `runtime-cache-related-reading->runtime-cache-evidence`
- `runtime-cache-revocation->runtime-cache-evidence`
- `runtime-cache-security-projections->runtime-cache-evidence`
- `runtime-cache-sitemap->runtime-cache-evidence`
- `runtime-cache-telemetry->runtime-cache-evidence`
- `security->production-correctness`
- `security->release-evidence`
- `security-authenticated-dast->release-evidence`
- `test-inventory->static-governance`
- `test-inventory->test-quality-lint`
- `ux-viewport-plan-progress->production-correctness`
- `ux-viewport-plan-progress->release-evidence`
- `validate-matrix->app-config-local-tuning`
- `validate-matrix->behavior-doc-static-admission`
- `validate-matrix->behavior-test-evidence`
- `validate-matrix->native-fuzz-sanitizer`
- `validate-matrix->native-smoke`
- `validate-matrix->pr-smart-gate-plan`
- `validate-matrix->public-hydration-fast`
- `validate-matrix->public-hydration-nightly`
- `validate-matrix->release-final-flaky-governance`
- `validate-matrix->test-inventory`
- `validate-matrix->test-quality-lint`
- `visual-console->visual`
- `visual-public->visual`
- `wasm-fuzz-regression->production-correctness`
- `wasm-fuzz-regression->release-evidence`
<!-- FSUSBLOG-GENERATED:END testing.dependency-edges -->

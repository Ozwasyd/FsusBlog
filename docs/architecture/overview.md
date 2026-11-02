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

Article authoring current-context admission belongs to the canonical
`ArticleDocumentContextAdapter`. Disposing that owner retires every snapshot from
current-context admission, including its last snapshot with unchanged bytes and
digest. The historical readonly context remains available for lifecycle evidence;
consumers must use the owner predicate rather than infer currentness from it.

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

## Authoring navigation history boundary

`AuthoringNavigationHistory` in
`src/frontend/src/services/authoring/authoringNavigationHistory.ts` owns one
process-local semantic history per canonical `OpenArticleDocumentRegistry`.
The closed v1 state binds session, workspace, user and site scopes. It retains
at most 128 entries (64 by default) and 256 command fingerprints. It has no
hydration or persistence API: reload discards the history; logout or workspace
replacement must discard the owning Registry and create a new scope. Clearing
this session removes entries and pending intents while retaining command/user
sequence watermarks and bounded retry fingerprints to prevent delayed reentry.

Entries preserve Registry article/draft/document identities, its original
string-or-null source/draft revisions and document epoch, exact owning and target
group IDs, explicit user action sequence/time, cause, validity observation refs
and digests. An optional anchor preserves the public source node ID, node-bound
range and affinity, original numeric Anchor source revision and source/context
identity digests. The two upstream revision types are never converted into each
other. No body, title, heading text, URL, DOM coordinate, editor instance,
private selection, browser route state or undo state is retained. A range without
a public node ID is inadmissible as an anchor identity.

The closed cause registry admits internal link, relation inspector, Rail, Quick
Switcher, future global search, explicit anchor reveal and recent-closed restore
visits. Automatic activation/restore/refresh and caret/scroll/input events have
no visit cause. Same-action route-to-anchor settling preserves its user action
timestamp and sequence and coalesces only the same document, revisions, groups
and cause within 500 ms of the action, using a separate recording timestamp;
an existing anchor cannot be replaced by another anchor in the same action.
A rapid identical semantic target/cause coalesces within that window. Distinct
anchors form distinct visits. Every new visit truncates the forward branch and
evicts oldest entries above capacity; entry IDs survive coalescing.

Append/coalesce admits current visits only; an unavailable attempt cannot move
the cursor by masquerading as a completed user visit. Commands carry exact
scope, expected history revision, increasing command sequence and idempotency
coordinates. An identical retry within the bounded
fingerprint window returns a replay receipt with no executable target. Conflicts
fail closed; older commands outside that window fail CAS or sequence checks.
User sequence/time watermarks also reject delayed visit settling after branch
changes, eviction or clear. Receipts contain only semantic command/cursor/entry,
cause/validity/ref/digest projections. Digests detect changed coordinates; they
are not producer authentication or permission grants.

Back/forward revalidates the adjacent entry, emits a closed semantic target
intent and leaves the committed cursor unchanged. A matching CAS settlement
commits the cursor only for `completed`; cancellation/failure preserves it.
Pending traversal rejects another back/forward; a new user visit, invalidation
or clear cancels that pending intent, so late settlement fails closed. Missing,
deleted, archived, stale revision, permission revoked, missing/partial anchor,
missing group and unknown targets produce an unavailable intent without moving
or skipping the cursor. Unknown observations never become current implicitly.
`replace-invalid` updates validity only, preserving document/group/anchor facts.

The pure observation helper consumes actual Registry status/context and coherent
Group projections. The Group registry's actual `revision` is retained separately
from the local group's `revision`, and its `articleRegistryRevision` must match
the observed Registry revision. Group command publication order is monotonic
for the same canonical owner; a local group revision is not a lifetime epoch.
An empty group can close and its exact `groupId` can be created again at local
revision 0. A newer Group registry publication therefore admits a lower local
revision; at the same publication the local coordinate must agree exactly.
Neither producer-wide counter may move backwards, and no coordinate is inferred
or replaced with a fabricated group epoch. Missing owner coordinates or
incoherent Registry/Group projections fail closed.

For example, move the same document out of a group at local revision 2, close
the empty group, recreate the same ID at revision 0, and move the document back.
The original Group producer advances its registry revision on each of those
four commands, while the returned group's local revision is 1. History can
consume that later coherent observation without having seen the intermediate
missing group. The exact document/epoch/source/anchor and group ID checks remain.
Replay checks publication order independently of the mutation freshness
predicate. Anchor currentness additionally requires the exact numeric source
and context digest projection supplied by the Anchor owner. An absent mounted
entry alone proves only unknown; a confirmed missing fact must come from its
source owner. Existing ownership is never moved to satisfy the requested target
group. A recent restore visit stores only upstream entry/restore-receipt refs
and a digest, after the recent-closed owner has validated the real restore. It
has no recent stack, close policy or restore implementation.

The independent verifier reconstructs each command transition without invoking
the mutation reducer or owner, checks full seals, bounds, branch/coalescing,
cursor/cancellation/idempotency and receipt/target equality, and replays up to
1,024 supplied transitions from explicit genesis. External observation and
recent-restore provenance remain upstream obligations; replay cannot certify
them. Closed validators reject added URL/title/heading/DOM/offset or recent
payload fields. The module exposes no event subscriptions, component stacks,
browser-history replacement or persistence hooks.

The ordinary static source control
`node tools/frontend/check-authoring-navigation-history-source.mjs` consumes the
canonical in-memory frontend source index and writes no receipt or qualification
artifact. It checks the named history owner, required exported boundaries,
canonical type-only imports, fixed digest imports, browser/event/activation
calls, forbidden payload fields and named local navigation stacks. It does not
replace independent runtime or mutation coverage, and is not attached to the
held test matrix in this source slice. Its authored group-reuse control covers
move-out/close/same-ID-create/move-back using the original producer's global and
local coordinates, plus regressing/equal-publication counter negatives. It
checks the independent replay ordering and the coherent observation schema by
AST only. The control added for this path is UNRUN under the execution HOLD;
prior static observations do not qualify the corrected candidate. Full types
remain blocked by the prerequisite closure; an own-module zero-diagnostic
observation is not a passing full compilation.

This source slice uses type-only imports from the actual Group and Anchor
contracts. Their canonical sources must land before the master application can
resolve those imports. Group additionally needs the canonical Registry atomic
ownership cell/transaction capability; the history owner cannot supply it.
Registry's open-or-activate command and Anchor's restore command require real
session/map/current-document inputs beyond a history intent. Future adapters
must obtain them from those owners; a semantic intent cannot be cast into a
mounted target or a full Anchor context. Recent restore receipt provenance also
requires the actual recent-closed owner. This slice does not attach to Write,
Frame, Main, SDK, routing, transport or storage and establishes no runtime,
privacy/security, IME or full issue acceptance.

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
- `behavior-doc-static-admission->test-inventory`
- `behavior-doc-static-admission->test-quality-lint`
- `behavior-doc-static-admission->ux-viewport-plan-progress`
- `behavior-doc-static-admission->validate-matrix`
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
- `pr-smart-gate-plan->source-governance`
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
- `validate-declarations->behavior-doc-static-admission`
- `validate-declarations->pr-smart-gate-plan`
- `validate-matrix->app-config-local-tuning`
- `validate-matrix->behavior-test-evidence`
- `validate-matrix->native-fuzz-sanitizer`
- `validate-matrix->native-smoke`
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

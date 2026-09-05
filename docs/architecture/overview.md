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
- `backend-cache-invalidation-batch->backend-qps`
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
- `backend-qps->production-correctness`
- `backend-qps->release-evidence`
- `backend-qps-article-detail-miss->backend-qps`
- `backend-qps-cache-hit->backend-qps`
- `backend-qps-cache-miss-singleflight->backend-qps`
- `backend-qps-cache-registry->backend-qps`
- `backend-qps-comment-cursor->backend-qps`
- `backend-qps-hotread->backend-qps`
- `backend-qps-index-plan->backend-qps`
- `backend-qps-list-pagination->backend-qps`
- `backend-qps-related-reading->backend-qps`
- `backend-qps-risk-filter->backend-qps`
- `backend-qps-view-count-flush->backend-qps`
- `backend-qps-visitlog-invalidation->backend-qps`
- `backend-test-governance->backend-nightly`
- `backend-unit->backend-fast`
- `behavior-doc-static-admission->aeds-compression-profile`
- `behavior-doc-static-admission->app-config-local-tuning`
- `behavior-doc-static-admission->backend-benchmark-regression`
- `behavior-doc-static-admission->backend-build-governance`
- `behavior-doc-static-admission->backend-cache-invalidation-batch`
- `behavior-doc-static-admission->backend-mutation`
- `behavior-doc-static-admission->backend-mutation-changed-critical`
- `behavior-doc-static-admission->backend-perf`
- `behavior-doc-static-admission->backend-qps-article-detail-miss`
- `behavior-doc-static-admission->backend-qps-cache-hit`
- `behavior-doc-static-admission->backend-qps-cache-miss-singleflight`
- `behavior-doc-static-admission->backend-qps-cache-registry`
- `behavior-doc-static-admission->backend-qps-comment-cursor`
- `behavior-doc-static-admission->backend-qps-hotread`
- `behavior-doc-static-admission->backend-qps-index-plan`
- `behavior-doc-static-admission->backend-qps-list-pagination`
- `behavior-doc-static-admission->backend-qps-related-reading`
- `behavior-doc-static-admission->backend-qps-risk-filter`
- `behavior-doc-static-admission->backend-qps-view-count-flush`
- `behavior-doc-static-admission->backend-qps-visitlog-invalidation`
- `behavior-doc-static-admission->backend-test-governance`
- `behavior-doc-static-admission->behavior-evidence-pre-runtime`
- `behavior-doc-static-admission->behavior-test-evidence`
- `behavior-doc-static-admission->browser-performance-regression`
- `behavior-doc-static-admission->coverage-frontend`
- `behavior-doc-static-admission->cross-stack-contract`
- `behavior-doc-static-admission->csrf-browser-matrix`
- `behavior-doc-static-admission->current-schema-bootstrap-integration`
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
- `bootstrap->backend-qps`
- `bootstrap->backend-qps-runtime-sequential`
- `bootstrap->browser-diagnostics-manual`
- `bootstrap->browser-diagnostics-nightly`
- `bootstrap->browser-runtime-risk-diagnostics`
- `bootstrap->data-scale-m`
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

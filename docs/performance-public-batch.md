# Public Performance Optimization Batch Evidence

This document closes the public performance batch tracked by #166. Runtime work landed in #167 through #176; this page records the final evidence shape and the checks that keep it covered.

## Batch Scope

- #167 split telemetry bus work out of the public entry cold path.
- #168 minimized public AOT asset injection and deferred full-app takeover preloads.
- #169 removed non-critical stylesheet readiness from the public loader gate.
- #170 lazy-loaded comments, PoW prewarm and article interaction islands.
- #171 combined/deferred home featured and hot article loading.
- #172 delayed human-read challenge requests until visible dwell starts.
- #173 deferred Service Worker startup and search index shard loading.
- #174 extended PublicHotReadFastPath to public HTML routes.
- #175 added dynamic SPA fallback HTML compression.
- #176 added ongoing performance governance for admin chunks, media delivery and telemetry noise.

## Current Evidence

- Asset budget evidence: `.tmp/frontend/asset-size-budget.json`
  - Status: `ok`
  - Generated at: `2026-06-12T07:33:57.346Z`
  - Total dist bytes: `67,596,707` of `83,886,080`
  - Violations: `0`
- Route render pressure evidence: `.tmp/release-evidence/frontend-render-pressure-summary.json`
  - Status: `ok`
  - Generated at: `2026-06-12T07:28:53.833Z`
  - Hard violations: `0`
  - Soft warnings: `1` existing admin `AuditLog.vue` page-size warning
- Public route waterfall coverage:
  - `/`
  - `/article/:id`
  - `/archive`
  - `/category/:id`
  - `/tag/:id`

## Validated Transfer and Security Boundary

Dynamic SPA fallback HTML contains a per-response CSP nonce, so it deliberately uses identity encoding and does not emit `Vary: Accept-Encoding`. This keeps the nonce out of a compression oracle while preserving runtime head injection, accurate `Content-Length`, and body-free `HEAD` responses. A client that explicitly forbids identity receives `406` instead of a compressed nonce-bearing document.

Compression remains available only for pre-materialized PublicAOT artifacts that contain no per-request secret. `WebApplicationCompositionExtensionsTests` verifies that their Brotli and gzip variants are smaller than identity bytes and that the emitted bytes match the precomputed artifact variants exactly.

## Gates

- `npm run check:asset-size-budget`
- `npm run check:route-render-pressure`
- `npm run check:dom-budget`
- `npm run check:views-constraints`
- `npm run check:public-performance-batch`
- `dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter WebApplicationCompositionExtensionsTests -p:BaseOutputPath=.tmp/dotnet-test-bin/`

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

## Validated Improvement

The batch contains one directly executable >20% transfer-size improvement: dynamic SPA fallback HTML compression.

The fallback writer now renders CSP nonce and runtime head injection first, then negotiates `br`, `gzip` or identity with `Vary: Accept-Encoding`, `Content-Encoding` and accurate `Content-Length`. `HEAD` requests negotiate headers but do not write a body.

Representative rendered fallback payload:

| Variant | Bytes | Reduction vs identity |
| --- | ---: | ---: |
| identity | 9,135 | 0% |
| brotli | 162 | 98.23% |
| gzip | 231 | 97.47% |

`WebApplicationCompositionExtensionsTests` enforces the durable requirement: both br and gzip dynamic fallback bodies must be at least 20% smaller than the rendered identity HTML while preserving CSP nonce and head injection correctness.

## Gates

- `npm run check:asset-size-budget`
- `npm run check:route-render-pressure`
- `npm run check:dom-budget`
- `npm run check:views-constraints`
- `npm run check:public-performance-batch`
- `dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter WebApplicationCompositionExtensionsTests -p:BaseOutputPath=.tmp/dotnet-test-bin/`

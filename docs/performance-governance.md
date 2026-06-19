# Performance Governance

This document records the ongoing frontend performance rules that sit below the public first-screen P0/P1 work.

## Admin route chunks

Admin code is split by domain instead of a single oversized `route-admin` chunk:

- `route-admin-article`
- `route-admin-moderation`
- `route-admin-security`
- `route-admin-users`
- `route-admin-ops`
- `route-admin-dashboard`
- `route-admin-content`
- `route-admin-messages`

`check:asset-size-budget` enforces raw, gzip, and brotli budgets for `route-admin-*` chunks. ECharts must stay in the lazy `echartsRuntime` boundary and must not be imported directly by public routes or ordinary components.

## Public image delivery

Public images must carry explicit delivery metadata:

- `width` and `height` for layout stability.
- `decoding="async"` for non-blocking decode.
- `loading="lazy"` for below-fold and secondary images.
- `loading="eager"` only for above-fold images.
- `fetchpriority="high"` only for true LCP candidates, currently the public article detail cover image.
- Responsive visual images with `object-cover` or an `aspect-*` constraint must include `sizes`.

Prefer manual WebP/AVIF uploads for covers. The application must not synthesize fake covers to satisfy layout requirements.

## Production telemetry console noise

High-frequency info telemetry must not write to the production console by default. Warning and error audits remain visible. Info-level audit console output requires the explicit `VITE_FSUSBLOG_AUDIT_CONSOLE_INFO=1` flag for local diagnostics.

## Route render pressure

`check:route-render-pressure` and `check:dom-budget` cover public, user, and admin domains. Admin moderation and security routes are included so new policy/model/security surfaces cannot grow without render-pressure evidence.

## Perception-sealed v2 security budget

perception-sealed@v2 challenge telemetry records issue p99, verify p99, payload p95, and client render p95. The readiness detail budget snapshot warns when issue p99 exceeds 100 ms, verify p99 exceeds 32 ms, payload p95 exceeds 6200 bytes, or client render p95 exceeds 55 ms. These warnings are rollout gates for security observability; metrics collector failures must remain best-effort and cannot change provider verify outcomes.

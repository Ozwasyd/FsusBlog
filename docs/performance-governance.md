# Performance Governance

This document records the ongoing frontend performance rules that sit below the public first-screen P0/P1 work.

## Application configuration experiments

Application-level PublicAot and PublicHotRead knobs have one versioned catalog and a repo-local,
bounded experiment runner. The runner estimates local first-order sensitivity, pairwise interaction
and curvature, but it cannot write production configuration or relax correctness, security, resident
memory, snapshot overlap, stale/fallback, queue-age or release guardrails. High noise, residual drift
or a guardrail failure produces `insufficient-evidence`/`rejected` plus a smaller trust region and an
explicit rollback profile.

Notification queue tuning remains synthetic-only until issue #1451 defines delivery, loss, ordering
and lane semantics. Catalog authority, commands, evidence fields, model limits and profile adoption are
documented in [应用配置局部敏感度与安全步进](performance-app-config-local-tuning.md).

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

`check:asset-size-budget` enforces raw, gzip, and brotli budgets for `route-admin-*` chunks. `check:route-asset-budget` runs after a Vite build and reads `.vite/manifest.json` to report route-level raw/gzip/brotli first-entry cost, async dependency count, and forbidden public imports; it writes `.tmp/frontend/route-asset-budget.json` for CI evidence. ECharts must stay in the lazy `echartsRuntime` boundary and must not be imported directly by public routes or ordinary components.

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

## Full app takeover

Public shell takeover must keep non-first-frame plugins out of the mount window. `FsuMotion` is dynamically installed after mount through an idle/timer gate. AppRuntime ownership lives solely in `bootstrap/runtimeActivation.ts` (`dormant` → `scheduled` → `active`); the FullApp composition root schedules activation after interactive takeover (inheriting the first intent) or after-first-paint for direct SPA boots. Public AOT hydration must not mount AppRuntime. New full app plugins should either be required for first paint or follow the same deferred installation pattern.

## Perception-sealed v2 security budget

perception-sealed@v2 challenge telemetry records issue p99, verify p99, payload p95, and client render p95. The readiness detail budget snapshot warns when issue p99 exceeds 100 ms, verify p99 exceeds 32 ms, payload p95 exceeds 6200 bytes, or client render p95 exceeds 55 ms. These warnings are rollout gates for security observability; metrics collector failures must remain best-effort and cannot change provider verify outcomes.

The perception-sealed@v2 issue path is intentionally stateless: providers generate the challenge id, render material, sealed token, assignment, and payload, then return them without writing PostgreSQL or Redis. The verify path owns mutable state: Redis `INCR` gates attempts, Redis SETNX-style lease acquisition enforces consume-once replay protection, asynchronous audit records verify outcomes, and the orchestrator mints the short-lived `X-Fsus-Challenge-Proof` only after provider verification succeeds. The CI matrix keeps `issue-no-db-redis-write` and `verify-redis-setnx-incr` as separate cases so issue p99 regressions cannot be hidden behind verify-path work.

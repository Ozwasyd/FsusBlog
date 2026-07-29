# Performance Governance

## Measurement noise qualification

产品性能结论必须先通过宿主 measurement noise qualification。权威 policy 是
`config/testing/measurement-noise-policy.json`，执行 owner 是
`tools/test/measurement-noise-envelope.mjs`；lane 或 nested producer 不得维护
第二套阈值或把 collector 缺失解释为零负载。

每个 measurement window 在 admission deadline 内先等待一个 clean preflight
observation，再以独立 monotonic 起点开始实际测量，并在结束后记录 post
observation。preflight、during、post 都包含宿主与 current-run 指标。
blocking 超限把运行归为 `infra.noisy-measurement-window`，此时既不能归因于
产品退化，也不能发布产品通过结论；diagnostic-only 字段只帮助解释运行。
外部进程 identity coverage 只作诊断，不冒充 required metric collector
coverage；identity 读取失败不会授权终止该进程，CPU/I/O authority 仍由 host
cumulative 与 current-run cgroup cumulative 的差值及压力指标按 policy 判定。
单项 cgroup metric 缺失时保留其他 partial evidence，但 preflight 仍不满足，
不得启动 measurement workload；资格与产品结论 fail closed。已测宿主噪声超限
同样在 preflight 直接阻止产品启动。
三轮 Production fresh qualification 的每一轮必须独立 clean，retry 不能覆盖
首次 noisy evidence。

Matrix 中直接拥有 envelope 的 tier 不与同轮 sibling task 共享执行 wave，并通过
`benchmark-window` 防止多个测量 owner 重叠；该调度隔离不改变被测 workload 的
并发，也不要求锁定或清理整台宿主，外部进程仍由 collector fail closed 判定。
Benchmark build producer 在 admission 之前独立回收且记录能完整证明属于本轮
run/namespace/build root/Fresh 或 resume source 的 attached 或 detached build server；
qualification owner 本身保持只观察，不终止进程。sibling、IDE、未知 owner 和
其他外部进程始终留给 collector 按 policy fail closed 分类。

Linux direct lane 由 transient user-systemd service 建立 task-owned cgroup；
collector 要求 `cgroup.procs` 与 measured root 的完整 process tree 精确相等，
shared/incomplete cgroup 一律 fail closed。command environment 通过 run-local
`0600` JSON carrier 交给 bootstrap，不展开到 `systemd-run` argv。matrix owner
审计由 `config/testing/measurement-window-inventory.json` 固定；外部 72h soak
只有在导入并完整验证 `external-soak/72h` envelope receipt 后才能计入
release-final。

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

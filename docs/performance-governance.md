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

## Markdown preview paired Release diagnostic acceptance

`markdown-preview-release-performance` 比较两份显式、不可变且彼此独立的
Release side。它不会 checkout、构建、寻找 `latest` 或从一个 artifact root
复制出两侧；base 与 candidate 必须分别拥有 clean source checkout、production
build receipt、Release static/backend runtime 和同一份
`acceptance-representative` fixture。调用方不得手工拼 side manifest，而要为每侧
先写不含 source identity、artifact digest、machine、browser version、storage-state
digest 或 identity-probe response 的 declaration，再调用唯一 sealer：

```bash
npm --prefix src/frontend run seal:markdown-preview-release-side -- \
  --declaration /evidence/base-declaration.json \
  --output /evidence/base-side.json

npm --prefix src/frontend run seal:markdown-preview-release-side -- \
  --declaration /evidence/candidate-declaration.json \
  --output /evidence/candidate-side.json
```

declaration schema 是
`fsusblog.markdown-preview-release-performance-side-declaration.v1`。它只声明
side、source root、production artifact root/receipt、Release runtime URLs/routes
与 identity-probe header names，以及 fixture root/profile/identity。sealer
现场运行 `git rev-parse HEAD`、`git rev-parse HEAD^{tree}` 与 canonical worktree
fingerprint，要求 checkout clean 并与 production receipt 的 commit/fingerprint
一致；frontend domain、SSR/client entry digest 从 receipt 派生；machine/cgroup/
cpuset、managed Chromium version、storage-state digest 与 identity-probe
status/body/header 都从当前环境实测。probe header 只允许
`X-Fsus-Release-Id`、`X-Fsus-Build-Identity` 的小写名称，并必须包含
`x-fsus-release-id`；实测值必须等于 declaration 的 `releaseId`。`releaseId`
必须通过 canonical release-id contract 且其 commit prefix 与 side source commit
一致，`buildIdentity` 必须等于 `releaseId`。没有独立 live 或 manifest authority
的 image digest 不属于此 diagnostic side schema。manifest 和 evidence 不内联
cookie、authorization、token、key 或 storage state。
输出以 `0444` 原子封存，并再次经过 measurement consumer 的 exact-schema verifier。

两份 manifest 生成后，唯一测量入口是：

```bash
FSUSBLOG_MARKDOWN_PREVIEW_BASE_MANIFEST=/evidence/base-side.json \
FSUSBLOG_MARKDOWN_PREVIEW_CANDIDATE_MANIFEST=/evidence/candidate-side.json \
npm --prefix src/frontend run check:markdown-preview-release-performance
```

该入口是 `browser-diagnostics` owner 下的 manual diagnostic acceptance：
matrix 中 `evidenceClass: diagnostic`、`requiredFor: none`，不进入
`release-final` authoritative closure。noise receipt 的
`qualificationEligible: true` 只表示当前测量窗口足以形成这次产品性能结论，
不改变 evidence class，也不是 release-final 证据。

lane 在启动时只删除其三个固定 output owner，随后由 measurement-noise admission
包裹真实 runner。执行顺序固定为每侧一次 warmup，再进行五轮 serial retained
measurement；每轮交替先测 side，最终每侧恰有五个保留样本。AOT 与 client
Markdown median 的 candidate/base ratio 均不得超过 `1.02`，private preview
不得超过 `1.03`，每个对应 retained sample 及两侧最大值都不得出现 raw AEDS
response bytes 增长。比较使用未舍入 median；缺样本、重样本、零值、NaN、顺序
漂移、feature/placeholder/browser error、runtime/source/machine drift 均 fail closed。
每个 retained/warmup sample 的 article、about 与 admin write navigation response
都必须携带与 side 相同的 `x-fsus-release-id`；article/about 还必须从受服务 HTML
的 `#fsus-public-boot-config.frontendBuildIdentity` 读到同一 identity。该逐次
navigation evidence 会写入 raw measurement，并由最终 sealer 对 side manifest
独立复核；admin route 不要求不存在的 public boot config。

private preview 的 `preview:sha256:*` 是后端响应与 DOM completion 的 source
identity；FsusUI 的 `markdown:*` 只用于 render/activation completion。二者必须
分别在各自域内相等，不能直接互比。最终
`.tmp/perf/markdown-preview-release-performance/summary.json` 只有在 raw
measurement、固定 threshold/schedule 的独立重算和同一 raw file digest 的 clean
noise receipt 全部通过后才重建；同目录的 `raw-measurements.json` 与
`measurement-noise.json` 保留完整绑定。

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

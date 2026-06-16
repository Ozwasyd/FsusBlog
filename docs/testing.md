# 测试策略

FsusBlog 采用机器可读测试 DAG。`tests/matrix.yml` 是唯一测试拓扑源，`tools/run-test-matrix.mjs` 负责 `preflight` / `validate` / `list` / `plan` / `run` / `ci-plan` / `docs` / `evidence-plan`，`tools/test.sh` 仅保留兼容入口并代理到 runner。

---

## 层级总览

层级表由 `tests/matrix.yml` 生成，提交快照见 [testing.generated.md](testing.generated.md)。本地查看当前 production DAG：

```bash
./tools/test.sh production --plan-only
```

更新生成文档：

```bash
node tools/docs/generate-testing-docs.mjs --out docs/testing.generated.md
node tools/docs/generate-testing-docs.mjs --check
```

本地与 GitHub Actions 使用同一个 matrix 元数据。常用复现入口：

```bash
./tools/test.sh ci-fast
./tools/test.sh ci-production
./tools/test.sh ci-job fast-backend
./tools/test.sh ci-tier backend-fast
./tools/test.sh ci-plan --out .tmp/ci-plan.json
```

`ci-job <job>` 按 `ciJob` 聚合运行该 Actions job 里的 required matrix tiers；`ci-tier <tier>` 运行单个 tier，默认包含它的 matrix 依赖，可继续传 `--no-deps` 或 `--shard i/n`。每个 tier 执行前都会在日志里打印对应的本地复现命令。完整 tier 与 CI job 对照见 [testing.generated.md](testing.generated.md)。

Matrix 同时声明调度元数据：`phase` 表示 CI DAG 阶段，`cost` 表示预期耗时，`resourceClass` 标识主要资源（如 `browser`、`database`、`benchmark`），`maxParallel` 约束 shard 并发，`requiresBootstrap` 标明是否依赖本地 runtime bootstrap。GitHub Actions 的 sharded jobs 必须与 matrix `maxParallel` 保持同步；benchmark 类 tier 固定 `maxParallel=1`，避免与噪声较大的浏览器/负载套件共享 runner 时污染结果。

Matrix 也声明 setup/cache 元数据：`requiresNode`、`requiresDotnet`、`requiresPlaywright` 表示运行时需求，`cacheProfile` 表示依赖缓存需求。`cacheProfile=frontend` 必须使用 `actions/setup-node` 的 npm cache，并固定 `cache-dependency-path: src/frontend/package-lock.json`；`cacheProfile=backend` 必须使用 `~/.nuget/packages`，key 固定由 `*.csproj`、`*.props`、`*.targets`、`global.json`、`NuGet.config` 共同计算；`full` 同时要求两者。Playwright tier 只安装声明的浏览器：`chromium` tier 只安装 Chromium，cross-browser tier 使用 `${{ matrix.browser }}`。

### Frontend fast Vitest sharding

`frontend-fast` 是 shardable tier，默认 `defaultShards=2`。GitHub Actions 的 `fast-frontend-unit` job 使用 `node tools/run-test-matrix.mjs ci-job-matrix fast-frontend-unit` 生成 shard matrix，并分别运行：

```bash
./tools/test.sh ci-tier frontend-fast --no-deps --shard 1/2
./tools/test.sh ci-tier frontend-fast --no-deps --shard 2/2
```

`--shard i/n` 会注入 `FSUSBLOG_TEST_SHARD_INDEX/TOTAL`，`run_fast_frontend_lane()` 将其转换成 Vitest `--shard=i/n`，只传给 `test:unit:fast`、`test:property`、`check:frontend-state-machines` 和 `check:frontend-perf-regression`。build、static governance、contract checks 仍保持原命令；后续若要减少重复 setup，应通过独立 tier 拆分处理。

每个 shard 上传独立 artifact：`fast-frontend-unit-1-of-2`、`fast-frontend-unit-2-of-2`。artifact 内容仍包含 `src/frontend/coverage/**`、`.tmp/frontend/**` 和 `.tmp/release-evidence/jobs/**`；fast-summary 通过 `fast-frontend-unit-*` pattern 合并下载。per-shard job summary 记录 `stageDurationsMs.test`，用于后续评估是否从 2 shards 提升到 4 shards。

### Frontend fast group parallelism

`frontend-fast` 先串行执行 `build` group，确保构建产物、manifest 与生成文件稳定后，再并行执行三个 post-build groups：`tests`、`runtime-contracts`、`static-governance`。`tests` group 内部仍按 unit/property/state/perf 顺序执行，避免多个 Vitest coverage/model/perf 进程竞争同一输出；`runtime-contracts` 覆盖 worker/a11y/binary/runtime/wasm checks；`static-governance` 覆盖 API parity、schema、copy/security/static policy 与 repo-root governance scripts。

并行组失败会输出具体 group 名称，例如 `parallel group failed: frontend-fast-post-build/runtime-contracts`，避免只看到 frontend-fast 总失败。每个 group 会写入 `.tmp/frontend/frontend-fast-groups.jsonl`，成功完成时汇总为 `.tmp/frontend/frontend-fast-groups.json`；`run-test-matrix` 会把这些数据复制到 `fast-frontend-unit-*` job summary 的 `groupDurationsMs` / `groupResults` 字段中，CI summary 与 artifact 都能看到 build/tests/runtime-contracts/static-governance 的耗时。

### Browser lane scaling policy

浏览器 lane 优先通过 shard 扩展，再考虑提高 Playwright workers。shard 提供独立进程、独立 namespace、独立 artifact 和 per-shard `stageDurationsMs.test`；worker 只在 lane 已有稳定 shard 证据后提高。

| Lane | Scale mode | Current policy | Artifact isolation | Worker policy |
|---|---|---|---|---|
| `acceptance` | shard-only | `4` shards, `maxParallel=4` | `acceptance-playwright-1-of-4` ... `4-of-4` | keep `playwrightWorkers=1` |
| `visual-public` / `visual-console` | shard + worker | each group uses `2` shards, `maxParallel=2`; `visual` aggregate is artifact-only | `visual-public-playwright-1-of-2` / `2-of-2`, `visual-console-playwright-1-of-2` / `2-of-2`, aggregate `visual-playwright` | keep `playwrightWorkers=2`; do not raise without visual baseline evidence |
| `ux-viewport-smoke` | shard-only | `2` shards, `maxParallel=2` | `ux-viewport-smoke-1-of-2` / `2-of-2` | keep `playwrightWorkers=1` |
| `cross-browser-smoke` | browser matrix | chromium/firefox/webkit matrix, no spec shard | browser-specific artifact | keep worker `1` |
| `frontend-render-pressure` | single process | no shard; measures DOM/render pressure noise | single artifact | no Playwright worker scaling |
| `resilience` | single process | no shard; shares fault/runtime state | single artifact | no Playwright worker scaling |

Acceptance parallelism decision（2026-06-15）：在不提高 worker 的前提下采用 `maxParallel=4`。旧 `maxParallel=2` 会把 4 个 acceptance shards 排成两波；`maxParallel=4` 让 4 个独立 shard 同时开始，理论 wall-clock 从两波 shard 总和降为最慢 shard。本轮 evidence 由 `node tools/run-test-matrix.mjs ci-job-matrix acceptance-playwright` 与 `node tools/run-test-matrix.mjs ci-plan --format github-actions` 记录：4 个 `acceptance-playwright-*-of-4` shard、`playwrightWorkers=1`、job `maxParallel=4`。该变更只增加进程级 shard 并发，不提高单 shard 浏览器 worker 数；如果 per-shard job summary 或 flaky evidence 显示任一 shard 新增不稳定，回退路径是把 `tests/matrix.yml` 中的 `acceptance.maxParallel` 降回 `2`，workflow 会从 validate-matrix 输出同步回退。

`ux-viewport-smoke` sharding plan：smoke 模式覆盖一组 viewport/route/content-boundary 快速断言，适合先按 Playwright 原生 `--shard 1/2`、`2/2` 分片，而不是提高 worker。`check:ux:viewport-smoke` 必须传递 `${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-}`；每个 shard 上传 `.tmp/ux/**`、`.tmp/release-evidence/ux-viewport-summary.json` 和 `src/frontend/test-results/playwright/ux-viewport-smoke/**`。`ux-viewport-visual` 与 `ux-viewport-boundaries` 保持单进程，因为它们涉及截图/边界证据，需单独评估后再 shard。

### Screenshot evidence tiers

截图检查拆成两个独立 CI tier：`visual-public` 只运行公开页截图检查，输出 `.tmp/visual/public/**` 与 `src/frontend/test-results/playwright/visual-public/**`；`visual-console` 只运行控制台截图检查，输出 `.tmp/visual/console/**` 与 `src/frontend/test-results/playwright/visual-console/**`。两个 tier 都写入 `fsusblog.visual.screenshot-group.v1` summary，记录独立 `durationMs`、状态、shard 参数和 Playwright output dir。

`visual` tier 不再执行浏览器测试，只下载 `visual-public-playwright-*` 与 `visual-console-playwright-*` artifact 后运行 `tools/visual/aggregate-screenshot-evidence.mjs`，生成 `.tmp/visual/summary.json` 和 `.tmp/release-evidence/visual-screenshot-summary.json`。aggregate evidence 使用 `fsusblog.visual.screenshot-aggregate.v1`，保留 public/console 的 `groupDurationsMs`、job summary 路径和组合证据路径；缺少任一组 summary、job summary 非 success、或组状态为 failure 都会让 aggregate tier 失败。

CI 的安装步骤必须通过 `node tools/ci/run-stage.mjs --stage install -- ...` 执行，并把耗时合并到 `.tmp/release-evidence/jobs/<job>.json`。job summary 的 `failureStage` 只能是 `setup`、`restore`、`install`、`bootstrap`、`test`、`artifact`、`summary`，`stageDurationsMs` 会保留每个阶段的 wall-clock 耗时；因此 npm/Playwright install 失败、runtime bootstrap 失败、测试失败和 release evidence 汇总失败可以在 artifact 中区分。

Flaky 治理由 `tests/flaky.yml` 和 `tools/ci/check-flaky-registry.mjs` 控制。每个 quarantine 条目必须包含 `suite`、`test`、`issue`、`reason`、`expires`、`allowedRetries`、`owner`、`mode`、`classification`；过期条目会使 CI 失败。默认策略是不重试：unit、static governance、security、backend deterministic gates 都不得 silent retry。只有 browser-heavy suites 通过 `tools/ci/run-flaky-governed.mjs` 允许最多 1 次 retry 并写入 `.tmp/release-evidence/flaky/<suite>.json`；Production Summary 会把 `passed-after-retry` 和 clean pass 分开展示。Benchmark/perf 噪声不得走通用 flaky retry，必须使用独立的 `benchmark-noise` 分类和性能 evidence。`release-final` 会使用 `--release-final` 模式重新校验 registry/evidence，并拒绝任何 retry、skip 或 critical quarantine 证据。

`coverage-gate` 与 `production` 是两个 independent required checks：coverage 负责阈值和合并覆盖率，production 负责运行时风险 DAG。`release-final` 在二者之上增加 strict coverage、changed-code coverage、critical module coverage、strict shard completeness、no visual skip、live exposure、artifact digest binding 和 test-quality lint。

`load` 与 WebSocket pressure 检查会写入 `.tmp/perf/load-public-api.json` 和 `.tmp/perf/notification-stream-pressure.json`，release evidence 会把 `.tmp/perf/` 作为性能证据归档。默认参数来自 `tests/perf/perf-policy.yml`：HTTP load baseline 为 `concurrency=10`、`rounds=6`、`durationMs=30000`；WebSocket pressure 为 `connections=50`、`durationMs=30000`。

性能证据默认采用项目内基线：single process、Kestrel-only、无 nginx、无 CDN、无 reverse-proxy cache、无代理压缩层计入结果。nginx/Caddy/CDN 可以作为生产部署层存在，但相关数据必须写入独立的 `optional_deployment_layer`，并标记 `counted_as_project_baseline=false`。

Backend QPS/perf artifact 必须包含以下 metadata。`backend-qps` lane 由 `tools/test/lanes/runtime-evidence-probe.mjs` 写入该块，Docker/wrk 性能脚本也必须保持同一语义：

```yaml
performance_baseline:
  date: YYYY-MM-DD
  mode: kestrel-only
  process_count: 1
  reverse_proxy: false
  cdn: false
  response_compression_proxy: false
  native_aot: false
  ready_to_run: true|false|null
  tiered_pgo: true|false|null
  runtime: dotnet-10
  database: postgres version / local-or-remote / unknown
  redis: redis version / local-or-remote / unknown
  machine: cpu/memory/kernel / unknown

optional_deployment_layer:
  reverse_proxy: none|nginx|caddy|cloudflare|other
  proxy_cache: true|false
  proxy_compression: true|false
  counted_as_project_baseline: false
```

未来性能 issue / perf evidence checklist：

- 明确目标属于 `kestrel-only internal baseline` 还是 `optional deployment-layer`；未声明时默认前者。
- QPS、latency、cache hit、compression 和 static file 结论不得混用 Kestrel-only 与代理层结果。
- 如果 `baseUrl` 指向 nginx/CDN/reverse proxy，必须在证据中保留 `optional_deployment_layer`，并另行说明代理缓存、压缩和 buffering 设置。
- 项目内优化 issue 不得把 CDN、nginx proxy cache 或代理压缩计为验收收益。

---

## 各层详解

### `fast` — 快速静态治理与单元测试

**触发时机**：本地提交前、PR 检查

**覆盖内容**：
- `tests/backend/Unit/` — 服务逻辑、工具函数、DTO 映射
- `PodContractValidation.AreAllPodModelsReferenceFree()` — POD 引用安全断言
- AEDS v2 帧头编解码逻辑（`AedsEncoder`、`AedsDecoderValidator`）：16-byte header、CRC16、payload length、unknown version 拒绝、v1 frame 拒绝
- compact POD round-trip：article list/detail/hot/category/tag/comment/stats 与损坏 payload 拒绝
- JWT 签发与校验逻辑（`JwtHelper`）
- 缓存键构建逻辑（`CacheKeyBuilder`）

**单独运行**：
```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter "Category!=Integration" -v minimal
```

---

### `integration` — 服务端集成测试

**触发时机**：PR 检查、分支合并前

**前置条件**：
```bash
docker compose -f docker-compose.dev.yml up -d
# 等待 /health/ready 通过
```

**覆盖内容**：
- `tests/backend/Integration/` — 真实数据库 + Redis
- 端点级集成：文章 CRUD、评论流、分类/标签查询
- 缓存回填与失效（L1 + L2）
- 认证流程：注册 → 登录 → refresh → logout
- PoW 挑战-答案验证（Redis backed）
- 会话吊销语义

**单独运行**：
```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter "Category=Integration" -v minimal
```

---

### `release` — 公开页与 AOT 测试

**触发时机**：Release 构建验证、生产部署前

**前置条件**：`http://127.0.0.1:8080` 可访问（Release 构建容器）

**覆盖内容**（主要通过 `npm run check:*` 系列）：
- `check:public-seo-smoke` — 公开页 SEO 标签（canonical、description、OpenGraph、Twitter card、feed discovery、JSON-LD `@graph`/`WebSite`/`SearchAction`/`BreadcrumbList`/`BlogPosting`）
- `check:public-hydration` — AOT 首屏到 SPA hydration 无闪白，并核验文章详情 hydration/bootstrap 均携带 `relatedReading`
- `check:aot` — AOT 契约合规（`PublicAotShellEntryContract` 格式验证）
- `check:error-code-alignment` — 前后端错误码枚举一致性

`check:public-hydration` 中的 refresh hydration detector 会把匹配 Vue hydration 关键词的 `console.warn`、`console.error` 与 `pageerror` 统一视为 release-blocking failure；不得以 `PASS (n warning(s))` 形式放行 hydration warning。该 detector 每次运行都会写入 `.tmp/release-evidence/public-hydration-detector-summary.json`，schema 为 `fsusblog.public-hydration-detector.v1`，并包含 route、stage、browser、viewport、warnings/errors 与 detector canary 结果。release evidence manifest 会索引该文件；缺失或 `status != "success"` 会阻断 release closeout。

Public hydration matrix 由 `tests/frontend/checks/public/public-hydration-matrix.registry.json` 统一声明，新增公开 AOT page kind 必须同步 registry，否则 `check-public-hydration-matrix-governance.mjs` 会因 manifest 覆盖漂移失败。`public-hydration-fast` 是 PR 级轻量治理 lane，输出 `.tmp/release-evidence/public-hydration-matrix-summary.json`；`release` lane 在 #330-#335 summary 全部生成后以 `FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS=1` fail-closed 校验并写合并 summary；`public-hydration-nightly` 保留 Firefox/WebKit、更多 state/clock/fixture/cache 组合的 off-critical-path shard 策略。

**Public hydration matrix 本地复现**：
```bash
./tools/test.sh ci-tier public-hydration-fast --no-deps
./tools/test.sh ci-tier release
./tools/test.sh ci-tier public-hydration-nightly --no-deps
```

---

### `acceptance` — 全量 Playwright E2E

**触发时机**：发布分支、合并到 main 前

**前置条件**：全部服务（前端 3000、后端 5000、Release 8080）可访问

**覆盖场景**：
- `spa-routes` — SPA 所有路由跳转无白屏
- `public-routes` — 公开页直接访问与 hydration
- `acceptance` — 完整用户流程（注册 → 登录 → 发评论 → 登出）
- 管理员流程（内容管理、消息广播）
- 作者工作台：私有预览、SEO/质量发布前检查、warning 跳过理由审计、封面上传、资产库重建与复用、修订历史与回滚

**运行**：
```bash
cd src/frontend
npx playwright test --config=playwright.config.ts
```

---

### `visual` — 视觉回归

**触发时机**：UI 组件或样式变更后

**覆盖内容**：
- 深色模式 / 浅色模式截图比对
- viewport registry 来自 `tests/frontend/fixtures/ux-viewport-matrix.json`
- screenshot baseline 视口：`narrow-mobile` 360x780、`mobile` 390x844、`desktop` 1440x960
- smoke/boundary 额外覆盖 320x568、844x390、1024x900、1366x640、2560x1440、3440x1440 等极端尺寸
- 截图基线版本管理（`test-results/` 目录）

更新视觉基线：
```bash
cd src/frontend
npx playwright test --update-snapshots
```

---

### `security` — 安全场景测试

**触发时机**：认证/鉴权代码变更后、安全审计

**覆盖场景**：

| 场景 | 测试内容 |
|------|---------|
| 匿名请求 | 公开端点可访问；私有端点返回 401 |
| 登录请求 | 有效 JWT 授权成功；过期 Token 返回 401 |
| Admin 请求 | admin 角色可访问管理端；普通用户返回 403 |
| PoW 验证 | 无 PoW 头的注册/登录请求被拒绝 |
| MFA 流程 | 启用 MFA 后登录触发挑战；恢复码单次有效 |
| Passkey 流程 | 注册上限（5枚）、断言失败处理 |
| 封禁用户 | `BannedUserFilter` 拦截写操作 |
| 会话吊销 | 吊销后的 Refresh Token 无法续签 |
| Binary 鉴权一致性 | `/api/binary/**` 端点自身声明并验证公开/登录/admin/PoW 边界 |
| 通知鉴权 | WebSocket 私人事件仅已认证连接接收 |
| CORS | 非白名单来源请求被拒绝 |
| 安全头 / Cookie | CSP、XFO、XCTO、Referrer-Policy、Permissions-Policy、auth/PoW no-store、`__Host-*` Cookie 属性 |
| 攻击矩阵 | CSRF 形态、伪造 Cookie/JWT、篡改 PoW、method override、路径穿越、超大 / 畸形 binary payload |
| ASVS / WSTG 矩阵 | `tools/security/check-security-matrices.mjs` 校验 `security/asvs-v5.0.0-matrix.yml` 与 `security/wstg-v4.2-matrix.yml` 的版本化 ID、代码/测试/证据路径和 owner |
| 供应链审计 | `tools/security/check-supply-chain-audit.sh` 对 NuGet 和 npm production dependencies 执行 high/critical vulnerability gate |
| SBOM | `tools/security/generate-sbom.sh` 从 NuGet lock files、`package-lock.json` 和 image digest 生成 CycloneDX 1.5 evidence |
| ZAP WARN 策略 | `tools/security/check-zap-warn-policy.mjs` 校验 `security/zap-warn-policy.yml`，要求每个 WARN 有 owner、接受理由、修复期限和升级条件 |
| DAST | OWASP ZAP baseline 扫描本地前后端目标，FAIL 级告警阻断发布 |
| 生产暴露面工具 | `tools/security/test-production-exposure-tools.sh` 用合成 DNS/firewall/live evidence 覆盖 prereq handoff/returned 脚本与 tar/find/xargs 依赖清单、evidence request schema、request `requiredEvidence`/`verificationCommands`/`handoffChecks`、request returned-evidence/returned-handoff verifier 与 closeout 命令、request currentStatus/nextActions/unblockPlan、firewall source sha256 生成/缺失/格式/原始文件摘要不匹配拒绝、handoff request 缺失 firewall source sha256 合同拒绝、status report requiredHosts/delegationDomains、live/DNS readiness `requiredHosts` 与 DNS delegation `delegationDomains` 字符串/数组形态、handoff request/status/manifest 对齐、request/status 域名漂移拒绝、request/status blocker 明细漂移拒绝、request requiredEvidence 路径漂移拒绝、request 缺失 handoff check 拒绝、request 缺失 blocker source 的 unblockPlan 拒绝、request 缺失 returned handoff closeout 命令拒绝、request 顶层 returned verifier 命令漂移拒绝、manifest request firewall source sha256 合同漂移拒绝、manifest request returned closeout command summary 漂移拒绝、manifest request unblockPlan summary 漂移拒绝、manifest blocker 明细漂移拒绝、manifest external exposure valid 漂移拒绝、manifest external exposure 组件状态漂移拒绝、request evidenceFiles 路径漂移拒绝、request/status artifact digest 漂移拒绝、manifest host/domain drift 拒绝、release bundle exposure artifact drift 拒绝、bundle artifact 非标准路径拒绝、manifest sha256 digest 校验、缺失 artifact 残留 digest 拒绝、handoff bundle 导出前校验、exporter 输出目录/tarball 自校验、tarball 解压前路径穿越和非普通 entry 拒绝、summary/operator checklist/returned-evidence manifest/README/校验和/tarball 生成、handoff bundle checker 目录/tarball 验证与篡改 returned manifest/README/artifact digest/symlink/archive path traversal/unsupported entry 拒绝、含 symlink 源 release evidence 导出失败、handoff summary unblockPlan、operator checklist unblockPlan、returned manifest unblockPlan 拒绝、returned handoff closeout 对完整 bundle 的 preflight 校验和篡改 operator checklist fail-closed、direct returned-evidence closeout 对父级 handoff bundle 的 preflight 校验和篡改 operator checklist fail-closed、returned expected manifest source metadata 与 unblockPlan sources/count/key/file/artifact/command 映射拒绝、returned evidence 目录验收与 symlink 拒绝、ok/blocked returned manifest 保留、returned request 与 expected manifest scope 缩窄拒绝、returned evidence 成功 closeout 与 missing expected manifest/blocked/缩窄 request/缩窄 manifest fail-closed、临时 fixture 路径拒绝、manifest request summary、complete closeout 自动生成并刷新 request、verifier、status report、失败写 blocked status report、早期失败仍刷新后续 evidence、成功 closeout 写出 `status=ok` |
| 回传 handoff 收口 | `complete-production-exposure-from-returned-handoff-bundle.sh` 覆盖空 returned-evidence 槽 fail-closed、目录输入成功 closeout、tarball + `.sha256` 输入成功 closeout、blocked tarball 输入 fail-closed 且保留解包后的 blocked status 证据、symlinked returned-evidence tarball 与 archive path traversal tarball 解压前拒绝、handoff bundle README/expected manifest 暴露一键 closeout 命令，并复用 returned evidence scope/verifier 规则 |

**DAST 依赖**：

- 本地和 CI 必须可运行 Docker。
- 默认镜像：`ghcr.io/zaproxy/zaproxy:stable`，可用 `FSUSBLOG_ZAP_IMAGE` 覆盖。
- 报告输出：`.tmp/security/zap/`，CI 会上传到 `quality-gate-artifacts`。
- ZAP WARN 级告警会保留在报告中；FAIL 级告警或扫描器错误会使 `security` / `production` 失败。

---

### `resilience` — 弹性测试

**覆盖内容**：
- **上传弹性**：分片上传中断后续传、过期上传清理
- **通知弹性**：慢消费者断开、断线重连游标恢复
- **搜索弹性**：Service Worker 离线搜索降级
- **Wasm 解码**：Binary 解码失败应暴露协议错误，不得回退到文本 API
- **AEDS v2 兼容边界**：服务端、TypeScript adapter、Worker 与 Wasm decoder 均拒绝 v1 frame；记录列表类响应 raw bytes 与 decode ms 基线，4 KiB 以内走主线程 decode，大包走 Worker/Wasm
- **Redis 短暂不可用**：L1 缓存兜底行为

---

### `load` — 轻量并发压测

> 非性能基准，仅验证基础并发稳定性。

**覆盖内容**：
- 文章列表 / 详情并发读（baseline `concurrency=10`、`rounds=6`、`durationMs=30000`，源自 `tests/perf/perf-policy.yml`）
- Binary 链并发读
- WebSocket binary notification stream 多连接稳定性（`connections=50`、`durationMs=30000`）

**backend-perf-readiness / 性能基准**：

`backend-perf` 在矩阵中是 BenchmarkDotNet build/readiness tier，只构建并确认 benchmark 项目可用；真实回归运行由 `backend-benchmark-regression` 负责并输出 release evidence。

`backend-qps` 是运行时 HTTP probe 证据，默认命名口径为 `backend-qps-kestrel-only`：调用本仓库启动的 Kestrel 进程，证据中 `performance_baseline.mode=kestrel-only`。如果要对 nginx/CDN/reverse proxy 做部署层对比，使用单独 artifact 名称（例如 `backend-qps-deployment-proxy-optional`），并保持 `optional_deployment_layer.counted_as_project_baseline=false`。

CI 将 `backend-qps` 拆为两个阶段：`backend-qps-collectors` 使用 matrix 并发运行 `backend-qps-*` collector tier，每个 collector 在独立 runner 中 bootstrap 本地 app stack 并只上传 `.tmp/perf/backend-qps/<mode>.json`；`backend-qps` aggregate job 等待 collectors 与 `integration-runtime`，下载 collector artifacts 后运行 `tools/test/lanes/backend-qps.sh aggregate`，统一写入 `.tmp/release-evidence/backend-qps-summary.json`。collector 不再各自写 summary，避免并发覆盖；本地 `./tools/test.sh backend-qps` 仍通过 matrix DAG 先完成 bootstrap 和 collectors，再执行 aggregate。

CI 的 file-only checks 与 app-stack checks 必须分阶段：`cross-stack-contract` 只运行 `backend-api-integration` 与 `cross-stack-contract` 这类仓库文件/生成契约检查；`security-static-fuzz` 只运行 `wasm-fuzz-regression` 与 `contract-fuzz`；需要本地 app stack 的 `endpoint-depth-runtime`、`integration-runtime`、`security-runtime` 保持独立 job。新增检查时若 `services: []` 且 `requiresBootstrap: none`，优先放入对应 file-only job，不能塞回 runtime job。

独立运行真实 BenchmarkDotNet：
```bash
cd FsusBlog.Core.Benchmarks
dotnet run -c Release
```
结果保存在 `BenchmarkDotNet.Artifacts/results/`。当前套件覆盖 AEDS/POD encode/decode、raw cache-hit defensive copy 与 readonly fast path、合成 search rebuild/query BM25 路径，以及 Public AOT bundle encode/decode；生产调高 runtime tuning 前必须把对应基准结果随发布证据保存。

---

### `production` — production-ci-gate

`production` 是 PR/CI 的 production-ci-gate。它执行当前 production DAG 并校验 release evidence schema，但允许 manifest 为 schema-valid `collected-blocked`，用于表达外部生产证据尚未回传或占位证据仍是 `scheduled`；这不等于可以发布。

执行顺序请以机器输出为准：

```bash
./tools/test.sh production --plan-only
```

当前高层顺序为：

1. `fast`：Debug build `-warnaserror`、服务端非集成测试、`vue-tsc`、前端 release build warning-as-error、静态治理脚本。
2. 强制 bootstrap：启动或重启 PostgreSQL、Redis、Debug 后端、Vite 前端、Release Preview。`fast` 会重新生成前端 release 资源并同步到后端 StaticWebAssets，production 门禁必须在这里重启运行时，避免旧进程继续服务上一代代码或静态资源。
3. 复用同一套运行环境执行 `release`、`integration`、`security`、`acceptance`、`cross-browser-smoke`、`visual`、`ux-viewport-smoke`、`frontend-render-pressure`、`resilience`、`load`、`backend-qps`。
4. 收集 release evidence 并运行 schema/semantic check；此处不使用 `--require-ok`。

```bash
./tools/test.sh production
```

当视觉验收被明确排除在当前变更范围之外时，可以只在该轮使用：

```bash
FSUSBLOG_SKIP_VISUAL_GATE=1 ./tools/test.sh production
```

该开关只跳过 `production` 内的 `visual` tier，不会跳过 `security`、`acceptance`、`resilience` 或 `load`；常规发布仍应恢复完整 visual gate。使用该例外时必须同时设置 `FSUSBLOG_VISUAL_SKIP_REASON`、`FSUSBLOG_VISUAL_SKIP_APPROVER`、`FSUSBLOG_VISUAL_SKIP_IMPACT`、`FSUSBLOG_VISUAL_SKIP_RERUN_URL`，门禁会写入 `.tmp/gate-logs/visual-gate-skip.json` 并由 release evidence manifest 索引。

完成后检查：
```bash
curl -fsS http://127.0.0.1:8080/health/ready
```

失败时优先查看：

- `.tmp/acceptance/*.log` — 后端、Vite、preview 启动日志
- `src/frontend/test-results/playwright/` — Playwright trace / screenshot
- GitHub Actions 的 `quality-gate-artifacts` artifact

GitHub Actions 中 `Quality Gate` 会在 `pull_request`、`main` / `master` push、手动 `workflow_dispatch` 触发同一条 `./tools/test.sh production` 门控。CI 需要配置 `GITHUB_PACKAGES_TOKEN` secret，用于安装 `@ozwasyd` 私有包。Playwright worker 数从 `tests/matrix.yml` 的 `playwrightWorkers` tier policy 派生；本地排查时优先复用 matrix policy，只在明确验证隔离性后覆盖。

#### Backend affected-test selection

`Quality Gate / Fast Backend` 在 `pull_request` 上设置 `FSUSBLOG_TEST_SELECTION=affected`，并用完整 git history 计算 PR base 到当前提交的 changed files。`main` / `master` push、`workflow_dispatch`、release/manual full gates 使用 `FSUSBLOG_TEST_SELECTION=full`，继续运行完整 non-integration backend tests。

`tools/dotnet-affected-tests.sh` 的 changed-file 规则保持保守：

- 无变更或只改前端、文档、非 backend 路径时，记录 `selection=affected effective=skip` 并跳过 non-integration backend tests。
- `src/backend/`、`src/shared/`、`src/core/`、`tests/backend/`、solution/build props、`global.json` 等 backend/shared/core/test 或构建输入变更时，升级为 `selection=affected effective=full`。
- 鉴权、安全、权限相关路径，例如 `Infrastructure/Auth`、`BannedUserFilter`、`JwtHelper`、`Infrastructure/Security`、`Modules/Endpoints/Auth`、`src/shared/Contracts/Security` 以及 backend auth/security 测试变更，会记录 `reason=auth-security-sensitive` 并运行完整 non-integration backend tests；fast-backend 的独立 auth state-machine tier 仍照常运行。

日志必须同时能看出请求策略和最终策略：`run_fast_backend_lane()` 输出 `backend-fast selection=affected|full`，affected 脚本输出 `effective=skip|full` 与 `reason=...`。

#### Backend build parallelism

`backend-fast` 的 .NET build 默认仍使用 deterministic safe mode：`FSUSBLOG_DOTNET_BUILD_PARALLELISM=safe`，等价于 MSBuild `/m:1`。这保留本地 debug、release/manual full gates 与保守排障路径的单 worker 行为。

PR fast-backend 可以通过 GitHub repository variable `FSUSBLOG_DOTNET_BUILD_PARALLELISM` opt in 并行 build；支持值为：

- `safe` 或 `1`：使用 `/m:1`。
- `auto`：使用 `/m`，由 MSBuild 按 runner CPU 自动选择并行度。
- 大于 `1` 的整数：使用 `/m:N`。

`run_fast_backend_lane()` 在 build 前输出 `dotnet-build parallelism=<mode> arg=<msbuild-arg>`，用于确认 CI 实际选择的模式。无效值会直接失败，避免静默回退到未知并行度。

Benchmark 记录口径：在同一个 runner、同一个提交、同一份 NuGet cache 状态下分别运行 `FSUSBLOG_DOTNET_BUILD_PARALLELISM=safe ./tools/test.sh ci-tier backend-fast --no-deps` 与 `FSUSBLOG_DOTNET_BUILD_PARALLELISM=auto ./tools/test.sh ci-tier backend-fast --no-deps`，记录 wall-clock、退出码、重跑次数和是否出现非确定性失败。默认值只能在至少两轮 CI fast-backend 对比都显示 `auto` 无新增 flake 且明显降低 wall-clock 后再从 `safe` 提升；在此之前只通过 repo variable 对 PR fast gates opt in。

当前本地单轮 build benchmark（2026-06-15，same checkout，warmed NuGet cache after first run）：

| Mode | MSBuild arg | Wall-clock | Exit | Flake signal |
|---|---:|---:|---:|---|
| `safe` | `/m:1` | 53s | 0 | none observed in one run |
| `auto` | `/m` | 12s | 0 | none observed in one run |

这组数据只证明并行 build 在当前机器可用；它不是提升默认值的依据。CI 默认仍是 `safe`，直到 PR fast-backend 在 GitHub runner 上积累至少两轮 `safe`/`auto` 对比和 flake 记录。

#### Root CI setup 与 fail-fast 诊断

`validate-matrix` 是 Quality Gate 的根作业。它先运行：

```bash
node tools/run-test-matrix.mjs preflight
```

`preflight` 会创建并验证 `.tmp/`、`.tmp/release-evidence/`、`.tmp/gate-logs/`、`.tmp/env/`、`.tmp/docs/`，确认 test matrix、workflow、runner 脚本和 Git metadata 可用，并写出 `.tmp/gate-logs/preflight.json`。本地排查 CI 根失败时先运行同一条命令；如果失败，修复该输出里的缺失目录、权限或 matrix 错误后再看下游测试。

`ci-plan` 必须使用 `--out` 写文件：

```bash
node tools/run-test-matrix.mjs ci-plan --format github-actions --out .tmp/ci-plan.json
```

不要用 shell 重定向写 `.tmp/ci-plan.json`，因为缺失父目录时会在脚本外失败，错误信息不可操作。`production-summary` 会把非成功作业分成 earliest root non-success jobs 与 downstream fan-out：前者是应优先修复的真实根失败，后者通常是上游失败导致的 skipped/cancelled，仍然会让门禁失败，但不应被误判为通过。

#### Release evidence 与 job summary

每个 matrix tier 执行时都会更新对应 CI job 的机器摘要：

```text
.tmp/release-evidence/jobs/<job-id>.json
```

摘要使用 `fsusblog.ci.job-result.v1`，包含 `status`、`failureStage`、`rootCause`、`tierIds`、`artifacts`、`localReproduction`、`commit`、`runId` 和 `attempt`。CI matrix shard 使用稳定 job id / artifact 名称，例如 `acceptance-playwright-1-of-4`、`visual-public-playwright-1-of-2`、`visual-console-playwright-1-of-2`、`cross-browser-smoke-chromium`；基础 `ciJob` 仍保留在 `ciJob` 字段中。`cross-browser-smoke` 使用 browser matrix full-spec 模式，不再对每个浏览器固定执行 `--shard 1/3`。

失败后先看 `production-summary` 的 root failure 分组；若对应 job summary 已下载，它会附带 `failureStage`、`rootCause`、`reproduce` 和 summary artifact 路径。完整发布证据在 `.tmp/release-evidence/<stamp>/manifest.json`，其中 `artifacts.jobSummaries` 指向收集到的 `job-summaries/` 目录。`release-evidence` 在 CI 中会校验 required job summary 是否存在、schema 是否正确，以及 matrix 声明的生成型 artifact/evidence 是否由对应 job 上传。

### `release-closeout` — release-closeout-gate

`release-closeout` 只用于最终发布收口，必须要求 release evidence manifest 为 `collected-ok`：

```bash
./tools/test.sh release-closeout
tools/operations/check-release-evidence-manifest.mjs --require-ok
```

`collected-blocked` 是合法的 CI 证据状态，但不是可发布凭据。dry-run backup restore、dry-run smoke、manual-only smoke checklist、未执行 authenticated DAST、零 seed Wasm fuzz、observed-only fault injection 和空 short soak 都必须保持 blocked/scheduled，不能写成最终发布通过。

### `release-final` — final publish credential

`release-final` 是唯一最终发布凭据。它是 `tests/matrix.yml` 中的 first-class tier，但标记为 `manualOnly`，不会作为 PR/push Quality Gate 的默认 job。发布候选必须显式运行：

```bash
./tools/test.sh release-final
```

`release-final` 会从同一个 matrix DAG 派生执行路径，并在 `release-closeout` 之外额外强制：

- `coverage-gate-strict`：backend line >= 85、backend branch >= 75、frontend line >= 75、frontend branch >= 65、changed-code line >= 90，critical backend module branch >= 90 或有批准例外。
- release runtime lanes：admin console、auth flow、authoring flow、private preview、error boundary、RBAC negative path 都绑定 release artifact。
- release AOT lanes：generation、consumption、static asset digest coherence 分开验证。
- release load/scale/stability lanes：peak、burst、scale-m、soak-min、memory leak budget、open handle budget、critical mutation slice。
- strict evidence：manifest 必须为 `collected-ok`，visual skip 不能产生 clean pass，live exposure/firewall/DNS evidence 必须存在，backup restore 必须是 real drill，post-deploy smoke 必须是 deployed endpoint 自动覆盖，authenticated DAST/Wasm fuzz/fault injection/short soak 必须真实执行，job summary 必须覆盖所有 acceptance/visual shard 与 cross-browser browser combination。
- artifact binding：`tools/release/check-release-final.mjs` 要求 manifest commit、job summary commit 与 `sha256:` image digest 一致。
- test-quality lint：`tools/ci/check-test-quality.mjs` 阻断无断言测试、HTTP 200-only 弱断言和关键路径 snapshot-only 测试。

`production` 可以证明 PR/CI 风险矩阵没有已知阻断；`release-closeout` 可以证明当前 manifest 已收口；只有 `release-final` 可以作为发布候选通过的最终凭据。

---

## 测试洁净性约定

详见 `tests/backend/TESTING.md`。

核心约定：

1. **无状态污染**：每个集成测试用例使用独立的数据库事务，测试后回滚
2. **默认固定本地端口**：当前本地 acceptance/bootstrap 默认使用 3000/5000/8080/5432/6379 与固定容器名前缀，可通过环境变量覆盖；在 #51 的动态端口与 namespace 完全落地前，不保证同机多套 acceptance 并行
3. **无真实 IO 在单元测试中**：数据库、Redis、文件系统访问全部通过接口 Mock
4. **测试隔离**：`fast` 层测试不依赖任何运行中的服务
5. **失败即停**：CI 中任一层失败会阻断下游层；下游 skipped 会由 `production-summary` 归类为 downstream fan-out，不视为成功

---

## 关键测试场景矩阵

所有 API 变更必须覆盖以下场景：

| 场景 | 对应测试层 |
|------|-----------|
| 匿名公开读（Binary / Wasm）| release, resilience |
| 作者资产库 admin-only 边界、重建、复用、孤儿清理 | fast, acceptance, resilience |
| 作者分析 dashboard、搜索关键词/来源路径/404 聚合、RUM ingestion/dashboard/隐私边界 | unit, acceptance, telemetry privacy |
| 登录用户写操作 | integration, acceptance, security |
| Admin 管理操作 | acceptance, security |
| Admin-only 私有预览、SEO/质量发布前检查、warning override 审计、匿名拒绝、feed/sitemap 不暴露 | unit, acceptance, security attack matrix |
| 评论待审队列、批量审核、误判恢复、封禁联动、公开只读 approved | unit, acceptance, security attack matrix |
| Markdown/frontmatter 单篇导出、全站内容包、导入恢复 revisions | unit, authoring restore smoke |
| OpenTelemetry trace/metrics/log correlation、OTLP 开关、无 PII tag 白名单 | unit, readiness smoke |
| WebSocket 实时推送 | integration, resilience |
| AOT 首屏 hydration | release, acceptance |
| Binary 错误帧 / 解码失败 | resilience |
| AEDS v1 拒绝 / v2 CRC16 / compact payload | fast, resilience |
| PoW 前置验证 | security |
| 会话并发吊销 | security |

## 单作者博客新增门禁

本轮单作者博客能力的窄门禁：

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~ArticlePublicationTests|FullyQualifiedName~PublicAotDocumentComposerTests|FullyQualifiedName~SchemaMigrationRegistryTests|FullyQualifiedName~AuthoringWorkflowServiceTests"
cd src/frontend && npx vitest run --config vitest.config.ts ../../tests/frontend/unit/api/authoring.test.ts
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~AuthoringWorkflowServiceTests|FullyQualifiedName~CommentServiceValidationTests"
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~ObservabilityTests|FullyQualifiedName~ServiceCollectionExtensionsTests|FullyQualifiedName~ProductionHealthTests|FullyQualifiedName~ScheduledPublishWorkerTests|FullyQualifiedName~UnifiedCacheTests"
npm --prefix src/frontend run check:security:attack-matrix
cd src/frontend && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test acceptance/admin-console.spec.ts -g "dashboard, article write"
npm --prefix src/frontend run check:acceptance:console
npm --prefix src/frontend run check:pwa-offline-policy
npm --prefix src/frontend run check:pwa-offline-smoke
npm --prefix src/frontend run check:subscription-privacy
npm --prefix src/frontend run check:subscription-smoke
npm --prefix src/frontend run check:public-distribution-contract
npm --prefix src/frontend run check:public-seo-smoke
npm --prefix src/frontend run check:distribution-version-coherence
npm --prefix src/frontend run check:telemetry-privacy
tools/operations/backup-restore-drill.sh
tools/operations/test-backup-restore-drill-fixture.sh
FSUSBLOG_SMOKE_DRY_RUN=1 tools/operations/post-deploy-smoke.sh
tools/operations/collect-release-evidence.sh
tools/operations/test-release-evidence-fixture.sh
tools/operations/cleanup-retention.sh
```

这些检查覆盖文章公开可见性、SEO discovery/JSON-LD、分发版本一致性、schema migration registry、OpenTelemetry collector 开关与无 PII tag 白名单、AI provider 默认关闭、PWA 私有路由不缓存、RUM 不采集私有页与敏感字段、备份/烟测/证据/保留期脚本。这里的 backup restore 与 post-deploy smoke dry-run 只验证脚本调度，会写入 `status=scheduled`，不能作为发布收口证据。完整发布仍必须回到 `./tools/test.sh production` 与 `./tools/test.sh coverage-gate`，最终发布还必须跑 `./tools/test.sh release-final`。

作者 AI 辅助的静态门禁为 `npm --prefix src/frontend run check:author-ai-assist`，覆盖 admin-only endpoint、actor audit、provider review config、编辑器接线和文档同步。后端行为由 `AuthoringWorkflowServiceTests` 覆盖默认 disabled 与 provider-enabled review-blocked 分支。

## Production 风险清单

`production` 必须同时满足：

- 编译、类型检查、Vite build 均为 0 warning / 0 error。
- 所有运行时 API 响应均为 AEDS frame；错误、鉴权拒绝和异常兜底统一为 `ApiError`。
- Binary frame 必须为 AEDS v2，header 长度 16 字节；v1 frame 不允许被服务端、Worker 或 Wasm 接受。
- `/api/binary/**` 在公开读、匿名拒绝、admin 拒绝场景下状态与 AEDS error frame 一致。
- `check:distribution-version-coherence` 覆盖文章生命周期状态：draft、scheduled、archived 必须只在 admin 状态列表和 admin detail 可见，published 才能进入 public list/detail、feed、sitemap、related-reading、PublicAOT 与 search index；delete/restore/permanent-delete 继续验证回收站语义。
- PoW、MFA、Passkey、session refresh/revoke/logout、RBAC 权限矩阵均无绕过。
- 安全头、CORS、auth/PoW no-store、Cookie 安全属性、畸形 AEDS frame、notification stream 握手失败和攻击矩阵均无绕过。
- OWASP ZAP baseline 不得产生 FAIL 级告警；报告必须保留为发布门控 artifact。
- WebSocket 通知握手、匿名 PoW、重连 cursor、AOT hydration、搜索、上传、视觉和轻量并发门控全部通过。
- Markdown 代码高亮必须保持 Shiki 输出质量，但 highlighter 只能在实际代码块渲染时懒加载；`FSUSBLOG_VITE_WARN_AS_ERROR=1 npm --prefix src/frontend run build` 不允许出现 chunk size warning。
- 前端资源大小预算由 `npm --prefix src/frontend run check:asset-size-budget` 执行，默认限制总 `dist` 80 MiB、单 JS 900 KiB、单 CSS 600 KiB、单 Wasm 220 KiB，并输出 `.tmp/frontend/asset-size-budget.json`。

---

## 参见

- [development.md](development.md) — 本地环境搭建
- [operations.md](operations.md) — 发布门控与滚动更新
- `tests/backend/TESTING.md` — 洁净性约定完整版
- `tools/test.sh` — 测试入口脚本

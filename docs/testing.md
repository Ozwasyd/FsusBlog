# 测试策略

FsusBlog 采用**多分层测试**架构，从纯单元测试到全量发布门控共 10 个层级，按依赖复杂度递进。机器可读测试矩阵位于 `tests/matrix.yml`，`tools/check-test-matrix.mjs` 在 fast gate 中校验每个 tier 的入口命令、owner 和 evidence 归档位置。

---

## 层级总览

| 层级 | 命令 | 依赖 | 耗时估计 | 场景 |
|------|------|------|---------|------|
| `fast` | `./tools/test.sh fast` | 无 | < 30s | 纯单元，无 IO |
| `integration` | `./tools/test.sh integration` | Docker、端口 3000/5000 | < 3min | 服务端集成 |
| `ci` | `./tools/test.sh ci` | Docker | < 4min | fast + integration |
| `release` | `./tools/test.sh release` | 端口 8080 | < 5min | 公开页/AOT/SEO |
| `acceptance` | `./tools/test.sh acceptance` | 全部端口 | < 15min | 全量 Playwright E2E |
| `visual` | `./tools/test.sh visual` | 全部端口 | < 10min | 视觉回归、截图基线 |
| `security` | `./tools/test.sh security` | 全部端口 | < 10min | 认证/MFA/PoW/权限 |
| `resilience` | `./tools/test.sh resilience` | 全部端口 | < 8min | 上传/搜索/SSE 弹性 |
| `load` | `./tools/test.sh load` | 全部端口 | < 20min | 轻量并发压测 |
| `production` | `./tools/test.sh production` | Docker、全部端口 | < 60min | 全量发布门控（fast 后强制 bootstrap，串行风险清单） |

`load` 与 SSE pressure 检查会写入 `.tmp/perf/load-public-api.json` 和 `.tmp/perf/sse-pressure.json`，release evidence 会把 `.tmp/perf/` 作为性能证据归档。

---

## 各层详解

### `fast` — 纯单元测试

**触发时机**：本地提交前、PR 检查

**覆盖内容**：
- `tests/backend/FsusBlog.Server.Tests/Unit/` — 服务逻辑、工具函数、DTO 映射
- `PodContractValidation.AreAllPodModelsReferenceFree()` — POD 引用安全断言
- AEDS v2 帧头编解码逻辑（`AedsEncoder`、`AedsDecoderValidator`）：16-byte header、CRC16、payload length、unknown version 拒绝、v1 frame 拒绝
- compact POD round-trip：article list/detail/hot/category/tag/comment/stats 与损坏 payload 拒绝
- JWT 签发与校验逻辑（`JwtHelper`）
- 缓存键构建逻辑（`CacheKeyBuilder`）

**单独运行**：
```bash
dotnet test tests/backend/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj \
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
- `tests/backend/FsusBlog.Server.Tests/Integration/` — 真实数据库 + Redis
- 端点级集成：文章 CRUD、评论流、分类/标签查询
- 缓存回填与失效（L1 + L2）
- 认证流程：注册 → 登录 → refresh → logout
- PoW 挑战-答案验证（Redis backed）
- 会话吊销语义

**单独运行**：
```bash
dotnet test tests/backend/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj \
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
- 移动端（375px）/ 桌面端（1280px）布局
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
| 生产暴露面工具 | `tools/security/test-production-exposure-tools.sh` 用合成 DNS/firewall/live evidence 覆盖 prereq handoff/returned 脚本与 tar/find/xargs 依赖清单、evidence request schema、request `requiredEvidence`/`verificationCommands`/`handoffChecks`、request returned-evidence/returned-handoff verifier 与 closeout 命令、request currentStatus/nextActions/unblockPlan、firewall source sha256 生成/缺失/格式/原始文件摘要不匹配拒绝、handoff request 缺失 firewall source sha256 合同拒绝、status report requiredHosts/delegationDomains、live/DNS readiness `requiredHosts` 与 DNS delegation `delegationDomains` 字符串/数组形态、handoff request/status/manifest 对齐、request/status 域名漂移拒绝、request/status blocker 明细漂移拒绝、request requiredEvidence 路径漂移拒绝、request 缺失 handoff check 拒绝、request 缺失 blocker source 的 unblockPlan 拒绝、request 缺失 returned handoff closeout 命令拒绝、request 顶层 returned verifier 命令漂移拒绝、manifest request firewall source sha256 合同漂移拒绝、manifest request returned closeout command summary 漂移拒绝、manifest request unblockPlan summary 漂移拒绝、manifest blocker 明细漂移拒绝、manifest external exposure valid 漂移拒绝、manifest external exposure 组件状态漂移拒绝、request evidenceFiles 路径漂移拒绝、request/status artifact digest 漂移拒绝、manifest host/domain drift 拒绝、release bundle exposure artifact drift 拒绝、bundle artifact 非标准路径拒绝、manifest sha256 digest 校验、缺失 artifact 残留 digest 拒绝、handoff bundle 导出前校验、exporter 输出目录/tarball 自校验、tarball 解压前路径穿越和非普通 entry 拒绝、summary/operator checklist/returned-evidence manifest/README/校验和/tarball 生成、handoff bundle checker 目录/tarball 验证与篡改 returned manifest/README/artifact digest/symlink/archive path traversal/unsupported entry 拒绝、含 symlink 源 release evidence 导出失败、handoff summary unblockPlan、operator checklist unblockPlan、returned manifest unblockPlan 拒绝、returned handoff closeout 对完整 bundle 的 preflight 校验和篡改 operator checklist 不改 TODO、direct returned-evidence closeout 对父级 handoff bundle 的 preflight 校验和篡改 operator checklist 不改 TODO、returned expected manifest source metadata 与 unblockPlan sources/count/key/file/artifact/command 映射拒绝、returned evidence 目录验收与 symlink 拒绝、ok/blocked returned manifest 保留、returned request 与 expected manifest scope 缩窄拒绝、returned evidence 成功 closeout 与 missing expected manifest/blocked/缩窄 request/缩窄 manifest 不改 TODO、临时 fixture 路径拒绝、manifest request summary、complete closeout 自动生成并刷新 request、verifier、status report、失败不改 TODO、失败写 blocked status report、缺失 `Comment:` 字段时拒绝勾选、早期失败仍刷新后续 evidence、成功 closeout 勾选当前 `NB-P0-001` fixture 并把 `生产可信闭环` 进度更新为 `5/5` |
| 回传 handoff 收口 | `complete-production-exposure-from-returned-handoff-bundle.sh` 覆盖空 returned-evidence 槽不改 TODO、目录输入成功 closeout、tarball + `.sha256` 输入成功 closeout、blocked tarball 输入不改 TODO 且保留解包后的 blocked status 证据、symlinked returned-evidence tarball 与 archive path traversal tarball 解压前拒绝且不改 TODO、handoff bundle README/expected manifest 暴露一键 closeout 命令，并复用 returned evidence scope/verifier 规则 |

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
- 文章列表 / 详情并发读（50 VU × 30s）
- Binary 链并发读
- SSE 多连接稳定性（20 并发 SSE 连接）

**性能基准**（独立工具）：
```bash
cd FsusBlog.Core.Benchmarks
dotnet run -c Release
```
结果保存在 `BenchmarkDotNet.Artifacts/results/`。当前套件覆盖 AEDS/POD encode/decode、raw cache-hit defensive copy 与 readonly fast path、合成 search rebuild/query BM25 路径，以及 Public AOT bundle encode/decode；生产调高 runtime tuning 前必须把对应基准结果随发布证据保存。

---

### `production` — 全量发布门控

包含上述所有层级，是**唯一允许合并到生产分支的门控**。执行顺序为：

1. `fast`：Debug build `-warnaserror`、服务端非集成测试、`vue-tsc`、前端 release build warning-as-error、静态治理脚本。
2. 强制 bootstrap：启动或重启 PostgreSQL、Redis、Debug 后端、Vite 前端、Release Preview。`fast` 会重新生成前端 release 资源并同步到后端 StaticWebAssets，production 门禁必须在这里重启运行时，避免旧进程继续服务上一代代码或静态资源。
3. 复用同一套运行环境依次执行 `integration` runtime、`release`、`acceptance`、`visual`、`security`、`resilience`、`load`。

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

GitHub Actions 中 `Quality Gate` 会在 `pull_request`、`main` / `master` push、手动 `workflow_dispatch` 触发同一条 `./tools/test.sh production` 门控。CI 需要配置 `GITHUB_PACKAGES_TOKEN` secret，用于安装 `@ozwasyd` 私有包。CI 默认 `FSUSBLOG_PLAYWRIGHT_WORKERS=1`，本地可按机器资源显式覆盖。

---

## 测试洁净性约定

详见 `tests/backend/FsusBlog.Server.Tests/TESTING.md`。

核心约定：

1. **无状态污染**：每个集成测试用例使用独立的数据库事务，测试后回滚
2. **无硬编码端口**：端口配置通过环境变量或 `appsettings.Test.json` 注入
3. **无真实 IO 在单元测试中**：数据库、Redis、文件系统访问全部通过接口 Mock
4. **测试隔离**：`fast` 层测试不依赖任何运行中的服务
5. **失败即停**：CI 中任一层失败立即中止，不继续运行后续层

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
dotnet test tests/backend/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~ArticlePublicationTests|FullyQualifiedName~PublicAotDocumentComposerTests|FullyQualifiedName~SchemaMigrationRegistryTests|FullyQualifiedName~AuthoringWorkflowServiceTests"
cd src/frontend && npx vitest run --config vitest.config.ts ../../tests/frontend/unit/api/authoring.test.ts
dotnet test tests/backend/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~AuthoringWorkflowServiceTests|FullyQualifiedName~CommentServiceValidationTests"
dotnet test tests/backend/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj --no-restore --filter "FullyQualifiedName~ObservabilityTests|FullyQualifiedName~ServiceCollectionExtensionsTests|FullyQualifiedName~ProductionHealthTests|FullyQualifiedName~ScheduledPublishWorkerTests|FullyQualifiedName~UnifiedCacheTests"
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

这些检查覆盖文章公开可见性、SEO discovery/JSON-LD、分发版本一致性、schema migration registry、OpenTelemetry collector 开关与无 PII tag 白名单、AI provider 默认关闭、PWA 私有路由不缓存、RUM 不采集私有页与敏感字段、备份/烟测/证据/保留期脚本。完整发布仍必须回到 `./tools/test.sh production` 与 `./tools/test.sh coverage-gate`。

作者 AI 辅助的静态门禁为 `npm --prefix src/frontend run check:author-ai-assist`，覆盖 admin-only endpoint、actor audit、provider review config、编辑器接线和文档同步。后端行为由 `AuthoringWorkflowServiceTests` 覆盖默认 disabled 与 provider-enabled review-blocked 分支。

## Production 风险清单

`production` 必须同时满足：

- 编译、类型检查、Vite build 均为 0 warning / 0 error。
- 所有运行时 API 响应均为 AEDS frame；错误、鉴权拒绝和异常兜底统一为 `ApiError`。
- Binary frame 必须为 AEDS v2，header 长度 16 字节；v1 frame 不允许被服务端、Worker 或 Wasm 接受。
- `/api/binary/**` 在公开读、匿名拒绝、admin 拒绝场景下状态与 AEDS error frame 一致。
- `check:distribution-version-coherence` 覆盖文章生命周期状态：draft、scheduled、archived 必须只在 admin 状态列表和 admin detail 可见，published 才能进入 public list/detail、feed、sitemap、related-reading、PublicAOT 与 search index；delete/restore/permanent-delete 继续验证回收站语义。
- PoW、MFA、Passkey、session refresh/revoke/logout、RBAC 权限矩阵均无绕过。
- 安全头、CORS、auth/PoW no-store、Cookie 安全属性、畸形 AEDS frame、SSE 握手失败和攻击矩阵均无绕过。
- OWASP ZAP baseline 不得产生 FAIL 级告警；报告必须保留为发布门控 artifact。
- WebSocket 通知握手、匿名 PoW、重连 cursor、AOT hydration、搜索、上传、视觉和轻量并发门控全部通过。
- Markdown 代码高亮必须保持 Shiki 输出质量，但 highlighter 只能在实际代码块渲染时懒加载；`FSUSBLOG_VITE_WARN_AS_ERROR=1 npm --prefix src/frontend run build` 不允许出现 chunk size warning。
- 前端资源大小预算由 `npm --prefix src/frontend run check:asset-size-budget` 执行，默认限制总 `dist` 80 MiB、单 JS 900 KiB、单 CSS 600 KiB、单 Wasm 220 KiB，并输出 `.tmp/frontend/asset-size-budget.json`。

---

## 参见

- [development.md](development.md) — 本地环境搭建
- [operations.md](operations.md) — 发布门控与滚动更新
- `tests/backend/FsusBlog.Server.Tests/TESTING.md` — 洁净性约定完整版
- `tools/test.sh` — 测试入口脚本

# 系统架构

本文档描述 FsusBlog 的整体架构设计、数据流路径、缓存分层和模块边界。

## 概览

FsusBlog 是一个单体全栈系统，以"公开内容首屏速度 + 运行时一致性 + 安全链路完整性"为核心约束。

```text
项目内性能基线（Kestrel-only / single process）
Browser
  ├── 公开页首访  → Kestrel → Public AOT HTML shell / SPA index.html + 客户端 hydration
  ├── SPA 路由    → Vue Router     → Pinia Store → API / Binary / Worker
  └── Service Worker               → 本地搜索索引（离线可用）

Kestrel (ASP.NET Core 10)
  ├── Auth / Rate Limiting / CORS
  ├── Redis L2 缓存
  ├── PostgreSQL（SqlSugar ORM）
  └── 静态文件服务（AOT cache 卷）

可选部署层（不计入项目内 QPS 基线）
Browser
  → Nginx / Caddy / CDN / 反向代理（TLS、边缘缓存、运营商压缩等）
  → Kestrel
```

性能证据默认只声明项目内基线：单进程、Kestrel-only、无 nginx/CDN/reverse-proxy cache、无外部压缩层。生产部署可以在 Kestrel 前放置 nginx、Caddy 或 CDN，但这属于 operator deployment layer；如果压测经过该层，证据必须单独标注，并且不得计入 FsusBlog 内部优化的 QPS 结论。

## 模块边界

| 模块 | 职责 |
|------|------|
| `FsusBlog.Server` | HTTP API、认证、Rate Limiting、缓存治理、安全链路、AOT 输出、notification stream |
| `FsusBlog.Client` | SPA、公开页 hydration、Wasm 解码、Service Worker 搜索、状态管理 |
| `FsusBlog.Shared` | 前后端共享二进制协议模型（AEDS 帧结构、契约结构体） |
| `FsusBlog.Core` | POD 编解码、映射、投影逻辑（与 HTTP 无关的纯计算层） |
| `FsusBlog.Server.Tests` | xUnit 单元与集成测试，按洁净等级分层 |

**边界规则**：

- `Server` 和 `Client` 均可引用 `Shared`，但彼此不得直接引用对方。
- `Core` 不引用任何 HTTP、缓存或认证相关依赖。
- `Client` 端 Wasm 模块（`wasm/`）不引用任何 JS/TS 代码。
- `Shared` 只承载跨进程稳定 DTO、AEDS/NotificationStream/POD 契约和响应信封；端点请求上下文、服务命令、缓存 key、认证中间状态必须留在 `Server`。
- `Server` 端点层只做路由、输入校验和响应组装。二进制头、frame 名称、设备指纹、viewer identity、admin step-up proof 与 read-proof 适配分别通过 `IBinaryEndpointRequestContext`、`IHumanReadProofEndpointAdapter` 等基础设施服务注入。

## 运行时装配边界

`Program.cs` 只保留 host 创建、配置入口和高层启动调用：

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.ConfigureFsusApplication();

var app = builder.Build();
app.UseFsusPublicHotReadFastPath();
app.UseFsusApplicationPipeline();
app.MapFsusApplicationRoutes();
app.Run();
```

Host runtime tuning、Serilog、OpenTelemetry、ForwardedHeaders、rate limiting 与核心服务注册由 `Infrastructure/Bootstrap/WebApplicationBuilderCompositionExtensions.cs` 收口；具体 HTTP 管线由 `Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs` 收口：

| 阶段 | 方法 | 职责 |
|------|------|------|
| L0 公开热点 | `UseFsusPublicHotReadFastPath` | 在常规管线前命中 `/api/binary/article/**.aeds`、`/api/binary/category.aeds`、`/api/binary/tag.aeds` 与公开 HTML 快照，直接写出预编码 bytes |
| 安全响应头 | `UseFsusSecurityHeaders` | CSP/HSTS/跨源隔离等头部策略 |
| 核心中间件 | `UseFsusCoreMiddlewares` | 异常、审计、认证授权、匿名网关头守卫、封禁用户、访问日志兼容占位 |
| 静态资源 | `UseFsusStaticAssets` | Public AOT cache、SPA 静态文件、fallback |
| 端点管线 | `UseFsusEndpointPipeline` | OpenTelemetry trace correlation、crawler-aware Rate Limiting、OutputCache、API/Binary/健康路由 |

`UseFsusEndpointPipeline` 的端点链路顺序必须保持 `UseCors()` -> `UseAntiforgery()` -> `UseFsusCsrfOriginGuard()` -> `AnonymousGatewayHeaderGuardMiddleware` -> `UseAuthentication()` -> `UseRateLimiter()` -> `BannedUserMiddleware` -> `UseAuthorization()`。CSRF Origin guard 只在带 Cookie/Authorization 的状态变更请求上执行，要求 `Origin` 或 `Referer` 命中可信来源；匿名网关头守卫只允许显式匿名 profile / runtime `X-Fsus-*` 请求头，拒绝 username/email/role/userId/password/TOTP 等传统账号头和未知 `X-Fsus-*`，且必须在认证前执行，避免外部网关注入头生成业务 principal。`fixed_ip` 限流分区需要读取已认证的 admin principal 才能应用管理端绕过；封禁写入检查仍在限流之后、授权之前执行。

路由组装按 `MapFsusOperationalRoutes`、`MapFsusApiRoutes`、`MapFsusPublicRoutes` 分层，避免在新增 API 时同时触碰健康探针、notification stream、SPA fallback 和静态文件策略。

运行时 DI 组合根按边界拆分：基础设施注册由 `AddBinaryRuntime`、`AddNotificationRuntime`、`AddCrawlerAndSearchRuntime`、`AddFileAndAuthRuntime`、`AddAuditRuntime`、`AddMessagingRuntime`、`AddCacheRuntime`、`AddIdentityRuntime`、`AddBackgroundRuntime`、`AddSpaRuntime`、`AddObjectPools` 分段承载；领域注册由 `AddContentRuntimeServices`、`AddUserRuntimePorts`、`AddGeneralDomainServices`、`AddCoreBridgeServices` 分段承载。新增服务应优先落入对应分组，避免把 Bootstrap 重新变成无边界注册清单。

审核词库运行时由 `ModerationDictionaryService` 承载，注册在内容领域服务分组。它从 `configs/moderation/dictionaries/**` 和 `configs/moderation/region-policies/**` 构建 immutable snapshot；global 词库进入 `ContentFilterService` 硬拦截，地区策略组合进入 `RegionLegalModerationService` 计算 submit/viewer action、`blocked_regions` 和 replay diff。reload 失败时继续使用旧 snapshot，并通过审计通道写入 `dictionary_reload_failed` / `region_policy_reload_failed`。

可选反垃圾模型由 `AntiSpamModerationService` 承载，默认 `Moderation:AntiSpamModel:Enabled=false` 且处置模式为 `score-only`。评论创建成功并写入地区合规后，服务在短超时内调用 `none/mock/http-json/fsus-cli` provider selector；模型先写 `comment_moderation_signal` 风险信号，再由 `CommentModerationDispositionPolicy` 在显式配置的 `auto-low-risk-approve` / `auto-hide-high-risk` 模式下决定是否自动通过或隐藏。地区策略优先级高于模型：`RegionCanPublish=false`、`RegionRequiresManualReview=true` 或 `RegionHideUntilReviewed=true` 时模型不得自动通过；provider 失败写 `timeout/unavailable/error/contract_invalid` signal 并 fail-open。

`BannedUserMiddleware` 是运行时封禁检查的唯一实现，不再保留旧过滤器兼容别名；新增调用点必须使用 Middleware 命名。该中间件必须先按 `identity_kind` 分流：`admin_principal` 不读取普通 `sys_user` 状态或 blacklist，直接交给后续 admin authorization/session 语义；`anonymous_account` 与 legacy user 才进入普通用户删除/封禁写锁。普通账号 access token 携带 `account_subject_hash`，中间件的 L1 account-state key 固定为 `account:state:{accountSubjectHash}`；缺失 claim 的 legacy token 只能走 `AccountSubjectHasher` 的 legacy fallback，不能恢复 `user:account-state:{userId}`。admin access token 在 JWT 基础校验后必须由 `AdminSessionValidationService` 请求期回查 `admin_session` 和 `admin_principal`，撤销、禁用、idle/absolute 到期、token hash mismatch 或 session/principal 不一致都要 fail closed，并清理 admin cookies。root admin bootstrap 是 admin principal plane 的唯一初始化写入，complete 路径必须在同一 DB transaction 内拿 PostgreSQL xact advisory lock、重查 active root、写 principal/credential/session/audit，并由 active-root partial unique index 兜底并发。

受限账号安全收尾、认证响应 `no-store` 等端点级策略只允许通过 endpoint metadata 声明。`Infrastructure/Policies/EndpointPolicyMetadata.cs` 提供 `AllowRestrictedAccountAction(RestrictedAccountAction.*)` 与 `RequireNoStoreResponse()`，运行时中间件读取路由元数据执行策略，避免 `/api/...` 字符串匹配在路由迁移时失效；普通消息、评论、内容等业务写入不得声明受限账号放行 metadata。

生产启动校验通过 `ProductionStartupValidationHostedService` 纳入 DI 生命周期。生产环境校验失败时写入 `StartupRuntimeState` 的 `productionStartupValidation=degraded` 并记录日志，进程保持可观测；就绪探针仍由 DB/Redis 连通性决定。非生产环境报告 `skipped`。

安全运行策略由 `ISecurityAdminPolicyService` 暴露进程内 immutable 快照，公开读、PoW、RiskControl 和后台概览只读该内存状态。后台 `/api/binary/admin/security/**` 修改 AntiCrawler/PoW 策略时，在原有 admin principal、`system.config`、`X-Fsus-Mfa-Proof` 和高价值审计边界内额外写入 `security_policy_snapshot` 版本化记录；启动期 `SecurityPolicySnapshotHostedService` 必须排在 `LifecycleHostedBootstrapService` 之后，从 active 策略加载内存快照，active 反序列化失败时回退到最近 last-known-good 版本。请求热路径不得为了读取策略同步查询 PostgreSQL；持久化写失败会让管理写请求失败并保留日志诊断，下一次启动仍以最后可用的 active/LKG 持久化快照恢复运行时策略。

运行时可观测性由 `Infrastructure/Observability` 统一管理。`FsusObservability` 暴露 `ActivitySource=FsusBlog.Server` 与 `Meter=FsusBlog.Server`，并把自定义属性限制为低基数 `fsus.*` 白名单。ASP.NET Core、HttpClient、runtime、Npgsql、notification stream meter、cache、PublicAOT、search 和 scheduled-publish worker 都进入同一 trace/metric 面；`ObservabilityCorrelationMiddleware` 把 `Activity.TraceId` 写回 `HttpContext.TraceIdentifier` 和 `X-Fsus-Trace-Id`，使错误响应、Serilog/audit 与标准 collector trace 能按同一 ID 关联。OTLP exporter 默认关闭，只有 `Observability:ExporterEnabled`/`OTEL_EXPORTER_OTLP_ENDPOINT` 打开后才向 collector 导出。

缓存治理清单由 `tools/cache/export-cache-governance.mjs` 从 `CachePolicyRegistry`、`CacheTag`、`HttpCachePolicyCatalog` 生成到 `docs/cache-governance.catalog.json`。`tools/check-cache-governance.sh` 会在 fast gate 中校验该清单，防止 cache key/tag/catalog 与文档证据漂移。

## 前端主题与组件覆盖边界

FsusBlog 只维护应用语义 alias，底层颜色、阴影、过渡和缓动优先复用 Element Plus / FsusUI 变量：

- `src/frontend/src/assets/public-page.css` 定义 `--fsus-color-*`、`--fsus-duration-*`、`--fsus-ease-standard` 等 alias，不再在页面组件重复声明同语义色值。
- 管理表格默认使用 FsusUI table 视觉；不得再通过集中 CSS 或页面级 `:deep(.el-table*)` 重画 header、hover、cell padding。只允许在业务模板上声明列宽、列固定、tag/link 等语义内容。
- `src/frontend/src/fsusui/primitiveAdapters.ts` 是 FsusBlog 本地 primitive 到 FsusUI 语义 variant 的适配层；`UiButton`、`UiTag`、`UiEmptyState` 只保留业务语义映射，不再各自维护基础控件状态面。
- FsusUI 1.4.0 之后不再维护集中 `fsusui-overrides.css`。业务页不得用全局 `.el-*` 接管组件内部结构；确需响应式排布时，只能挂在当前业务壳层类或 `blog-*` utility class 上，并优先使用 FsusUI 变量和组件默认样式。
- FsusUI 组件实例上的 `class` 只能承载布局尺寸、响应式可见性、测试/语义 hook；不得把 `bg-*`、`text-*`、`border-*`、`rounded-*`、`shadow-*` 或 `!important` 类直接挂到 `ElButton`、`ElTag`、`ElAvatar`、`ElStatistic`、`ElLink` 等组件上重画默认视觉。
- `check:fsusui-boundary` 在 fast gate 中默认严格失败；任一 FsusUI 边界 warning 都会让 `check:views-constraints` 失败，并由 `check:fsusui-boundary-fixture` 防止退回 warning-only 模式。
- FsusBlog 自有 utility 不占用 `.fsus-*` 类名空间；公开页链接/按钮焦点和交互态统一使用 `blog-focus-ring`、`blog-link-state`、`blog-interactive-state`。
- `prefers-reduced-motion: reduce` 由全局样式关闭循环动画和页面过渡；组件内新增动画必须走 `--fsus-duration-*` 与 `--fsus-ease-standard`。

## 请求路径

### 公开页首访

```text
Browser
  → Kestrel（项目内基线）
    → Kestrel 尝试读取 Public AOT document cache
      → 命中且 renderer/assets version 匹配 → 直接输出 HTML
      → 过期或 version 不兼容 → 删除旧 artifact，返回 SPA index.html + 排队 backfill
      → 未命中 → 返回 SPA index.html + 排队 backfill
      → backfill worker → bootstrap provider → Node/Vue SSR worker pool → document cache
    → SPA index.html fallback：客户端 hydration 接管

可选部署：
Browser
  → Nginx / CDN / 反向代理（静态文件、TLS、proxy cache、压缩均为部署层能力）
  → Kestrel（项目内基线仍从这里开始）
```

### Public AOT 单一渲染链

公开页的 `Home / ArticleDetail / Filter / Archive / About / Privacy / Guidelines / Copyright` 统一遵循一条渲染流水线：

```text
IPublicAotRouteRegistry
  → IPublicAotBootstrapProvider（产出 typed PublicPageSnapshot）
  → PublicAotRenderRequest + PublicAotRendererPayloadMapper
  → IPublicAotEntryRenderer（Node/Vue SSR worker pool）
  → src/public-renderers/renderPublicPage.ts（入口）+ src/public-renderers/publicEntryRegistry.ts / pageAssemblies.ts / scaffold.ts
  → PublicAotDocumentComposer
  → versioned AOT HTML document cache + hydration `.aeds` sidecar
```

关键约束：

- `src/frontend/scripts/server-public-ssr.mjs` 以 AEDS 行协议 worker 模式长驻，支持 `buildEntry` / `validateBundle` / `health` / `shutdown`；`PublicAot:SsrWorkerMode=PerRequest` 可作为紧急回退。
- `PublicAotSsrRuntimeState` 聚合 backfill queue scheduled/dropped/completed/failed counters、worker restart/stderr warning、timeout/renderer/DB gate/document compose/cache write failure 分类、circuit breaker 与 route quarantine。`/internal/public-aot/health` 复用 `X-Fsus-Public-Aot-Token`，输出 resource check、Node probe、`validateBundle` sample probe 和 runtime snapshot；`tools/operations/public-aot-health.mjs` 是 release/ops 诊断入口。
- SSR worker circuit breaker 只保护 backfill lane：连续 worker-level failure 打开后，新 backfill 被 short-circuit；cooldown 后只允许一个 half-open probe，成功才关闭。route-level renderer/document compose 重复失败会按 `PublicPageKind + routeKey` quarantine，并在 route/content/settings invalidation 或 TTL 到期后清除。公开读路径必须继续返回 fresh/stale AOT 或 SPA fallback，不得因 breaker/quarantine 阻断匿名阅读。
- AOT document cache 只允许由服务端 `server-ssr` backfill 写入；客户端、管理端和脚本不得上传 AOT bundle。
- AOT document cache 按 frontend asset version 写入版本化 artifact 路径；旧版本 artifact 只能在后台清理或因 version 不兼容被拒绝，不能直接返回给公开 URL。
- `PublicAotDocumentComposer` 只负责文档包装、SEO 头、bootstrap 脚本和 hydration sidecar marker 注入，不承担页面业务结构修复；`PublicAotDocumentService` 在 compose 周期把 hydration AEDS frame 作为 raw `.aeds` sidecar 写到 `wwwroot/aot-cache/payloads`。sidecar URL 由 payload SHA-256 content hash 派生，静态响应使用 `application/vnd.fsus.aeds` 与 `public,max-age=31536000,immutable`，因此新 HTML 永远指向新 payload，旧 payload 只需后台异步清理。
- AOT document cache artifact 记录 hydration sidecar 的 URL、SHA-256 和相对路径；旧 artifact 缺少 metadata 时从 HTML marker 回读。文件缓存命中前必须确认 sidecar 存在且 SHA-256 与 URL hash 一致，否则删除/淘汰 HTML entry 并走 miss 重建。key/prefix/all invalidation 删除 HTML document entry，但保留 content-hash sidecar；sidecar 没有稳定 URL 复用语义，因此不会让已失效 document 继续可达。
- 多节点部署必须让 `wwwroot/aot-cache/frontend/**` 与 `wwwroot/aot-cache/payloads/**` 使用同一共享 artifact storage 或共享卷；否则当前 Public AOT cache 只支持单节点/共享存储一致性。v1.3 之前不把 Nginx/CDN 或跨节点复制延迟作为正确性前提，节点本地缺失或 hash mismatch 会 fail-closed 为 cache miss。
- Provider、shell service 与 renderer 之间只传递 `PublicPageSnapshot` / `PublicAotRenderRequest`，进入 Node worker 前由 `PublicAotRendererPayloadMapper` 做唯一 dictionary payload 映射；禁止恢复匿名 object graph 或每个 provider 自行拼 payload。
- `PublicAotDocumentService` 只在 compose 周期内解码一次 entry bootstrap/hydration payload，后续标题、描述和脚本注入复用同一解码结果。
- 页面内部结构、hydration props 与 Markdown HTML 以 Vue public renderer/helper 为唯一真相源，禁止 C# Markdown/props 与 Vue 组件双轨并存。
- `PublicPageRegistry`（C#）是跨语言页面身份元数据唯一真相源；前端通过 `src/frontend/src/public-renderers/generated/publicPageManifest.ts` 读取生成结果，`publicPageModel.ts` 只补 routeName/activeNav，禁止在 TS 再维护第二套 `pageId/canonicalSlug/seoEligible/aotShellReady/deferSpaBoot`。
- `PublicRouteIdentityRegistry`（C# shared）是跨语言 route identity token 与 path 语义唯一真相源；前后端都不得再各自硬编码 `article/category/tag/tag-name/search` 这组 bucket 字面量，或 `/article/ /category/ /tag/ /search /user/profile` 这组 path 常量。
- `src/backend/Infrastructure/PublicAot/PublicAotPageCatalog.cs` 只保留服务端运行时元数据（如 static path、默认标题、canonical fixed path）；`pageId`、hydration kind 和固定 slug 必须从 shared identity 派生，禁止在 backend catalog 再手写第二份跨语言页面身份。
- `ISpaAssetManifestService` 负责入口脚本、CSS、preload 和 frontend asset version；AOT 文档不得用正则补丁改写 dev/prod 资产路径。

### 测试隔离与运行时 key scope

生产缓存、Redis L2、notification stream backlog 与文章运行时 key 前缀只依赖 `IRuntimeKeyScope`。测试会话隔离通过 `TestAwareRuntimeKeyScope` 适配 `ITestSessionKeyScope`，`X-Fsus-Test-Session` 语义不得向默认生产缓存、notification stream 或业务 service 扩散。

测试 fixture 不得把可复用密码、JWT signing key、生产域名或固定数据库行 ID 写成源码默认值。需要伪造本地 session 的 Playwright / smoke 脚本必须显式使用 `loginWithFixtureSessionBypass`，并通过 `FSUSBLOG_TEST_SESSION_SECRET` 或测试专用 `Jwt__SecretKey` 提供短期签名密钥；会执行 SQL 的 fixture 只能连接 `fsusblog-dev*`、`fsusblog-test*` 或 `fsusblog-ci*` 容器。生成的 `.playwright-fixtures` storage-state 属于本地临时凭据，运行后应清理，不参与提交、缓存或跨环境复用。

部署与 CI 供应链同样属于运行时边界：OpenResty 模板收口 TLS/HSTS/跨源安全头，生产配置显式覆盖 `AllowedHosts`，Docker build context 排除 `.env` 系列本地机密；GitHub Actions 使用 SHA pinning，Dockerfile 对 vcpkg commit 与 wasm release artifact checksum fail closed。`check:infra-security-governance` 负责防止这些部署护栏退化。

### Public Route Identity

公开页路由身份采用集中规范，避免服务端与预热脚本各自推导：

| 页面 | route key / filter key | canonical path |
|------|------------------------|----------------|
| 首页 | `home` | `/` |
| 文章详情 | `article:{id}` | `/article/{id}` |
| 分类筛选 | `category:{id}` | `/category/{id}` |
| 标签筛选（ID） | `tag:{id}` | `/tag/{id}` |
| 标签筛选（名称） | `tag-name:{name}` | `/tag/{name}` |
| 归档 | `archive` | `/archive` |
| 关于 | `about` | `/about` |
| 隐私政策 | `privacy` | `/privacy` |
| 用户守则 | `guidelines` | `/guidelines` |
| 版权声明 | `copyright` | `/copyright` |

`filterKey` 是筛选页稳定身份，`routeKey` 是公开页缓存/渲染身份。对分类与标签页，二者通常一致；对无效目标和兼容场景，也必须由统一 identity 层产出。

### API 读取（文章/评论）

```text
Client
  → AEDS Binary（Accept: application/octet-stream）
    → Kestrel → 公开读 artifact fast path（article detail *.aeds）
      → 命中 → 直接搬运预编码 raw/br/gzip AEDS frame variant → 返回 application/octet-stream
      → 未命中 → singleflight 排队后台 rebuild → 503/stale/SPA fallback，不在请求内同步打 PostgreSQL
    → 其他公开列表/聚合 → L1 readonly raw cache
      → 命中 → AedsBinaryWriter 写 header + payload，避免 L1 hit 的 byte[] 防御性复制
      → 未命中 → Redis L2 / DB concurrency gate / cache refill
  → TypeScript adapter / Wasm Web Worker 解码 AEDS 帧 → Pinia Store 更新
```

Article/comment binary endpoints 只面向应用 facade：文章端点通过 `IArticleEndpointService` 获取 article list/detail/hot/featured 与写入操作，评论端点通过 `ICommentEndpointService` 获取 thread/reply/user cursor 与删除操作。Core query、raw payload cache、投影转换和 service mutation 不在 endpoint 文件内展开。文章写入后的搜索投影、实时通知、Redis 热榜清理、文章详情 AEDS artifact 生成/失效和图片资产清理统一下沉到 `IArticleMutationSideEffectCoordinator`，由 `ArticleSearchProjector`、`ArticleDetailAedsArtifactProjector`、`ArticleRealtimeNotifier`、`ArticleAssetCleanupPolicy` 等小服务承载，`ArticleService` 只负责写入事务、查询、缓存/AOT 失效编排。

用户域对外按不重叠 facade 拆分：`IUserAccountReader` 只返回 `UserAccountSnapshot`，`IUserLoginWorkflowService` 负责登录/MFA 风险/最终签发，`IUserProfileCommandService` 负责资料与注销，`IUserSessionCommandService` 负责 refresh/session revoke，`IUserAdminModerationService` 负责后台治理。`User`/`UserSession` ORM entity 只在 `UserService` 兼容实现内部流转，不作为 endpoint、middleware 或 notification stream admission 的读取契约。

### 认证写请求（注册 / 登录）

```text
Client
  → Rate Limiter (fixed_ip) → PoW 验证
  → 密码/Passkey 验证
  → JWT Access Token（15 min） + HttpOnly Refresh Token Cookie
  → MFA 挑战（如已启用，Passkey 登录免 MFA）
```

注册/登录 binary 端点按 `AuthBinaryRequestReader -> AuthBinaryApplicationFacade -> AuthBinaryResponseWriter` 分层：reader 只负责 AEDS request frame 解码，application facade 只负责注册、凭据校验、MFA 登录分支和最终 session token 结果，endpoint 保留 cookie 写入这一 HTTP side effect，writer 只负责 AEDS `AuthLoginFlow` / `ApiError` frame。

MFA challenge ticket 属于短 TTL 安全缓存，内部只保存账号容器 `AccountId` 与稳定 `AccountSubjectHash`。验证失败计数通过 `IUnifiedCache.IncrementAsync(CachePolicyId.SecurityMfaChallenge, ...)` 并行写入 ticket、subject、IP 三个维度，其中账号维度固定为 `fail:subject:{accountSubjectHash}`，不得使用 `fail:user:{userId}`；高价值/安全 audit scope 只写 `AccountId`、`AccountSubjectHash` 与 hash 后的 ticket/IP/UA。运行时回退路径是删除 `SecurityMfaChallenge` 下对应 `fail:subject:*` 或 challenge ticket key，让客户端重新发起短 TTL MFA challenge；不需要重启服务，也不得通过恢复裸 user id key 降级。

TOTP recovery code 的持久化状态只在 `user_mfa_profile`：`mfa_recovery_codes_hash` 保存换行分隔的 `v3$argon2id$m=65536,t=3,p=4$...` 条目，`hash_version` 标记当前集合版本。schema migration 会为旧 profile 补 `hash_version=1`；运行时只接受当前 v3 或 deadline 前的裸 SHA-256 legacy 迁移输入，旧 hash 被消费或正常 TOTP 验证成功后不得继续留作可用恢复码。回退路径是让用户重新走 `/api/binary/auth/mfa/recovery/regenerate` 生成 v3 恢复码，不恢复 PBKDF2 或旧消费 API。

## 发布构建边界

`src/backend/FsusBlog.Server.csproj` 的 Release publish 默认会检查 `src/frontend/node_modules`、执行 `npm run build:release` 并复制 `src/frontend/dist` 与前端 runtime 文件，保证单体发布产物一致。需要后端-only 诊断或临时发布时，可显式传入 `/p:PublishClientAssets=false`，跳过前端依赖检查、前端构建和前端 artifact copy；该开关不改变生产默认行为。

## 缓存分层

| 层级 | 类型 | 用途 | 失效策略 |
|------|------|------|----------|
| L0 — Hot read snapshot | `PublicHotReadSnapshot` 不可变进程内快照 | 公开 article/category/tag `.aeds` 与公开 HTML 高频命中 | 文章、浏览量、分类标签、定时发布与 AOT 变更只入队刷新；后台 projector debounce/coalesce 后重建并原子发布 |
| L0 — AOT 卷 | 静态 HTML 文件 | 公开页首访 shell | 内容变更时主动清除 |
| L1 — 内存 | `IMemoryCache` / `ConcurrentDictionary` | 进程内高频读对象 | 绝对过期 + 手动吊销 |
| L2 — Redis | `IUnifiedCache` | 跨重启持久热点 | TTL + 手动吊销 |
| CDN（未来） | 边缘缓存 | 静态资源 & 公开页 | Cache-Control + 版本前缀 |

> L1 暖身策略：L2 命中后立即回填 L1，避免下次 L2 往返。

运行时缓存只通过 `IUnifiedCache`、`CachePolicyRegistry`、`CachePolicyId` 与 `ICacheInvalidationDispatcher` 进入。`TryGetRawAsync` 保持 caller-owned 防御性复制语义；只读公开 payload 使用 `TryGetRawReadonlyAsync`，调用方只能把不可变 buffer 同步写出到 response，不能把 backing array 暴露为可写状态。旧的 `Core.Cache.CacheManager` / `ILevel1CacheStore` / `ILevel2CacheStore` 双层抽象已移除，core benchmark 覆盖 POD/AEDS codec、raw cache-hit decode/readonly cache hit、search rebuild/query 和 Public AOT bundle 编解码，不再模拟第二套 cache manager。

`IUnifiedCache` 的写入/变更型操作必须先移除 L1，再提交 Redis L2 变更；`IncrementAsync`、`ConsumeOnceAsync`、`ConsumeOnceAndGetAsync`、`RemoveAsync` 和批量失效都遵循 L1-first 顺序，避免并发读在 L2 已变更前后重新提升 stale L1 值。需要取回 payload 的一次性 challenge 使用 `ConsumeOnceAndGetAsync`，由 Redis GETDEL 语义在同一 L2 操作中取值并删除；调用方不得先 `GetStringAsync` 再 `RemoveAsync` 拼接一次性语义。L1-first 允许一次安全方向的 stale miss，但不得允许旧值在同进程内复活。

缓存失效优先使用 Redis registry 精确删除 prefix 命中的 key；registry 缺失时，`RemoveByPrefixAsync` 会记录 `registry_missing` 警告并执行 Redis keyspace scan fallback 回收现存 key，扫描失败则降级为可观测 warning，让后续写入自然修复 registry。AOT cache 文件失效仍走专用 Public AOT cache 服务，不在统一 Redis prefix 失效路径里全盘扫描。热点 miss singleflight 等待使用指数退避，避免固定间隔轮询放大 Redis 与 GC 压力。singleflight 入口由 `ConcurrentDictionary` 和 entry 自身引用计数管理，不依赖 `IMemoryCache` eviction callback；最后一个等待者释放后才 retire 并移除 entry，避免 eviction 与等待者注册竞态造成 lost wakeup 或已释放 semaphore。

缓存 miss 回填、后台 projector 和修复任务访问 PostgreSQL 时必须通过 `DbConcurrencyGate`。外层调用获得全局 slot 后会创建 reservation；同一 async flow 内的 reentrant 调用不得直接绕过 gate，也不得再消耗第二个全局 slot，而是在该 reservation 内串行执行。reservation 停止接收后，新进入的 reentrant 调用必须回到全局 gate，保证 `MaxConcurrentMisses` 对后台 DB 压力仍是有效上限。

封禁 blacklist 缓存使用 `CachePolicyId.SecurityBlacklistUser`，suffix 固定为 `account:{accountSubjectHash}`。`BlacklistService` 仍以 `sys_user.Status/BanReason` 为数据库真源，`accountId` 只用于 DB 回源和持久化更新，不得拼进 Redis/L1 key；`CacheInitializer` 预热与 bootstrap rollback entry 也必须先转换为 `AccountSubjectHash` 后写入或删除缓存。运行时回退路径是删除对应 `account:{accountSubjectHash}` 缓存，让下一次写请求或 notification stream admission 回查 PostgreSQL 并回填；不需要重启进程，也不得通过恢复裸 `userId` key 降级。

站点合规配置使用 `CachePolicyId.SystemCompliance` 进入 L1/L2/raw binary cache。admin 保存后由 `ICacheInvalidationDispatcher.InvalidateComplianceAsync` 清除 compliance cache、SEO/distribution output cache 与相关 AOT 静态页，并推送 `CacheControl` shell invalidate 事件；因此 ICP/公安备案、版权与许可 footer、RSS copyright 和 sitemap 静态页可在不重启服务的情况下收敛。

评论缓存失效由 `ICacheInvalidationDispatcher.InvalidateCommentMutationAsync(CommentCacheInvalidationScope)` 承载：公开可见性变化只删除 `CommentCursor` 的 `article:{articleId}:` 前缀，特定回复树变化可额外删除 `article:{articleId}:root:{rootId}:`，个人评论历史只删除 `UserCommentCursor` 的 `account:{accountId}:` 前缀；不得再用空 prefix 或 `CacheTag.Comment` 全局清除公开评论 output cache。公开评论 frame identity 包含 viewer region，保证 `comment_region_compliance.blocked_regions` 过滤后的 CN-MAINLAND/UNKNOWN/其他地区读模型不会共享同一个缓存条目。公开评论线程/回复端点不挂 HTTP OutputCache，避免审核 notification stream、地区过滤与浏览器缓存产生状态分叉。评论 cursor limit 由 `ICommentCursorPolicyResolver` 从 `CommentCursorPolicies` / `CommentCursorPolicies:Tenants:{tenant}` 配置解析；缺省仍使用 threads 10/50、replies 20/100、user comments 10/50，端点和 Core gateway 不得直接硬编码分页上限。

## AEDS Binary 链

FsusBlog 运行时 API 只维护 AEDS binary 链：

| 链路 | 内容类型 | 解码位置 | 用途 |
|------|----------|----------|------|
| Binary 链 | `application/octet-stream`（AEDS v2 帧） | TypeScript adapter / 浏览器 Wasm Worker | 生产主链、公开读取与管理端写操作 |

**失败逻辑**：Wasm Worker 解码失败时，客户端可切到 TypeScript binary decoder 或展示协议错误；不得重发文本 API 请求。

**v2 写出与缓存路径**：
- 帧头固定 16 字节，动态响应通过 `AedsFrameBufferWriter` 预留 header 并在同一 pooled buffer 中写 payload，`Seal()` 后回填 header/CRC，避免先构造 payload 再复制到完整 frame。
- `/api/binary/**` 在完成 Accept 与 binary request content-type 校验后直接进入 endpoint 写出链路，不再被 API binary response middleware 捕获到临时缓冲。
- 非 binary `/api/**` 请求只有在客户端显式接受 binary envelope 时才进入捕获/转换路径；普通 JSON 成功响应不再被无差别缓冲。真人阅读 proof 运行时路径已迁移到 `/api/binary/read-proof/*.aeds`。
- 非上传 binary 请求使用 pooled frame buffer 读取，默认最大 frame 为 8 MiB；解码后的 payload 以 buffer slice 传递给端点，buffer 生命周期挂到 response completion，不再为 payload 额外 `ToArray()`。
- 上传分片继续走 raw stream，端点用 request body backed `IFormFile` 交给文件服务，不再把整个分片读入 `MemoryStream` 后克隆成数组。
- PostgreSQL/ORM entity/command service 是 write model；Public AOT HTML、article detail `.aeds`、search index、list/category/tag/hot snapshot 是 artifact-backed read model；L1/L2/OutputCache 只是加速层，不能作为 CQRS read model 的替代。
- 公开热点 GET（article list、hot articles、category、tag、detail、公开 HTML）优先由 `PublicHotReadFastPath` 在 `UseFsusApplicationPipeline` 之前命中不可变快照并写出完整预编码 bytes；binary artifact 在构建阶段生成 raw/br/gzip variant，请求时按 `Accept-Encoding` 选择，并支持 variant-aware `ETag` / `If-None-Match` / `304`。hit 路径不访问 PostgreSQL、Redis、`IMemoryCache`、OutputCache、文件系统、OpenTelemetry span 或 AEDS encoder。DB fallback 只允许在后台 projector、修复任务或 `/api/binary/admin/article/**` 管理端路径发生。快照状态（`NotStarted` / `Building` / `Ready` / `Failed`）通过 readiness 暴露；未 Ready 时 L0 路径返回 `503` + `Retry-After`，写入链路不等待完整重建。HTML artifact 的 `routeKey` 会先映射为 URL-safe `pathKey`，`/api/binary/article/html/{pathKey}.html` 只作为诊断/预览命中路径，不计入真实公开页 QPS。
- `PublicHotArtifactUpdateWorker` debounce/coalesce 期间必须收集窗口内全部唯一 article ID，并在同一个 snapshot 上依次执行 delta projector 后原子 publish；任一 update 没有有效 article ID 时强制全量 rebuild。不得只使用窗口首个 article ID，否则删除、归档、转草稿或敏感内容修订可能让后续文章的 detail frame 继续被 L0 匿名命中。
- PublicHot 全量 projector 必须在 `MaxArticleFrames` 截断前统计当前公开文章总量，并把 `publicArticleCount`、`articleFrameLimit`、`articleFrameLimitExceeded` 暴露到 runtime snapshot；一旦公开文章数超过 frame 上限，readiness/runtime 必须 degraded/not_ready，避免仍公开的老文章因预加载容量静默变成 L0 404。
- 浏览计数不在读取链路产生，而由独立真人阅读 proof 事件更新。
- VisitLog flush 只写入 `IHotStatsInvalidationCoalescer` dirty 标记，不直接 broad invalidate AdminStats/HotArticles。coalescer 对 HotArticles 使用 2s debounce、Stats 使用 10s debounce，并在 threshold 或 shutdown 时 flush pending state；HotArticles 的 L1/L2 identity 形如 `ArticleHot:v{hotVersion}:core:v2:{count}` / `ArticleHotFrame:v{hotVersion}:core:v2:{count}`，失效时发布新版本并让旧版本按 TTL 自然过期，避免高频 `RemoveByPrefixAsync(..., string.Empty)` 扫描。
- `IUnifiedCache` 提供 `RemoveManyAsync` 与 `RemoveByPrefixManyAsync`。写路径失效应优先传递 `CacheKeyIdentity` / `CachePrefixIdentity` 批量请求，由 cache 层合并 L1 remove、Redis `KeyDeleteAsync(RedisKey[])`、registry `SetRemoveAsync(RedisValue[])`，并在同 policy 多 prefix 时只扫描一次 registry；registry 缺失 fallback 使用同 policy prefixes 的共同前缀执行一次 keyspace scan 后再二次过滤。
- compact payload 使用共享 UTF-8 blob + 固定数值记录，作为当前兼容的 payload 字典化落点，减少列表、分类、标签、conversation 和 stats 的重复文本包体。
- Notification stream payload 写出优先走已知契约的 typed writer；只有新增且尚未登记的 payload 才允许进入反射兜底。
- 管理端 stats 对外收敛为 `AdminStatsQueryDto` / `AdminStats` 聚合 query model。`/api/binary/stats` 同帧携带 overview、recent comments 与 regions，dashboard 首屏从单次请求派生视图区块；recent/region 窄端点仅作为兼容入口。
- 前端 4 KiB 及以下 payload 默认主线程 TypeScript decode，大 payload 交给 Worker / Wasm decode。
- 前端工具型响应式状态优先使用事件源本身：dashboard chart resize 由 chart 容器 `ResizeObserver` 驱动，布局断点由 `matchMedia` 驱动，human-read-proof 只按剩余 dwell 时间调度一次性提交检查，避免全局 resize 风暴和固定间隔 dwell polling。
- JSON 与 Binary 失败语义共用 `ApiErrorSemanticMapper`，只在传输层区分 JSON envelope 与 `ApiError` frame，错误码、HTTP status 和默认消息必须一致。
- Binary 端点基础解析通过 `IBinaryEndpointRequestContext` 统一读取 frame/header、缓存身份、设备指纹与 viewer identity，端点文件不得手写第二套头部解析。

## Notification Stream 握手与可观测性

```text
Client
  → GET /api/notifications/stream/preflight（同 RiskControl/legacy PoW/cursor/protocol 参数）
  → 204 No Content：再发 WebSocket upgrade 到 /api/notifications/stream
  → 非 204：读取 AEDS ApiError frame 与 X-Fsus-Notification-Stream-* 头，映射为前端失败码
```

- WebSocket 主通道仍固定为 `GET /api/notifications/stream` + `fsus-aeds.v2`。
- 该通道不是标准 Server-Sent Events，不使用 `EventSource` 或 `text/event-stream`，每条消息都是完整 AEDS v2 binary frame。
- Preflight 与正式 WebSocket 握手共用 `NotificationStreamHandshakeService`，先校验 Origin allowlist，再验证认证、RiskControl / legacy PoW、cursor 和协议语义；preflight 不要求 WebSocket upgrade，且只校验一次性 RiskControl proof 的存在性和 kind，正式 WebSocket 握手才消费 proof。
- 握手失败统一写入 `X-Fsus-Notification-Stream-Error-Code` 与 `X-Fsus-Notification-Stream-Status-Code`，并返回 AEDS `ApiError` frame。
- Preflight 与正式 WebSocket endpoint 都使用 `notification_stream` 固定窗口策略；正式连接在 `NotificationStreamConnectionManager.RegisterConnection` 内、`AcceptWebSocketAsync` 与 per-connection channel 分配之前获取全局 / IP / 账号原子租约。配额由 `NotificationStream:MaxConnectionsGlobal`、`NotificationStream:MaxConnectionsPerIp`、`NotificationStream:MaxConnectionsPerAccount` 控制，超限返回 `429 notification_connection_limit`，并在 `RemoveConnection`、accept 失败、backlog/heartbeat/pump 异常与请求取消路径释放租约。
- 通知握手只编排协议、RiskControl / legacy PoW 与握手结果。账号封禁/注销准入下沉到 `NotificationStreamAdmissionService`，notification stream audience 分组下沉到 `NotificationStreamAudienceResolver`，消息域到 user/group route 的映射下沉到 `MessageNotificationStreamPort`。
- Notification stream backlog 按 route 写入 Redis stream（`u:{id}` / `g:{group}`；multi-user target 展开为多个 user route），多目标 backlog 写入通过 Redis batch/pipeline 一次提交；replay 只读取当前连接可见的 user/group stream 后按 event id 合并，不再从全局流拉取后置过滤。
- 业务发布路径只负责写 backlog 并把本地 fanout 意图放入 `NotificationStreamLocalFanoutQueue`，`NotificationStreamLocalFanoutWorker` 再遍历本机连接。慢连接仍由每连接队列和 slow-consumer 断开保护兜底，突变请求不随本机连接数线性放大。
- Resilience drill 通过 Development/Test-only `/_fsus/testing/notification-stream/publish` 入口驱动同一 `INotificationStreamPublisher` 链路；`drillSlowConsumer=1` 只在 Development/Test WebSocket query 中启用发送延迟，`drillQueueCapacity` 可把该测试连接的 per-connection queue 降到 32，用来稳定触发背压关闭，不改变生产 pump 行为。
- 连接 pump 使用每连接一个 `PeriodicTimer` heartbeat loop；业务 frame 与 heartbeat 通过发送锁串行写 WebSocket，避免每轮 idle wait 创建 linked timeout CTS。
- `CacheControl` 与 `SearchIndexUpdated` 的搜索索引版本字段以 `version / manifestUrl / generatedAt` 为唯一消费语义，Service Worker 不再从多个字段推导版本。

## 真人阅读事件源

```text
SPA hydration
  → /api/binary/read-proof/challenge.aeds
  → 主内容可见停留 ≥ 8s
  → /api/binary/read-proof/submit.aeds
  → VisitLogChannel(HumanReadEvent)
  → sys_visit_log + Article.Views 投影 + Redis hot articles + stats/cache invalidation
```

- `sys_visit_log` 是文章浏览与站点访问统计的单一事件源，字段包含 `event_type`、`route_key`、`article_id`、`viewer_key_hash`、`proof_id`、`dwell_ms`；最终态不保留历史 `userid` / `user_id` 账号绑定列。
- `article_view_seed` / `ArticleViewSeed` 只保存迁移时的历史 `article.views`，用于重建 `Article.Views = legacy_views + article_read events` 投影；运行时详情、热榜、搜索或公开读链不得把它当作实时浏览量来源。
- 直接读取 `/api/binary/article/{id}.aeds`、AOT 首屏、无 JS、爬虫和预取请求不会增加计数。
- `VisitLogMiddleware` 仅保留为管线兼容占位，不再从 GET 请求采样。
- `VisitLogProcessorService` 只负责读取事件批次与落库，文章浏览量投影由 `IArticleViewProjectionService` 聚合后通过单条 `VALUES` 更新批量写入，Redis 热榜使用 batch/pipeline，PublicHot 只收到一个 `article-view-projection-batch` dirty event。公开详情读链不再因单次 view 增量删除 `ArticleDetail` / `ArticleDetailFrame` 内容缓存；`ArticleService.IncreaseViewCountAsync` 只把正向增量写入进程内 `IArticleViewWriteBuffer`，`ArticleViewFlushWorker` 每 5 秒或 graceful shutdown 时批量 flush 到 PostgreSQL 与 Redis `blog:top_articles`，flush 后再标记 stats/hot articles dirty 并触发 PublicHot 最终一致刷新。缓存命中的详情响应会用 Redis 热榜分数向上覆盖展示 views，避免为浏览量抖动破坏正文缓存命中率；若进程在 flush 前崩溃，已落库的 `sys_visit_log` 仍由 `ArticleViewProjectionRepairWorker` 重建 `Article.Views` 投影作为回退。
- `ArticleViewProjectionRepairWorker` 周期性从 `sys_visit_log` 重新聚合 `article_read` 事件修复 `article.views`，保证访问日志已落库但投影失败时不会永久漂移。访问日志落库、投影修复、定时发布和 PublicHot rebuild 都走 `DbConcurrencyGate`，避免后台任务绕过 DB 并发预算。
- 多实例部署下，带全局副作用的后台 worker 通过 `IBackgroundWorkerLease` 在 Redis L2 上执行 leader election。`ArticleMutationOutboxDispatcher`、`LogCleanupService`、`ScheduledPublishWorker`、`UploadSessionCleanupWorker`、`PublicAotBackfillWorker`、`CrawlerUpdateWorker`、`PowLoadResetWorker` 与 `ArticleViewProjectionRepairWorker` 每轮实际工作前先用 `CachePolicyId.BackgroundWorkerLease` 抢占 5 秒 lease，并在长任务内按 2 秒周期续租；standby 实例跳过本轮，leader 失联后 lease TTL 自动释放并由下一实例接任。该 lease 只保护 worker 运行权，不改变任务周期、数据库事务语义或 outbox/retry 语义。

## Service Worker 搜索

```text
npm run build → 生成 search v3 静态索引 → 随 SPA 部署
首访搜索 → 加载 core + recent shard → Wasm 排序 → 返回紧凑二进制结果
后台预热 → 增量加载 archive shard；不再生成或下载重复 body shard
Service Worker → 缓存 manifest/shard/patch 并按版本隔离旧索引
```

搜索不依赖服务端在线检索，断网或服务不可用时仍可完整使用。

服务端在线搜索在索引 rebuild 完成后保留进程内 token posting snapshot，`SearchAsync` 优先走 runtime snapshot 返回 Top 200，并从原文窗口生成 snippet；只有 snapshot 尚未构建时才回退数据库 `%keyword%` 查询。启动期搜索索引备份在 Linux 上优先创建 hardlink snapshot，失败时才回退文件复制。

## 单作者发布与开放分发

文章实体现在显式记录 `Status`、`ScheduledPublishAt`、`PublishedAt`、`ArchivedAt`、`DeletedAt`。公开读链、feed、sitemap、related-reading、搜索 runtime fallback、search index rebuild、分类/标签计数必须只读取 `Status=Published` 且发布时间已到的文章；`IsDeleted` 继续保留原有回收站语义。

`ScheduledPublishWorker` 每分钟按 `scheduled_publish_at, id` 扫描到期 `Scheduled` 文章，在同一事务内把文章转换为 `Published` 并写入 `article_mutation_outbox` 的 `scheduled-published` 事件；事务成功后仍同步尝试 search index、PublicAOT、HTTP/cache 失效与 `PublicHotArtifactUpdateQueue` 入队。若事务失败，文章保持可被后续扫描重试；若事务已提交但任一派生副作用失败，worker 记录 degraded，outbox dispatcher 会按 retry/backoff 重放 cache/search/AEDS/PublicHot/notification stream 派生更新。`article_mutation_outbox` 仍保存事件级 pending/processing/processed/poison 与 retry/backoff，`article_mutation_outbox_edge` 记录 public-aot、http-cache、search-projection、article-detail-aeds、public-hot-read、notification 等 edge 的 status、attempt count、last error 和 updated_at；dispatcher 重跑时会跳过已完成 edge，只在 required edge 全部完成后才把事件标记 processed。PublicHotRead 入队返回显式 accepted/rejected 状态；请求内同步副作用按 best-effort 记录日志，outbox replay 的 required public-hot-read edge 在队列满或关闭时进入 retry，不再只依赖 warning。失败结果会写入事件 retry count、next retry、last error，并同步记录失败 edge。worker 每轮把 `lastPublishedCount`、`lastFailedCount`、`dueBacklog` 与最近错误写入 `ScheduledPublishRuntimeState`，`/api/ops/health/ready-detail` 的 runtime 区块会暴露该快照。创建、更新、删除、恢复、永久删除同样必须在同一文章事务内写入 `article_mutation_outbox`，请求内仍同步尝试派生更新；若进程在提交后崩溃，`ArticleMutationOutboxDispatcher` 会按 retry/backoff 重放派生更新并在成功后标记 processed。

文章删除、恢复与永久删除都使用 PostgreSQL `xmin` 作为 row-version guard。软删除只匹配当前未删除 row-version；恢复只匹配当前已删除 row-version，并恢复为 Draft；永久删除在同一事务内先按 `isdeleted=true + xmin` 执行 `FOR UPDATE`，锁定成功后才清理 comment/tag/body/article，避免 stale restore/delete interleaving 删除子表或发出重复 outbox。

Binary 文章列表缓存使用 `core:v4:{public|admin}:...:{status}` 身份隔离，HTTP OutputCache 的 ArticleList 策略也必须按 `page/size/categoryId/tagId/isDeleted/status` vary。匿名列表只缓存 public published 视图；admin 状态筛选可缓存 draft/scheduled/archived/deleted 视图，但 admin 详情读取未发布文章时绕过公开详情缓存，避免草稿负缓存或私有正文污染匿名 `/article/{id}` 读链。公共文章列表 page URL 只作为兼容层，DB 读取必须走 `(createtime DESC, id DESC)` keyset walk，`ArticleList` AEDS payload 通过 cursor envelope 暴露 `nextCursor/hasMore`；公共列表总数使用 `ArticleListCount` 缓存并绑定 `ArticleListVersion + filter`，内容变更后随列表版本自然失效。

开放分发层由 `BlogDistributionService` 与 `DistributionEndpoints` 提供：

- `/feed/rss.xml`、`/feed/atom.xml`、`/feed/feed.json` 与历史 `/api/Article/rss`
- `/sitemap.xml`、`/robots.txt`
- `/api/binary/article/{articleId}/related.aeds`（主运行时 AEDS）

`RelatedReadingService` 是相关文章、上一篇、下一篇的唯一查询入口，端点与 PublicAOT article snapshot 共用它。相关性只来自公开文章的分类、标签、正文关键词和发布时间，不读取点赞、收藏、关注、登录用户或画像数据；PublicAOT renderer payload 会携带同一份 `relatedReading`，SPA hydration 后继续使用同一个 view contract 渲染，避免首屏与运行时结构不一致。PublicAOT article detail 生成会先读取 admin/detail 原始视图并在 provider 内执行同一套公开可见性判定；只有 private 读取为空时才回退到公开 detail 读取，因此草稿、定时、归档状态不会被旧公开缓存覆盖，发布后的公开读链也可以帮助 AOT 避免偶发空读。

这些端点使用 output cache 的 ArticleList/Seo tag，响应头使用 `Cache-Control: public, max-age=60, stale-while-revalidate=300` 与 `Vary: Accept-Encoding, CF-IPCountry, X-Fsus-Region`，条件缓存与 304 语义只由 OutputCache/上游缓存层负责，`DistributionEndpoints` 不按正文手写 ETag 或解析 `If-None-Match`。公开评论、公开 taxonomy 与 related-reading AEDS 端点额外挂 `public_read` 限流和 `RiskAwarePublicReadFilter`：普通用户直接读取，verified crawler 使用独立高额度，social preview bot 不能访问 API，高风险 IP 在动态 API 上先要求 PoW，持续高风险返回 429。`VerifiedCrawler` 只由通过 CIDR/rDNS 验证的 search crawler 设置；AntiCrawler `observe` 模式下的伪造 crawler 可被放行观察，但不得进入 verified-crawler 分区。风险读写通过 `ISecurityRiskSignalSink` / `ISecurityRiskScoreReader` / `ISecurityRiskPolicyProvider`，反爬虫、PoW、ReadProof 和 RateLimiter 只写入各自来源信号；`SecurityRiskEventSink` 先维持 Redis `SecurityPowRisk` 热路径，再把同一事件写入 PostgreSQL `security_risk_event`，按 source/reason/action/subjectHash/routeKey/clientIpHash/deviceFpHash 可查询，Redis miss 时由 `RiskScoreEngine` 按剩余 TTL 对 PostgreSQL 事件线性衰减聚合并回填热缓存。持久化失败只写 structured fallback log，不让公开读、auth、comment 或 notification stream 判定变成 500；后台 `/api/binary/admin/security/**` 改 AntiCrawler/PoW 策略时由原生 security binary endpoint 直接执行 admin 授权、MFA、fixed_ip 限流和审计边界并更新 singleton 快照，外部 `/api/admin/security/**` JSON 已移除，策略热路径只读内存快照，不同步查询 DB。PublicHotRead L0 artifact 命中仍在常规 endpoint 前直接返回，不进入该动态加压路径。PublicAOT backfill 请求会记录排队时的失效版本；写盘前若同一路由或页面在排队后又被文章突变失效，本次 backfill 会丢弃，避免 draft/scheduled/archived 时排队的旧 category/tag 文档在 published 失效后覆盖新状态。测试隔离开启时，PublicAOT cache key 与 backfill 查询必须携带同一个 `X-Fsus-Test-Session`，后台生成通过临时 `HttpContext` 读取对应测试 schema，避免把测试文章写入全局 AOT 缓存。`check:distribution-version-coherence` 会预热公开缓存后，验证 draft/scheduled/archived 隐藏、published 可见，以及 update/delete/restore/permanent-delete 在 public binary list/detail、admin 状态列表/回收站、feed、sitemap、AOT article/category/tag pages 与 search index alias 上保持一致。

## 作者工作台与私有内容边界

作者工作台表包含 `article_draft`、`article_revision`、`asset_library_item`、`site_subscription`，评论审核字段保存在 `comment`，地区合规结果保存在 `comment_region_compliance`。生产前端通过原生 `/api/binary/author/**` AEDS endpoint 调用作者工作台；授权、admin step-up、fixed_ip 限流、审计、缓存失效和业务语义都在该 binary endpoint 内直接执行，外部 `/api/author/**` JSON 入口和 internal bridge 兼容层均已移除。`article_draft` 以 `owner_admin_principal_id + draft_key` 隔离并持久化正文、摘要、封面、分类、标签、`status`、`scheduled_publish_at` 与 `client_revision`；编辑器同时写本地缓存和 `/api/binary/author/drafts`，检测到服务端草稿更新时暂停服务端覆盖并要求作者恢复或丢弃。写作页从站点 SEO 配置计算 title/description/canonical/OG image/slug 预览，并在发布或定时发布前调用 `/api/binary/author/prepublish-check` 检查 SEO、危险 HTML、Markdown 结构、正文链接与图片 alt；错误项阻断提交，warning 需要作者在确认弹窗填写跳过理由并写入 `prepublish-warning-override` 审计。`/api/binary/author/preview` 不读写公开文章表，直接把当前表单 payload 渲染为受限 Markdown/AOT-like HTML，并由写作页以 sandboxed iframe 展示。`article_revision` 在创建、更新和回滚时记录标题、正文、摘要、封面、分类、标签、修订序号、diff 摘要、`created_by_admin_principal_id` 与时间；修订写入在文章事务内对 `article` 行执行 `FOR UPDATE` 并由 `(article_id, revision_no)` 唯一索引兜底，避免并发更新产生重复修订号。编辑器通过 `/api/binary/author/articles/{articleId}/revisions` 和单条 revision detail 在侧栏比较当前表单与历史版本，回滚后复用文章更新链路触发 AOT/search/feed/binary cache 失效并写入审计。`asset_library_item` 由 `/api/binary/author/articles/{articleId}/assets/reindex` 从正文 Markdown 图片与封面重建，仅索引 `/uploads/illustration/*`，保存 alt text、来源文章、hash 和引用计数；失去引用的资产先保留为 `referenceCount=0` 供作者审计，`/api/binary/author/assets/orphans` 只删除孤儿索引行，不删除上传文件本体。评论创建后默认 `Pending`，提交地区由 request IP 解析并写入合规表；CN-MAINLAND 严格策略只在 submit/viewer 为 CN-MAINLAND 时生效，UNKNOWN submit 进入人工审核且公开不可见，UNKNOWN viewer 对非空 blocked regions 保守隐藏。公开评论线程、回复预览和回复游标只读取 `Approved` 且未被当前 viewer region 屏蔽的记录；`/api/binary/author/comments/moderation` 提供状态队列、命中原因和地区合规字段，队列/单条/批量普通审核均要求 `comment.moderate`，单条/批量审核还必须携带 `admin-sensitive` admin step-up proof，服务层按旧状态 CAS 更新并只允许审核状态机内的转换，且不允许批准 `can_publish=false` 的发布地违法评论。匿名评论策略、nullifier 封禁和匿名凭证撤销继续分别要求 `anonymous.comment.configure`、`anonymous.nullifier.block`、`anonymous.credential.revoke`，不由 `comment.moderate` 或 `system.config` 代替。审核通过会向对应文章 notification stream 推送 `CommentAdded`，已公开评论被隐藏/拒绝/删除会推送 `CommentRemoved`；缓存清理按 article/root/user scope 执行，并可在拒绝/隐藏时联动封禁非 admin 用户。作者分析从 `VisitLog` 聚合真实阅读、搜索 routeKey、公开来源路径和 404 routeKey，并用 `PublicAOT` miss 审计估算 AOT 命中率；dashboard 只读取 admin-only `/api/binary/author/analytics`，不从私有页面采集 RUM。`/api/binary/author/**` 全部要求 admin principal，并按路由声明 `article.write`、`comment.moderate`、匿名治理、`audit.read` 或 `system.config` 细粒度权限，负责服务端草稿、预览、发布前检查、修订回滚、资产重建、作者分析、评论审核、导入导出和默认关闭的 AI 辅助。

评论审核链路的作者展示名投影必须与公开读取一致：队列、审核通过 `CommentAdded` 推送和回复站内通知都只读取 comment / parent comment 行内快照；public 使用 `public_handle` 后接未署名兜底，anonymous / zk anonymous 使用 `anonymous_display_name` 后接匿名兜底。审核链路不得通过 `user_id`、`reply_to_user_id` 或 `sys_user` 回退账号 username / public handle。

### ZK-prod 匿名评论密码学选型

[ADR-ZK-CircuitNative-Groth16.md](architecture/decisions/ADR-ZK-CircuitNative-Groth16.md) 是生产匿名评论密码学选型的架构来源：凭证签发使用 circuit-native credential v2，匿名评论证明使用 Groth16 anonymous comment proof。运行时标识固定为 `fsus.anonymous.comment.v2`，AEDS / circuit 绑定使用 `public_input_layout_version = 3`，`verifying_key_hash` 只能来自最终 trusted setup vk hash；credential root / revocation root 和 `nullifier = PRF(credential_secret, action_context, scope)` 是电路与服务端 ticket 校验的共同边界。只要 circuit-native issuer、Groth16、trusted setup、native verifier 或 wasm prover 任一生产组件未就绪，`zk_anonymous` ticket 链路必须保持 fail-closed，不得回退到 deterministic verifier、普通匿名、公开评论或托管网络。

circuit-native credential issuer 私钥是匿名凭证签发根密钥，不属于 web asset、上传资产或备份下载面。`AnonymousCredentialIssuer:CircuitNative:IssuerPrivateKeyPath` 必须指向非 `wwwroot`、非 `uploads`、非 `backups` 的本地文件；Unix mode 必须不宽于 `0600`。该校验是启动就绪边界，失败时中止 issuer 构造，回退只能是修正部署路径或文件权限后重启。

预览输出带 `data-preview-only=true` 和 `data-markdown-renderer=server-preview`，只走 admin JSON API，不写 PublicAOT cache，不进入 feed/search/sitemap。订阅表只保存 email hash 与 channel，避免把站点更新订阅扩展成社交关系链。

## PWA 与匿名性能遥测

`public/manifest.webmanifest` 暴露安装能力；`public/sw.js` 只缓存公开 shell 路由和搜索索引，不缓存 `/user`、`/admin`、`/login`。`/api/binary/**` 包括新的 public `.aeds` artifact 只走 service worker 网络透传，浏览器缓存策略完全由服务端 `Cache-Control`、`ETag`、`no-store` 负响应决定，不写入 shell/search cache。离线 shell 响应附带 `X-Fsus-Offline-Stale: 1` 和 `Cache-Control: no-store`，让 UI 和代理都能识别 stale 内容。`check:pwa-offline-smoke` 必须跑在 production preview 或真实生产 URL 上，验证最近公开文章可离线读取且私有 console 路由离线不命中缓存。

前端 `telemetryService` 采集公开页面 Core Web Vitals、hydration time、Wasm decode timing、Markdown render timing 与 navigation timing，只记录 `pageType`、`aotSource` 和数值指标；私有页面不发送 RUM 事件，敏感输入不进入 payload。匿名 `POST /api/binary/telemetry/rum` 使用 batched AEDS `RumMetricBatchRequest` frame、8192 bytes 帧上限、每批 16 条上限和低基数字段白名单，由 `RumTelemetryService` 净化后写入独立 `frontend_rum_metric` 表；旧 `/api/telemetry/rum` JSON endpoint 已移除。作者 dashboard 从该表聚合 P75/平均值、页面类型和 AOT 来源分布；RUM 不再占用 `sys_audit_log`。

`sys_audit_log` 是结构化安全审计表，字段包括 `source/type/action/outcome/severity/actor/target`、trace/path/method、隐私 hash、`context_json` 和 tamper evidence。普通 Serilog 事件仍通过 bounded channel 异步落库；请求 audit/log context 的普通账号维度写作 `AccountId`，审计主体维度写作 `AuditActorId`，不得再输出泛化的 `UserId` 字段。mapper 只从显式 `AuditActorType` + `AuditActorId` 生成 actor，不把普通日志 context 中的裸 `UserId`/`AccountId`/`AdminPrincipalId` 提升为审计主体，并会过滤这些身份平面字段。admin/security/audit 高价值事件由 `IAuditEventService` 直接同步写入，失败时落 `FSUSBLOG_DATA_ROOT/audit-fallback/critical-audit-*.jsonl`。审计查询响应默认 `pii-redacted`，不会把 `IpHash`、`UserAgentHash`、`SessionIdHash` 或 `DeviceFingerprintHash` 精确值返回给普通 `audit.read` admin；只有带 `audit.investigate` 的 admin 显式请求 `piiMode=investigation` 才能读取完整 hash，且该读取本身写高价值审计。`/api/ops/health/ready-detail` 的 `runtime.auditLog` 暴露 queued/dropped/writeFailure/fallback 计数；后台 `LogCleanupService` 保留 RUM 14 天、访问日志 30 天、普通审计 365 天，高价值或 critical 审计不自动清理。

## 安全链路概览

详细内容见 [security.md](security.md)，主链路概述如下：

```text
匿名请求
  → Rate Limiter (fixed_ip)
  → PoW 挑战（注册/登录等高风险操作）
  → 密码哈希验证（BCrypt，cost ≥ 10）
  ↘ Passkey 验证（FIDO2 Discoverable Credential）

认证成功
  → AEDS auth frame + HttpOnly Cookie session（短期 JWT 仅作为服务端内部签发/校验细节）
  → Refresh Token（HttpOnly Cookie，`UserSession.RefreshTokenHash` 哈希存储，CAS 轮换制）
  → 可选：MFA TOTP 挑战（Passkey 登录免 MFA）
  → 会话记录（可列出 / 吊销全部其他）

请求授权
  → [anonymous] 公开内容端点
  → [authenticated] 用户端点（需 HttpOnly Cookie session / AEDS auth frame）
  → [admin] 管理端端点（需 `identity_kind=admin_principal` + 具体 `admin_permission`）
```

## 生产编排

```text
docker-compose.yml
├── fsus-nginx          # 可选部署层：反向代理 + 静态文件 + SSL 终端；不计入项目内 QPS 基线
├── fsus-server         # ASP.NET Core 10 API（Alpine）
│   ├── 挂载: fsus-aot-cache（AOT HTML shell）
│   └── 挂载: fsus-logs（Serilog 滚动日志）
├── fsus-postgres       # PostgreSQL（持久化卷）
└── fsus-redis          # Redis（持久化卷）
```

上述编排是生产部署参考，不改变性能证据口径。项目内部 benchmark、`backend-qps` 与 issue 验收默认使用 Kestrel-only single-process baseline；若单独评估 nginx/CDN/reverse proxy，应在证据中写入 `optional_deployment_layer`，并标记 `counted_as_project_baseline=false`。

健康检查入口：

- `GET /health/live`：存活探针（进程存活即返回 200，`application/json`）
- `GET /health/ready`：公网最小就绪探针（只返回 `status` / `checkedAt`，HTTP 200/503 表示 ready/not ready）
- `GET /api/ops/health/ready-detail`：受保护的详细就绪报告（admin principal + `audit.read`）

Health/ops 协议独立于 PublicAOT 与 AEDS payload。`ProductionHealthEndpoints` 的公网 readiness 只返回最小 JSON；详细运维快照只在受保护端点返回。readiness 的启动状态来自 `StartupRuntimeState.CreateSnapshot()`，定时发布后台状态来自 `ScheduledPublishRuntimeState.CreateSnapshot()`，RiskControl 状态来自 active/LKG policy、perception-sealed@v2 AEAD key、Redis consume-once、challenge provider registry 和 perception performance budget 检查。perception-sealed@v2 token 的 AEAD AAD 绑定 envelope context 与 ciphertext hash，密文 payload 另带 payload binding hash；action/route envelope swap、payload-only context drift 或旧 binding 缺失都必须 fail closed 为 tamper/context mismatch。因此生产启动校验、cache/bootstrap rollback、定时发布 backlog、RiskControl enforcement 与 PublicAOT 壳层协议可以分别演进。

单作者后台运维面板位于 `/user/manage/ops`、`/user/manage/cache`、`/user/manage/integrity`，后端统一由 `AdminOperationsService` 聚合。`/api/binary/author/ops/health` 合并 readiness、审计 runtime、Crawler CIDR、PublicHotRead、Search manifest、备份 artifact、结构化最近错误和 `article_mutation_outbox` backlog；最近错误只在查询物化后做摘要清理和分组，避免 ORM projection 把 SQL 表达式泄露到 UI。`/api/binary/author/cache/diagnostics` 从 `PublicHotReadStore`、`PublicAotInvalidationTracker`、`CacheInvalidationRuntimeState`、search manifest 与实际 sitemap/feed 构建结果读取状态；`/api/binary/author/integrity` 做只读巡检，safe fix 只处理无效 `article_tag` 和注销用户 session 撤销，必须通过 diff、确认短语、admin step-up proof 和审计事件闭环。

备份/恢复闭环由 `tools/operations/backup-site.sh`、`tools/operations/restore-site.sh` 和 `tools/operations/backup-restore-drill.sh` 承载。站点包包含 PostgreSQL dump、uploads、DataProtection keyring、脱敏配置、AOT cache 和 search artifacts；Redis 仍视为缓存/控制面依赖，restore drill 使用空 Redis 数据目录即可验证恢复后的运行时。数据库迁移仍由启动 lifecycle 运行，失败后的回滚依赖迁移前站点包或数据库 dump，而不是自动 in-process down migration。

## 生产启动保护

服务器通过 HostedService 在启动后执行以下生产校验，失败时进入可观测降级状态而不是直接终止进程：

- JWT 密钥不得为默认占位值
- `Security:Pow:SigningKey`、`Security:CaptchaV1:SigningKey`、`Security:RecoveryKeyPepper`、`AnonymousCredentialIssuer:SubjectHashPepper`、`VisitLog:IpHashPepper`、`Moderation:RegionPolicy:IpHashKey`、`Moderation:Pepper` 必须使用独立高熵值，且不得等于 `Jwt:SecretKey`
- Redis 密码不得为空
- `SITE_BASEURL` 必须为 HTTPS
- CORS 配置的 Origins 不得包含 HTTP 来源

运行期日志的隐私边界与生产启动密钥边界一致：原始客户端 IP 只能参与本地判定，不能进入日志、指标或 fallback structured event。PoW、RiskControl、visit log 和审计链路需要来源关联时必须写 HMAC 后的 `ClientIpHash` / `IpHash`；PoW 日志使用 `VisitLog:IpHashPepper`，缺失该配置时不得回退到 JWT、localhost、raw remote IP 或请求头。

降级状态会写入运行时状态任务 `productionStartupValidation`。回退路径是修复环境变量或依赖服务后重启应用；密钥类错误只能恢复对应安全域的上一个密钥，不能临时复用 JWT 密钥，也无需修改路由、中间件或健康探针代码。

详细部署流程见 [production.md](production.md)。

# 系统架构

本文档描述 FsusBlog 的整体架构设计、数据流路径、缓存分层和模块边界。

## 概览

FsusBlog 是一个单体全栈系统，以"公开内容首屏速度 + 运行时一致性 + 安全链路完整性"为核心约束。

```text
Browser
  ├── 公开页首访  → Nginx 静态文件 → AOT HTML shell（命中缓存）
  │                                → 未命中 → SPA index.html + 客户端 hydration
  ├── SPA 路由    → Vue Router     → Pinia Store → API / Binary / Worker
  └── Service Worker               → 本地搜索索引（离线可用）

Nginx → Kestrel (ASP.NET Core 10)
  ├── Auth / Rate Limiting / CORS
  ├── Redis L2 缓存
  ├── PostgreSQL（SqlSugar ORM）
  └── 静态文件服务（AOT cache 卷）
```

## 模块边界

| 模块 | 职责 |
|------|------|
| `FsusBlog.Server` | HTTP API、认证、Rate Limiting、缓存治理、安全链路、AOT 输出、SSE |
| `FsusBlog.Client` | SPA、公开页 hydration、Wasm 解码、Service Worker 搜索、状态管理 |
| `FsusBlog.Shared` | 前后端共享二进制协议模型（AEDS 帧结构、契约结构体） |
| `FsusBlog.Core` | POD 编解码、映射、投影逻辑（与 HTTP 无关的纯计算层） |
| `FsusBlog.Server.Tests` | xUnit 单元与集成测试，按洁净等级分层 |

**边界规则**：

- `Server` 和 `Client` 均可引用 `Shared`，但彼此不得直接引用对方。
- `Core` 不引用任何 HTTP、缓存或认证相关依赖。
- `Client` 端 Wasm 模块（`wasm/`）不引用任何 JS/TS 代码。
- `Shared` 只承载跨进程稳定 DTO、AEDS/SSE/POD 契约和响应信封；端点请求上下文、服务命令、缓存 key、认证中间状态必须留在 `Server`。
- `Server` 端点层只做路由、输入校验和响应组装。二进制头、frame 名称、设备指纹、viewer identity、MFA proof 与 read-proof 适配分别通过 `IBinaryEndpointRequestContext`、`IHumanReadProofEndpointAdapter` 等基础设施服务注入。

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
| 核心中间件 | `UseFsusCoreMiddlewares` | 异常、审计、认证授权、封禁用户、访问日志兼容占位 |
| 静态资源 | `UseFsusStaticAssets` | Public AOT cache、SPA 静态文件、fallback |
| 端点管线 | `UseFsusEndpointPipeline` | OpenTelemetry trace correlation、Rate Limiting、OutputCache、API/Binary/健康路由 |

路由组装按 `MapFsusOperationalRoutes`、`MapFsusApiRoutes`、`MapFsusPublicRoutes` 分层，避免在新增 API 时同时触碰健康探针、SSE、SPA fallback 和静态文件策略。

运行时 DI 组合根按边界拆分：基础设施注册由 `AddBinaryRuntime`、`AddNotificationRuntime`、`AddCrawlerAndSearchRuntime`、`AddFileAndAuthRuntime`、`AddAuditRuntime`、`AddMessagingRuntime`、`AddCacheRuntime`、`AddIdentityRuntime`、`AddBackgroundRuntime`、`AddSpaRuntime`、`AddObjectPools` 分段承载；领域注册由 `AddContentRuntimeServices`、`AddUserRuntimePorts`、`AddGeneralDomainServices`、`AddCoreBridgeServices` 分段承载。新增服务应优先落入对应分组，避免把 Bootstrap 重新变成无边界注册清单。

`BannedUserMiddleware` 是运行时封禁检查的唯一主实现；旧 `BannedUserFilter` 名称仅作为兼容别名保留，新增调用点必须使用 Middleware 命名。

封禁写入绕过、认证响应 `no-store` 等端点级策略只允许通过 endpoint metadata 声明。`Infrastructure/Policies/EndpointPolicyMetadata.cs` 提供 `AllowBannedUserWrite()` 与 `RequireNoStoreResponse()`，运行时中间件读取路由元数据执行策略，避免 `/api/...` 字符串匹配在路由迁移时失效。

生产启动校验通过 `ProductionStartupValidationHostedService` 纳入 DI 生命周期。生产环境校验失败时写入 `StartupRuntimeState` 的 `productionStartupValidation=degraded` 并记录日志，进程保持可观测；就绪探针仍由 DB/Redis 连通性决定。非生产环境报告 `skipped`。

运行时可观测性由 `Infrastructure/Observability` 统一管理。`FsusObservability` 暴露 `ActivitySource=FsusBlog.Server` 与 `Meter=FsusBlog.Server`，并把自定义属性限制为低基数 `fsus.*` 白名单。ASP.NET Core、HttpClient、runtime、Npgsql、SSE meter、cache、PublicAOT、search 和 scheduled-publish worker 都进入同一 trace/metric 面；`ObservabilityCorrelationMiddleware` 把 `Activity.TraceId` 写回 `HttpContext.TraceIdentifier` 和 `X-Fsus-Trace-Id`，使错误响应、Serilog/audit 与标准 collector trace 能按同一 ID 关联。OTLP exporter 默认关闭，只有 `Observability:ExporterEnabled`/`OTEL_EXPORTER_OTLP_ENDPOINT` 打开后才向 collector 导出。

缓存治理清单由 `tools/cache/export-cache-governance.mjs` 从 `CachePolicyRegistry`、`CacheTag`、`HttpCachePolicyCatalog` 生成到 `docs/cache-governance.catalog.json`。`tools/check-cache-governance.sh` 会在 fast gate 中校验该清单，防止 cache key/tag/catalog 与文档证据漂移。

## 前端主题与组件覆盖边界

FsusBlog 只维护应用语义 alias，底层颜色、阴影、过渡和缓动优先复用 Element Plus / FsusUI 变量：

- `src/frontend/src/assets/public-page.css` 定义 `--fsus-color-*`、`--fsus-duration-*`、`--fsus-ease-standard` 等 alias，不再在页面组件重复声明同语义色值。
- 管理表格默认使用 FsusUI table 视觉；不得再通过集中 CSS 或页面级 `:deep(.el-table*)` 重画 header、hover、cell padding。只允许在业务模板上声明列宽、列固定、tag/link 等语义内容。
- `src/frontend/src/fsusui/primitiveAdapters.ts` 是 FsusBlog 本地 primitive 到 FsusUI 语义 variant 的适配层；`UiButton`、`UiTag`、`UiEmptyState` 只保留业务语义映射，不再各自维护基础控件状态面。
- FsusUI 1.4.0 之后不再维护集中 `fsusui-overrides.css`。业务页不得用全局 `.el-*` 接管组件内部结构；确需响应式排布时，只能挂在当前业务壳层类或 `blog-*` utility class 上，并优先使用 FsusUI 变量和组件默认样式。
- FsusUI 组件实例上的 `class` 只能承载布局尺寸、响应式可见性、测试/语义 hook；不得把 `bg-*`、`text-*`、`border-*`、`rounded-*`、`shadow-*` 或 `!important` 类直接挂到 `ElButton`、`ElTag`、`ElAvatar`、`ElStatistic`、`ElLink` 等组件上重画默认视觉。
- FsusBlog 自有 utility 不占用 `.fsus-*` 类名空间；公开页链接/按钮焦点和交互态统一使用 `blog-focus-ring`、`blog-link-state`、`blog-interactive-state`。
- `prefers-reduced-motion: reduce` 由全局样式关闭循环动画和页面过渡；组件内新增动画必须走 `--fsus-duration-*` 与 `--fsus-ease-standard`。

## 请求路径

### 公开页首访

```text
Browser
  → Nginx（静态文件优先）
    → 命中 AOT 缓存卷（/aot-cache/*.html）→ 直接返回预渲染 HTML
    → 未命中 → 转发 Kestrel
      → Kestrel 尝试读取 Public AOT document cache
        → 命中且 renderer/assets version 匹配 → 直接输出 HTML
        → 过期但 version 兼容 → 输出 stale HTML + 排队 refresh
        → 未命中或 version 不兼容 → 返回 SPA index.html + 排队 backfill
        → backfill worker → bootstrap provider → Node/Vue SSR worker pool → document cache
      → SPA index.html fallback：客户端 hydration 接管
```

### Public AOT 单一渲染链

公开页的 `Home / ArticleDetail / Filter / Archive / About` 统一遵循一条渲染流水线：

```text
IPublicAotRouteRegistry
  → IPublicAotBootstrapProvider（产出 typed PublicPageSnapshot）
  → PublicAotRenderRequest + PublicAotRendererPayloadMapper
  → IPublicAotEntryRenderer（Node/Vue SSR worker pool）
  → src/helpers/publicAotBundle.ts + src/public-renderers/renderPublicPage.ts
  → PublicAotDocumentComposer
  → versioned AOT HTML document cache
```

关键约束：

- `src/frontend/scripts/server-public-ssr.mjs` 以 AEDS 行协议 worker 模式长驻，支持 `buildEntry` / `validateBundle` / `health` / `shutdown`；`PublicAot:SsrWorkerMode=PerRequest` 可作为紧急回退。
- AOT document cache 只允许由服务端 `server-ssr` backfill 写入；客户端、管理端和脚本不得上传 AOT bundle。
- AOT document cache 按 frontend asset version 写入版本化 artifact 路径；旧版本 artifact 只能在后台清理或因 version 不兼容被拒绝，不能直接返回给公开 URL。
- `PublicAotDocumentComposer` 只负责文档包装、SEO 头和脚本注入，不承担页面业务结构修复。
- Provider、shell service 与 renderer 之间只传递 `PublicPageSnapshot` / `PublicAotRenderRequest`，进入 Node worker 前由 `PublicAotRendererPayloadMapper` 做唯一 dictionary payload 映射；禁止恢复匿名 object graph 或每个 provider 自行拼 payload。
- `PublicAotDocumentService` 只在 compose 周期内解码一次 entry bootstrap/hydration payload，后续标题、描述和脚本注入复用同一解码结果。
- 页面内部结构、hydration props 与 Markdown HTML 以 Vue public renderer/helper 为唯一真相源，禁止 C# Markdown/props 与 Vue 组件双轨并存。
- `PublicPageRegistry`（C#）是跨语言页面身份元数据唯一真相源；前端通过 `src/frontend/src/public-renderers/generated/publicPageManifest.ts` 读取生成结果，`publicPageModel.ts` 只补 routeName/activeNav，禁止在 TS 再维护第二套 `pageId/canonicalSlug/seoEligible/aotShellReady/deferSpaBoot`。
- `PublicRouteIdentityRegistry`（C# shared）是跨语言 route identity token 与 path 语义唯一真相源；前后端都不得再各自硬编码 `article/category/tag/tag-name/search` 这组 bucket 字面量，或 `/article/ /category/ /tag/ /search /user/profile` 这组 path 常量。
- `src/backend/Infrastructure/PublicAot/PublicAotPageCatalog.cs` 只保留服务端运行时元数据（如 static path、默认标题、canonical fixed path）；`pageId`、hydration kind 和固定 slug 必须从 shared identity 派生，禁止在 backend catalog 再手写第二份跨语言页面身份。
- `ISpaAssetManifestService` 负责入口脚本、CSS、preload 和 frontend asset version；AOT 文档不得用正则补丁改写 dev/prod 资产路径。

### 测试隔离与运行时 key scope

生产缓存、Redis L2、SSE backlog 与文章运行时 key 前缀只依赖 `IRuntimeKeyScope`。测试会话隔离通过 `TestAwareRuntimeKeyScope` 适配 `ITestSessionKeyScope`，`X-Fsus-Test-Session` 语义不得向默认生产缓存、SSE 或业务 service 扩散。

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

`filterKey` 是筛选页稳定身份，`routeKey` 是公开页缓存/渲染身份。对分类与标签页，二者通常一致；对无效目标和兼容场景，也必须由统一 identity 层产出。

### API 读取（文章/评论）

```text
Client
  → AEDS Binary（Accept: application/octet-stream）
    → Kestrel → 公开读 artifact fast path（article detail *.aeds）
      → 命中 → 直接搬运预编码 AEDS frame → 返回 application/octet-stream
      → 未命中 → singleflight 排队后台 rebuild → 503/stale/SPA fallback，不在请求内同步打 PostgreSQL
    → 其他公开列表/聚合 → L1 readonly raw cache
      → 命中 → AedsBinaryWriter 写 header + payload，避免 L1 hit 的 byte[] 防御性复制
      → 未命中 → Redis L2 / DB concurrency gate / cache refill
  → TypeScript adapter / Wasm Web Worker 解码 AEDS 帧 → Pinia Store 更新
```

Article/comment binary endpoints 只面向应用 facade：文章端点通过 `IArticleEndpointService` 获取 article list/detail/hot/featured 与写入操作，评论端点通过 `ICommentEndpointService` 获取 thread/reply/user cursor 与删除操作。Core query、raw payload cache、投影转换和 service mutation 不在 endpoint 文件内展开。文章写入后的搜索投影、实时通知、Redis 热榜清理、文章详情 AEDS artifact 生成/失效和图片资产清理统一下沉到 `IArticleMutationSideEffectCoordinator`，由 `ArticleSearchProjector`、`ArticleDetailAedsArtifactProjector`、`ArticleRealtimeNotifier`、`ArticleAssetCleanupPolicy` 等小服务承载，`ArticleService` 只负责写入事务、查询、缓存/AOT 失效编排。

用户域对外按不重叠 facade 拆分：`IUserAccountReader` 只返回 `UserAccountSnapshot`，`IUserLoginWorkflowService` 负责登录/MFA 风险/最终签发，`IUserProfileCommandService` 负责资料与注销，`IUserSessionCommandService` 负责 refresh/session revoke，`IUserAdminModerationService` 负责后台治理。`User`/`UserSession` ORM entity 只在 `UserService` 兼容实现内部流转，不作为 endpoint、middleware 或 SSE admission 的读取契约。

### 认证写请求（注册 / 登录）

```text
Client
  → Rate Limiter (fixed_ip) → PoW 验证
  → 密码/Passkey 验证
  → JWT Access Token（15 min） + HttpOnly Refresh Token Cookie
  → MFA 挑战（如已启用，Passkey 登录免 MFA）
```

注册/登录 binary 端点按 `AuthBinaryRequestReader -> AuthBinaryApplicationFacade -> AuthBinaryResponseWriter` 分层：reader 只负责 AEDS request frame 解码，application facade 只负责注册、凭据校验、MFA 登录分支和最终 session token 结果，endpoint 保留 cookie 写入这一 HTTP side effect，writer 只负责 AEDS `AuthLoginFlow` / `ApiError` frame。

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

缓存失效优先使用 Redis registry 精确删除 prefix 命中的 key；registry 缺失时，`RemoveByPrefixAsync` 会记录 `registry_missing` 警告并执行 Redis keyspace scan fallback 回收现存 key，扫描失败则降级为可观测 warning，让后续写入自然修复 registry。AOT cache 文件失效仍走专用 Public AOT cache 服务，不在统一 Redis prefix 失效路径里全盘扫描。热点 miss singleflight 等待使用指数退避，避免固定间隔轮询放大 Redis 与 GC 压力。

评论缓存失效由 `ICacheInvalidationDispatcher.InvalidateCommentMutationAsync(CommentCacheInvalidationScope)` 承载：公开可见性变化只删除 `CommentCursor` 的 `article:{articleId}:` 前缀，特定回复树变化可额外删除 `article:{articleId}:root:{rootId}:`，个人评论历史只删除 `UserCommentCursor` 的 `user:{userId}:` 前缀；不得再用空 prefix 或 `CacheTag.Comment` 全局清除公开评论 output cache。公开评论线程/回复端点不挂 HTTP OutputCache，避免审核 SSE 与浏览器缓存产生状态分叉。

## AEDS Binary 链

FsusBlog 运行时 API 只维护 AEDS binary 链：

| 链路 | 内容类型 | 解码位置 | 用途 |
|------|----------|----------|------|
| Binary 链 | `application/octet-stream`（AEDS v2 帧） | TypeScript adapter / 浏览器 Wasm Worker | 生产主链、公开读取与管理端写操作 |

**失败逻辑**：Wasm Worker 解码失败时，客户端可切到 TypeScript binary decoder 或展示协议错误；不得重发文本 API 请求。

**v2 写出与缓存路径**：
- 帧头固定 16 字节，服务端通过 `Response.BodyWriter` 分段写出 header + payload，避免构造完整 frame 副本。
- `/api/binary/**` 在完成 Accept 与 binary request content-type 校验后直接进入 endpoint 写出链路，不再被 API binary response middleware 捕获到临时缓冲。
- 非 binary `/api/**` 请求只有在客户端显式接受 binary envelope 时才进入捕获/转换路径；普通 JSON 成功响应和真人阅读 proof 写入请求不再被无差别缓冲。
- 非上传 binary 请求使用 pooled frame buffer 读取，默认最大 frame 为 8 MiB；解码后的 payload 以 buffer slice 传递给端点，buffer 生命周期挂到 response completion，不再为 payload 额外 `ToArray()`。
- 上传分片继续走 raw stream，端点用 request body backed `IFormFile` 交给文件服务，不再把整个分片读入 `MemoryStream` 后克隆成数组。
- PostgreSQL/ORM entity/command service 是 write model；Public AOT HTML、article detail `.aeds`、search index、list/category/tag/hot snapshot 是 artifact-backed read model；L1/L2/OutputCache 只是加速层，不能作为 CQRS read model 的替代。
- 公开热点 GET（article list、hot articles、category、tag、detail、公开 HTML）优先由 `PublicHotReadFastPath` 在 `UseFsusApplicationPipeline` 之前命中不可变快照并写出完整预编码 bytes；hit 路径不访问 PostgreSQL、Redis、`IMemoryCache`、OutputCache、文件系统、OpenTelemetry span 或 AEDS encoder。DB fallback 只允许在后台 projector、修复任务或 `/api/binary/admin/article/**` 管理端路径发生。快照状态（`NotStarted` / `Building` / `Ready` / `Failed`）通过 readiness 暴露；未 Ready 时 L0 路径返回 `503` + `Retry-After`，写入链路不等待完整重建。HTML artifact 的 `routeKey` 会先映射为 URL-safe `pathKey`，`/api/binary/article/html/{pathKey}.html` 只作为诊断/预览命中路径，不计入真实公开页 QPS。
- 浏览计数不在读取链路产生，而由独立真人阅读 proof 事件更新。
- compact payload 使用共享 UTF-8 blob + 固定数值记录，减少列表、分类、标签和 stats 的包体。
- SSE notification payload 写出优先走已知契约的 typed writer；只有新增且尚未登记的 payload 才允许进入反射兜底。
- 管理端 stats 对外收敛为 `AdminStatsQueryDto` / `AdminStats` 聚合 query model。`/api/binary/stats` 同帧携带 overview、recent comments 与 regions，dashboard 首屏从单次请求派生视图区块；recent/region 窄端点仅作为兼容入口。
- 前端 4 KiB 及以下 payload 默认主线程 TypeScript decode，大 payload 交给 Worker / Wasm decode。
- 前端工具型响应式状态优先使用事件源本身：dashboard chart resize 由 chart 容器 `ResizeObserver` 驱动，布局断点由 `matchMedia` 驱动，human-read-proof 只按剩余 dwell 时间调度一次性提交检查，避免全局 resize 风暴和固定间隔 dwell polling。
- JSON 与 Binary 失败语义共用 `ApiErrorSemanticMapper`，只在传输层区分 JSON envelope 与 `ApiError` frame，错误码、HTTP status 和默认消息必须一致。
- Binary 端点基础解析通过 `IBinaryEndpointRequestContext` 统一读取 frame/header、缓存身份、设备指纹与 viewer identity，端点文件不得手写第二套头部解析。

## SSE 握手与可观测性

```text
Client
  → GET /api/notifications/stream/preflight（同 PoW/cursor/protocol 参数）
  → 204 No Content：再发 WebSocket upgrade 到 /api/notifications/stream
  → 非 204：读取 JSON ApiResponse 与 X-Fsus-Sse-* 头，映射为前端失败码
```

- WebSocket 主通道仍固定为 `GET /api/notifications/stream` + `fsus-aeds.v2`。
- Preflight 只验证认证、PoW、cursor 和协议语义，不要求 WebSocket upgrade。
- 握手失败统一写入 `X-Fsus-Sse-Error-Code` 与 `X-Fsus-Sse-Status-Code`；WebSocket 路径失败仍返回 AEDS `ApiError` frame。
- 通知握手只编排协议、PoW 与握手结果。账号封禁/注销准入下沉到 `NotificationStreamAdmissionService`，SSE audience 分组下沉到 `NotificationStreamAudienceResolver`，消息域到 user/group route 的映射下沉到 `MessageSsePort`。
- SSE backlog 按 route 写入 Redis stream（`u:{id}` / `g:{group}`；multi-user target 展开为多个 user route），多目标 backlog 写入通过 Redis batch/pipeline 一次提交；replay 只读取当前连接可见的 user/group stream 后按 event id 合并，不再从全局流拉取后置过滤。
- 业务发布路径只负责写 backlog 并把本地 fanout 意图放入 `SseLocalFanoutQueue`，`SseLocalFanoutWorker` 再遍历本机连接。慢连接仍由每连接队列和 slow-consumer 断开保护兜底，突变请求不随本机连接数线性放大。
- 连接 pump 使用每连接一个 `PeriodicTimer` heartbeat loop；业务 frame 与 heartbeat 通过发送锁串行写 WebSocket，避免每轮 idle wait 创建 linked timeout CTS。
- `CacheControl` 与 `SearchIndexUpdated` 的搜索索引版本字段以 `version / manifestUrl / generatedAt` 为唯一消费语义，Service Worker 不再从多个字段推导版本。

## 真人阅读事件源

```text
SPA hydration
  → /api/read-proof/challenge
  → 主内容可见停留 ≥ 8s
  → /api/read-proof/submit
  → VisitLogChannel(HumanReadEvent)
  → sys_visit_log + Article.Views 投影 + Redis hot articles + stats/cache invalidation
```

- `sys_visit_log` 是文章浏览与站点访问统计的单一事件源，字段包含 `event_type`、`route_key`、`article_id`、`viewer_key_hash`、`proof_id`、`dwell_ms`。
- `article_view_seed` 保存迁移时的历史 `article.views`，用于重建 `Article.Views = legacy_views + article_read events` 投影。
- 直接读取 `/api/binary/article/{id}.aeds`、AOT 首屏、无 JS、爬虫和预取请求不会增加计数。
- `VisitLogMiddleware` 仅保留为管线兼容占位，不再从 GET 请求采样。
- `VisitLogProcessorService` 只负责读取事件批次与落库，文章浏览量投影由 `IArticleViewProjectionService` 聚合后通过单条 `VALUES` 更新批量写入，Redis 热榜使用 batch/pipeline，详情失效设置批次上限，PublicHot 只收到一个 `article-view-projection-batch` dirty event。
- `ArticleViewProjectionRepairWorker` 周期性从 `sys_visit_log` 重新聚合 `article_read` 事件修复 `article.views`，保证访问日志已落库但投影失败时不会永久漂移。访问日志落库、投影修复、定时发布和 PublicHot rebuild 都走 `DbConcurrencyGate`，避免后台任务绕过 DB 并发预算。

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

`ScheduledPublishWorker` 每分钟按 `scheduled_publish_at, id` 扫描到期 `Scheduled` 文章，转换为 `Published` 后同步 search index，并通过 `ICacheInvalidationDispatcher.InvalidateArticleMutationAsync` 触发文章列表、旧 JSON 详情缓存、CoreBridge `core:v2:{id}` / `core:v3:{id}` 详情缓存、RSS、PublicAOT 等失效链，同时向 `PublicHotArtifactUpdateQueue` 入队 L0 快照刷新。单篇发布失败会保留 `Scheduled` 状态，下一轮继续重试；worker 每轮把 `lastPublishedCount`、`lastFailedCount`、`dueBacklog` 与最近错误写入 `ScheduledPublishRuntimeState`，`/health/ready` 的 runtime 区块会暴露该快照。创建、更新、删除、恢复、永久删除必须在同一文章事务内写入 `article_mutation_outbox`，请求内仍同步尝试 search/AEDS/PublicHot/SSE 派生更新；若进程在提交后崩溃，`ArticleMutationOutboxDispatcher` 会按 retry/backoff 重放派生更新并在成功后标记 processed。

Binary 文章列表缓存使用 `core:v3:{public|admin}:...:{status}` 身份隔离，HTTP OutputCache 的 ArticleList 策略也必须按 `page/size/categoryId/tagId/isDeleted/status` vary。匿名列表只缓存 public published 视图；admin 状态筛选可缓存 draft/scheduled/archived/deleted 视图，但 admin 详情读取未发布文章时绕过公开详情缓存，避免草稿负缓存或私有正文污染匿名 `/article/{id}` 读链。

开放分发层由 `BlogDistributionService` 与 `DistributionEndpoints` 提供：

- `/feed/rss.xml`、`/feed/atom.xml`、`/feed/feed.json` 与历史 `/api/Article/rss`
- `/sitemap.xml`、`/robots.txt`
- `/api/public/articles/{articleId}/related`

`RelatedReadingService` 是相关文章、上一篇、下一篇的唯一查询入口，端点与 PublicAOT article snapshot 共用它。相关性只来自公开文章的分类、标签、正文关键词和发布时间，不读取点赞、收藏、关注、登录用户或画像数据；PublicAOT renderer payload 会携带同一份 `relatedReading`，SPA hydration 后继续使用同一个 view contract 渲染，避免首屏与运行时结构不一致。PublicAOT article detail 生成会先读取 admin/detail 原始视图并在 provider 内执行同一套公开可见性判定；只有 private 读取为空时才回退到公开 detail 读取，因此草稿、定时、归档状态不会被旧公开缓存覆盖，发布后的公开读链也可以帮助 AOT 避免偶发空读。

这些端点使用 output cache 的 ArticleList/Seo tag，依赖文章突变和 SEO 变更的统一失效。PublicAOT backfill 请求会记录排队时的失效版本；写盘前若同一路由或页面在排队后又被文章突变失效，本次 backfill 会丢弃，避免 draft/scheduled/archived 时排队的旧 category/tag 文档在 published 失效后覆盖新状态。测试隔离开启时，PublicAOT cache key 与 backfill 查询必须携带同一个 `X-Fsus-Test-Session`，后台生成通过临时 `HttpContext` 读取对应测试 schema，避免把测试文章写入全局 AOT 缓存。`check:distribution-version-coherence` 会预热公开缓存后，验证 draft/scheduled/archived 隐藏、published 可见，以及 update/delete/restore/permanent-delete 在 public binary list/detail、admin 状态列表/回收站、feed、sitemap、AOT article/category/tag pages 与 search index alias 上保持一致。

## 作者工作台与私有内容边界

作者工作台表包含 `article_draft`、`article_revision`、`asset_library_item`、`site_subscription`，评论审核字段保存在 `comment`。`article_draft` 持久化正文、摘要、封面、分类、标签、`status`、`scheduled_publish_at` 与 `client_revision`；编辑器同时写本地缓存和 `/api/author/drafts`，检测到服务端草稿更新时暂停服务端覆盖并要求作者恢复或丢弃。写作页从站点 SEO 配置计算 title/description/canonical/OG image/slug 预览，并在发布或定时发布前调用 `/api/author/prepublish-check` 检查 SEO、危险 HTML、Markdown 结构、正文链接与图片 alt；错误项阻断提交，warning 需要作者在确认弹窗填写跳过理由并写入 `prepublish-warning-override` 审计。`/api/author/preview` 不读写公开文章表，直接把当前表单 payload 渲染为受限 Markdown/AOT-like HTML，并由写作页以 sandboxed iframe 展示。`article_revision` 在创建、更新和回滚时记录标题、正文、摘要、封面、分类、标签、修订序号、diff 摘要、操作者与时间；修订写入在文章事务内对 `article` 行执行 `FOR UPDATE` 并由 `(article_id, revision_no)` 唯一索引兜底，避免并发更新产生重复修订号。编辑器通过 `/api/author/articles/{articleId}/revisions` 和单条 revision detail 在侧栏比较当前表单与历史版本，回滚后复用文章更新链路触发 AOT/search/feed/binary cache 失效并写入审计。`asset_library_item` 由 `/api/author/articles/{articleId}/assets/reindex` 从正文 Markdown 图片与封面重建，仅索引 `/uploads/illustration/*`，保存 alt text、来源文章、hash 和引用计数；失去引用的资产先保留为 `referenceCount=0` 供作者审计，`/api/author/assets/orphans` 只删除孤儿索引行，不删除上传文件本体。评论创建后默认 `Pending`，公开评论线程、回复预览和回复游标只读取 `Approved`；`/api/author/comments/moderation` 提供状态队列和命中原因，单条/批量审核必须携带 `admin-sensitive` MFA proof，服务层按旧状态 CAS 更新并只允许审核状态机内的转换。审核通过会向对应文章 SSE 推送 `CommentAdded`，已公开评论被隐藏/拒绝/删除会推送 `CommentRemoved`；缓存清理按 article/root/user scope 执行，并可在拒绝/隐藏时联动封禁非 admin 用户。作者分析从 `VisitLog` 聚合真实阅读、搜索 routeKey、公开来源路径和 404 routeKey，并用 `PublicAOT` miss 审计估算 AOT 命中率；dashboard 只读取 admin-only `/api/author/analytics`，不从私有页面采集 RUM。`/api/author/**` 全部要求 admin 角色，负责服务端草稿、预览、发布前检查、修订回滚、资产重建、作者分析、评论审核、导入导出和默认关闭的 AI 辅助。

预览输出带 `data-preview-only=true` 和 `data-markdown-renderer=server-preview`，只走 admin JSON API，不写 PublicAOT cache，不进入 feed/search/sitemap。订阅表只保存 email hash 与 channel，避免把站点更新订阅扩展成社交关系链。

## PWA 与匿名性能遥测

`public/manifest.webmanifest` 暴露安装能力；`public/sw.js` 只缓存公开 shell 路由和搜索索引，不缓存 `/user`、`/admin`、`/login`。`/api/binary/**` 包括新的 public `.aeds` artifact 只走 service worker 网络透传，浏览器缓存策略完全由服务端 `Cache-Control`、`ETag`、`no-store` 负响应决定，不写入 shell/search cache。离线 shell 响应附带 `X-Fsus-Offline-Stale: 1` 和 `Cache-Control: no-store`，让 UI 和代理都能识别 stale 内容。`check:pwa-offline-smoke` 必须跑在 production preview 或真实生产 URL 上，验证最近公开文章可离线读取且私有 console 路由离线不命中缓存。

前端 `telemetryService` 采集公开页面 Core Web Vitals、hydration time、Wasm decode timing、Markdown render timing 与 navigation timing，只记录 `pageType`、`aotSource` 和数值指标；私有页面不发送 RUM 事件，敏感输入不进入 payload。匿名 `POST /api/telemetry/rum` 由 `RumTelemetryService` 净化后写入 `sys_audit_log` 的 performance 记录，作者 dashboard 从这些记录聚合 P75/平均值、页面类型和 AOT 来源分布。

## 安全链路概览

详细内容见 [security.md](security.md)，主链路概述如下：

```text
匿名请求
  → Rate Limiter (fixed_ip)
  → PoW 挑战（注册/登录等高风险操作）
  → 密码哈希验证（BCrypt，cost ≥ 10）
  ↘ Passkey 验证（FIDO2 Discoverable Credential）

认证成功
  → JWT Access Token（Bearer，15 min）
  → Refresh Token（HttpOnly Cookie，`UserSession.RefreshTokenHash` 哈希存储，CAS 轮换制）
  → 可选：MFA TOTP 挑战（Passkey 登录免 MFA）
  → 会话记录（可列出 / 吊销全部其他）

请求授权
  → [anonymous] 公开内容端点
  → [authenticated] 用户端点（需 Bearer JWT）
  → [admin] 管理端端点（需 admin 角色声明）
```

## 生产编排

```text
docker-compose.yml
├── fsus-nginx          # 反向代理 + 静态文件 + SSL 终端
├── fsus-server         # ASP.NET Core 10 API（Alpine）
│   ├── 挂载: fsus-aot-cache（AOT HTML shell）
│   └── 挂载: fsus-logs（Serilog 滚动日志）
├── fsus-postgres       # PostgreSQL（持久化卷）
└── fsus-redis          # Redis（持久化卷）
```

健康检查入口：

- `GET /health/live`：存活探针（进程存活即返回 200，`application/json`）
- `GET /health/ready`：就绪探针（Redis + DB 连通性，`application/json`）

Health/ops 协议独立于 PublicAOT 与 AEDS payload。`ProductionHealthEndpoints` 只返回 JSON 运维快照；readiness 的启动状态来自 `StartupRuntimeState.CreateSnapshot()`，定时发布后台状态来自 `ScheduledPublishRuntimeState.CreateSnapshot()`，因此生产启动校验、cache/bootstrap rollback、定时发布 backlog 与 PublicAOT 壳层协议可以分别演进。

## 生产启动保护

服务器通过 HostedService 在启动后执行以下生产校验，失败时进入可观测降级状态而不是直接终止进程：

- JWT 密钥不得为默认占位值
- Redis 密码不得为空
- `SITE_BASEURL` 必须为 HTTPS
- CORS 配置的 Origins 不得包含 HTTP 来源

降级状态会写入运行时状态任务 `productionStartupValidation`。回退路径是修复环境变量或依赖服务后重启应用；无需修改路由、中间件或健康探针代码。

详细部署流程见 [production.md](production.md)。

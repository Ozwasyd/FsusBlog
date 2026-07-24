# 系统架构

本文档描述 FsusBlog 的整体架构设计、数据流路径、缓存分层和模块边界。

> 2026-07-16 强匿名资格链路：v5/layout 6 circuit 在浏览器私有 witness 内验证签名精确属性，server verifier 只重建最小谓词 transcript，并按 attested root metadata 校验匿名集 `k>=20`。ticket v3 仅保存 rate class、moderation predicate 与 scope-bound nullifier；Comment/notification/moderation/provider/stats/admin 投影不保存精确资格属性。旧 frame 180/181、ticket codec v1/v2、layout <=5 和旧 key 均 fail closed。无重启降级通过 reloadable `AnonymousIdentity:ZkAnonymousCommentsEnabled=false` 或 `AnonymousIdentity:ZkProd:Enabled=false` 停止新 ticket；已有 public comment/read path 不受影响。

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
| ------ | ------ |
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
app.UseFsusApplicationPipeline();
app.MapFsusApplicationRoutes();
app.Run();
```

Host runtime tuning、Serilog、OpenTelemetry、ForwardedHeaders、rate limiting 与核心服务注册由 `Infrastructure/Bootstrap/WebApplicationBuilderCompositionExtensions.cs` 收口；`Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs` 是纯组装层，只保留 middleware/endpoint 顺序和模块装配。CSP、静态资源、Public AOT/SPA ownership、路由判定、HTML materialization 与逐请求状态处理由 `PublicWebRuntime.cs` / `PublicWebRuntime.HtmlMaterialization.cs` 承担，并由各自 focused tests 直接覆盖：

| 阶段 | 方法 | 职责 |
| ------ | ------ | ------ |
| 安全响应头 | `UseFsusSecurityHeaders` | CSP/HSTS/跨源隔离等头部策略 |
| 核心中间件 | `UseFsusCoreMiddlewares` | Shield、全局异常与 AEDS 错误响应边界 |
| 可观测关联 | `ObservabilityCorrelationMiddleware` | 在公开读分类前建立低基数 trace/metrics 上下文，保证 L0 hit 与常规端点均返回同一 `X-Fsus-Trace-Id` 语义 |
| 公开读分类 | `UseFsusPublicHotReadClassifier` | 在通用 endpoint pipeline 前至多分类一次；先显式拒绝 auth/admin/author/manage/internal/billing/audit namespace 与任何携带 principal/credential/CSRF header 的请求，再只为安全目录中逐项登记的 public artifact/HTML allowlist 附加不可变 route/media/security feature 与预缓存 endpoint metadata |
| 公开读审计上下文 | `UseFsusPublicHotReadRequestAuditContext` | 在 synthetic public-read metadata 已建立后只创建轻量 Serilog/request audit context；不做同步持久审计或 actor lookup，miss 回常规端点时由 execution state 跳过第二次执行 |
| 公开读专用限流 | `UseFsusPublicHotReadRateLimiter` | 使用候选 feature 上的静态 `public_read` metadata 执行 crawler/social-aware 分区，不依赖常规 routing |
| 公开读门控 | `UseFsusPublicHotReadSecurityGate` | 复用同一 feature 执行 public_read 风险裁决、PoW challenge/validation 和拒绝风险信号写入；resolved action 为 disabled 时以零分裁决且不访问风险分存储 |
| L0 公开热点 | `UseFsusPublicHotReadFastPath` | 在安全门控后命中 `/api/binary/article/**.aeds`、`/api/binary/category.aeds`、`/api/binary/tag.aeds` 与公开 HTML 快照，直接写出预编码 bytes |
| 回退恢复 | `UseFsusPublicHotReadFallbackRestore` | artifact miss、不支持的 public route 等回退时清除 synthetic endpoint，再进入原 routing/endpoint 语义；已通过的限流与 gate 结果不会重复消费 |
| 端点管线 | `UseFsusEndpointPipeline` | ResponseCompression、OutputCache、CORS、antiforgery、认证授权、封禁与请求审计 |
| 静态资源 | `UseFsusStaticAssets` | Public AOT cache、SPA 静态文件、fallback |

`UseFsusEndpointPipeline` 的常规端点链路顺序必须保持 `UseResponseCompression()` -> `UseOutputCache()` -> `UseCors()` -> `UseAntiforgery()` -> `UseFsusCsrfOriginGuard()` -> `AnonymousGatewayHeaderGuardMiddleware` -> `UseAuthentication()` -> `UseRateLimiter()` -> `BannedUserMiddleware` -> `UseAuthorization()` -> `RequestAuditContextMiddleware`。`PublicHotReadCrossCuttingControlCatalog` 把两条链的控制分为 `global-before-branch`、`early-replayed`、`endpoint-only/not-applicable`：release/security headers、deployment tracking、Shield/exception/binary 与 correlation 位于分叉前；`public_read` limiter 和轻量 request audit context 在 early branch 重放，并分别通过 `RateLimitEvaluated`/`RequestAuditContextEvaluated` 阻止 miss fallback 重复执行；CORS、antiforgery/CSRF、gateway header guard、authentication、banned-user 和 authorization 只有在 classifier 已证明匿名、无 Origin、安全方法的精确公开 artifact 时才可声明 L0 不适用。启动在注册任何 stage 前校验 required set、唯一 stage/guard、route policy、synthetic metadata，并对每个 probe path 实际执行 anonymous allow、credential/principal/Origin/unsafe-method fallback；任一失败中止启动。CI 的 `tools/check-public-hot-read-cross-cutting-controls.mjs --self-test` 同时检查 catalog、application pipeline 与 endpoint pipeline，新增控制若未同时声明覆盖与行为证据会失败。

classifier 的公开 allowlist 只由 `PublicHotReadRouteSecurityCatalog` 中逐项登记的 article/category/tag AEDS route 与 Public AOT page 构成；`/api`、`/api/binary` 下 auth/admin/author/manage/internal/billing/audit、已认证 principal、Authorization/Cookie/CSRF header、`Origin`、非 `GET`/`HEAD`、notification stream 与未登记 dynamic binary 都强制回常规管线。snapshot publication 必须携带 `published-visible-at-cutoff-v1`、`sourceVisibility=public`、与 candidate 相同的 source version、cutoff 及 published-only/deleted/future exclusion；只允许 `Published` 且到期、未删除输入进入真实 frame materializer，evidence 漂移时保留旧 snapshot。专用 gate 与 `RiskAwarePublicReadFilter` 共用同一实现；artifact miss 复用已允许结果，避免重复 risk score/PoW。主要风险是未来公开 namespace 未登记时只走较慢常规管线。无重启回退通过 reload-capable 配置源把 `PublicHotRead:Enabled=false`：classifier 立即停止附加 feature，匿名、登录、admin、notification stream 与 binary 请求全部恢复原 routing/endpoint 链；revocation、PoW、RiskControl、安全头和 notification stream 不关闭。重新启用前必须运行 catalog checker/focused parity 与 visibility 负例，并确认 readiness snapshot 为 Ready。

新增控制、focused 验证命令、启动失败处置和无重启回退步骤见 [PublicHotRead 横切控制与回退手册](security/public-hot-read-cross-cutting-controls.md)。

常规链路的 `UseResponseCompression()` 由 `EndpointAwareResponseCompressionProvider` 二次门控，不代表全局压缩。endpoint 必须显式携带 `PublicResponseCompressionMetadata` 与 `AllowAnonymous`，请求必须是无 Cookie/Authorization/CSRF header 的 HTTPS GET/HEAD，响应还必须是 `200 + Cache-Control: public`、安全 `Vary`、无 cookie/content-disposition/既有 encoding，并落在公开文本媒体类型白名单。当前只有 `DistributionEndpoints` 与 `IntegrityVerificationEndpoints` 登记；auth/admin/account/notification/WebSocket/动态 binary/HTML/错误和个性化响应即使误加 metadata 也由 path、route-kind、auth/antiforgery metadata、principal、header、status/cache/media 多层 fail closed。provider 在 response start 时再判定，因此 handler 后写入的 `Set-Cookie`、`private/no-store` 或敏感 `Vary` 仍能阻止压缩；内层 provider 只在通过后追加 `Vary: Accept-Encoding`，保留已有 country/region vary token。`ResponseCompressionPolicy:Enabled=false` 通过 reload-capable 配置源即时关闭这条通用压缩支路，无需改变管线顺序或重启。

Public AOT/PublicHotRead 的 nonce HTML 在 artifact 生成或反序列化时编译为不可变 UTF-8 segment template；请求只将同一个随机 base64url nonce 写入预计算 slot，并对 `BodyWriter` 做一次 flush，不再执行整页 bytes→string→bytes 转换或 placeholder 扫描。nonce 实体固定采用 identity streaming、`Cache-Control: private,no-store`、无 `ETag`/`304`；静态无 nonce HTML 才保留预生成 br/gzip variant 与 strong validator。模板绑定 renderer/frontend/artifact digest，随不可变 snapshot 交换；旧 snapshot 无活动引用后即可回收。security header middleware 与 PublicHotRead 都通过 `ShouldUseDevelopmentCspPolicy` 选择同一 CSP；本地 release acceptance 使用 `Testing:EnforceProductionCsp=true` 保留 Development fixture endpoints 但验证 production policy，非 Development 不能被该开关降级。模板 UTF-8 bytes、slot table 和构建生成的静态 inline SHA-256 可行性清单计入 `PublicHotReadSnapshot.ResidentBytes`，默认 `PublicHotRead:MaxResidentBytes=0` 时按运行时可用内存自动派生预算，超预算 publication fail closed。设计、压缩取舍与验证命令见 [CSP nonce UTF-8 templates](performance-csp-nonce-template.md)。

PublicHotRead 容量以 `independent-readonly-arrays-upper-bound-v1` 物理模型核算，而不是只看 frame count。snapshot 逐类记录 raw AEDS、br、gzip、HTML/template、key/index 上界、artifact/object/array、LOH eligible、base/overlay/removed 以及 article/list/taxonomy/HTML bytes；`MaxResidentBytes`、`MaxRawBytes`、`MaxCompressedBytes`、`MaxHtmlBytes`、`MaxSnapshotOverlapBytes`、`MaxArticleResidentBytes` 与 `MaxArtifactObjects` 在 publish 前一次性校验并汇总全部超限项。零值默认从 `GC.GetGCMemoryInfo().TotalAvailableMemoryBytes` 的容器/cgroup 可见上限派生，不读宿主机总 RAM。candidate/current overlap 不合格时旧 snapshot 保持 active；原子交换后用不持有强引用的集合观察所有 retiring 版本，下一次 publication 会把仍被 reader 持有的 N-1/N-2 一并计入 overlap，等待旧 reader 自然释放。`MaxRetiringBytes` 始终在 publish lock 内执行并从容器内存动态派生默认值；`MaxRetiringSnapshots=0` 与 `RetiringSnapshotDeadline=0` 表示不以 GC 尚未清理的弱引用数量或 age 拒绝发布，只有显式正数才启用相应硬门禁。这样 stale active snapshot 的 full refresh 不会因未发生 GC 而永久闭锁，所有仍存活 retiring bytes 仍计入 overlap/bytes 硬预算。仍被 reader 持有的 snapshot 不能被 LRU 容器安全地强制释放，所以达到 bytes 或显式 count/deadline 时新 publication fail closed 并保留当前 active version，只有 target 已释放的弱引用才会按 retirement 顺序清除。Public AOT shell 的进程内热缓存使用独立的真实 LRU，按 `PublicAot:MaxMemoryCacheEntries`、`MaxMemoryCacheBytes` 与 `MemoryCacheEntryDeadline` 限制 count/bytes/age；零值同样动态派生，容量或 deadline 淘汰不影响磁盘壳层与 SPA fallback。HTML delta 达到 bounded threshold 后合并 base/overlay/removed；article detail 以 views 热度与最近发布两个 segment 交错形成 deterministic Top-K，再受 article resident bytes 限制，cold miss 回退既有版本化 L1/L2/DB 路径。预压缩 variant 只在 publish/backfill 阶段按最小尺寸、压缩收益和客户端份额 admission；请求路径仍只读 slice，不 copy。当前证据选择独立只读数组而非 packed/mmap：它已经提供零 body copy，强制 pack 会在每次 snapshot build 引入全量合并复制；只有对象管理/LOH/GC 门禁证明其成为主瓶颈时才切换 release-scoped pack。详见 [PublicHotRead residency](performance-public-hot-read-residency.md)。

PublicHotRead sanity gate 与容量 gate 共用同一个 publication lock：候选先检查 publication evidence 与 visibility age/future cutoff，再做 raw/compressed/HTML/overlap budget 拒绝，最后检查 AEDS schema/CRC/frame type、br/gzip 可逆性与完整 snapshot HMAC，任一失败都保留当前 snapshot。每个 immutable binary variant 的封签绑定 route/list key、frame/version、ETag/cache/encoding；HTML body 与真实 CSP nonce template bytes 分别封签并绑定 renderer/template metadata。命中路径只重算将被写出的一个 binary HMAC，HTML 同时校验 body/template；tamper 或超过 `MaxSnapshotAge` 时记录 `fsus.hotread.sanity.fallback` 并恢复到 canonical endpoint，不做 PostgreSQL/Redis sanity query。`PublicHotReadStartupWarmupService` 在 age 上限一半处排队 full refresh，projector scope 在首次 build 后立即释放。DB mutation consistency 不由 HMAC 冒充：写路径在 commit 前持有 scope-bound PostgreSQL owner lock并建立 Redis `TransitionPending` tombstone，durable article mutation outbox 在 commit 后推进同一 generation，pipeline 固定 `public-artifact-revocation -> public-hot-read-fast-path`，transition 期间返回 410；新 snapshot 成功发布并确认 generation 后才 compare-delete tombstone。主要风险是连续刷新失败导致 L0 降级到常规端点而增加延迟，不会继续返回过龄或被改写 bytes。无需重启的回退仍是热更新 `PublicHotRead:Enabled=false`，revocation stage 保持启用。Redis Pub/Sub 当前没有 subscriber ACK，所以该段不声明多节点线性化；跨节点 invalidation 与 snapshot convergence 仍由 #399/#400 定义。

公开制品的单节点跨表示坐标只以 `src/shared/Contracts/Validation/public-representation-coordinate.json` 为 machine-readable authority。该 manifest 不复制 release ID 或 AEDS wire 常量，而是分别引用 `release-id-contract.json` 与 `aeds-protocol.json`；生成器 `tools/contracts/generate-public-representation-coordinate.mjs` 只投影 Shared C#、frontend TypeScript 与 Wasm C++ 所需字段/transition 表面。坐标在 canonical projection、AOT build、HotRead snapshot build 或 artifact publish 阶段密封 route/source/revision/publication/visibility、renderer/release/assets、AEDS schema、document/sidecar digest、SEO 与 hydration page kind；请求命中只比较随 artifact 已携带的值，不允许为补齐或验证坐标新增 PostgreSQL/Redis 查询。

transport map 固定覆盖 `canonical -> PublicAOT entry -> HTML`、`hydration payload -> sidecar`、`canonical -> PublicHotRead AEDS/HTML`、`cache/file -> runtime entry`、`HTML/sidecar/AEDS -> browser hydration` 与 `Service Worker shell -> navigation`。`tools/contracts/public-representation-coordinate.mjs` 消费同一 manifest，比较每个 transition 的 `preserves` 字段，并用 length-prefixed UTF-8 + SHA-256 形成稳定 identity；本地闭环 harness 比较 AOT/sidecar/hydrate 与 HotRead/AEDS/decode 两条路径的相同业务 invariants。renderer/assets/source/digest、错误 sidecar URL、旧 release shell 或 snapshot source mismatch 一律返回 manifest 声明的确定性 fallback，不得继续 hydrate 半兼容状态。evidence 只允许固定 layer/transition/counter，route、digest、release 与 asset identity 禁止成为 metric label；一次 mutation 的各 artifact rebuild 计入 rebuild amplification。

该坐标合同不改变 middleware 顺序、AEDS v2 wire、现有 release authority，也不扩展 #428 的多节点收敛承诺。出现坐标 checker 或生成表面问题时，可回滚当前应用 commit；运行中的旧 artifact 继续由既有 renderer/assets/hash gate 管理。出现实际 mismatch 时无需重启：AOT/cache entry 执行 evict-and-rebuild，HotRead 保留上一份合格 snapshot 或回常规 endpoint，浏览器/Service Worker 走 network canonical navigation；必要时仍可热更新 `PublicHotRead:Enabled=false` 关闭 L0，但不得禁用 hydration、AOT 或 Service Worker 来伪造一致性。

上述应用级与端点级顺序仍由纯组装类型 `WebApplicationCompositionExtensions` 内的 `s_applicationPipelineStages` / `s_endpointPipelineStages` 直接驱动运行时注册；stage 只委托给显式 runtime module，不实现 route decision、HTML 输出或业务状态机。顺序必须保持 `trace correlation -> classifier -> early request audit context -> dedicated rate limiter -> security gate -> writer -> fallback restore -> endpoint pipeline`；runtime catalog 在 stage 注册前 fail closed，middleware sentinel 会证明 L0 hit 不触达不适用的 endpoint-only 阶段，source checker 负责两端防漂移。边界和回归门禁见 [Composition root boundary](architecture/composition-root-boundary.md)。

JWT bearer cookie 入口在 `UseAuthentication()` 内完成。`OnMessageReceived` 对同一请求只解析一次 admin cookie preference，并通过 `HttpContext.Items` 复用 admin raw access token 给 `OnTokenValidated`；endpoint metadata/path 决策不得在同一请求内重复扫描，admin session 校验和 host-prefixed cookie 选择保持不变。legacy plain cookie fallback 已移除：生产只读取 `__Host-*` Cookie，开发环境只有显式启用 `AuthCookies:AllowInsecureTransportCookies` 时才读取当前非 host-prefixed cookie 名称。

认证响应写 Cookie 时，普通账号 `SessionId` Cookie 由登录/刷新签发路径已知的 session id 显式传入 `AuthCookieService.SetTokenCookies`。JWT helper 的签发结果同时携带 token 与绝对 `ExpiresAtUtc`，普通登录、MFA、Passkey、refresh rotation 和 admin session 路径都把该值原样传给 Cookie 写入层；Cookie 层不得重新读取 `Jwt:AccessTokenExpiresMinutes`、反向解析 access token，或维护独立期限。缺少 session id 时只跳过 session cookie，不改变 access/refresh cookie 策略。首枚 Passkey 使用独立 `EnrollmentToken` / `__Host-EnrollmentToken` cookie，Path 固定 `/api/binary/auth/enrollment`，不复用 Access/Refresh/SessionId；bootstrap 只写 provisional account + enrollment row，`AccountEnrollmentService` 在一个事务中完成 credential + active + formal session，`AccountEnrollmentCleanupWorker` 只通过 scoped service 删除过期 provisional 数据。`JwtHelper` 和普通登录工作流都拒绝为非 active registration state 签发正式 token。

Refresh rotation 的数据库 CAS 与 HTTP Cookie 交付由端点显式编排：commit 后先通过 `IUserSessionCommandService.VerifyRefreshRotationAsync` 核对新 hash/session，再追加三枚普通账号 Cookie，随后重复相同核对，最后才执行 `EmptySuccess` frame。前/后核对或 Cookie append 失败时响应尚未开始，端点追加普通账号 Cookie 删除头并返回 401；admin principal cookie plane 不受影响。该顺序不引入旧 token grace，也不跨层传入 `HttpResponse` 到领域服务。最终核对与网络送达之间仍是不可事务化窗口，客户端仅进行一次 network retry。

路由组装按 `MapFsusOperationalRoutes`、`MapFsusApiRoutes`、`MapFsusPublicRoutes` 分层，避免在新增 API 时同时触碰健康探针、notification stream、SPA fallback 和静态文件策略。

运行时 DI 组合根按边界拆分：基础设施注册由 `AddBinaryRuntime`、`AddNotificationRuntime`、`AddCrawlerAndSearchRuntime`、`AddFileAndAuthRuntime`、`AddAuditRuntime`、`AddMessagingRuntime`、`AddCacheRuntime`、`AddIdentityRuntime`、`AddBackgroundRuntime`、`AddSpaRuntime`、`AddObjectPools` 分段承载；领域注册由 `AddContentRuntimeServices`、`AddUserRuntimePorts`、`AddGeneralDomainServices`、`AddCoreBridgeServices` 分段承载。新增服务应优先落入对应分组，避免把 Bootstrap 重新变成无边界注册清单。

组合根在 `builder.Build()` 前同时执行三层 lifetime 门禁：默认容器始终启用 `ValidateOnBuild` / `ValidateScopes`；`DependencyGraphValidator` 从最终 `IServiceCollection` 递归检查 singleton/hosted-service 经 transient 或 singleton 到 scoped 的 captive path，并展开 mixed-lifetime `IEnumerable<T>` 的全部注册；`FsusBlog.DiLifetimeAnalyzer` 在编译期对 `AddSingleton` / `TryAddSingleton` / `AddHostedService` 注册、完整 singleton/transient 链、集合注册和 singleton factory 的 `GetRequiredService<T>` 调用报告 `FSUSDI001`。factory 或 keyed descriptor 无法仅靠反射还原时保守计入 `opaqueFactories`，仍由容器 build 与 Roslyn 源码门禁覆盖。后台任务不得把 scoped DbContext/业务服务注入构造函数；通过 `IServiceScopeFactory` 创建的 scope 必须 `await using`，关键 DbContext scope 使用 `DependencyInjectionScopeTelemetry` 形成 `di.scope` Activity，并在 scope dispose 后关闭。完整规则、指标和回退见 [DI lifetime validation](architecture/dependency-injection-lifetime-validation.md)。

审核词库运行时由 `ModerationDictionaryService` 承载，注册在内容领域服务分组。它从 `config/moderation/dictionaries/**` 和 `config/moderation/region-policies/**` 构建 immutable snapshot；global 词库进入 `ContentFilterService` 硬拦截，地区策略组合进入 `RegionLegalModerationService` 计算 submit/viewer action、`blocked_regions` 和 replay diff。reload 失败时继续使用旧 snapshot，并通过审计通道写入 `dictionary_reload_failed` / `region_policy_reload_failed`。配置根与项目所有权见 [configuration layout](configuration-layout.md)。

可选反垃圾模型由 `AntiSpamModerationService` 承载，默认 `Moderation:AntiSpamModel:Enabled=false`、处置模式 `score-only`、`FailOpen=false`。需要模型的评论先以 `Pending` 提交并在写入地区合规后调用内置 `FsusAntiSpamModel` portable runtime scorer；runtime reload 只加载模型数据包并校验 `manifest.json`、digest、signature、runtime format、threshold policy 和 `test_vectors.jsonl`，校验通过后以 immutable scorer snapshot 原子替换 active snapshot。模型先写 `comment_moderation_signal` 风险信号，再由 `CommentModerationDispositionPolicy` 在显式模式下决定是否自动通过或隐藏。地区策略优先级高于模型：`RegionCanPublish=false`、`RegionRequiresManualReview=true` 或 `RegionHideUntilReviewed=true` 时模型不得自动通过；runtime 缺失、超时、加载或评分失败写 `unavailable/error/contract_invalid` signal 并默认保留 `Pending`。只有运维显式开启 `FailOpen=true` 且地区/匿名策略均允许时才可转为 `Approved`。

`BannedUserMiddleware` 是运行时封禁检查的唯一实现，不再保留旧过滤器兼容别名；新增调用点必须使用 Middleware 命名。该中间件必须先按 `identity_kind` 分流：`admin_principal` 不读取普通 `sys_user` 状态或 blacklist，直接交给后续 admin authorization/session 语义；普通账号才进入删除/封禁写锁。普通账号 access token 必须携带从 `sys_user.account_subject_hash` 读取的 `account_subject_hash`，中间件的 L1 account-state key 固定为 `account:state:{accountSubjectHash}`；缺失或格式错误的 claim 直接返回 401，不得使用 account id、handle 或旧缓存快照派生。账号快照 cache namespace 固定为 `account:subject-v1:{accountId}:v{version}`，旧 payload 缺失物理字段时必须 miss 并回查 PostgreSQL。admin access token 在 JWT 基础校验后必须由 `AdminSessionValidationService` 请求期回查 `admin_session` 和 `admin_principal`，撤销、禁用、idle/absolute 到期、token hash mismatch 或 session/principal 不一致都要 fail closed，并清理 admin cookies。root admin bootstrap 是 admin principal plane 的唯一初始化写入，complete 路径必须在同一 DB transaction 内拿 PostgreSQL xact advisory lock、重查 active root、写 principal/credential/session/audit，并由 active-root partial unique index 兜底并发。admin passkey login、step-up 和 session revoke 写入独立 `admin_audit_log`，请求路径只通过 `IAdminAuditLogChannel` 入有界队列；队列满或后台批量写失败时必须 fallback direct write，不改变现有 admin audit 查询输出。

受限账号安全收尾、认证响应 `no-store` 等端点级策略只允许通过 endpoint metadata 声明。`Infrastructure/Policies/EndpointPolicyMetadata.cs` 提供 `AllowRestrictedAccountAction(RestrictedAccountAction.*)` 与 `RequireNoStoreResponse()`，运行时中间件读取路由元数据执行策略，避免 `/api/...` 字符串匹配在路由迁移时失效；普通消息、评论、内容等业务写入不得声明受限账号放行 metadata。

生产启动校验通过 `ProductionStartupValidationHostedService` 纳入 DI 生命周期。生产环境校验失败时写入 `StartupRuntimeState` 的 `productionStartupValidation=degraded` 并记录日志，进程保持可观测；就绪探针仍由 DB/Redis 连通性决定。非生产环境报告 `skipped`。

Schema migration 的跨实例启动互斥使用同一个 PostgreSQL session advisory lock，但等待方只能短事务轮询 `pg_try_advisory_lock`，不得用阻塞式 `pg_advisory_lock` 长时间持有 virtual transaction。迁移计划包含 `CREATE INDEX CONCURRENTLY`，阻塞等待方的 virtual transaction 会反向阻塞持锁实例完成索引并形成死锁。轮询连接在成功后持有 session lock，直到全部 PreCodeFirst、CodeFirst、PostCodeFirst 和模型校验结束才显式解锁；取消或异常必须关闭连接释放锁。运行时回退不需要改 schema：保持一个实例执行 migration，其余实例等待或由编排层暂停启动，不能绕过互斥并行执行 DDL。

安全运行策略由 `ISecurityAdminPolicyService` 暴露进程内 immutable 快照，公开读、PoW、RiskControl 和后台概览只读该内存状态。后台 `/api/binary/admin/security/**` 修改 AntiCrawler/PoW 策略时，在原有 admin principal、`system.config`、`X-Fsus-Mfa-Proof` 和高价值审计边界内额外写入 `security_policy_snapshot` 版本化记录；启动期 `SecurityPolicySnapshotHostedService` 必须排在 `LifecycleHostedBootstrapService` 之后，从 active 策略加载内存快照，active 反序列化失败时回退到最近 last-known-good 版本。请求热路径不得为了读取策略同步查询 PostgreSQL；持久化写失败会让管理写请求失败并保留日志诊断，下一次启动仍以最后可用的 active/LKG 持久化快照恢复运行时策略。

RiskControl challenge 的端到端 readiness 由版本化 capability registry 收口，不能用 provider DI 注册数代替。后端 catalog 与前端 registry 对每个 `SecurityChallengeKind` 记录 provider、UI/headless executor、host、取消能力和 action surface；orchestrator 在调用 provider 前按 action fail closed，production readiness 也验证 active policy 的每个 kind。管理端分别展示 provider/executor/UI host/headless host/policy，不把 PoSpace/Passkey 占位组件显示为 ready。回退时无需重启：通过 reload-capable policy 将不合格 kind 的子系统切到 disabled/observe 或回滚 LKG；manifest 本身只能随已验证静态资源构建变更。

组合 RiskControl challenge 由一个 UUIDv7 `envelopeId` 聚合，`SecurityChallengeOrchestrator` 把 `RiskDecision.RequiredChallenges` 原序固化为最多 8 个 member bindings；单 challenge 只是 `memberCount=1` 的同一 envelope 状态机。Redis 保存带 TTL 的 ordered challengeIds/requiredKinds/verifiedMembers/version 热状态，TTL 不得晚于最短 required member expiry；每次 verify 通过 versioned CAS 原子校验 envelope、next ordinal、member state、action/route/subject/client/device、policyVersion 后推进 `completedCount`。PostgreSQL `security_challenge` / `security_challenge_attempt` 仍按 member challengeId 承担可审计真源和恢复诊断，不能在 Redis miss、断连或 CAS 冲突时替代 envelope state 放行。member verify 只返回 progress；全部 required members verified 后才 mint 一个 aggregate proof，claims 额外绑定 envelopeId 与 ordered requiredKinds。最终三个兼容 header 中 challengeId/kind 仍取最后一个 ordered member，业务 filter 还必须按当前 RiskDecision 校验完整 ordered requiredKinds，不能把最后 member 当作客户端完成声明。

前端 composition 只注册一个 envelope runner，UI challenge host 与 `notification.subscribe` headless host 都向它提交 envelope，不各自复制 assignment 循环、provider payload lookup、verify progress 或 proof-store 逻辑。runner 默认顺序执行；policy 明示允许并行时也必须通过固定小 semaphore 限制 PoSpace、perception 等 expensive Worker，并保持 cheap executor 与 expensive executor 分池，避免一个最多 8-member envelope 无界占用 CPU/内存。refresh、cancel、身份变化、route generation 变化、component unmount 与 notification dispose 都推进 runner generation、终止整个 envelope、调用 binary cancel transport 撤销服务端状态并拒绝迟到结果提交。无需重启的降级只热更新 policy 禁用 multi-challenge band、切换受影响 action 到 observe/disabled 或回滚 LKG；已签发 envelope 保持 fail closed 到 TTL 到期，不拆成多个独立 proof，也不恢复 `assignments[0]`。

PoSpace 参数由 Shared 权威源 `src/shared/Contracts/Validation/Security/pospace-v1-contract.json` 经 `tools/contracts/generate-pospace-v1-contract.mjs` 生成到 Shared 与 frontend，provider 和 runtime 不各持一份数字。弱设备 unsupported 重签仍复用 `/api/binary/security/challenge`：endpoint 解析 bounded attributes，`PoSpaceUnsupportedReissueService` 通过独立 assignment store 校验持久化事实，先清除 `SecurityPoSpaceChallenge` 一次性 cache 并撤销旧 challenge，再按当前 RiskControl snapshot 选择替代裁决。该边界不把数据库查询或客户端 capability 放进 composition root，也不改变 AEDS frame layout。运行时降级可通过热更新 policy 禁用 PoSpace/回滚 LKG；fallback 不可用时 fail closed，不要求重启。

运行时可观测性由 `Infrastructure/Observability` 统一管理。`FsusObservability` 暴露 `ActivitySource=FsusBlog.Server` 与 `Meter=FsusBlog.Server`，并把自定义属性限制为低基数 `fsus.*` 白名单。ASP.NET Core、HttpClient、runtime、Npgsql、notification stream meter、cache、PublicAOT、search 和 scheduled-publish worker 都进入同一 trace/metric 面；`ObservabilityCorrelationMiddleware` 把 `Activity.TraceId` 写回 `HttpContext.TraceIdentifier` 和 `X-Fsus-Trace-Id`，使错误响应、Serilog/audit 与标准 collector trace 能按同一 ID 关联。`RecordSecurityEvent` 是 Shield/RiskControl 高频热路径，固定 `(operation, reason, result)` 组合必须复用预热/有界 `TagList` cache，enum 来源必须走 `SecurityRiskReason` overload，新增缓存命中率、miss count 和 record elapsed 指标不得改变原 `fsus.security.event.count` 的 tag 名和值。OTLP exporter 默认关闭，只有 `Observability:ExporterEnabled`/`OTEL_EXPORTER_OTLP_ENDPOINT` 打开后才向 collector 导出。

缓存治理清单由 `tools/cache/export-cache-governance.mjs` 从 `CachePolicyRegistry`、`CacheTag`、`HttpCachePolicyCatalog` 生成到 `docs/cache-governance.catalog.json`。`tools/check-cache-governance.sh` 会在 fast gate 中校验该清单，防止 cache key/tag/catalog 与文档证据漂移。

预编码 AEDS frame 的 L1 生命周期通过独立 `IOwnedFrameCache` 边界管理，`ICacheRawReader` raw payload port 保持 defensive-copy 语义。cache miss 直接把真实 POD writer 写入 `OwnedAedsFrame` 的最终 frame buffer；consumer 只能持有只读 lease。Redis serialization、并发 response、replace/eviction/invalidation、cancellation/exception 与 shutdown 都必须在最后一个 lease 释放前保留 backing；精确 key 和批量/prefix invalidation 在删除 L1/L2 时按 Redis key 获取确定顺序的 mutation gate，防止旧 L2 read 在删除后重新安装。owner retirement 会立即停止新 reader，但 logical/capacity residency 直到 backing 实际归还或清零后才扣减，因此 in-flight reader 不会被伪报为已释放。固定逻辑资源不能只靠 I/O gate 判断 source 新鲜度：AdminStats generation 以 Redis `INCRBY 0` 权威读取而不经过进程 L1；新 generation 同时隔离 frame、core aggregate、overview、recent 与 region source identity，因此跨实例旧 L1 或发布后的删除窗口不能把旧 source 安装成新 frame。rebuild 在 source read 前后复核 generation，漂移时重读，持续 churn 时只直出而不安装；invalidation 清理 previous-generation 与 legacy identity。敏感 frame 由 `AedsFrameSensitivity` 默认清零，只有显式 public-immutable allowlist 可跳过；无法验证的 L2 frame 一律保守清零。该边界只声明消除本进程 miss/rebuild 的 payload/frame application copy，不假设 StackExchange.Redis、socket 或文件系统内部零拷贝，也不改变 TTL、ETag 或 AEDS v2 wire contract；新增 generation 只进入 cache identity。PublicHotRead snapshot 与文件 artifact 继续使用 exact array，但 projector 直接写最终 frame，避免精确 payload 中间数组。测量、owner 状态机和聚焦验证见 [AEDS cache-miss owned-frame](performance-aeds-cache-miss-owned-frame.md)。

## 前端 Binary 组合边界

前端 AEDS 链路按 `contracts → codecs/adapters → composition` 的单向边界组织：

- `src/frontend/src/contracts/binaryApi.ts` 与 `binaryTransport.ts` 是 API/adapter/worker 共享类型边界，不具有运行时依赖；
- `src/frontend/src/codecs/binary/` 只负责通用 POD reader 和 request encoder，业务 API 不导入 response adapter；
- `src/frontend/src/adapters/binary/` 只把已验证 payload 映射为 contract，不导入 API 实现；
- `src/frontend/src/services/binaryTransport.ts` 负责请求、错误和主线程/worker 调度，只接受 `BinaryFramePayloadDecoder` 注入；
- `src/frontend/src/composition/binaryDecoderRegistry.ts` 是具体 frame decoder 的唯一组合根，浏览器请求由 `composition/binaryTransport.ts` 注入，worker 在自己的入口直接消费同一 registry。

因此新增 frame mapper 时只能在 registry 增加显式登记，不能恢复 adapter barrel、让 transport 导入具体业务 adapter，或让 adapter 反向读取 API response type。`check:binary-import-boundaries` 扫描静态 import 图并以强连通分量门禁这一约束。回退时可把 composition root 指向上一版 registry，而不修改请求路径、frame 编号或 transport 行为；不允许用 JSON/双 transport 作为回退。

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
  → strict route identity（完整 path + 正整数/有效单段 slug）
  → cold-miss status classification（Success / NotFound / Gone / TransientFailure）
  → IPublicAotBootstrapProvider（产出 typed PublicPageSnapshot）
  → PublicAotRenderRequest + PublicAotRendererPayloadMapper
  → IPublicAotEntryRenderer（Node/Vue SSR worker pool）
  → src/public-renderers/renderPublicPage.ts（入口）+ src/public-renderers/publicEntryRegistry.ts / pageAssemblies.ts / scaffold.ts
  → PublicAotDocumentComposer
  → versioned AOT HTML document cache + hydration `.aeds` sidecar
```

关键约束：

- `src/frontend/scripts/server-public-ssr.mjs` 以 AEDS 行协议 worker 模式长驻，支持 `buildEntry` / `validateBundle` / `health` / `shutdown`；`PublicAot:SsrWorkerMode=PerRequest` 可作为紧急回退。
- `PublicAotSsrRuntimeState` 聚合 backfill queue scheduled/dropped/completed/failed counters、worker restart/stderr warning、timeout/renderer/DB gate/document compose/cache write failure 分类、circuit breaker、route quarantine 与 SSR worker resource snapshot。`/internal/public-aot/health` 复用 `X-Fsus-Public-Aot-Token`，输出 resource check snapshot、Node probe、`validateBundle` sample probe 和 runtime snapshot；`tools/operations/public-aot-health.mjs` 是 release/ops 诊断入口。
- `PublicRouteIdentity` 对 article/category/tag 动态路径执行完整匹配，不再从前缀截取第一段；unknown、零值、额外 segment 和不存在 taxonomy 在首个服务器响应返回 404。除 `/` 外的尾斜杠由 public route composition 单跳 301 到无尾斜杠 canonical。
- `PublicSearchRequestPolicy` 在 SPA fallback 读取模板前规范化 `/search`：共享 `PublicSearchRoutePolicy` 把 q/sort/page 的长度、枚举和页码边界生成到前端，服务端对重复/默认/非法组合单跳 301，对危险超限输入返回 400；成功与失败首响应都设置 noindex。搜索 route 不进入 Public AOT registry/sitemap/JSON-LD，前端 router 只镜像同一策略并在 SPA 导航中原子替换 search noindex head。
- 标签 route identity 只以 `tag:{id}` / `/tag/{id}` 作为可索引成功身份。`tag-name:{name}` 是只读迁移身份：shell 在读取任何旧 name AOT cache 前调用 provider，把当前名称或 `tag_url_alias` 单跳 301 到 ID；name route 不进入 manifest、backfill 或成功 navigation snapshot。标签更新事务先持久化旧名称 alias，再写新显示名，canonical 因而不随重命名变化。
- `PublicAotShellService.RenderClassifiedAsync` 在 cold miss 排队 backfill 前调用对应 provider 建立真实状态；只有 `Success` 可排队。`NotFound`/`Gone`/`TransientFailure` 分别映射 404/410/503 独立 noindex HTML，负响应不进入 AOT cache、不带成功 SEO metadata，也不启动 SPA。该分类只发生在 AOT miss/dev-source bypass；fresh artifact 仍走原有热路径和 mutation invalidation，避免把每次命中退化为数据库读取。
- `IAotSeoConfigSnapshot` 是 AOT bootstrap 的 SEO/compliance 读取入口，使用 30 秒 TTL 限制 `GetSeoConfigAsync` / `GetSiteComplianceConfigAsync` DB round trip；snapshot refresh 在一个 DI scope 内复用 scoped `ISystemService` / `ISqlSugarClient`，因此两个 cache-miss 读取必须串行，不能在同一 Npgsql connection 上重叠 command。不同请求仍由 snapshot refresh gate 合并。SEO 或合规配置保存时必须经 `ICacheInvalidationDispatcher` 同步失效该 snapshot，因此 admin 修改无需重启即可收敛。
- SSR worker circuit breaker 只保护 backfill lane：连续 worker-level failure 打开后，新 backfill 被 short-circuit；cooldown 后只允许一个 half-open probe，成功才关闭。route-level renderer/document compose 重复失败会按 `PublicPageKind + routeKey` quarantine，并在 route/content/settings invalidation 或 TTL 到期后清除。公开读路径必须继续返回 fresh/stale AOT 或 SPA fallback，不得因 breaker/quarantine 阻断匿名阅读。
- Public AOT backfill 在进入 snapshot/SSR 前取得 `page kind + route key + frontend asset version + optional test session` lease。`single` runtime 使用进程内 local handle，不访问 Redis；`static-role` / `adaptive` runtime 使用 `PublicAotBackfillLease` Redis key、30 秒 TTL 与 10 秒 compare-renew，release 只允许 token owner compare-delete。lease 竞争、暂时不可用或续约丢失只取消该次后台工作并保留 SPA fallback，不计入 renderer failure/circuit breaker；已 quarantine 的 route 在抢 lease 前再次拒绝。节点崩溃后 lease 由 TTL 自动释放，其他节点可在新 miss 上接管。写 artifact 前先校验排队时的 frontend asset version 与 invalidation version，active-release commit guard 后再校验一次，旧 lease/render 不能覆盖新 asset generation。Redis lease 故障的安全降级不需要重启：新 backfill 自动停止写入，公开读继续走现有 fresh artifact 或 SPA fallback；恢复 Redis 后新 miss 自然重新竞争，不允许绕过 lease 强制写入。
- AOT document cache 只允许由服务端 `server-ssr` backfill 写入；客户端、管理端和脚本不得上传 AOT bundle。
- AOT document cache 按 frontend asset version 写入版本化 artifact 路径；旧版本 artifact 只能在后台清理或因 version 不兼容被拒绝，不能直接返回给公开 URL。
- `PublicAotDocumentComposer` 只负责文档包装、SEO 头、bootstrap 脚本和 hydration sidecar marker 注入，不承担页面业务结构修复；`PublicAotDocumentService` 在 compose 周期把 hydration AEDS frame 作为 raw `.aeds` sidecar 写到 `wwwroot/aot-cache/payloads`。sidecar URL 由 payload SHA-256 content hash 派生，静态响应使用 `application/vnd.fsus.aeds` 与 `public,max-age=31536000,immutable`，因此新 HTML 永远指向新 payload，旧 payload 只需后台异步清理。
- AOT document cache artifact 记录 hydration sidecar 的 URL、SHA-256 和相对路径；旧 artifact 缺少 metadata 时从 HTML marker 回读。文件缓存命中前必须确认 sidecar 存在且 SHA-256 与 URL hash 一致，否则删除/淘汰 HTML entry 并走 miss 重建。key/prefix/all invalidation 删除 HTML document entry，但保留 content-hash sidecar；sidecar 没有稳定 URL 复用语义，因此不会让已失效 document 继续可达。
- Home/category/tag 的公开分页把规范页码写入 `routeKey`（`:page:N`）和规范 query，因此每页拥有独立 document cache、navigation snapshot、hydration seed、payload hash 与 ETag。文章 mutation 不再只 bump 第一页 key，而是清除 Home/Archive/Filter page prefix 和全部 hot HTML，保证分类归属或排序变化不会留下深分页旧产物；优先 backfill 第一页，其余页由全量 manifest 或访问 miss 重建。回退时关闭 Public AOT/SPA 接管即可让服务端输出的分页 `<a href>` 走整页导航，页面本身不依赖点击脚本。
- AOT file shell cache 在 memory hit 之外还维护 path -> `(LastWriteTimeUtc, length, decoded entry)` metadata cache；同一 artifact 未变化时可跳过重复文件读取和 binary decode。`PublicAotCacheEntryBinaryCodec` 保留 256 容量 decoded entry cache，compose/SEO snapshot/codec/file cache 分别通过 `fsus.aot.compose.elapsed`、`fsus.aot.bootstrap.seo_snapshot.hit_ratio`、`fsus.aot.cache.codec.hit_ratio`、`fsus.aot.shell_cache.file_hit_ratio` 暴露热路径观测。
- 多节点部署必须让 `wwwroot/aot-cache/frontend/**` 与 `wwwroot/aot-cache/payloads/**` 使用同一共享 artifact storage 或共享卷；否则当前 Public AOT cache 只支持单节点/共享存储一致性。v1.3 之前不把 Nginx/CDN 或跨节点复制延迟作为正确性前提，节点本地缺失或 hash mismatch 会 fail-closed 为 cache miss。
- Provider、shell service 与 renderer 之间只传递 `PublicPageSnapshot` / `PublicAotRenderRequest`，进入 Node worker 前由 `PublicAotRendererPayloadMapper` 做唯一 dictionary payload 映射；禁止恢复匿名 object graph 或每个 provider 自行拼 payload。
- `PublicAotDocumentService` 只在 compose 周期内解码一次 entry bootstrap/hydration payload，后续标题、描述和脚本注入复用同一解码结果。
- 页面内部结构、hydration props 与 Markdown HTML 以 Vue public renderer/helper 为唯一真相源，禁止 C# Markdown/props 与 Vue 组件双轨并存。
- `PublicPageRegistry`（C#）是跨语言页面身份元数据唯一真相源；前端通过 `src/frontend/src/public-renderers/generated/publicPageManifest.ts` 读取生成结果，`publicPageModel.ts` 只补 routeName/activeNav，禁止在 TS 再维护第二套 `pageId/canonicalSlug/seoEligible/aotShellReady/deferSpaBoot`。
- `PublicRouteIdentityRegistry`（C# shared）是跨语言 route identity token 与 path 语义唯一真相源；前后端都不得再各自硬编码 `article/category/tag/tag-name/search` 这组 bucket 字面量，或 `/article/ /category/ /tag/ /search /user/profile` 这组 path 常量。
- `src/backend/Infrastructure/PublicAot/PublicAotPageCatalog.cs` 只保留服务端运行时元数据（如 static path、默认标题、canonical fixed path）；`pageId`、hydration kind 和固定 slug 必须从 shared identity 派生，禁止在 backend catalog 再手写第二份跨语言页面身份。
- `ISpaAssetManifestService` 负责入口脚本、CSS、preload 和 frontend asset version；AOT 文档不得用正则补丁改写 dev/prod 资产路径。
- 发布构建生成的 `/assets/fsus-spa-entry.js` 必须是只导入 manifest hashed entry 的稳定 redirect module，不能复制 hashed entry 内容。split chunk 对 hashed entry 的循环 import 因而始终回到同一个 ESM module identity，避免应用 bootstrap、service-worker 注册和 module-private Trusted Types policy 被执行两次；回退时切换整组 frontend manifest/AOT 文档，不得把 alias 改回内容副本或启用 `allow-duplicates`。

### 测试隔离与运行时 key scope

生产缓存、Redis L2、notification stream backlog 与文章运行时 key 前缀只依赖 `IRuntimeKeyScope`。测试会话隔离通过 `TestAwareRuntimeKeyScope` 适配 `ITestSessionKeyScope`，`X-Fsus-Test-Session` 语义不得向默认生产缓存、notification stream 或业务 service 扩散。

测试 fixture 不得把可复用密码、JWT signing key、生产域名或固定数据库行 ID 写成源码默认值。需要伪造本地 session 的 Playwright / smoke 脚本必须显式使用 `loginWithFixtureSessionBypass`，并通过 `FSUSBLOG_TEST_SESSION_SECRET` 或测试专用 `Jwt__SecretKey` 提供短期签名密钥；会执行 SQL 的 fixture 只能连接 `fsusblog-dev*`、`fsusblog-test*` 或 `fsusblog-ci*` 容器。生成的 `.playwright-fixtures` storage-state 属于本地临时凭据，运行后应清理，不参与提交、缓存或跨环境复用。

部署与 CI 供应链同样属于运行时边界：OpenResty 模板收口 TLS/HSTS/跨源安全头，生产配置显式覆盖 `AllowedHosts`，Docker build context 排除 `.env` 系列本地机密；GitHub Actions 使用 SHA pinning，Dockerfile 对 vcpkg commit 与 wasm release artifact checksum fail closed。`check:infra-security-governance` 负责防止这些部署护栏退化。

### Public Route Identity

公开页路由身份采用集中规范，避免服务端与预热脚本各自推导：

| 页面 | route key / filter key | canonical path |
| ------ | ------------------------ | ---------------- |
| 首页 | `home` | `/` |
| 文章详情 | `article:{id}` | `/article/{id}` |
| 分类筛选 | `category:{id}` | `/category/{id}` |
| 标签筛选（ID） | `tag:{id}` | `/tag/{id}` |
| 标签筛选（历史名称兼容） | `tag-name:{name}` | 301 → `/tag/{id}`（不 self-canonical、不预热） |
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
    → Kestrel → Forwarded/Security/Core/EndpointPipeline
      → public_read 限流 + 公开读风险门控
      → 公开读 artifact fast path（article detail *.aeds）
      → 命中 → 直接搬运预编码 raw/br/gzip AEDS frame variant → 返回 application/octet-stream
      → 未命中 → singleflight 排队后台 rebuild → 503/stale/SPA fallback，不在请求内同步打 PostgreSQL
    → 其他公开列表/聚合 → L1 readonly raw cache
      → 命中 → AedsBinaryWriter 写 header + payload，避免 L1 hit 的 byte[] 防御性复制
      → 未命中 → Redis L2 / DB concurrency gate / cache refill
  → TypeScript adapter / Wasm Web Worker 解码 AEDS 帧 → Pinia Store 更新
```

Article/comment binary endpoints 只面向应用 facade：文章端点通过 `IArticleEndpointService` 获取 article list/detail/hot/featured 与写入操作，评论端点通过 `ICommentEndpointService` 获取 thread/reply/user cursor 与删除操作。文章链路以 `IArticleCoreService` 为唯一应用层所有者，endpoint、AOT、authoring 与 view flush 均提交 `ArticlePageQuery`、`CreateArticleCommand`、`UpdateArticleCommand` 等稳定 contract；`ArticleService` 仅作为 `IArticleCoreGateway` 的 Server infrastructure adapter，直接承载数据库事务、源数据缓存与 side-effect port 调用。运行时不再注册 `IArticleService`、`ArticleServiceCoreAdapter`、`ArticleCoreGateway` 或 `ArticleCoreQueryCache`，因此不会发生 `Server request → Core → Server request` 回折或 Core/Server 双层 DTO 缓存。公开 list frame cold miss 使用 `UseSourceCache=false` 由 Core handler 显式绕过源 DTO cache，frame 由 `ArticleEndpointService` 唯一写入；private/admin list、detail 与 search 的源缓存由 infrastructure port 唯一写入。文章写入后的搜索投影、实时通知、Redis 热榜清理、文章详情 AEDS artifact 生成/失效和图片资产清理由 `IArticleMutationSideEffectCoordinator` 排序编排，真实副作用所有权分别下沉到 `IArticlePublicMutationFence`、`ArticleMutationProjectionInvalidator`、`ArticleMutationDelivery`、`ArticleAssetCleanupPolicy` 等窄服务；完整边界见 `docs/architecture/article-mutation-side-effect-boundaries.md`。文章详情 projector/rebuild 的 source 读取可使用单条聚合 SQL 读取 article/category/article_body/tags/rights/proof；该复杂查询只属于写时投影、shadow 或 repair，不属于公开请求 hot path。公开 detail 的文件 artifact miss 先读取 `public_article_projection`：独立 `NpgsqlDataSource` 对 article PK 执行单条 prepared positional query，以 fixed ordinal + `SequentialAccess` 读取已编码 frame，校验 CRC/ETag 后一次回填 artifact。projection 缺失/损坏才排队 repair 并进入 legacy 动态兜底，不能永久静默 fallback。完整所有权与回退说明见 `docs/architecture/issue-1264-article-core-ownership.md`。

文章写模型使用双坐标：`current_revision_id` 指向作者正在编辑的修订，`current_publication_id` 指向公开侧不可变 `article_publication`。立即/定时发布、归档、恢复和回滚都经同一 transition writer；已发布文章的未来更新以 `pending_publication_at` 等待 worker，在一个 PostgreSQL 事务内创建 publication、切换指针、写 exact-coordinate outbox。PublicHotRead、Public AOT、AEDS detail/list、search shard、cache healing、rights/responsibility manifest 只沿 publication 读取，outbox replay 只加载事件携带的 revision/publication，不能猜测 latest。迁移采用 nullable columns/table/view 的 Expand + backfill，旧缓存/ARD3/ARD4 只读兼容；无重启降级时停止 worker/outbox consumer、保留旧 active publication 与新增表列，再切回兼容代码。详见 [`docs/api/article-publication-revisions.md`](api/article-publication-revisions.md) 与 [`docs/testing/article-publication-consistency.md`](testing/article-publication-consistency.md)。

`ArticlePublicationValidator` 是文章内容与 taxonomy 的唯一写入门禁，按 request scope 与 `ArticleService` 共用同一 `ISqlSugarClient`。create/update 在 `UseTranAsync` 内、任何 article/revision/tag/outbox insert/update 之前调用；rollback 与 import 复用同一 Core gateway，因此不能形成旁路。作者工作台 prepublish endpoint 只把同一 validator 的结果投影为 `canPublish/issues`。这条边界允许 Draft/Archived 保留未完成内容，但结构/内容安全和已提供 taxonomy 的错误始终回滚整个事务。部署回退不需要 schema 变更：保持当前 active slot 或切回前一构建；运行时降级只能改存 Draft/Archived，不得热关闭写入门禁。

用户域对外按不重叠 facade 拆分：`IUserAccountReader` 只返回 `UserAccountSnapshot`，并通过 `AccountSnapshotVersion` + `AccountSnapshot` 缓存读取投影字段，不 materialize 完整 `User` entity；账号 status/deleted/MFA/Passkey/Recovery/public handle/匿名凭证状态变更后必须 bump snapshot version，让 `/auth/me`、MFA challenge start、notification stream admission、评论 actor 解析和封禁中间件复用同一新鲜快照语义。`CommentActorResolver` 的 public handle 与 account-bound anonymous credential level 只能来自该 snapshot reader，不得在评论写入热路径直接查 `User` 表或 credential service。`IUserLoginWorkflowService` 负责登录/MFA 风险/最终签发，`IUserProfileCommandService` 负责资料与注销，`IUserSessionCommandService` 负责 refresh/session revoke，`IUserAdminModerationService` 负责后台治理。`User`/`UserSession` ORM entity 只在 `UserService` 兼容实现内部流转，不作为 endpoint、middleware、notification stream admission 或 comment actor resolver 的读取契约。

管理端账号列表保留 page/pageSize 兼容参数，但服务端内部必须使用 `(createtime DESC, id DESC)` keyset window 逐页推进，不执行 `COUNT + OFFSET`。搜索维度只允许 accountId 精确匹配、`identity_kind` 枚举精确匹配和 `public_handle` 前缀匹配；对应索引为 `idx_user_admin_list_time_id`、`idx_user_admin_list_status_time_id`、`idx_user_admin_list_identity_time_id` 与 `idx_user_public_handle_prefix`。默认列表返回已观察到的总数下界并记录 `fsus.admin.account_list.query_elapsed_ms`、count skipped/used 与 keyword type/page/pageSize/cursor 指标。

### 认证写请求（注册 / 登录）

```text
Client
  → Rate Limiter (fixed_ip) → PoW 验证
  → 密码/Passkey 验证
  → JWT Access Token（`Jwt:AccessTokenExpiresMinutes`，签发 `exp` 与 Cookie `Expires` 同源） + HttpOnly Refresh Token Cookie
  → MFA 挑战（如已启用，Passkey 登录免 MFA）
```

注册/登录 binary 端点按 `AuthBinaryRequestReader -> AuthBinaryApplicationFacade -> AuthBinaryResponseWriter` 分层：reader 只负责 AEDS request frame 解码，application facade 只负责注册、凭据校验、MFA 登录分支和最终 session token 结果，endpoint 保留 cookie 写入这一 HTTP side effect，writer 只负责 AEDS `AuthLoginFlow` / `ApiError` frame。

前端认证广播同样按 transport 与 composition 分层：`authBroadcastRuntime` 只拥有浏览器广播通道、事件校验、去重、dispose 和订阅表，不读取 Pinia；`authBroadcastComposition` 由 `authSessionRuntime.init(pinia)` 安装，把普通账号 login/logout/expired、独立 admin changed 与 notification `SessionRevoked` 显式映射到各自 Store callback。user/admin/notification Store 只暴露窄 publisher/handler 注入点，不导入广播实现。bootstrap 重建先 dispose 旧 composition 再绑定新 Pinia，因此 Public AOT → Full SPA 接管、public renderer 与 notification runtime 不再通过 Store 反向拥有 BroadcastChannel。

认证 Store 的缓存按 page epoch 分层：服务端返回的普通账号 snapshot 和独立 admin principal 可在内存中按各自 TTL 复用；`guest`/`missing` 负结果只存在当前页面内存，不进入 Pinia persisted state、LocalStorage 或 Service Worker。新页面始终从 `unknown` 发起 session handshake，并在 Store 构造时删除旧 `fsus_user_storage` 迁移残留。focus、visibility、登录/账号切换与 login/admin-changed 认证广播会同时失效 user/admin 两类负缓存，以覆盖另一 tab 登录、Passkey completion 和 admin step-up 改写 HttpOnly Cookie 的场景；logout/expiry 事件可在清理旧缓存后建立新的 `guest`，请求网络失败不生成新的负结论。授权读取只消费 active server principal，不消费 UI 为 `unknown` 投影出的 `missing` 状态。

MFA challenge ticket 属于短 TTL 安全缓存，内部只保存账号容器 `AccountId` 与稳定 `AccountSubjectHash`。验证失败计数通过 `ICacheCounterStore.IncrementManyWithExpiryAsync(CachePolicyId.SecurityMfaChallenge, ..., s_failureWindowTtl)` 在单个 Redis 脚本中写入 ticket、subject、IP 三个维度，并只在计数 key 缺失 TTL 时设置 10 分钟窗口，避免失败计数与 registry 成为无界增长状态；账号维度固定为 `fail:subject:{accountSubjectHash}`，不得使用 `fail:user:{userId}`；高价值/安全 audit scope 只写 `AccountId`、`AccountSubjectHash` 与 hash 后的 ticket/IP/UA。运行时回退路径是删除 `SecurityMfaChallenge` 下对应 `fail:subject:*` 或 challenge ticket key，让客户端重新发起短 TTL MFA challenge；不需要重启服务，也不得通过恢复裸 user id key 降级。

Security challenge verify 在 AEDS frame decode、required field 和 kind 校验后，只允许先做 provider payload JSON 的 cheap byte/char 上限检查，然后执行 `ISecurityChallengeVerifyRateLimiter.TryAcquireAsync`。只有 rate limit 通过后才用 bounded `Utf8JsonReader` 解析 provider payload 并调用 provider verify；被限流的 malformed/攻击 payload 返回泛化 challenge failure，不消耗 JSON dictionary materialization。回退路径是删除 `SecurityChallengeVerifyRateLimit` 对应短 TTL key，让客户端在新的限流窗口内重试，不改变 challenge wire contract 或 provider verify 语义。

TOTP recovery code 的持久化状态只在 `user_mfa_profile`：`mfa_recovery_codes_hash` 保存换行分隔的 `v3$argon2id$m=65536,t=3,p=4$...` 条目，`hash_version` 标记当前集合版本。schema migration 会为旧 profile 补 `hash_version=1`；运行时只接受当前 v3 或 deadline 前的裸 SHA-256 legacy 迁移输入，旧 hash 被消费或正常 TOTP 验证成功后不得继续留作可用恢复码。回退路径是让用户重新走 `/api/binary/auth/mfa/recovery/regenerate` 生成 v3 恢复码，不恢复 PBKDF2 或旧消费 API。

## 发布构建边界

`src/backend/FsusBlog.Server.csproj` 的 Release publish 默认会检查 `src/frontend/node_modules`、执行 `npm run build:release` 并复制 `src/frontend/dist` 与前端 runtime 文件，保证单体发布产物一致。需要后端-only 诊断或临时发布时，可显式传入 `/p:PublishClientAssets=false`，跳过前端依赖检查、前端构建和前端 artifact copy；该开关不改变生产默认行为。

### Release-scoped storage boundary

Blue/Green 存储按四类互不重叠的 root 分类：

| class | identity / examples | mutation rule |
| --- | --- | --- |
| durable shared | uploads、DataProtection keyring | 两槽共享；业务真源，不随 candidate cleanup 删除 |
| immutable asset | `<asset-root>/<releaseId>` frontend/Wasm/font/SW | append-only；同路径不同 SHA-256 fail closed；按 retention state 做 applied GC |
| release derived | `<derived-root>/<releaseId>/{public-aot,public-hot,search,ssr,precompressed,generated-manifests}` | 只写本 release subtree；多文件通过 staging + generation manifest + atomic pointer 发布 |
| instance scoped | `<instance-root>/<slot>/<releaseId>/<instanceId>/{logs,tmp,runtime-snapshots}` | 仅当前实例；不得成为 rollback 或跨槽真源 |

Compose 把 `${FSUSBLOG_RELEASE_ASSET_STORE}/releases` 只读挂载为 `/app/release-assets`，把共享 release-derived volume 挂载为 `/app/release-derived`。`UseReleaseScopedStaticAssets` 在 SPA fallback 前注册 `/release-assets/<releaseId>/...` 与 `/release-derived/<releaseId>/...`；Production 缺任一 root 配置会拒绝启动。服务可达不等于产物可发布：rollout 仍必须先 materialize exact manifest、验证 N/N-1、持久 retention state，执行 applied GC 后再复读旧 index/hash/SW/cache。无需重启的降级是停止 GC、保护 active/N-1、为当前 release 重新发布 generation；禁止 clear shared root、改写旧 release 或恢复 mutable `current/latest` 路径。

通用静态文件中间件与 Release SPA template locator 始终以配置后的物理 `WebRootPath` 为权威来源，不采用 Development static-web-assets 或源码树候选可能注入的 source-first 结果。这样本地 Release 验收中的 `ASPNETCORE_WEBROOT`、SPA `index.html`、hashed assets、搜索索引 writer 与 `/search/index.bin` / `index.manifest.aeds` reader 指向同一 run-bound root；源码树里的历史 bundle 或 alias 不能与当前产物跨代拼接。显式 `preferSourceTemplate` 只保留给开发源码模板路径。

## 缓存分层

跨节点失效的模式选择、Redis transport、publish/apply 顺序、replay identity、重试、无回环与 degraded 语义只由 [Distributed cache invalidation](architecture/distributed-cache-invalidation.md) 定义。本节只描述各缓存层自身的存储和局部失效边界，不复制分布式总线协议。

| 层级 | 类型 | 用途 | 失效策略 |
| ------ | ------ | ------ | ---------- |
| L0 — Hot read snapshot | `PublicHotReadSnapshot` 不可变进程内快照 | 公开 article/category/tag `.aeds` 与公开 HTML 高频命中 | 文章、浏览量、分类标签、定时发布与 AOT 变更只入队刷新；后台 projector debounce/coalesce 后重建并原子发布 |
| L0 — AOT 卷 | 静态 HTML 文件 | 公开页首访 shell | 内容变更时主动清除 |
| L1 — 内存 | `IMemoryCache` / `ConcurrentDictionary` | 进程内高频读对象 | 绝对过期 + 手动吊销 |
| L2 — Redis | typed/raw/string/CAS/counter/one-time/invalidation ports | 跨重启持久热点 | TTL + 手动吊销 |
| CDN（未来） | 边缘缓存 | 静态资源 & 公开页 | Cache-Control + 版本前缀 |

> L1 暖身策略：L2 命中后立即回填 L1，避免下次 L2 往返。

Redis 连接由单一进程级生命周期拥有：`RedisConnectionMultiplexerHolder` 暴露一个惰性、并发安全的异步 creation task，使用 `AbortOnConnectFail=false`、`ConnectRetry=5` 保留初始连接重试。服务注册只登记 holder 与 factory，不发起网络连接；Host 构造依赖 Redis 的其他 hosted service 时可能先触发 task，`RedisMultiplexerHostedService` 与所有 DI factory 都加入同一 task，因此完整 `ServiceProvider` 生命周期内最多调用一次 `ConnectionMultiplexer.ConnectAsync`。`IConnectionMultiplexer`、`SharedRedisDistributedCache`、各 Redis cache storage port、readiness health check、Session、PublicAOT、Notification stream 与 release fence 等直接消费者均引用该对象；`SharedRedisDistributedCache` 保留既有 `IBufferDistributedCache` 调用面、`FsusBlog_` instance prefix、`absexp` / `sldexp` / `data` hash、byte payload 与 TTL/sliding refresh 协议，但不拥有或替换连接。断线重连由同一 multiplexer 内部完成，任何 cache/health 路径都不得再次调用 `ConnectionMultiplexer.Connect/ConnectAsync`。hosted stop 不提前 dispose，以便其他 hosted service 完成收尾；创建成功的对象由 DI 在完整 `ServiceProvider` 结束时唯一 dispose。创建失败则让共享 task 与启动共同失败，不回退到第二连接。

运行时缓存按能力进入窄 port：`ICacheTypedReader`、`ICacheRawReader`、`ICacheStringReader`、对应 writer、`ICacheCompareExchangeStore`、`ICacheCounterStore`、`ICacheOneTimeStore`、`ICacheInvalidationStore`、`ICacheLeaseStore`、`ICacheDiagnostics` 与 `IOwnedFrameCache`。生产代码不提供聚合这些能力的 façade；消费者构造函数只声明真实调用的 port。key/policy 由 `ICacheKeyResolver` / `ICachePolicyRegistry` 单向供给 storage；进程内 single-flight 与 owned-frame mutation gate 由 `CacheSingleFlightCoordinator` 独立拥有；metrics 通过 `ICacheTelemetry` 输出；payload serialization 由调用方传入显式 decoder/encoder，因此 Redis storage 不引用 JSON、POD 或 AEDS 业务 codec。`TryGetRawAsync` 保持 caller-owned 防御性复制语义；只读公开 payload 使用 `TryGetRawReadonlyAsync`，调用方只能把不可变 buffer 同步写出到 response，不能把 backing array 暴露为可写状态。

Redis 连接所有权继续严格遵循 #1259：所有 cache ports 和 `SharedRedisDistributedCache` 从 DI 接收同一个 `IConnectionMultiplexer`，本层不创建、复制、重连或 dispose 第二个连接。`CacheSingleFlightCoordinator` 只拥有进程内 keyed semaphore，不依赖 Redis 或 `IMemoryCache`；`SharedRedisDistributedCache` 只承载 `IDistributedCache` hash/TTL 协议，不反向依赖 owned frame 或 coordination。无重启回退不恢复巨型 façade：可通过 reloadable cache policy 把特定 policy 的 L1 TTL 调为零并保持 Redis L2/失效语义，或把对应功能开关切到既有 DB-only 路径；回退期间同一 multiplexer 和 key/TTL contract 不变。

L1 不再使用最终 Redis 字符串作为 `IMemoryCache` key，而是使用 `(runtime/test scope, CachePolicyId, identity kind, identity, version)` 结构键。字符串 identity 继续兼容并按 Redis key 的 `default/trim/version` 规则规范化；整数 identity 使用独立字段和重载，在 L1 hit 上不执行 `int -> string`。只有 L1 miss、损坏条目清理或 L2 变更时才构造带 scope 的 Redis key。Redis key 到结构化 L1 key 的进程内索引只服务 prefix/scan 失效和 rolling-upgrade legacy string-key 清理，eviction callback 会移除索引；精确失效、版本切换与 test-session scope 仍保持同一确定性映射。

缓存 Activity 只有在 `ActivitySource.HasListeners()` 且 listener 实际采样时创建；policy 名称由冻结表复用，cache operation 的 tag set 按 operation/policy/layer/result 组合一次缓存。L1 `hit` / `hit_negative` 的运行时 shadow counter 使用 32 路 striped 累加，miss/reject/decode/Redis error 保持精确计数；release evidence 在 `operations.runtimeTuning.counterModes` 记录 L1 与 PublicHotRead counter mode。Redis 读取异常仍设置 sampled Activity error、写结构化 error log、记录 `redis_error` 指标并向调用方传播，不能用性能优化吞掉错误。

cache writer、counter、one-time 与 invalidation ports 的写入/变更型操作必须先移除 L1，再提交 Redis L2 变更；`IncrementAsync`、`IncrementClampedWithExpiryAsync`、`ConsumeOnceAsync`、`ConsumeOnceAndGetAsync`、`RemoveAsync` 和批量失效都遵循 L1-first 顺序，避免并发读在 L2 已变更前后重新提升 stale L1 值。需要取回 payload 的一次性 challenge 使用 `ConsumeOnceAndGetAsync`，由 Redis GETDEL 语义在同一 L2 操作中取值并删除；调用方不得先 `GetStringAsync` 再 `RemoveAsync` 拼接一次性语义。L1-first 允许一次安全方向的 stale miss，但不得允许旧值在同进程内复活。

RiskControl proof 的 ownership 在前后端保持同一单次转移：浏览器内存 store 通过 reservation 保证同一 token 只有一个 holder；发送前取消可恢复，标记 in-flight 后无论成功、业务拒绝、超时或未知网络结果都进入终态。notification preflight 用单条 Redis Lua 把原 proof 原子移动为受同一 action/route/subject/IP/device/policy 绑定、最长 30 秒的一次性 grant；确定性 grant identity 允许 HTTP 响应丢失后恢复同一未消费 grant，不允许二次 mint。grant 只持有 proof token hash 与 envelopeId，恢复和 WebSocket GETDEL 后均回查 completed envelope；cancel/revoke 因而会让未消费 grant 立即 fail closed。WebSocket 不保留原 proof，reconnect 重新 challenge。热回退无需重启：把相关 RiskControl action 或 `globalMode` 调回 `observe`，客户端即停止取得新 proof；已有短 TTL proof/grant 自然过期，legacy notification PoW 路径保持可用。

PoSpace 的物理运行时只有 `securityPoSpaceChallengeExecutor` 一条：它持有 Worker client、解析 assignment/provider payload、执行 capability/solve、调用统一 challenge verify 并把 proof 写入同一内存 store。`FsusPoSpaceChallenge` 与 notification headless adapter 不实现第二套算法或超时；两者都用 generation/cancel/dispose 隔离 refresh、组件卸载、stream stop 与身份切换，迟到 Worker/verify 结果只能被丢弃。notification 收到 unsupported 时仅以低基数原因和 bounded reissue count 调用 server-authoritative refresh，达到上限即 fail closed；无需重启的回退是热关闭 PoSpace policy，保留 Sha256PoW 与 guest legacy PoW 路径。

普通 binary 业务请求采用 server-first handoff：原命令先无 proof 提交，`RequiresRiskControlFilter` 的结构化 428 再携带 decision/action/routeKey/policyVersion；transport 只解析低基数 headers，统一 runtime 校验原命令 identity 后才 issue 当前服务端选定的 capability。前端没有 action→kind policy shadow，也不从 admin policy 或旧流程缓存做裁决。之后唯一 proof handoff 仍是 `SecurityChallengeProofLease -> BinaryRequestOptions.riskChallengeProof -> binaryApiClient`；transport 完成 proof 字段校验、wire kind 映射、三项请求 header 写入和 settlement，API wrapper 只传 lease。Recovery Key、Passkey 与公开评论共享 `useRiskChallengeCommand`：只有幂等命令或带固定 mutation identity 的同一 payload closure 才能在 challenge 完成后执行一次；服务器已响应或网络结果未知时不重放。策略中途切换时以最新 428 为准，旧 assignment 重新签发或 fail closed。无需重启的回退是把 action/global mode 热切到 `observe` 或回滚 LKG，不能恢复客户端预裁决。

普通账号会话校验是有意绕过 L1 的安全专用路径：`UserSessionValidationCache` 直接读 Redis L2 的 `SecurityUserSessionValidation` v3 快照，内容包含 session/account `xmin`、账号状态与 `normal|restricted|revoked` mode。hit 直接裁决；miss、Redis 异常或 payload 损坏进入 `IUserSessionDbFallbackGate` 的有界并发/连续失败熔断，再按 `sessionid` 主键回源 PostgreSQL，DB 失败或预算拒绝均 fail closed。成功回源以数值 row-version 单调 CAS best-effort 修复 Redis，repair conflict 不读取 cache 反向覆盖本次数据库真相。ban/unban/revoke producer 在账号或会话数据库事务内推进 mode 并发布新快照；旧版本不能覆盖新 restricted/revoked 值。受限能力由 endpoint metadata 单一白名单表达，middleware 默认拒绝其余业务，notification stream 在握手 admission 前拒绝 restricted principal。`Security:UserSessionValidation:DistributedCacheEnabled=false` 可由 reloadable provider 动态切换 DB-only；恢复时按数据库状态回填。运行时 meter 暴露 cache、fallback、repair、延迟、并发和故障附加 DB QPS，用于决定限流、熔断与回退，不得切换为只相信 JWT。

Session admission 的请求元数据先进入 `IUserSessionMetadataProtector`：IP 被截断为 IPv4 `/24` 或 IPv6 `/48`，device/network signal 再按 account scope、domain 与 `Security:RiskPseudonymization` epoch 做 HMAC；User-Agent 只投影为 browser/OS/form-factor。`UserSession` 不映射 raw fingerprint/IP/UA，replay/revoke SQL 也不得用 device signal 扩大 authority。后台 leader cleanup 按 `Security:UserSessions:MetadataRetentionDays` 清除过期/已撤销 session 的内部 HMAC；`MetadataRiskSignalsEnabled=false` 可在不重启时停用这些信号的风险加分，但不能恢复原始值写入。

安全风险分数使用 `CachePolicyId.SecurityPowRisk` 存储在 Redis L2。正向风险累加必须通过 `IncrementClampedWithExpiryAsync` 的单次 Lua 脚本完成 `GET + delta + clamp + PEXPIRE`，不得在安全挑战、反爬或公开阅读路径里先 `GetStringAsync` 再 `SetStringAsync` 做读-改-写；`scoreDelta == 0` 只记录 risk event，不读写 Redis 分数。无风险读使用进程内 zero-risk cache 降低 miss RTT；写入正分必须删除该 zero-risk entry，风险重置仍走显式 `RemoveAsync`。运行时回退路径是删除对应 `SecurityPowRisk` key 或 zero-risk entry，让下一次请求按策略重新累加/读取，不需要重启进程。

缓存失效优先使用 Redis registry 精确删除 prefix 命中的 key；registry 缺失时，`RemoveByPrefixAsync` 会记录 `registry_missing` 警告并执行 Redis keyspace scan fallback 回收现存 key，扫描失败则降级为可观测 warning，让后续写入自然修复 registry。AOT cache 文件失效仍走专用 Public AOT cache 服务，不在统一 Redis prefix 失效路径里全盘扫描。热点 miss singleflight 等待使用指数退避，避免固定间隔轮询放大 Redis 与 GC 压力。singleflight 入口由 `ConcurrentDictionary` 和 entry 自身引用计数管理，不依赖 `IMemoryCache` eviction callback；最后一个等待者释放后才 retire 并移除 entry，避免 eviction 与等待者注册竞态造成 lost wakeup 或已释放 semaphore。

缓存 miss 回填、后台 projector 和修复任务访问 PostgreSQL 时必须通过 `DbConcurrencyGate`。gate 至少拆为 `public-short-read`、`admin-heavy-read`、`foreground-write`、`background-projection-rebuild` 四类，每类拥有独立 limit、bounded queue、timeout、active/waiting/timeout 与 wait/query p99；默认值从主 Npgsql pool 和公共 projection 独立 pool capacity 派生，允许配置覆盖，但不得只按应用 CPU 或无限放大连接数。公共 projection 使用独立 pool，因此 background rebuild 饱和不能占掉 public read slot。外层调用获得 class slot 后创建 reservation；同一 async flow 内的 reentrant 调用在 reservation 内串行执行，不重复占 slot。

`public_article_projection` 由 online Expand migration 创建，运行时 reader 不执行 DDL。文章 create/update/publish/archive/delete/restore/permanent-delete、scheduled publish、revision/content、category/tag rename 与 rights proof 通过同事务 `article_mutation_outbox` 收敛；projector 先 upsert DB frame，再执行 DB/frame shadow parity，最后原子替换文件 artifact。任一步失败都会保留 required edge 为 failed/pending。全量 backfill 用 durable watermark、动态 rate 和 background gate limit 控制并支持 pause/resume；mismatch 写入独立 evidence 表。`Database:PublicArticleProjection:Enabled=false` 可在 reload 配置中即时回到 legacy read，不需要重启或删除新表；回退窗口内仍继续维护投影，生产证据密封前不得删除旧 source query。详见 [Public article projection](performance-public-article-projection.md)。

公开 taxonomy frame 使用 `category_public_article_count`、`tag_public_article_count` 与 `article_public_taxonomy_projection` 作为计数投影。`/api/binary/category.aeds`、`/api/binary/tag.aeds` 和 PublicHotRead category/tag artifact 的 cold miss 只读取分类/标签元数据加 rollup，不在公开读路径对 `article` / `article_tag` 做全量 join/group 聚合。文章创建、更新、删除、恢复、永久删除和 outbox replay 都通过 `ITaxonomyCountProjectionService.ReconcileArticleAsync` 比较旧 snapshot 与当前公开可见状态，只在 category/tag count delta 真实变化时更新 rollup，并调用 `BumpFrameVersionAsync`；分类/标签 metadata mutation 同样必须走该入口。bump 会先读取旧版本，再原子递增 `TaxonomyFrameVersion`，随后删除 `CategoryFrame` / `TagFrame` 的 legacy `all`、`v:{previous}:all` 与 `v:{current}:all` identity。请求只以当前 version identity 回填 raw L1/L2 frame：已观测到新版本的实例不再读取并发中的旧版本回填，这些不可达数据按 TTL 淘汰；尚未收敛的实例最多在 `TaxonomyFrameVersion` 的 1 分钟 L1 TTL 后切到新 identity。动态 `/api/binary/category` 与 `/api/binary/tag` 不再叠加 HTTP OutputCache，避免独立的五分钟响应副本与逐请求 `RiskAwarePublicReadFilter`、raw frame version 失效产生分叉。

taxonomy 缓存故障的无需重启回退必须同时处理 raw frame 与 PublicHotRead L0，不能只删除 version key。以生产环境无 runtime prefix 的默认 Redis key 为例：先读取 `fsus:blog:taxonomy-frame-version:main` 的当前正整数 `N`，对该 key 执行原子 `INCR` 得到 `N+1`；随后删除 `fsus:blog:category-frame:all`、`fsus:blog:tag-frame:all`、两类 `v:0:all`、`v:N:all` 与 `v:{N+1}:all` key；再从 `/user/manage/cache` 触发 `public-hot-rebuild`。若 version key 缺失或不是正整数，先清除 legacy `all`、fallback `v:0:all` 和已知的 versioned frame，再把 version key `SET` 为一个未使用的正整数 `M`，并清除两类 `v:M:all`；不得只 `DEL` version key，否则请求会退回可能仍有旧值的 `v:0:all`。多实例部署等待最多 1 分钟让远端 version L1 收敛，期间通过 taxonomy frame cache hit/miss 与 PublicHotRead build 状态确认新版本已重建；为清理收敛窗口内的旧实例回填，等待后再删除两类 legacy `all`、`v:0:all` 和原版本 `v:N:all`。测试 session 或其他 runtime scope 必须对上述 key 加实际 scope prefix；这些步骤只操作缓存和后台重建队列，不需要重启应用。

封禁 blacklist 缓存使用 `CachePolicyId.SecurityBlacklistUser`，suffix 固定为 `account:{accountSubjectHash}`。`BlacklistService` 仍以 `sys_user.Status/BanReason` 为数据库真源，`accountId` 只用于 DB 回源和持久化更新，不得拼进 Redis/L1 key；`CacheInitializer` 预热与 bootstrap rollback entry 也必须先转换为 `AccountSubjectHash` 后写入或删除缓存。运行时回退路径是删除对应 `account:{accountSubjectHash}` 缓存，让下一次写请求或 notification stream admission 回查 PostgreSQL 并回填；不需要重启进程，也不得通过恢复裸 `userId` key 降级。

站点合规配置使用 `CachePolicyId.SystemCompliance` 进入 L1/L2/raw binary cache。admin 保存后由 `ICacheInvalidationDispatcher.InvalidateComplianceAsync` 清除 compliance cache、SEO/distribution output cache 与相关 AOT 静态页，并推送 `CacheControl` shell invalidate 事件；因此 ICP/公安备案、版权与许可 footer、RSS copyright 和 sitemap 静态页可在不重启服务的情况下收敛。

评论缓存失效由 `ICacheInvalidationDispatcher.InvalidateCommentMutationAsync(CommentCacheInvalidationScope)` 承载：公开可见性变化只删除 `CommentCursor` 的 `article:{articleId}:` 前缀，特定回复树变化可额外删除 `article:{articleId}:root:{rootId}:`，个人评论历史只删除 `UserCommentCursor` 的 `account:{accountId}:` 前缀；不得再用空 prefix 或 `CacheTag.Comment` 全局清除公开评论 output cache。公开评论 frame identity 包含 viewer region，保证 `comment_blocked_region(comment_id, region_code)` 可索引过滤后的 CN-MAINLAND/UNKNOWN/其他地区读模型不会共享同一个缓存条目；frame cache hit/miss 通过 cache runtime counters 按 roots/replies 与规范化 region 记录。公开评论线程/回复端点不挂 HTTP OutputCache，避免审核 notification stream、地区过滤与浏览器缓存产生状态分叉。评论 cursor limit 由 `ICommentCursorPolicyResolver` 从 `CommentCursorPolicies` / `CommentCursorPolicies:Tenants:{tenant}` 配置解析；缺省仍使用 threads 10/50、replies 20/100、user comments 10/50，端点和 Core gateway 不得直接硬编码分页上限。

`CommentQueryService` 先计算当前 viewer-region 的直接可见评论，再用递归 CTE 沿 `parent_id` 补齐任意层级祖先；不直接可见但承载公开后代的节点只生成无正文、无作者身份的墓碑投影。删除叶或全部后代均不可见时不进入游标窗口，避免空墓碑永久占位；回复目标被删除/隐藏/地区屏蔽时仍保留 `reply_to_comment_id` 结构，但 `replyToAuthor` 改为固定安全占位。删除事务提交后按 article/root 范围失效缓存并发布 `CommentRemoved`，浏览器先 redact 本地节点再回源首屏，确保 notification stream 状态与冷读取收敛。无需重启的降级路径是通过现有审核运行时把新增评论保持 `Pending`，减少新公开分支；读模型没有 JSON fallback，也不绕过 viewer-region cache identity。

递归 UI 主读链把根、直接子节点和 permalink context 拆成三个 AEDS frame。根页只加载一层预览，展开分支时按 parent 独立 keyset 加载；permalink 用递归 CTE 读取一条祖先链，并以目标同级 keyset 窗口恢复上下文。节点 `childCount` 通过当前页 ID 集合的一次批量聚合回填，禁止 correlated per-node count；百万节点基准与查询计划记录在 [`performance-comment-tree.md`](performance-comment-tree.md)。浏览器以 comment ID 建立 node/parent 索引，实时事件按真实 parent 合并，折叠分支恢复焦点，深层视觉 guide 压缩但不改变 DOM 树和 `aria-expanded/aria-controls`。`CommentThreads:RecursiveReadsEnabled=false` 可热关闭三个新读端点并返回 503，旧 binary thread 路由继续承担滚动回退；`MaxDepth` 与 `MaxChildrenPerNode` 同样 reloadable，但已存树不被重写。

线程预览查询在同一个 root batch 内对墓碑链执行 `COUNT(*) OVER (PARTITION BY root_id)`，因此 `ReplyCount`、preview 和 `HasMoreReplies` 共享审核、删除、地区及有效 article publication 条件且没有逐根 N+1。创建、删除、审核转换与地区策略 replay 继续通过 article/root scoped `CommentCursor` 失效入口重建该投影；实时新增可单调递增本地计数，删除后必须回源权威窗口，避免在不知道未加载后代时错误递减。

评论 ownership overlay 复用认证 `CommentUserCursor` 的 article-scoped 窄读，不新增公共 frame：Core gateway 对 article filter 绕过未分区的账号历史 query cache，endpoint 的 owned-frame key 固定包含 account + article + cursor + limit + account version。前端公共线程模型不含 `authorAccountId`；`ArticleDetail` 独立维护 `ownedCommentIds`，冷加载、notification stream 新增/删除、公开提交回包与账号切换都收敛到同一私有读取。该 overlay 失败时只隐藏管理按钮，不会放宽删除权限；无需重启的回退是停止 articleId overlay 请求，公共阅读和服务端权威删除继续工作。

评论创建幂等身份直接保存在 `comment` 行：public 使用 `client_mutation_account_id + client_mutation_id`，强匿名使用不可逆 `anonymous_ticket_hash`，两者同时保存规范请求摘要与到期时间。写入前按身份取得 PostgreSQL advisory transaction lock，再在同一事务创建 comment、地区/blocked-region/nullifier 记录；提交后才消费匿名 ticket 和派发缓存/通知副作用。相同身份同摘要只读取原 comment 并返回 `idempotencyReplay=true`，不会重复 side effect；相同身份不同摘要返回 409。浏览器 public draft 持久化 mutation ID，双击、超时后的人工重试和页面恢复复用它；匿名网络响应丢失只用同一 ticket 自动重试一次。notification stream scheduler 与树合并继续以 `commentId` 去重。`Comments:MutationIdempotencyEnabled=false` 可热重载 fail closed 新的 public/anonymous 创建而不影响读取、审核和 notification stream；修复 schema 后重新开启，不允许回退到无幂等身份写入。

评论创建幂等身份直接保存在 `comment` 行：public 使用 `client_mutation_account_id + client_mutation_id`，强匿名使用不可逆 `anonymous_ticket_hash`，两者同时保存规范请求摘要与到期时间。写入前按身份取得 PostgreSQL advisory transaction lock，再在同一事务创建 comment、地区/blocked-region/nullifier 记录；提交后才消费匿名 ticket 和派发缓存/通知副作用。相同身份同摘要只读取原 comment 并返回 `idempotencyReplay=true`，不会重复 side effect；相同身份不同摘要返回 409。浏览器 public draft 持久化 mutation ID，双击、超时后的人工重试和页面恢复复用它；匿名网络响应丢失只用同一 ticket 自动重试一次。notification stream scheduler 与树合并继续以 `commentId` 去重。`Comments:MutationIdempotencyEnabled=false` 可热重载 fail closed 新的 public/anonymous 创建而不影响读取、审核和 notification stream；修复 schema 后重新开启，不允许回退到无幂等身份写入。

## AEDS Binary 链

FsusBlog 运行时 API 只维护 AEDS binary 链：

| 链路 | 内容类型 | 解码位置 | 用途 |
| ------ | ---------- | ---------- | ------ |
| Binary 链 | `application/octet-stream`（AEDS v2 帧） | TypeScript adapter / 浏览器 Wasm Worker | 生产主链、公开读取与管理端写操作 |

**失败逻辑**：Wasm Worker 解码失败时，客户端可切到 TypeScript binary decoder 或展示协议错误；不得重发文本 API 请求。

**v2 写出与缓存路径**：

- `src/shared/Contracts/Validation/aeds-protocol.json` 是 v2 header 与活动 frame type 的唯一机器可读源；生成器同步产出 Core/Shared C#、TypeScript 与 C++ `aeds_frame.hpp`。Core、Server 和测试统一引用 Shared packed header，不再维护 Core 手写副本。`check:aeds-protocol` fail closed 检查全部生成文件，cross-stack frame-schema check 还会编译真实 C++ decoder、遍历所有活动 frame type，并用 C# golden frame 验证 C++ 解码，因此跨语言名称、数值或 16-byte layout 漂移会在 CI 中阻断。
- 帧头固定 16 字节，动态响应通过 `AedsFrameBufferWriter` 预留 header 并在同一 pooled buffer 中写 payload，`Seal()` 后回填 header/CRC，避免先构造 payload 再复制到完整 frame。
- `BinaryFrameResult`、`BinaryFramePayloadResult` 与 `BinaryPreencodedFrameResult` 每个响应只提交一次 `PipeWriter`：`WriteAsync` 本身完成 flush 时不得再无条件 `FlushAsync`；直接 `GetSpan/Advance` 的 payload 路径只显式 flush 一次。request cancellation、aborted response 和 pipe backpressure 原样传播。
- `AedsFrameBufferWriter` 对未知、auth/session/MFA/Passkey、匿名凭证、admin/private 和 `ApiError` frame 默认清零后归还 `ArrayPool`；只有 `AedsFrameSensitivity` 明确列出的公开 immutable response frame 可跳过最终 buffer clear。扩容发生在 `Seal` 前，旧 buffer 始终按敏感数据清零。
- `/api/binary/**` 在完成 Accept 与 binary request content-type 校验后直接进入 endpoint 写出链路，不再被 API binary response middleware 捕获到临时缓冲。
- 非 binary `/api/**` 请求只有在客户端显式接受 binary envelope 时才进入捕获/转换路径；普通 JSON 成功响应不再被无差别缓冲。真人阅读 proof 运行时路径已迁移到 `/api/binary/read-proof/*.aeds`。
- 非上传 binary 请求使用 pooled frame buffer 读取，默认最大 frame 为 8 MiB；解码后的 payload 以 buffer slice 传递给端点，buffer 生命周期挂到 response completion，不再为 payload 额外 `ToArray()`。
- 上传分片继续走 raw stream，端点用 request body backed `IFormFile` 交给文件服务，不再把整个分片读入 `MemoryStream` 后克隆成数组。
- 上传会话 cleanup 由 `UploadSessionCleanupWorker` 后台执行，session init/status/part-map 只发送合并信号；默认 45s signal window 内重复请求记为 dropped/coalesced，不触发清理风暴。`FileService` 保存 session manifest 时同步写入 `.upload-sessions/expires/yyyyMMddHH/{uploadId}` 过期索引，cleanup 主路径只扫描已到期 bucket 内的候选 session；complete/abort/过期删除必须同步清理 index。legacy manifestless/session root sweep 仅作为低频兜底，不作为常规 cleanup 路径。上传 session lock 的 stale 扫描同样挂在后台 cleanup 末尾，`AcquireSessionLockAsync` 只执行单个 uploadId 的引用与 semaphore 等待，不再按每个分片请求扫描 `s_sessionLocks` 全表。运行时指标记录 `fsus.upload.cleanup.scanned_sessions`、`deleted_sessions`、`elapsed_ms`、signal accepted/dropped/coalesced，以及 `fsus.upload.session_lock.current_count`、`stale_scanned_count`、`stale_disposed_count`、`cleanup_elapsed_ms`、`acquire_elapsed_ms`。
- PostgreSQL/ORM entity/command service 是 write model；Public AOT HTML、article detail `.aeds`、search index、list/category/tag/hot snapshot 是 artifact-backed read model；L1/L2/OutputCache 只是加速层，不能作为 CQRS read model 的替代。
- 公开热点 GET（article list、hot articles、category、tag、detail、公开 HTML）先由 `PublicHotReadRequestFeature` 单次分类，再经专用 `public_read` limiter 与 `PublicReadSecurityGate`，最后由 `PublicHotReadFastPath` 写出不可变快照。候选 synthetic endpoint 只引用预构建 metadata，不按请求构造 display name；正常 allow 不写 risk event，zero-risk microcache hit 不访问 Redis。binary artifact 在构建阶段生成 raw/br/gzip variant，请求时按 `Accept-Encoding` 选择，并支持 variant-aware `ETag` / `If-None-Match` / `304`；nonce HTML 是例外，只使用预编译 UTF-8 segment identity stream、private/no-store 且没有 entity validator。L0 hit 不访问 PostgreSQL、Redis、`IMemoryCache`、OutputCache、文件系统、OpenTelemetry span 或 AEDS encoder，也不进入常规 endpoint pipeline。dynamic related-reading 从 classifier 排除；article/public HTML artifact miss 与未支持 public route 清除 synthetic endpoint 后回到既有 endpoint，且不会再次执行 limiter/risk/PoW。readiness 除 `NotStarted` / `Building` / `Ready` / `Failed` 外还暴露 `earlyDataPlaneEnabled`、`earlyDataPlaneState=disabled|not-ready|ready`、resident bytes/template bytes/budget。HTML artifact 的 `routeKey` 会先映射为 URL-safe `pathKey`，`/api/binary/article/html/{pathKey}.html` 只作为诊断/预览命中路径，不计入真实公开页 QPS。
- `PublicArtifactRevocationMiddleware` 位于 public-read security gate 与 fast path 之间，并独立重新识别公开 artifact 路由，因此即使热关闭 PublicHotRead classifier，也不会绕过 active tombstone。公开 create/update/delete 与 scheduled publish 在 DB 可见前先持有绑定 runtime/test-session scope 与 article/global id 的 PostgreSQL session advisory lock，再用 Redis Lua 原子分配 generation 并持久化 `TransitionPending` tombstone；未确认 marker 先让当前进程 fail closed，CDN purge 成功并持久化 confirmation 后，再发布 confirmed marker。commit/abort 或 durable outbox replay 只 CAS-promote 同一 generation，subscriber 对 pending marker 不排 rebuild。writer 崩溃后 `PublicMutationFenceRecoveryWorker` 只有 `pg_try_advisory_lock` 成功时才 promote/enqueue，活 writer 或较新 generation 保持 410。`Cloudflare` provider 直连 zone purge API，`Generic` provider 调用受控 HTTPS purge gateway。任一 active marker 对 article detail、公开 HTML、list/hot/featured/taxonomy artifact 保守返回 410/no-store，避免聚合 artifact 泄漏被撤回文章。每个 `PublicHotArtifactUpdateWorker` 在查询前捕获最大 generation，先原子 publish 本机新 snapshot，再只清除该 generation 及以前且属于本次 rebuild scope 的本机 marker；全局 marker 只能由 full rebuild 清除，较新的并发撤回不会被旧 snapshot 清除。共享 Redis tombstone 使用 payload compare-delete，且不广播全局 clear，因此尚未完成重建的 edge 继续 410。purge、通知、重建或 clear 任一失败时 outbox required edge/rebuild 重试，marker 保持 fail closed。Redis Pub/Sub 当前没有 subscriber ACK，不能把远端 edge 的收到时刻当作跨实例线性化屏障。
- `PublicHotArtifactUpdateWorker` debounce/coalesce 期间必须收集窗口内全部唯一 article ID，并在同一个 snapshot 上依次执行 delta projector 后原子 publish；任一 update 没有有效 article ID 时强制全量 rebuild。不得只使用窗口首个 article ID，否则删除、归档、转草稿或敏感内容修订可能让后续文章的 detail frame 继续被 L0 匿名命中。
- PublicHot 全量 projector 必须在 `MaxArticleFrames` 截断前统计当前公开文章总量，并把 `publicArticleCount`、`articleFrameLimit`、`articleFrameLimitExceeded` 暴露到 runtime snapshot；一旦公开文章数超过 frame 上限，readiness/runtime 必须 degraded/not_ready，避免仍公开的老文章因预加载容量静默变成 L0 404。
- 文章内容可信证明使用 Core 层 `ArticleCanonicalHashV1`，规则见 [Article Canonical Hash](integrity/article-canonical-hash.md)。第一版只定义本地 canonical payload 与 `sha256` digest，不接 IPFS、Arweave 或链上锚定；payload 绑定 `Article.Id`、可选 `ArticleRevision.Id`、`RevisionNo`、公开 route identity、标题、摘要、封面、分类、标签、状态、发布时间和 Markdown 正文，排除浏览量、运行时缓存版本、viewer/session/request context、评论、私信、审计日志与 raw admin principal identity。
- Rights V3 版权策略可信摘要使用 Core 层 `ArticleRightsCanonicalHashV1`，规则见 [Article Rights Canonical Hash](integrity/article-rights-canonical-hash.md)。payload 绑定 `Article.Id`、`ArticleRevision.Id`、`RevisionNo`、冻结版权策略字段、公开 canonical URL 与内容 canonical hash；字符串按 UTF-8/NFC/LF 固化，hash 输出为 `sha256:<64 lowercase hex>`。公开读路径只读取已投影 artifact 中的版权声明和 proof pointer，不查询 `article_rights_policy`、`article_rights_snapshot` 或 `article_rights_proof` 动态渲染。
- 公开产物可信证明使用 Core 层 `ArtifactDigestV1`，Server 层通过 `PublicArtifactDigestEntries` 适配当前产物读取入口，规则见 [Public Artifact Digest](integrity/artifact-digest.md)。它只绑定已生成或可读取的公开 bytes，包括 PublicAOT HTML/shell、`ArticleDetailAeds`、`PublicHotRead`、`DistributionEndpoints` 的 RSS/Atom/JSON Feed、`sitemap.xml`、`robots.txt`，以及复用 `AssetLibraryItem.Sha256` 的公开资产和 per-article asset manifest。`Missing`、`Pending`、`Stale`、`NotPublic`、`Unknown`、`Unavailable`、`HashMismatch` 只是可观测状态，不替代 PublicAOT、AEDS、PublicHotRead、feed/sitemap/search 的缓存失效和 outbox replay。
- 站点认可的 publish proof/checkpoint 使用 Server 层 `SiteIntegritySigningService` 签名，规则见 [Site Integrity Signing Keys](integrity/site-signing-keys.md)。第一版算法是 .NET 内置 `ECDSA_P256_SHA256`，payload domain separator 为 `fsusblog.integrity.publish-proof.v1`；`SiteSigningKeyRegistry` 只公开 public key metadata，私钥仅来自服务端环境变量、secret volume 或受控配置。缺失生产签名配置时 integrity proof 进入 `Disabled`/`Pending`，不得生成伪签名；revoked key 可保留历史验证窗口，compromised key 全量拒绝。
- Publish Proof 使用 `article_publish_proof` 持久化 `Article.Id`、`ArticleRevision.Id`、`RevisionNo`、canonical hash、公开产物 digest、发布时间、状态、签名 key 和 Base64Url signature，规则见 [Publish Proof](integrity/publish-proof.md)。ready proof 必须绑定真实 `ArticleRevision.Id`，同一 revision 重放依赖 `article:{articleId}:revision:{articleRevisionId}:proof:{proofVersion}` 幂等键；缺失/待生成 artifact 保持 `pending`，stale/hash mismatch 进入 `failed`，归档/删除/非公开文章进入 `not-public`，不得生成伪 ready 证明。`superseded` 只表示当前公开证明已被后续 revision 取代，不改写历史签名 payload；`CreatedByAdminPrincipalId` 不纳入公开 proof。Publish Proof 写入后追加本地 append-only [Transparency Log](integrity/transparency-log.md)，`integrity_transparency_log.seq`、`prev_entry_hash` 与 `entry_hash` 形成 hash chain，并通过 proof/log 双向字段关联。该日志只增强本地可审计性，不替代 `audit_log`、security risk event，也不代表链上或外部共识证明。Merkle checkpoint 使用 `integrity_merkle_checkpoint` 对 transparency log 范围生成 daily/release root、manifest 与站点签名，规则见 [Merkle Checkpoint](integrity/merkle-checkpoint.md)；checkpoint 只证明某条 publish proof 被包含在本地日志快照中，不替代 release artifact signing 或 SBOM hardening。

### Rights V3 final data flow

Rights V3 的最终公开读模型是同一 artifact pipeline：`admin write` 写入带 `baseRevisionId` 的 `ArticleWriteRequest V5`，以 preserve/replace/reset 明确选择有效 rights policy；服务端在文章事务内冻结 revision-bound snapshot，生成内容 canonical hash 与 rights policy hash；后台 projector 当前产出 `ArticleDetail AEDS V5`（并保留 V4/V3 artifact 只读兼容），把可公开的 Rights V3 snapshot、copy policy、proof pointer、正文 `updatedAt`、revision/publication 坐标和 integrity coordinates 编入同一 detail frame；`PublicAOT hydration` 消费这个 ArticleDetail 投影生成 HTML、metadata 和 hydration rights；integrity worker 生成 `rights proof`，把 snapshot、content hash、publish proof pointer 和 site signature 绑定；proof ready 后追加本地 append-only `transparency log`，再通过公开 integrity sidecar 暴露校验坐标。公开文章页没有、也不得新增 separate public rights endpoint；浏览器不得再请求 `/article/{id}/rights.aeds`、`/rights` 或其它 side channel 来补齐版权信息。

- 浏览计数不在读取链路产生，而由独立真人阅读 proof 事件更新。
- VisitLog flush 只写入 `IHotStatsInvalidationCoalescer` dirty 标记，不直接 broad invalidate AdminStats/HotArticles。coalescer 对 HotArticles 使用 2s debounce、Stats 使用 10s debounce，并在 threshold 或 shutdown 时 flush pending state；HotArticles 的 L1/L2 identity 形如 `ArticleHot:v{hotVersion}:core:v2:{count}` / `ArticleHotFrame:v{hotVersion}:core:v2:{count}`，失效时发布新版本并让旧版本按 TTL 自然过期，避免高频 `RemoveByPrefixAsync(..., string.Empty)` 扫描。
- `ICacheInvalidationStore` 提供 `RemoveManyAsync` 与 `RemoveByPrefixManyAsync`。写路径失效应优先传递 `CacheKeyIdentity` / `CachePrefixIdentity` 批量请求，由 cache 层合并 L1 remove、Redis `KeyDeleteAsync(RedisKey[])`、registry `SetRemoveAsync(RedisValue[])`，并在同 policy 多 prefix 时只扫描一次 registry；registry 缺失 fallback 使用同 policy prefixes 的共同前缀执行一次 keyspace scan 后再二次过滤。
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
- Preflight 与正式 WebSocket 握手共用 `NotificationStreamHandshakeService`，先校验 Origin allowlist，再验证认证、RiskControl / legacy PoW、cursor 和协议语义；preflight 不要求 WebSocket upgrade，且只校验一次性 RiskControl proof 的存在性和 kind，正式 WebSocket 握手才消费 proof。Origin/host allowlist 由 `NotificationStreamOriginSnapshotProvider` 从 `Seo:BaseUrl`、`CORS_ALLOWED_HOSTS`、`Fido2:Origins` 和 `AllowedHosts` 构建 immutable snapshot，并通过 configuration reload token 刷新；握手热路径只读 snapshot，不重复 split/parse 配置。
- 握手失败统一写入 `X-Fsus-Notification-Stream-Error-Code` 与 `X-Fsus-Notification-Stream-Status-Code`，并返回 AEDS `ApiError` frame。
- Preflight 与正式 WebSocket endpoint 都使用 `notification_stream` 固定窗口策略；正式连接在 `NotificationStreamConnectionManager.RegisterConnection` 内、`AcceptWebSocketAsync` 与 per-connection channel 分配之前获取全局 / IP / 账号原子租约。配额由 `NotificationStream:MaxConnectionsGlobal`、`NotificationStream:MaxConnectionsPerIp`、`NotificationStream:MaxConnectionsPerAccount` 控制，超限返回 `429 notification_connection_limit`，并在 `RemoveConnection`、accept 失败、backlog/heartbeat/pump 异常与请求取消路径释放租约。
- 通知握手只编排协议、RiskControl / legacy PoW 与握手结果。账号封禁/注销准入下沉到 `NotificationStreamAdmissionService`，notification stream audience 分组下沉到 `NotificationStreamAudienceResolver`，消息域到 user/group route 的映射下沉到 `MessageNotificationStreamPort`。已登录普通账号的 stream reconnect 使用 `NotificationStreamAccountAdmissionCache` 缓存短 TTL account state，避免每次重连读取 `sys_user`；ban state 仍在每次 admission 通过 `IBlacklistService.GetBanStateAsync` 校验并复用其 subject-hash 缓存，因此封禁收敛语义不回退。握手记录 origin validation elapsed、origin cache elapsed/hit ratio、account state hit/miss、admission DB read count 与 rejected reason count 指标。
- `MessageCenterService` 是消息中心读写和 notification delivery projection 的唯一应用服务。账户/admin inbox 列表必须让 count 与 page 查询并发执行，last message preview 使用单条 `DISTINCT ON (conversationid)` SQL 回源；创建、账号/admin 回复、系统消息、显式已读和状态变更都在各自 PostgreSQL 事务内同时写入消息/activity、unread/read cursor 与 per-target `message_mutation_outbox` event。请求线程不再直接发布这些实时事件；`MessageMutationOutboxWorker` 以稳定 delivery key、`FOR UPDATE SKIP LOCKED` claim、短 lease、指数退避和 poison 状态恢复提交后退出、发布失败与重复消费。它每轮通过 `IBackgroundWorkerLease` 取得单进程执行权，过期 processing claim 可重领，未过期 claim 不抢占。动态关闭 `MessageMutationOutbox:Enabled` 只暂停消费并保留 pending event，重新启用后继续重放，不回退为 best-effort 直推；积压、失败、poison 与 stuck claim 由 `fsus.message_outbox.*` 低基数指标观测。账号参与者的 read cursor/unread 保存在 `msg_participant_state`，管理员共享队列则独立保存在每 conversation 一行的 `msg_admin_queue_state`；只有账号消息在同一事务中增加 admin unread，admin/system 消息不增加。admin 最新详情按响应快照单调推进共享 cursor，列表、详情和 unread filter 都只读该投影；旧会话通过 migration 保守回填，并可由 `IMessageAdminQueueMaintenance` 检查/幂等重建。动态关闭 `Messages:AdminQueueProjectionEnabled` 时 admin 读取 fail closed，不回退参与者聚合；动态关闭 `Messages:ReplyWritesEnabled` 时账号/admin 回复同时 fail closed，读取与显式状态变更继续可用。相关热路径通过 `fsus.message.center.list.elapsed`、`fsus.message.center.reply.elapsed`、`fsus.message.center.fanout.refresh.elapsed` 与 `fsus.message.center.fanout.build_item.elapsed` 观测。
- 消息实时投影只发布 conversation/message reference 与 unread 计数：append 的 body 为空、upsert 的 last-message preview 为 null，账号端沿现有 delta paging 恢复权威正文，admin 端刷新列表/详情。`MessageRetentionCleanupService` 由现有 cleanup leader 周期调用，以 UTC cutoff 幂等清除到期 open/closed/system 内容和注销账号内容，保留行 ID、admin principal 与不可逆 audit reference；日志仅记录五类变更计数。`Messages:RetentionCleanupEnabled=false` 可热暂停清理，无需调整中间件或重启；已经清除的数据不提供应用级恢复。
- admin 状态变更使用显式转换矩阵和 `xmin` CAS；有效转换在同一事务中更新 conversation、追加不可变 `msg_conversation_status_event`，并分别写入账号/admin outbox。outbox 保存事件发生时的精确目标状态，worker 统一发布 `InboxConversationStatusChanged(15)`，不回读最新 conversation 状态；同状态请求返回 `no_change` 且不写审计/outbox。`fsus.message.center.status.count` 只使用有限的前状态、后状态与 outcome 标签观测转换结果。`Messages:StatusMutationsEnabled=false` 可热暂停状态写入，修复后直接恢复，不回退无审计、无 CAS 或 request-thread fanout。
- 系统消息 source-event replay 在目标状态读取之前解析，以保持原结果；新写入随后在同一消息事务中 `FOR UPDATE` 锁定 `sys_user`。普通消息 policy 只允许 active，封禁/恢复治理 policy 可允许 restricted，missing/deleted/未知状态均返回稳定领域错误；外键只做最终兜底。`Messages:SystemMessageTargetValidationEnabled=false` 热关闭后保留既有 replay、fail closed 新写入，不回退事务外检查。
- unread 的权威链固定为 `msg_message + monotonic read cursor -> participant/admin count projection -> Redis account total cache`。数据库 trigger 拒绝负 count、游标后退、跨会话或 internal cursor；重算服务可按单 conversation、单 account、单 admin conversation 或全量 admin queue 修复，差异日志不含消息正文。缓存 miss/损坏/CAS 失败回到数据库 count，Redis 永不反向覆盖数据库。`Messages:UnreadRepairEnabled=false` 仅热暂停维护写入。
- 消息创建、账号/admin 回复在同一事务中保存 `principal kind + principal id + ClientMutationId + request hash`；系统消息把稳定 `SourceEventId` 保存为唯一 `sourceMessageId`。写入前使用主体级 PostgreSQL advisory transaction lock，并跨 conversation/message 检查幂等身份：同键同摘要返回原始 ID 与 `idempotencyReplay=true`，同键不同摘要返回 `409`，不能重复增加 unread/activity/outbox。响应复用 POD reserved byte，不改变 AEDS frame type 或固定尺寸。`Messages:MutationIdempotencyEnabled=false` 热重载后 fail closed 四类写入，读取、mark-read、status 与 notification stream 继续可用；修复后重新启用，不允许回退为无身份写入。
- admin account context 是独立 read projection：列表、详情与 notification upsert 都由 `MessageCenterService` 生成相同的 `account id + coarse status`，并通过 admin-only frame 206/207 传输；账号 frame、public handle、admin principal/session 不参与该投影。sender display 在服务端按 viewer 生成，不能由前端从单一名称反推身份。`Messages:AdminAccountProjectionEnabled` 支持热关闭 admin 读取和 upsert，账号协议与消息写入保持可用。
- Notification stream backlog 按 route 写入 Redis stream（`u:{id}` / `g:{group}`；multi-user target 展开为多个 user route），多目标 backlog 写入通过 Redis batch/pipeline 一次提交。publisher 不再持有进程级全局 gate；它只按排序后的实际 storage route 获取 Redis ownership lock，因此有重叠 route 的 publisher 仍按 event id 单调 append，互不相关 target 不再无条件互相排队。multi-user publisher 以相同排序获取全部 route lock，避免与单 user publisher 交叉写入或形成锁环。replay 只读取当前连接可见的 user/group stream 后按 event id 合并和去重。
- `NotificationStreamDeliveryPolicyCatalog` 是 active event 的 machine-readable 权威目录；未知 enum 在编码或入队前 fail closed。local fanout 分为 lossless、replaceable/coalescible state、low 三条独立浅 lane，分别受 frame/byte/max-useful-age 约束；state/low lane 按 `event type + route + semantic key` 只保留最新 frame，worker 使用轮转起点调度，低优先级拥塞不占用 lossless capacity，且任一 lane 不会永久饥饿。
- 每连接队列同时约束 frame count、queued bytes 与 oldest age，并记录 send latency、coalesced/drop/resync count 和最后 event cursor。只有 policy 明确声明 `diagnostic-drop` 时允许静默 drop；其他 lane overflow、本机 fanout overflow或 frame 过期都会关闭受影响 target 的连接。`ReplayFromCursor` policy 发送 `4010 fsus_replay_required:<bounded-reason>` 并保留 cursor；`FullResync` policy 发送 `4011 fsus_full_resync_required:<bounded-reason>` 并清空 cursor。Redis retention gap 继续使用 `4009 fsus_replay_miss`。
- 连接在 backlog replay 前先注册到本机 fanout；replay 期间到达的 live frame 保存在该连接的有界队列，replay 完成后由同一 pump 接管，因此 replay/live 之间没有静默窗口。若这个窗口的 queue budget 被耗尽，连接收到上述 replay-required 指令，而不是继续消费有缺口的 live 状态。
- 配置预算为 `NotificationStream:Fanout:{Lossless|State|Low}FrameCapacity`、对应 `ByteBudget`、`NotificationStream:QueueByteCapacity` 与 `NotificationStream:QueueMaximumAgeMs`。观测包括 publish critical-section wait/route-lock count、lane depth/bytes/oldest age、coalesce/drop/expired、connection resync、send latency 与既有 fanout/replay 指标；标签只使用 lane、target kind 和固定 reason。
- 无需重启的降级路径是不改变 Redis backlog 与 AEDS frame，先在网关停止向候选 slot 建立新 stream，将流量切回上一 active slot，并通过既有 1012 deployment restart 协议让候选 slot 的连接携带 cursor 重连。不得通过恢复全局 gate、扩大为无限队列或允许 lossless 静默 drop 来降级。
- Resilience drill 通过 Development/Test-only `/_fsus/testing/notification-stream/publish` 入口驱动同一 `INotificationStreamPublisher` 链路；`drillSlowConsumer=1` 只在 Development/Test WebSocket query 中启用发送延迟，`drillQueueCapacity` 可把该测试连接的 per-connection queue 降到 32，用来稳定触发背压关闭，不改变生产 pump 行为。
- 连接 pump 使用每连接一个 `PeriodicTimer` heartbeat loop；业务 frame 与 heartbeat 通过发送锁串行写 WebSocket，避免每轮 idle wait 创建 linked timeout CTS。
- `CacheControl` 与 `SearchIndexUpdated` 的搜索索引版本字段以 `version / manifestUrl / generatedAt` 为唯一消费语义，Service Worker 不再从多个字段推导版本。

## 真人阅读聚合计数

```text
SPA hydration
  → /api/binary/read-proof/challenge.aeds
  → 主内容可见停留 ≥ 8s
  → /api/binary/read-proof/submit.aeds
  → VisitLogChannel(aggregate contribution: hour/article/dwell bucket)
  → article_read_hourly_aggregate + read_dwell_daily_aggregate
  → Article.Views 投影 + Redis hot articles + stats/cache invalidation
```

- 生产不写入 per-read row；`sys_visit_log` 与旧 projection watermark 由 `20260715-post-read-event-retirement` 物理删除。可信代理中间件规范化连接地址后，read-proof 入口只同步生成一分钟、path-scoped 的 HMAC 限流分区，以及 article/site + 15 分钟 epoch 的去重 HMAC；队列消息在请求边界就丢弃 IP、UA、设备指纹、route、proof id、viewer id、精确时间和精确 dwell，且不会进入 retry/dead-letter/fallback。
- 持久层只保留文章/UTC 小时计数、站点/日计数、四档 dwell/day histogram，以及 `Article.Views` 这种有界维度计数。四档固定为 `<10s`、`10–30s`、`30–120s`、`>120s`。
- 去重只在 article + 15 分钟 epoch 内有效，使用独立轮换 HMAC key；Redis lease 最长 20 分钟，摘要不进入数据库、日志、指标或备份。read-proof 请求不发送稳定 `X-Fsus-Device-Fp`，同一 IP/UA 只在 HMAC 的 article/epoch domain 内短期关联。
- `check-async-telemetry-privacy.mjs` 对所有 backend `Channel<T>` contract 和 scalar async write 做静态门禁；缓存/去重不可用时丢弃本次统计并返回 `dedup_unavailable`，不把请求身份转入后台补偿。
- 直接读取 `/api/binary/article/{id}.aeds`、AOT 首屏、无 JS、爬虫和预取请求不会增加计数。
- `VisitLogMiddleware` 仅保留为管线兼容占位，不再从 GET 请求采样。
- `VisitLogProcessorService` 名称仅为部署兼容，实际用单条 CTE upsert 聚合计数，不创建事件行。`ArticleViewProjectionRepairWorker` 已退役且不注册；投影失败只影响 `Article.Views` 派生显示，不影响已经落库的小时聚合。
- 地区统计过渡表不再写入；低样本 admin 读取先执行 `k=10` suppression，再按 UTC 日、固定 release scope 添加确定性 Laplace noise。DP 预算与精度边界见 [`privacy/read-analytics.md`](privacy/read-analytics.md)。
- 多实例部署下，仍有全局副作用的后台 worker 通过 `IBackgroundWorkerLease` 在 Redis L2 上执行 leader election。`ArticleMutationOutboxDispatcher`、`MessageMutationOutboxWorker`、`LogCleanupService`、`ScheduledPublishWorker`、`UploadSessionCleanupWorker`、`PublicAotBackfillWorker`、`CrawlerUpdateWorker` 与 `PowLoadResetWorker` 每轮实际工作前抢占短 lease；已退役的阅读事件 repair worker 不再注册，也不得重建事件表。

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

文章实体现在显式记录 `Status`、`ScheduledPublishAt`、`PublishedAt`、`ArchivedAt`、`DeletedAt`。公开读链、feed、sitemap、related-reading、搜索 runtime fallback、search index rebuild、分类/标签计数必须只读取 `Status=Published` 且发布时间已到的文章；`IsDeleted` 继续保留原有回收站语义。Core 状态策略与事务内 `ArticlePublicationTransitionWriter` 共用严格矩阵：普通写入只能在四个可编辑状态间转换，`Deleted` 只能由 delete 流程进入、由 restore 转回 `Published`，rollback 只到 `Published`，scheduled worker 只接受 `Scheduled/Published → Published`。未知枚举、缺失/无效计划时间和非法边都 fail closed 为带稳定 details code 的 validation，不再归一为 `Published`。

`ScheduledPublishWorker` 每分钟按 `scheduled_publish_at, id` 扫描到期 `Scheduled` 文章，在同一事务内把文章转换为 `Published` 并写入 `article_mutation_outbox` 的 `scheduled-published` 事件；事务成功后仍同步尝试 search index、PublicAOT、HTTP/cache 失效与 `PublicHotArtifactUpdateQueue` 入队。若事务失败，文章保持可被后续扫描重试；若事务已提交但任一派生副作用失败，worker 记录 degraded，outbox dispatcher 会按 retry/backoff 重放 cache/search/AEDS/PublicHot/notification stream 派生更新。`article_mutation_outbox` 仍保存事件级 pending/processing/processed/poison 与 retry/backoff，`article_mutation_outbox_edge` 记录 public-aot、http-cache、search-projection、article-detail-aeds、public-hot-read、notification、integrity-proof 等 edge 的 status、attempt count、last error 和 updated_at；dispatcher 重跑时会跳过已完成 edge，只在 required edge 全部完成后才把事件标记 processed。`integrity-proof` 是 publish proof 的非 required edge，只在 search、taxonomy、AEDS、PublicHot 等 required edge 已完成后调度；证明生成失败只记录 edge failed/pending/retrying 状态，不阻断发布事务、缓存失效、搜索投影、AEDS、PublicHot 或 notification stream。PublicHotRead 入队返回显式 accepted/rejected 状态；请求内同步副作用按 best-effort 记录日志，outbox replay 的 required public-hot-read edge 在队列满或关闭时进入 retry，不再只依赖 warning。失败结果会写入事件 retry count、next retry、last error，并同步记录失败 edge。worker 每轮把 `lastPublishedCount`、`lastFailedCount`、`dueBacklog` 与最近错误写入 `ScheduledPublishRuntimeState`，`/api/ops/health/ready-detail` 的 runtime 区块会暴露该快照。创建、更新、删除、恢复、永久删除同样必须在同一文章事务内写入 `article_mutation_outbox`，请求内仍同步尝试派生更新；若进程在提交后崩溃，`ArticleMutationOutboxDispatcher` 会按 retry/backoff 重放派生更新并在成功后标记 processed。

所有新 article mutation producer 写 `schemaVersion=2`，并在 primary write 的同一 PostgreSQL 事务内固化 revision、publication/release、rights snapshot、responsibility snapshot/version、事件时间以及 taxonomy/tag/visibility 的 before/after scope。dispatcher 在任何 edge 前以这些坐标做 version preflight；旧 release/revision 已被当前指针取代时，将尚未执行的 required/optional edge 记为 `skipped`，`last_error` 保存 `superseded-by-release:*` 或 `superseded-by-revision:*`，不得读取 latest 后覆盖新投影。当前版本才会进入 search、AEDS、PublicAOT、PublicHotRead 与 notification；AEDS/HotRead 还会把 expected release 传到 source query，坐标不再解析时保留当前 artifact。详见 [Versioned article mutation outbox](architecture/article-mutation-outbox-versioning.md)。

责任披露更新同样是 authority transaction：append-only snapshot、当前 publication 的显式责任指针和 `responsibility-updated` outbox 必须一起提交。dispatcher 先校验事件中的 article/revision/responsibility/publication 精确坐标，再更新 Public AOT、AEDS、HTTP cache、search/PublicHot 和 notification；不得查询 latest 猜测责任版本。无重启降级可将 `ArticleMutationOutbox:Enabled=false` 暂停派生 claim，authority 写入继续保留 pending 事件，修复后重新启用即可幂等重放。该迁移只承诺 PostgreSQL 单进程验收，schema 与新代码原子切换；旧 writer 不能在移除单 revision 唯一索引后并行写入，回退不得删除已追加快照或 publication 指针。

评论写入、删除、模型/人工审核状态转换和地区可见性记录采用独立的 `comment_mutation_outbox`。权威行与 `CommentCreated`、`CommentModerationChanged`、`CommentDeleted`、`CommentEdited`、`CommentReplyNotificationRequested`、`CommentVisibilityChanged` 在同一 PostgreSQL 事务提交；payload 被数据库约束为 `{}`，正文、匿名证明和 nullifier 不复制到事件。`CommentMutationOutboxWorker` 通过短 lease claim 恢复进程中断，按 model moderation、cache version、notification stream、site notification、audit projection 分 consumer checkpoint，重复投递跳过已完成 consumer；实时流以 event id 派生稳定 idempotency key，站内信复用 message source-event 去重。乱序事件在发送前重读当前评论状态，因此旧 approval 不能重新公开已删除或已隐藏评论。详细状态机与无重启回退见 [Comment mutation outbox](architecture/comment-mutation-outbox.md)。

分类/标签公开计数投影按 article 粒度串行化：`TaxonomyCountProjectionService` 在一个 PostgreSQL 事务内先取得 `(hashtext('taxonomy_projection'), articleId)` transaction advisory lock，再读取旧投影、计算计数差量并 upsert 新投影。同一文章的请求内副作用与 outbox replay 因而不能同时基于空旧投影重复累计；不同文章仍可并行。事务失败会完整回滚计数与投影，后续 outbox retry 可安全重放。

文章删除、恢复与永久删除都使用 PostgreSQL `xmin` 作为 row-version guard。软删除只匹配当前未删除 row-version；恢复只匹配当前已删除 row-version，并恢复为 Draft；永久删除在同一事务内先按 `isdeleted=true + xmin` 执行 `FOR UPDATE`，锁定成功后才清理 comment/tag/body/article，避免 stale restore/delete interleaving 删除子表或发出重复 outbox。

Binary 文章列表缓存使用 `core:v4:{public|admin}:...:{status}` 身份隔离，HTTP OutputCache 的 ArticleList 策略也必须按 `page/size/categoryId/tagId/isDeleted/status` vary。匿名列表只缓存 public published 视图；admin 状态筛选可缓存 draft/scheduled/archived/deleted 视图，但 admin 详情读取未发布文章时绕过公开详情缓存，避免草稿负缓存或私有正文污染匿名 `/article/{id}` 读链。公共文章列表 page URL 只作为兼容层，DB 读取必须走 `(createtime DESC, id DESC)` keyset walk，`ArticleList` AEDS payload 通过 cursor envelope 暴露 `nextCursor/hasMore`；公共列表总数使用 `ArticleListCount` 缓存并绑定 `ArticleListVersion + filter`，内容变更后随列表版本自然失效。

开放分发层由 `BlogDistributionService` 与 `DistributionEndpoints` 提供：

- `/feed/rss.xml`、`/feed/atom.xml`、`/feed/feed.json` 与历史 `/api/Article/rss`
- `/sitemap.xml`、`/robots.txt`
- `/api/binary/article/{articleId}/related.aeds`（主运行时 AEDS）

`BlogDistributionService` 不再用一个 snapshot 同时驱动 Feed 与 sitemap。Feed 使用独立的最新 50 篇最小投影；sitemap 使用无 Feed 上限的全量 identity/time 投影，并分别聚合分类、标签和静态页更新时间。正文表只选择 `updated_at`，不读取 Markdown；文章正文更新时间同时驱动 sitemap `lastmod`、Feed modified time 和 AOT `dateModified`。无可信更新时间的 URL 不输出 `lastmod`，空站不能用当前时间制造更新。urlset 以 45,000 条分片，根文档在超限时成为 sitemap index，诊断直接解析根/子 XML 和 RSS XML。

`PublicOriginPolicy` 是 AOT document、Feed、sitemap、robots 的共同 origin gate：配置 `Seo:BaseUrl` 为权威值，持久 SEO/artifact 只能相同或仍是项目占位值。`LifecycleHostedBootstrapService` 在 schema/account invariant 后、AOT/search 初始化前读取持久 SEO 并校验；生产冲突立即终止启动，避免任何表面输出第二套 canonical origin。

`RelatedReadingService` 是相关文章、上一篇、下一篇的唯一查询入口，端点与 PublicAOT article snapshot 共用它。相关性只来自公开文章的分类、标签、正文关键词和发布时间，不读取点赞、收藏、关注、登录用户或画像数据；PublicAOT renderer payload 会携带同一份 `relatedReading`，SPA hydration 后继续使用同一个 view contract 渲染，避免首屏与运行时结构不一致。PublicAOT article detail 生成会先读取 admin/detail 原始视图并在 provider 内执行同一套公开可见性判定；只有 private 读取为空时才回退到公开 detail 读取，因此草稿、定时、归档状态不会被旧公开缓存覆盖，发布后的公开读链也可以帮助 AOT 避免偶发空读。

这些端点使用 output cache 的 ArticleList/Seo tag，响应头使用 `Cache-Control: public, max-age=60, stale-while-revalidate=300` 与 `Vary: Accept-Encoding, CF-IPCountry, X-Fsus-Region`，条件缓存与 304 语义只由 OutputCache/上游缓存层负责，`DistributionEndpoints` 不按正文手写 ETag 或解析 `If-None-Match`。公开评论、公开 taxonomy 与 related-reading AEDS 端点额外挂 `public_read` 限流和 `RiskAwarePublicReadFilter`；公开 HTML 与 PublicHotRead hot binary artifact 候选同样进入 `public_read` 限流，并在 artifact 写出前由 `PublicHotReadSecurityGateMiddleware` 执行同一套公开读风险裁决：普通用户直接读取，verified crawler 使用独立高额度，social preview bot 不能访问 API，高风险 IP 先要求 PoW，持续高风险返回 429。`VerifiedCrawler` 只由通过 CIDR/rDNS 验证的 search crawler 设置；AntiCrawler `observe` 模式下的伪造 crawler 可被放行观察，但不得进入 verified-crawler 分区。风险读写通过 `ISecurityRiskSignalSink` / `ISecurityRiskScoreReader` / `ISecurityRiskPolicyProvider`，反爬虫、PoW、ReadProof 和 RateLimiter 只写入各自来源信号；`SecurityRiskEventSink` 先维持 Redis `SecurityPowRisk` 热路径，再把同一事件写入 PostgreSQL `security_risk_event`，按 source/reason/action/subjectHash/routeKey/clientIpHash/deviceFpHash 可查询，Redis miss 时由 `RiskScoreEngine` 按剩余 TTL 对 PostgreSQL 事件线性衰减聚合并回填热缓存。持久化失败只写 structured fallback log，不让公开读、auth、comment 或 notification stream 判定变成 500；后台 `/api/binary/admin/security/**` 改 AntiCrawler/PoW 策略时由原生 security binary endpoint 直接执行 admin 授权、MFA、fixed_ip 限流和审计边界并更新 singleton 快照，外部 `/api/admin/security/**` JSON 已移除，策略热路径只读内存快照，不同步查询 DB。PublicAOT backfill 请求会记录排队时的失效版本；写盘前若同一路由或页面在排队后又被文章突变失效，本次 backfill 会丢弃，避免 draft/scheduled/archived 时排队的旧 category/tag 文档在 published 失效后覆盖新状态。测试隔离开启时，PublicAOT cache key 与 backfill 查询必须携带同一个 `X-Fsus-Test-Session`，后台生成通过临时 `HttpContext` 读取对应测试 schema，避免把测试文章写入全局 AOT 缓存。`check:distribution-version-coherence` 会预热公开缓存后，验证 draft/scheduled/archived 隐藏、published 可见，以及 update/delete/restore/permanent-delete 在 public binary list/detail、admin 状态列表/回收站、feed、sitemap、AOT article/category/tag pages 与 search index alias 上保持一致。

## 作者工作台与私有内容边界

文章修订正文由不可变 `article_revision_content_block` 统一保存，`article_revision.content_block_id` 与该修订的完整 metadata 构成可直接重建的历史包。相同 Markdown 只保留一个 SHA-256 内容块；metadata-only、copyright-only 和 rollback 复用块，正文变化才分配块。精确无变化 update 返回当前坐标，不创建 revision/publication/outbox，因而不会进入缓存、AOT、search、integrity 或 notification stream 副作用。迁移先去重回填和检查可达性，再清空旧 inline 内容；清理任务只删除超过安全 cutoff 且执行时仍无引用的块。异常时由网关热切换暂停 admin article write/rollback，并停止孤块清理；匿名、登录、admin 读取、notification stream 和 binary read 保持在线，核验 missing/orphan 为零后恢复写入，无需重启，也不得恢复 inline/diff-chain 写法。

作者工作台表包含 `article_draft`、`article_revision`、`asset_library_item`、`site_subscription`，评论审核字段保存在 `comment`，地区合规结果保存在 `comment_region_compliance`，公开读取的地区屏蔽 lookup 保存在 `comment_blocked_region`。生产前端通过原生 `/api/binary/author/**` AEDS endpoint 调用作者工作台；授权、admin step-up、fixed_ip 限流、审计、缓存失效和业务语义都在该 binary endpoint 内直接执行，外部 `/api/author/**` JSON 入口和 internal bridge 兼容层均已移除。`article_draft` 以 `owner_admin_principal_id + draft_key` 隔离并持久化正文、摘要、封面、分类、标签、`status`、`scheduled_publish_at`、`client_revision` 与 `server_revision`；新建是 create-only，已有草稿以 `expected_server_revision` 条件更新并在同一 SQL mutation 原子递增，版本失配不更新 asset reference。相同 client revision 与规范化内容的请求视为响应丢失后的幂等重试，不再次递增；其它 stale/乱序保存返回 `draft_conflict`。DELETE 同样要求版本前置条件，避免旧标签页删除更新后的草稿。编辑器把完整草稿写入 `/api/binary/author/drafts`，浏览器 localStorage 只保存 schema、保存时间、来源文章和 client revision 等不可恢复正文的 metadata；服务端冲突后暂停自动重试并重新读取当前草稿供人工比较。刷新或跨设备恢复只接受 admin-authenticated server draft，旧的完整/残缺本地 snapshot 在读取时删除，不能覆盖当前表单。`server_revision` Expand 后到旧 slot 全部 drain 的 mixed-release 窗口必须在 gateway fence draft POST/DELETE，只保留 GET；旧代码的无 CAS upsert 不属于 N-1 write-compatible。该 fence 同时是无重启降级路径：既有草稿仍可读取，恢复写流量后客户端沿当前 `serverRevision` 继续。写作页从站点 SEO 配置计算 title/description/canonical/OG image/slug 预览，并在发布或定时发布前调用 `/api/binary/author/prepublish-check` 检查 SEO、危险 HTML、Markdown 结构、正文链接与图片 alt；错误项阻断提交，warning 需要作者在确认弹窗填写跳过理由并写入 `prepublish-warning-override` 审计。`/api/binary/author/preview` 不读写公开文章表，直接把当前表单 payload 渲染为受限 Markdown/AOT-like HTML，并由写作页以 sandboxed iframe 展示。`article_revision` 在创建、更新和回滚时记录标题、正文、摘要、封面、分类、标签、修订序号、diff 摘要、`created_by_admin_principal_id` 与时间；修订写入在文章事务内对 `article` 行执行 `FOR UPDATE` 并由 `(article_id, revision_no)` 唯一索引兜底，避免并发更新产生重复修订号。编辑器通过 `/api/binary/author/articles/{articleId}/revisions` 和单条 revision detail 在侧栏比较当前表单与历史版本，回滚后复用文章更新链路触发 AOT/search/feed/binary cache 失效并写入审计。`asset_library_item` 由 `/api/binary/author/articles/{articleId}/assets/reindex` 从正文 Markdown 图片与封面重建，仅索引 `/uploads/illustration/*`，保存 alt text、来源文章、hash 和引用计数；失去引用的资产先保留为 `referenceCount=0` 供作者审计，`/api/binary/author/assets/orphans` 只删除孤儿索引行，不删除上传文件本体。评论创建后默认 `Pending`，提交地区由 request IP 解析并写入合规表和 blocked region lookup；CN-MAINLAND 严格策略只在 submit/viewer 为 CN-MAINLAND 时生效，UNKNOWN submit 进入人工审核且公开不可见，UNKNOWN viewer 对任意 blocked region lookup 行保守隐藏。公开评论线程、回复预览和回复游标只读取 `Approved` 且未被当前 viewer region 屏蔽的记录；`/api/binary/author/comments/moderation` 提供状态队列、命中原因和地区合规字段，队列/单条/批量普通审核均要求 `comment.moderate`，单条/批量审核还必须携带 `admin-sensitive` admin step-up proof，服务层按旧状态 CAS 更新并只允许审核状态机内的转换，且不允许批准 `can_publish=false` 的发布地违法评论。匿名评论策略、nullifier 封禁和匿名凭证撤销继续分别要求 `anonymous.comment.configure`、`anonymous.nullifier.block`、`anonymous.credential.revoke`，不由 `comment.moderate` 或 `system.config` 代替。审核通过会向对应文章 notification stream 推送 `CommentAdded`，已公开评论被隐藏/拒绝/删除会推送 `CommentRemoved`；缓存清理按 article/root/user scope 执行，并可在拒绝/隐藏时联动封禁非 admin 用户。作者分析只从 `daily_read_stats` aggregate 读取总阅读数并用 `PublicAOT` miss aggregate 估算命中率；event-level route/search/404 journey 已删除，相应兼容列表为空。dashboard 只读取 admin-only `/api/binary/author/analytics`，不从私有页面采集 RUM。`/api/binary/author/**` 全部要求 admin principal，并按路由声明 `article.write`、`comment.moderate`、匿名治理、`audit.read` 或 `system.config` 细粒度权限，负责服务端草稿、预览、发布前检查、修订回滚、资产重建、作者分析、评论审核、导入导出和默认关闭的 AI 辅助。

authoring 已结束同一 runtime type 的 partial 过渡态：endpoint adapter 不再注入跨域 `AuthoringWorkflowService`，而是分别依赖 analytics reader、asset query/commands、draft lifecycle、prepublish policy、content export/import/AI assist、moderation queue/commands。五个实现模块互不调用实现类；跨模块只共享 `IAuthoringAuditWriter`、`IAuthoringPrepublishPolicy` 与 `AuthoringNormalization` 明确 port/纯函数，数据库事务仍由拥有对应 draft、asset、import 或 moderation 状态转换的模块收口。回退不恢复全能 façade：保持当前 active slot 服务并把候选 slot 切回前一构建即可；AI assist 还可通过既有 reloadable 配置关闭，endpoint、AEDS frame 和数据库 schema 均无需迁移或回滚。

评论审核链路的作者展示名投影必须与公开读取一致：队列、审核通过 `CommentAdded` 推送和回复站内通知都只读取 comment / parent comment 行内快照；public 使用 `public_handle` 后接未署名兜底，anonymous / zk anonymous 使用 `anonymous_display_name` 后接匿名兜底。审核链路不得通过 `user_id`、`reply_to_user_id` 或 `sys_user` 回退账号 username / public handle。`reply_to_user_id` 仅保存由目标 comment 的 active public account 派生的通知路由；它与回复者是否匿名无关，且事务内用 account share lock 防止注销竞态把通知投递给失效账号。

### ZK-prod 匿名评论密码学选型

[ADR-Anonymous-Credential-Blind-Issuance.md](architecture/decisions/ADR-Anonymous-Credential-Blind-Issuance.md) 定义当前 issuance：凭证领取使用 RFC 9474 randomized blind RSA，浏览器持有 finalized signature/opening/secret，issuer 只处理 blinded representative。评论证明 contract 固定为 `fsus.anonymous.comment.v5` / layout `6`。当前只完成真实 blind issuance primitive、AEDS 跨栈与浏览器 Finalize verification；current circuit-specific ceremony、proving key、verifying key 与 Wasm prover 尚未运行，因此 `production_usable=false`，blind signer 和 ZK ticket 默认关闭。credential possession 与所有稳定 credential material 只能是 current circuit 私有 witness；ticket/public transcript 仍只允许 scope-bound nullifier。任一 issuer/root/circuit/ceremony/verifier/prover gate 未就绪均 fail closed，不得拼接非当前 artifact、回退 deterministic verifier 或调用托管签名网络。

强匿名评论的 nullifier 防重放分为两段：ticket issue 只在 proof 校验后读取 `comment_anonymous_nullifier` 做 blocked/scope-limit 预检查，不预留或递增使用次数；submit 在 `CommentService` 的评论写事务内调用 nullifier consume，用单条 SQL 完成 missing row 插入、blocked/limit 判定、`use_count` 原子递增和 `first_comment_id`/`last_comment_id` 绑定。consume 拒绝时抛出匿名 nullifier rejection 并回滚评论、地区合规和 blocked-region 写入，保留并发 submit 下的单次消费语义，同时减少 issue + submit 重复 DB 往返。

当前 canonical scope 为 article-bound v1：顶层 `comment:v1:article:{articleId}:top` 每凭据周期 1 次，线程 `comment:v1:article:{articleId}:thread:{rootId}` 每凭据周期 3 次；客户端 proof scope、ticket payload、comment row 与 DB unique key 使用同一字符串。旧 `article:{id}` 行不迁移、不返还，但新 ticket fail closed；额度或 ownership 变更只能通过新 scope version 发布。

评论策略在前端保持 `backend CommentPolicySnapshotPod -> binary comment adapter -> contracts/commentPolicy.ts -> API/composable/privacy adapter` 单向依赖。contract 层维护与后端 POD 字段集合相同的 wire field catalog，静态测试同时比较后端 struct、前端 catalog 和业务层禁用规则；后端增加字段或前端 Decoder 漏映射都会使验证失败。当前 41-byte packed layout 是 client contract version 3，历史 layout 只经显式 mapper 得到 `contract_invalid`，不允许业务层维护平行的窄接口或 optional readiness escape hatch。运行时关闭沿用 reloadable ZK-Prod/anonymous-comments gate，无需重启，也不改变 binary frame number、notification stream 或 admin 路径。

blind RSA issuer 私钥是匿名凭证签发根密钥，不属于 web asset、上传资产或备份下载面。`AnonymousCredentialIssuer:BlindRsa:PrivateKeyPath` 只接受本机 PKCS#8 DER，必须位于非 `wwwroot`、非 `uploads`、非 `backups` 路径且 Unix mode 不宽于 `0600`。进程启动时一次装载并清零读取 buffer；运行时通过 reload-aware `BlindRsa:Enabled` gate 热关闭 metadata 与私钥操作。无需重启的回退是设置该值为 `false`；热开启和密钥轮换需要新进程加载并先完成 SPKI/root hash 协调。

预览输出带 `data-preview-only=true` 和 `data-markdown-renderer=server-preview`，只走 admin JSON API，不写 PublicAOT cache，不进入 feed/search/sitemap。订阅表只保存 email hash 与 channel，避免把站点更新订阅扩展成社交关系链。

## PWA 与匿名性能遥测

`public/manifest.webmanifest` 暴露安装能力；`public/sw.js` 只缓存公开 shell 路由和搜索索引，不缓存 `/user`、`/admin`、`/login`。`/api/binary/**` 包括新的 public `.aeds` artifact 只走 service worker 网络透传，浏览器缓存策略完全由服务端 `Cache-Control`、`ETag`、`no-store` 负响应决定，不写入 shell/search cache。离线 shell 响应附带 `X-Fsus-Offline-Stale: 1` 和 `Cache-Control: no-store`，让 UI 和代理都能识别 stale 内容。`check:pwa-offline-smoke` 必须跑在 production preview 或真实生产 URL 上，验证最近公开文章可离线读取且私有 console 路由离线不命中缓存。

前端 `telemetryService` 采集公开页面 Core Web Vitals、hydration time、Wasm decode timing、Markdown render timing 与 navigation timing，只记录 `pageType`、`aotSource` 和数值指标；私有页面不发送 RUM 事件，敏感输入不进入 payload。匿名 `POST /api/binary/telemetry/rum` 使用 batched AEDS `RumMetricBatchRequest` frame、8192 bytes 帧上限、每批 16 条上限和低基数字段白名单，由 `RumTelemetryService` 净化后写入独立 `frontend_rum_metric` 表；旧 `/api/telemetry/rum` JSON endpoint 已移除。作者 dashboard 从该表聚合 P75/平均值、页面类型和 AOT 来源分布；RUM 不再占用 `sys_audit_log`。

`sys_audit_log` 是结构化安全审计表，字段包括 `source/type/action/outcome/severity/actor/target`、trace/path/method、隐私 hash、`context_json` 和 tamper evidence。普通 Serilog 事件仍通过 bounded channel 异步落库；请求 audit/log context 的普通账号维度写作 `AccountId`，审计主体维度写作 `AuditActorId`，不得再输出泛化的 `UserId` 字段。mapper 只从显式 `AuditActorType` + `AuditActorId` 生成 actor，不把普通日志 context 中的裸 `UserId`/`AccountId`/`AdminPrincipalId` 提升为审计主体，并会过滤这些身份平面字段。`AuditLogEventMapper` 的 `SourceContext` 分类先走预编译 `FrozenDictionary` 精确命中，再走固定规则表和 256 项 bounded cache；不得恢复每条审计事件 20+ 个 switch/Contains 串行扫描。admin/security/audit 高价值事件由 `IAuditEventService` 直接同步写入，失败时落 `FSUSBLOG_DATA_ROOT/audit-fallback/critical-audit-*.jsonl`。写入侧维护进程内 `chain_id -> record_hash` tail cache；只有冷启动或 cache miss 才用 `idx_audit_chain_tail (chain_id, id DESC) WHERE record_hash IS NOT NULL` 查询前驱，批量 insert 成功后才更新 tail cache，保持 `prev_hash` 链接语义不回退。审计查询响应默认 `pii-redacted`，不会把 `IpHash`、`UserAgentHash`、`SessionIdHash` 或 `DeviceFingerprintHash` 精确值返回给普通 `audit.read` admin；只有带 `audit.investigate` 的 admin 显式请求 `piiMode=investigation` 才能读取完整 hash，且该读取本身写高价值审计。`/api/ops/health/ready-detail` 的 `runtime.auditLog` 暴露 queued/dropped/writeFailure/fallback 计数；后台 `LogCleanupService` 保留 RUM 14 天、访问日志 30 天，并按 `AuditRetentionCatalog` 的 action 级有限上限清理全部审计，high-value/Critical 只改变写入可靠性和调查优先级，不再意味着永久保留。

`AuditDetachedCheckpointHostedService` 在独立 ECDSA P-256 信任域中周期重算 audit record snapshots、顺序敏感 Merkle root、record range/head 与 checkpoint predecessor，并以 `FileMode.CreateNew + fsync + atomic move` 发布到 `FSUSBLOG_DATA_ROOT/<Audit:DetachedCheckpoint:DirectoryName>`。每次追加前后都从数据库重验现有 checkpoint；修改、删除、重排、全 HMAC 重签、checkpoint 缺口/回滚、签名或 key rotation 异常均 fail closed。worker 通过 reload-aware `Audit:DetachedCheckpoint:Enabled` 热停用，不影响审计写入或请求面；生产启动要求独立 DER key paths、相对 data-root 目录和有界周期/批量配置。本地目录只提供可导出的 detached evidence，不是 WORM；抵抗同主机特权删除仍需把 package、public registry 与 expected head 交给独立 custody，本仓库不接入外部 TSA/S3/公共链。

`AuditRetentionPayloadProtector` 在审计签名/持久化前用 retention-epoch AES-256-GCM DEK 加密 actor/target/trace/path/network/device/reason/event/context 敏感字段，行内只保留 ciphertext envelope、低基数分类和 epoch-keyed pseudonym。cleanup 严格按 action policy 执行“数据库快照与 Merkle checkpoint → #1111 独立签名 anchor → 销毁批次 DEK → 写无身份 destruction evidence → active-release fenced delete”；任一步失败都不宣称清理成功。local fallback 使用同一 envelope 和 anchor/destroy/purge 顺序。数据库/本地 fallback 由应用直接控制；backup/WAL/replica 只接受有期限的 operator attestation，站点备份不打包 `audit-retention/epoch-keys`，不得把平台外部删除伪装为应用完成。

生产 readiness 内部保持短 TTL `ProductionReadinessSnapshotCache`，单次刷新中 PostgreSQL、Redis ping、RiskControl、runtime snapshot 顶层任务通过 `Task.WhenAll` 并行等待；RiskControl 只读取上层启动的 Redis consume-once readiness 结果，不在自身路径里再次发起独立 Redis 检查。配置健康由 `IConfigurationHealthSnapshot` 在启动和后台 30s 刷新中运行 `ProductionStartupValidator.ValidateCore`，`CheckConfiguration` 只读取快照并继续对公开 readiness 做固定错误类别脱敏。runtime 区块内 PublicHotRead、audit log 和 runtime pressure snapshot 独立 fanout。观测指标包括 `fsus.readiness.check.elapsed` 以及 postgres/redis/risk_control/runtime 分项 elapsed histogram，用于定位慢探针来源。

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
Host OpenResty (唯一公网入口)
├── active blue  -> 127.0.0.1:8081 -> fsus-app-blue / project fsusblog-blue
└── active green -> 127.0.0.1:8082 -> fsus-app-green / project fsusblog-green

两槽位受控共享: external PostgreSQL、external Redis、uploads、DataProtection、只读 ZK material、append-only release assets、按 releaseId 分区的 release-derived
两槽位严格隔离: container/project/release identity、instance-scoped tmp/runtime snapshots、Serilog logs
```

生产 Compose 只有一份参数化定义，槽位脚本固定解析 blue/green 的容器名、Compose project、回环端口与派生卷，不能通过复制两份 Compose 漂移。`slot-preflight.sh` 在任何 pull/up 前核对 Docker daemon、内存、Docker 磁盘与 image reserve、端口和持久 active state；`slot-start.sh` 只操作候选 project，直接探测该槽位的 live/ready 后再用 temp + file fsync + rename + directory fsync 更新 `/var/lib/fsusblog/deployment/slots.json`。候选失败只清理候选 project。`slot-stop.sh` 从持久状态拒绝停止 active slot；`slot-status.sh` 在主机重启后把 state 与容器 label/health/loopback binding 交叉核对，不做隐式 active 推断。零停机 overlap 的认证下限固定为 4 CPU / 6144 MiB memory / 10240 MiB free disk；2C/2G 只属于单槽 profile。较低的 slot preflight 阈值只是 pull/start guard，最终 dual-slot、reload、drain、notification 与 P95/P99 影响由持续 resource evidence 判定。

生产操作者唯一入口是 `tools/deployment/release-rollout.sh`。`slot-start.sh`、`gateway-switch.sh`、`deploy-production.sh`、在线 migration、asset materialize/GC 和 fence/restart helper 都是其受锁内部步骤；`deploy-production.sh` 拒绝没有内部 slot 标记的直接调用，`slot-start.sh` 仅接受 rollout 继承标记或空 durable state 的显式一次性 bootstrap。rollout 以 mode-0600 durable state 固定 15 个阶段、每次 attempt 和 stage output hash；已失败阶段在补偿完成前不能重试，完成阶段在 `--resume` 时不重复执行，安全关键门禁没有 skip 参数。Challenge-kind cutover 的不可逆边界位于 activation 前的 `source-drain`：provisional gateway switch 后先关闭 source issuance 并等完 in-flight，再取得 endpoint 所需的精确 target authorization fence；随后持久化 destructive marker，执行固定 operation ID cutover、receipt verifier 与跨 backend/frontend/static binding。只有这些步骤全部完成，后续 `active-fence` 才撤销 source ownership、复验 target 并持久化 `activationCommitted`。marker 前失败可回滚；marker 后只能同 operation 恢复 target activation，禁止旧 source 回滚。最终 evidence 以 auxiliary hash封存 receipt、acceptance 与 binding gate。

OpenResty 主配置只 include `/etc/openresty/fsusblog/active-upstream.conf`；`gateway-control.mjs` 只能为已配置 blue/green 端口生成一行 loopback server，拒绝 hostname、任意端口和多 upstream。`gateway-switch.sh` 与 slot start/stop 共用宿主机 `flock`，把 target identity/loopback readiness、source 公网 identity、staged full-config test、fsync + atomic rename、installed config test、graceful reload、target 公网/loopback identity 和 durable state commit 串成一次 `stable → switching → stable` 事务。reload 或后置探测失败时先恢复并 reload source，无法证明恢复则保留 `rollback_required`。`gateway-rollback.sh` 只消费 previous release/digest；`gateway-recover.sh` 在重启后对 pending state、受控 include、source/target runtime 与公网 headers 做确定性对账，不能从容器年龄或 mutable tag 猜测。

应用发布状态由单例 `DeploymentRuntimeState` 管理，生产槽位固定从 `Starting → Candidate → Ready → Active → Draining → Stopped` 前进，启动或门禁错误进入 `Failed`；容器环境中的 immutable release ID、slot 和正整数 deployment generation 是激活/排空 CAS 的唯一身份。deployment generation 与 gateway `switchGeneration` 分离：宿主锁下先在 durable slot state 单调预留，每次真实容器启动都消耗新值，失败或中断不回退，避免旧控制请求命中新进程。Candidate 可以完成启动门禁、预热和 loopback smoke，但 `canReceiveTraffic=false`、不领取全局后台任务且不接受 notification stream；只有启动任务、PostgreSQL、Redis、资源、运行时和 release identity 全部健康才进入 Ready。rollout 调用 `gateway-switch.sh --defer-source-drain`，先证明 source 是唯一 Active、target 是精确 Ready Candidate，再在 OpenResty reload 前激活 target 并提交 durable traffic state；随后单独执行 active fence CAS、持续公网流量/旧资源/notification 对账，全部通过后才对 source 发送 1012 restart 和 drain。这样 active CAS 或 post-switch probe 失败时旧槽仍可由新单调 generation 重启并自动切回，而切流前已进入的请求不会被网关步骤主动终止。激活后的 reload/探测失败会恢复 source 流量并把 target 置为 Draining；若无法同时证明 source 恢复和 target 中和，持久状态保持 `rollback_required`，不能伪报 stable。仅 Development 且显式 `AllowSyntheticLocalFence=true` 的 local-unversioned/local 进程允许 synthetic fence；其事务 guard 仍要求业务事务，但不查询或写入生产 release witness/commit ledger。Production 启动校验继续禁止该开关。

Active-release fence 是 global singleton side effect 的第二身份边界：PostgreSQL `sys_deployment_fence` 保存 durable witness，Redis 保存可从 SQL 重建的低延迟镜像。`DurableActiveReleaseFenceStore` 并行读取两侧；Redis 空库从 SQL 恢复、升级期 SQL 空行从 Redis 引导、较高 generation 单调修复较旧侧，同 generation 不同 identity/digest 则 fail closed。Acquire/revoke 先在 SQL transaction advisory lock + `FOR UPDATE` 下完成 CAS，再更新 Redis；advisory lock 同时覆盖 singleton row 尚不存在的首次并发 acquire。SQL 已提交而 Redis 暂时失败时请求不会伪报成功，幂等重试负责恢复镜像。production 在 schema compatibility 后执行强制 durable-witness startup probe；不可达则拒绝启动。运行期第一次 refresh 失败立即撤销 runtime 可用性，绝不以旧 snapshot 授权；动态 `RefreshIntervalMs` / `StaleThresholdSeconds` 窗口耗尽后请求 graceful shutdown，由编排器重启并重新 probe。`ActiveReleaseFencedBackgroundWorkerLease` 只向当前 fence owner 发放带 release/slot/generation/digest 的 execution ticket；`IActiveReleaseCommitGuard` 在 scheduled transition、outbox claim/effect/state、crawler snapshot、每个 retention delete chunk、PoW reset、projection checkpoint、PublicAOT atomic publish 和 upload irreversible delete 前重新验证 ticket。Fence 丢失会在最后可取消点阻断旧 generation，不能靠长 lease 或“已开始执行”继续提交。动态设置 `ActiveReleaseFence:MutationEnabled=false` 只暂停 acquire/revoke，不关闭读取、readiness 与 commit guard，可作为无需重启的安全回退。该边界与业务 transaction/idempotency 同时成立，最终仍由 normal worker reconciliation 证明 exactly-once 与 stale-generation count=0。

`DeploymentRequestTrackingMiddleware` 仅用进程内原子计数跟踪普通 HTTP，排除 health/ops 与 notification stream；异常、取消和正常完成均在 `finally` 语义下释放。notification stream 使用连接管理器独立计数。进入 Draining 后公共 readiness 立即为 503，新普通请求和新 notification handshake 返回可重试拒绝，已进入请求/连接继续计入 blockers，全局 background lease 不再发放。`DeploymentDrainCoordinator` 先以 `Task.WhenAll` 并行调用 `ReleaseDrainParticipantRegistry`，再汇总 HTTP、notification、background claim、article-view、hot-stats、audit/admin-audit、visit-log、RUM、security/challenge audit、public-hot、ArticleDetail AEDS、PublicAOT backfill 和 upload-cleanup；participant 的 pending、timeout 或 error 都映射为 blocker，不能被观察-only 快照吞掉。主动 drain、`ApplicationStopping` 和 `StopAsync` 共享同一状态机与 drain task，Docker grace period 必须大于应用 deadline，不另建冲突的停止路径。

正常发布只消费 8-kind、`mode=normal` 的 graceful worker reconciliation。Forced-source/SIGKILL 资格演练属于隔离 Test topology：九类 ledger 完成并 teardown 后，再用相同 target release/digest、不同 rollout ID 创建 fresh normal control；qualification v2 hash-bind 两条独立 state。这样 destructive failure injection 不会破坏正常 source-drain 证据，也不能被拿来伪装正常 exactly-once 结果。最终 rollout evidence seal 15 stages、recoveries 与恰好六类 artifacts，并由 allowlisted bundle index 做 hash/readback。

强流量与旧资产 evidence 各有独立 HMAC trust boundary。operator plan 只保存
`evidenceInputs.trafficBindingKey` / `assetBrowserBindingKey` 的私有文件路径；resolver
验证 regular non-symlink、0400/0600 和 32..4096-byte 边界，再把 key 复制到每个隔离
runtime secrets 目录。traffic HMAC 绑定 session/AEDS/release-role/in-flight observation
chain；asset HMAC 绑定真实 Chromium、N-1 manifest、Service Worker/CacheStorage、applied
GC 与双向 backend compatibility。final evidence 只保存 keyId/signature，不保存 key。

在线迁移资格是生产 rollout 之外的隔离 Test composition，而不是第二个生产入口：

```text
private rehearsal plan
  -> materialize exact 10-case migration scenario
  -> repository rehearsal-schema-qualification-probe (Test + rehearsal guard)
  -> source/target loopback application bridge + readiness
  -> immutable migration qualification evidence
  -> teardown qualification topology
  -> fresh normal rollout with distinct rollout identity
```

应用的 `schema-bridge/write` 与 `schema-qualification/readiness` 只在 environment 精确
为 `Test` 且 `SchemaMigration:QualificationEnabled=true` 时注册；注册后仍经过 admin
`system.config` 与 `fixed_ip`。因此生产 API surface 不包含这些 routes。Expand/
Backfill 失败时保留 N/N-1 bridge 或暂停 durable checkpoint，无需重启 active source；
Contract marker 一旦声明 `rollbackCompatible=false`，编排器必须阻断旧 release 回切。

上述编排是生产部署参考，不改变性能证据口径。项目内部 benchmark、`backend-qps` 与 issue 验收默认使用 Kestrel-only single-process baseline；若单独评估 nginx/CDN/reverse proxy，应在证据中写入 `optional_deployment_layer`，并标记 `counted_as_project_baseline=false`。

健康检查入口：

- `GET /health/live`：存活探针（进程存活即返回 200，`application/json`）
- `GET /health/ready`：公网最小就绪探针（只返回 `status` / `checkedAt`，HTTP 200/503 表示 ready/not ready）
- `GET /api/ops/health/ready-detail`：受保护的详细就绪报告（admin principal + `audit.read`）
- `GET /api/ops/deployment/status`：受保护且仅 loopback 可调用的发布状态/排空快照（admin principal + `system.config`）
- `POST /api/ops/deployment/activate|drain`：带 release/slot/generation CAS 的可信宿主机控制面（admin principal + `system.config`）
- `GET/POST /api/ops/deployment/fence/status|acquire|revoke`：SQL durable witness + Redis mirror active-release fence 的查询与 CAS（admin principal + `system.config`）
- `POST /api/ops/deployment/fence/challenge-kind-cutover`：仅在 release/slot/generation 精确匹配的 active fence 下执行完整数值集合 3/10/13 的 challenge-kind state cutover，前后复验 fence；operator target map 还必须命中内置的不可逆权威 fingerprint，随后才写入幂等 receipt。intent 与 state 可在 intent-only crash 后幂等修复，envelope 只持久化计数与 ID 集合摘要，不内置旧 wire alias
- `POST /api/ops/deployment/fence/perception-character-v3-cutover`：target fence acquire 只授权切换，不直接开放 V3。one-shot service 先验证 generated contract/AEDS target、active pool manifest identity、热 RiskControl policy 与 release fence，再关闭 issuance；同一 operation 的 durable mutation 幂等撤销 V3 challenge row、state/active/device namespaces、包含 V3 的未完成 envelope 与非目标 pool generation，随后再次验证 fence。只有 exact receipt 持久化且 activation smoke 通过才写入按 release/slot/generation 隔离的 marker。每次 V3 issue/verify 都重新核对 receipt、pool、policy、schema 与 fence；生产异常 slot、cache failure、混合 instance 或 fence loss均 fail closed，仅 Development/Testing 明确旁路。dry-run 只读取并计算计划，不关闭或开放 issuance。
- `GET/POST /api/ops/deployment/notification-stream/restart/**`：有序 1012 restart、状态和显式启用的事件对账 drill（admin principal + `system.config`）

Health/ops 协议独立于 PublicAOT 与 AEDS payload。`ProductionHealthEndpoints` 的公网 readiness 只返回最小 JSON，并通过 `ProductionReadinessSnapshotCache` 使用 5 秒 TTL snapshot 与单飞刷新，避免编排器高频探测每次都新建 PostgreSQL 连接、Redis ping 或执行 RiskControl consume-once；每次读取会再应用当前 deployment state，所以 Draining 不受旧 5 秒 ready snapshot 影响。详细运维快照只在受保护端点返回，`/api/ops/health/ready-detail?forceRefresh=true` 可触发深度刷新。`ReleaseIdentityProvider` 在启动时一次性读取部署入口注入的 release/slot/commit/image ref/digest，启动日志、所有响应的非敏感 `X-Fsus-Release-Id` / `X-Fsus-Release-Slot` headers 与受保护 readiness 使用同一快照；生产缺失或 digest/ref 不一致时启动和 readiness 均 fail closed，本地未配置时使用 `local-unversioned` 诊断值。网关只用这两个 header 对账实际 upstream，不把它们当认证信息。readiness 的启动状态来自 `StartupRuntimeState.CreateSnapshot()`，定时发布后台状态来自 `ScheduledPublishRuntimeState.CreateSnapshot()`，RiskControl 状态来自 active/LKG policy、perception-sealed@v2 AEAD key、Redis consume-once、challenge provider registry 和 perception performance budget 检查。perception-sealed@v2 token 的 AEAD AAD 绑定 envelope context 与 ciphertext hash，密文 payload 另带 payload binding hash；action/route envelope swap、payload-only context drift 或旧 binding 缺失都必须 fail closed 为 tamper/context mismatch。因此生产启动校验、cache/bootstrap rollback、定时发布 backlog、RiskControl enforcement 与 PublicAOT 壳层协议可以分别演进。

单作者后台运维面板位于 `/user/manage/ops`、`/user/manage/cache`、`/user/manage/integrity`，后端统一由 `AdminOperationsService` 聚合。`/api/binary/author/ops/health` 合并 readiness、审计 runtime、Crawler CIDR、PublicHotRead、Search manifest、备份 artifact、结构化最近错误和 `article_mutation_outbox` backlog；最近错误只在查询物化后做摘要清理和分组，避免 ORM projection 把 SQL 表达式泄露到 UI。`/api/binary/author/cache/diagnostics` 从 `PublicHotReadStore`、`PublicAotInvalidationTracker`、`CacheInvalidationRuntimeState`、search manifest、distribution 轻量计数缓存、`ArticleCacheOwnershipCatalog`、UnifiedCache registry storage snapshot 和 `FsusObservability` cache hit/miss runtime counters 构建状态；distribution 诊断只按公开文章、公开分类、公开标签与 feed limit 计算 sitemap/feed 数量，使用 45 秒 TTL 与 `fsus.distribution.diagnostics.*` 指标，不生成或解析实际 XML/JSON feed 正文，公开 `/feed/*` 与 `/sitemap.xml` endpoint 构建路径保持不变。`/api/binary/author/integrity` 做只读巡检，safe fix 只处理无效 `article_tag` 和注销用户 session 撤销，必须通过 diff、确认短语、admin step-up proof 和审计事件闭环。

备份/恢复闭环由 `tools/operations/backup-site.sh`、`tools/operations/restore-site.sh` 和 `tools/operations/backup-restore-drill.sh` 承载。站点包包含 PostgreSQL dump、uploads、DataProtection keyring、脱敏配置、AOT cache 和 search artifacts；Redis 仍视为缓存/控制面依赖，restore drill 使用空 Redis 数据目录即可验证恢复后的运行时。生产 `serve` 的启动 lifecycle 只运行只读 schema compatibility，不获取 migration advisory lock，也不执行 descriptor。`release-rollout.sh` 的第 4 阶段显式执行 online Expand；Backfill 从 durable token 独立恢复，Contract 在 15 阶段之外并要求单独 destructive evidence/confirmation。Expand/Backfill 失败时保留 N/N-1 bridge 或暂停 token 即可，无需重启；Contract 执行后不能靠 image rollback 重建被移除的数据，只能隔离写路径并恢复经验证的迁移前站点包或数据库 dump。

`DropColumnStep` / `DropTableStep` 还必须携带 descriptor-matched rollback-window proof；冷启动 runner 与 online executor 都在事务前校验真实 source commit、引入时间、至少 30 天窗口和本地 proof anchor。issue #1127 报告的 44 个步骤在 read-event retirement 合入后已变为 46 个，动态库存与证明规则见 [destructive schema rollback-window proof](schema-migrations/destructive-rollback-window.md)。仅数据库完全无表时允许 fresh bootstrap；已有任意表时窗口未结束即 fail closed。

Release identity 的规范格式权威位于 `tools/release/release-id.mjs` 与共享 JSON 契约；生成的 C#/TypeScript 消费者必须通过 `--check` 保持一致。`ReleaseIdentityProvider` 要求真实 UTC 秒的 `YYYYMMDDHHmmss-sha12` 匹配完整 commit 前缀；若部署入口已注入 `createdAtUtc`，还必须通过同秒交叉校验。旧部署入口未注入该字段时从 canonical ReleaseId 派生只读 UTC 秒，以在后续 manifest/deployment wiring 合入前保持生产兼容；`local-unversioned` 只允许未配置的本地非发布诊断路径。该应用版本域不得替代 AEDS、manifest、rollout、migration 或密码学 schema version。

## Runtime capability 文件边界

多节点 capability 仍服从[单体分布式架构边界](architecture/monolithic-distributed-boundary.md)：同构节点运行同一主应用发布物，`single`、`static-role` 与 `adaptive` 只改变运行时职责，不能新增固定业务 sidecar 或让领域模块直接感知节点与 transport。

多节点有状态职责统一经过 `Infrastructure/Distributed/StateControl`。`ILeaseManager` 以 `responsibility + resource` 定义 single-writer partition；lease 具有有限 TTL、owner-bound renew/release 和单调递增 fencing token。关键写入必须同时校验 lease identity 与 fencing token，不能只凭节点 heartbeat 或本地 cancellation 判断写者仍有效。`single` 使用进程内实现保持单机热路径；`static-role` / `adaptive` 使用 runtime-scoped Redis Lua/transaction 原语，lease key 过期后其他节点取得更大的 token，旧节点的 checkpoint、complete、failure write 均 fail closed。

可重试后台任务使用 `taskType + objectId + operationId` 幂等键和 durable task record。默认语义是 at-least-once scheduling + effectively-once side effect：同一成功 record 返回 completed replay，不再次执行副作用；running record 只允许更大 fencing token 在旧 lease 失效后接管。长任务以 compare-version 保存 checkpoint，接管者从最后成功版本恢复。失败在 `RetryScheduled -> DeadLettered | CompensationRequired` 状态机中推进；retry delay 和 max attempts 来自任务注册的固定 policy，不能由接管节点静默放宽。cluster failure detector 是第一个接入的有状态职责，只有 `cluster:failure-detector` 当前 lease owner 执行状态转换。

模块间调用统一经过 `Infrastructure/Distributed/Modules` 的稳定 contract。`single` 直接调用 typed local operation，不查询 membership、不序列化；`static-role` / `adaptive` 先按 capability 与 active responsibility 选择 local 或 remote path，后台和长任务显式选择 queue，领域通知显式选择 event。remote path 传播 W3C trace context，并强制 timeout、幂等键限定的 retry、per-contract circuit breaker 与有界并发 backpressure。模块数据 ownership、版本兼容规则、失败语义和无需重启的 drain/恢复路径见 [Module invocation and ownership boundary](architecture/module-invocation-boundary.md)。

Redis 暂时不可用时，多节点 acquire/mutation 失败并停止新的有状态写入；现有匿名、登录、admin、notification stream 和 binary 请求路径不经过该协调器，继续按各自原契约工作。无需重启的局部回退是把受影响节点标记 `Draining` 或移除对应 active responsibility，让其他健康节点在 TTL 后接管；不得在多节点模式回退进程内 store。若要恢复 `single`，必须通过下一进程代际切换运行模式，不能热切换存储真源。

Search index、article service、PublicHotRead 与 application composition 仍按 orchestration、policy/state、I/O/persistence、codec/routing 和 metrics 组织 capability files。authoring 改由 analytics、asset library、draft lifecycle、content transfer 与 moderation workflow 五个 scoped 模块拥有独立构造依赖和失败/事务边界；endpoint 只看窄 port，任何模块不得通过另一个实现类或 `IServiceProvider` 回调原聚合。受治理 capability file 必须少于 1,500 行，`backend-build-governance` 会执行机器检查；最终 endpoint data source 和 DI descriptor 的行为测试负责证明 authoring 58 条 method/path、admin permission、frame lookup 与 scoped lifetime 未漂移。历史 capability slicing 背景见 [Runtime capability slices and source-file budget](architecture/issue-1119-runtime-capability-slices.md)。

Schema migration 不再使用 runtime service partial。`SchemaMigrationRegistry` 只暴露由 `SchemaMigrationManifest` 验证后的执行计划；release-range catalog 声明本区间 descriptor，domain-oriented definition 类型承载不可删除的历史 SQL/step。manifest 在数据库访问前校验 ID 唯一、phase + migration ID 单调顺序、catalog range、phase-tail dependency 和显式 gap，runner 不再自行重排数组。空库与 20260517 代表性历史 fixture 都必须在重复执行前后保持各自的 columns/indexes/constraints snapshot、history 和数据转换结果不变。目录、版本边界和新增迁移规则见 [Database Migration Runbook](database-migration.md#versioned-legacy-catalog)。

## Plugin foundation boundary

v1.3.0 plugin foundation begins as an inert package and control-plane boundary. A hostile
`.fspkg` is bounded and fully verified before persistence; it cannot extract files
or execute code. PostgreSQL `plugin_registry` stores the verified package bytes,
manifest, digest and lifecycle CAS coordinate, so cluster nodes read one authority
instead of node-local install state. The next boundary converts manifest requests
into a closed capability plan; grants default to empty, sensitive grants require
administrator confirmation, and every Host API operation rechecks its grant. Level
1 script profiles disable CLR/reflection/service-provider/raw I/O access and attach
timeout, memory, instruction, call-depth, output and log budgets. Raw SQL and native
C# loading remain unavailable. Exact package and state transitions are documented
in [Plugin package and Registry foundation](architecture/plugin-foundation.md);
permission, isolation and no-restart quarantine semantics are documented in
[Plugin permission and sandbox boundary](security/plugin-sandbox.md). The controlled
execution boundary is the cached [Plugin Hook Dispatcher](architecture/plugin-hook-dispatcher.md):
stable Hook names map to a required capability, all runtime calls recheck grants and
isolation, and distributed scopes reuse the shared fenced lease/idempotency state
instead of inventing node-local leader semantics.

## 生产启动保护

服务器通过 HostedService 在启动后执行以下生产校验，失败时进入可观测降级状态而不是直接终止进程：

账号 subject 物理投影的永久 invariant 在 schema migration 完成后、AOT cache、search 与普通 cache 初始化前执行。null、空白或非 64 位小写十六进制值会让 candidate 保持 not-ready；不得从 account id、public handle 或 Passkey handle 在请求期重建 subject。修复或继续 backfill 后重新启动 candidate 即可，健康节点无需清空数据或恢复已退役 reset surface。迁移顺序与查询由 [Account Subject Physical Projection Cutover](database-migration.md#account-subject-physical-projection-cutover) 定义，安全消费者由 [账号 subject 物理投影](security.md#账号-subject-物理投影) 定义。

- JWT 密钥不得为默认占位值
- PoW、sealed perception、Recovery Key、匿名凭证、VisitLog 与 moderation 的密钥必须使用独立高熵值，且不得等于 `Jwt:SecretKey`；VisitLog root 由 KMS/secret manager 注入并携带正整数 epoch
- Redis 密码不得为空
- `SITE_BASEURL` 必须为 HTTPS
- CORS 配置的 Origins 不得包含 HTTP 来源

`ProductionStartupValidator` 汇总配置缺陷时只产生稳定、低基数的错误类别；`StartupRuntimeState`、公开 readiness 与受保护 health 均不得转发底层 exception message 或运行时类型。回退不需要放宽健康探针或重新编译：恢复上一份有效配置或修正对应环境变量，再按现有编排滚动重启。

运行期日志的隐私边界与生产启动密钥边界一致：原始客户端 IP 只能参与本地判定，不能进入日志、指标或 fallback structured event。read analytics 不创建 IP pseudonym；PoW/crawler security-log 仍只使用 UTC 日窗口、KMS epoch 的 128-bit 假名，RiskControl 使用它自己的独立 pseudonym key。任一路径缺失配置时不得回退到 JWT、localhost、raw remote IP 或请求头。完整访问、retention、rotation 和 rollback 见 [visit-log IP pseudonyms](security/visit-log-ip-pseudonyms.md)。

降级状态会写入运行时状态任务 `productionStartupValidation`。回退路径是修复环境变量或依赖服务后重启应用；密钥类错误只能恢复对应安全域的上一个密钥，不能临时复用 JWT 密钥，也无需修改路由、中间件或健康探针代码。

详细部署流程见 [production.md](production.md)。
## 评论修订与作者管理

评论修订链由 `comment.current_version` 指向当前内容，`comment_revision(comment_id, version)` 保存 append-only 正文快照、操作与摘要。创建、编辑、删除的主表更新、revision 与 mutation outbox 位于同一数据库事务；编辑以 expectedVersion CAS 防止覆盖。public 作者管理通过 account authorization，强匿名作者管理通过不可逆 capability commitment，二者不共享身份映射。公开投影只编码当前正文与 `isEdited` 保留位；admin authoring 边界才读取完整 revision 序列。客户端 capability vault 为 memory-only，刷新即丢失，不进入 storage registry、service worker cache 或 notification stream。

评论治理写模型由三条 append-only 事实链组成：`comment_report` 保存去重后的风险队列输入，`comment_author_appeal` 绑定被申诉的 moderation event 并保存独立复核结果，`comment_moderation_event` 保存所有状态/删除/恢复/申诉事件。`comment.moderation_status` 仅是热路径当前投影；admin timeline 从 event 顺序重建并与投影比较。举报入口不写投影，申诉批准只通过既有 CAS/trigger 路径恢复可见性。

运行时可通过收紧 `Comments:AuthorEditWindowMinutes` 在不重启的情况下停止新的编辑。该降级不回滚 additive schema，也不影响匿名请求、登录请求、admin 修订读取、notification stream 或 binary 公共读取；旧客户端将 POD 保留位视为零/忽略。

## PerceptionCharacterV3 provider

`SecurityChallengeOrchestrator` 在生成 envelopeId 后把它传给 V3 provider。V3 provider 只依赖 `IPerceptionCharacterV3ArtifactPool`，不再依赖 request-time renderer、render semaphore 或 codec queue。active identity 仍由权威 subject/server-device/IP/action/route 组成，不含每次刷新的 envelopeId。pool entry 在响应前由 Redis Lua `SET NX` 永久 burn；随后从 immutable pack offset 读取并认证 record，exact transported bytes 的 `artifactHash` 再进入 answer HMAC、AES-256-GCM opaque state 与 Redis authoritative row。Redis reply loss、响应取消、state 创建失败或编码失败都不归还 entry；Redis 创建失败时不返回媒体。visual/audio replacement 以旧 envelope + opaque token + 全绑定在同一 Lua transition 原子 revoke 旧 challenge，再租用全新 entry 并生成新的 envelope/challenge/token/attempt identity，replacement 失败也不复活旧 identity。

`IPerceptionCharacterV3ResourcePlanner` 是唯一 V3 allocation/disposition owner。immutable input 包含 active generation 的 visual/audio/total ready inventory、当前 watermark、action coarse class、risk/escalation、认证与 Passkey assurance 以及 Redis/pool health；输出只允许 `allocate-v3`、`use-credential-step-up`、`require-cheaper-proof`、`queue-for-moderation`、`throttle`、`block` 或 `unavailable`。public read 默认不消费 V3；low watermark 把非必要 comment/write 转为审核或 cheaper proof；critical watermark 仅保留给配置的 recovery/admin security action；empty、revoked、corrupted 与 Redis unavailable 使用 action disposition table，绝不产生 `allow`。provider 只执行 planner 输出，不维护第二套 fallback。

pool manifest v1 以向旧 runtime 可忽略的 additive 字段为每项加入已由启动完整解密复验的 exact `artifactBytes`。同一 Redis Lua 在线性化点检查 generation revoke、operation retry fence、visual/audio/total inventory、minute + rolling-hour lease/egress budget，以及 IP prefix/server-device/subject/action quotas；只有全部通过才同时 burn entry、递减 ready、增加 leased、记录 exact bytes 和 operation identity。回包丢失后 operation fence 阻止 retry 再租一项或重复计费。inventory 与指标只使用 generation state、representation、watermark、coarse action/disposition 和 exact byte count，不包含 raw IP、challenge ID、token、answer 或 media。

同一 planner 只为 idle/offline replenishment 生成有界 entries/bytes 计划；public request、CPU/memory/I/O/latency pressure、unhealthy pool 或达到 high watermark 时输出 stop。生成失败不得切换 active generation。`Security:PerceptionCharacterV3:Resources:AllocationsEnabled=false` 由 reload-capable configuration 在下一次 plan 生效，无需重启；它只停止新 allocation 并强制 action disposition，不复活 retired generation，也不改变既有 verify/cancel drain。

Orchestrator 先按 server-owned cost class 建立完整计划，只签发首项；envelope Redis state 保存 planned challenge IDs、ordered kinds、binding、policy、预选 visual/audio representation 与 version。验证当前 member 前先 CAS `issued -> verifying`，只有 winner 可消费 provider proof；成功后再 CAS 把下一项置为 `issuing`，只有该 winner 可调用 next provider，随后以 challenge ID/version 将其置为 `issued`。因此 `PoW -> PoSpace -> V3` 中的 V3 pool lease 在前两项完成前不可达，延迟签发也不会从 verify 请求重新选择 representation；并发/回复丢失最多留下 fail-closed transition，不会重复消费 proof、再次调用 provider 或租用第二项。无需重启的降级由热 RiskControl policy 停止新 plan；既有 planned chain 仍按原 policy/binding 到期或撤销。

离线 pool builder 是 reference raster/audio/codec 唯一可执行 owner：它按 machine contract 生成完整 PNG/Ogg，校验 hard limits，以专用外部 key 和 fresh nonce 加密每条 record，并写一个 compact offset/length manifest。runtime startup 对 manifest、pack、每条 AEAD record、contract/artifact digest、duplicate ID 与表示做完整验证；请求期只加载 index、读取被 burn 的单条 record、计算 request-bound HMAC 并清零五字节 answer buffer。Redis 只持 lease/revocation metadata，不持完整媒体或答案；runtime 不拼接 PCM、不调用外部 TTS，也不给客户端 unit/label/recipe。

V3 typed union 复用现有 AEDS 174/175 外层 frame，但 V3 payload slice 由 Core 的 `PodBinaryCodec.PerceptionCharacterV3` 读写，不走 UTF-8 JSON dictionary。Shared 只持 closed public records/POD，Backend 持 canonical loader、artifact binding/provider/Redis；没有 retired V3/V1/V2 parser、alias 或 fallback。notification stream 仍只消费 aggregate proof，不承载 V3 media/state，因此 provider 故障不会改变 stream 协议或连接生命周期。

初次 Create 由单个 Redis Lua 同时执行 challenge key NX、完整 hash、绝对 TTL 与 active-identity index NX；index 的 device 维度来自 server-authoritative material 的 domain-separated stable digest，不依赖可轮换 answer/token key。具体 challenge 的 `DeviceBindingHash` 仍使用其 answer key；replacement 按旧 state 的 answer-key version 复算旧 binding，再用当前 key 签发新 binding。verify/revoke 同一脚本维护 terminal state 和 index。refresh/switch 先在内存准备 bounded candidate，再由 `ReplaceAsync` 的单个 Lua 把旧 active state、全 binding 和 index 作为 CAS 条件，原子写入带 TTL 的新 state、撤销旧 state并交换 index。Redis reply-loss 通过脚本内 operation result readback 判定；未决 operation 会阻止后续 mutation，不能由另一个应用实例猜测成功或重放。无需重启的降级仍是从热 RiskControl policy 移除 V3、停止新 issue/refresh 并让既有 verify/cancel 在短 TTL 内 drain；禁止回退到 async cancel+issue 或任何 V1/V2 character path。

### 浏览器单宿主与受保护命令

浏览器只挂载一个 application-level `SecurityChallengeDialogHost`，并通过共享 coordinator
串行化受保护命令。当前 production shared-flow inventory 严格只有 Passkey login begin/complete、
Recovery Key verify 与 comment/reply；account 与 admin 业务命令目前没有接入 shared RiskControl
proof endpoint/flow。尤其不得把 admin 的独立 `X-Fsus-Mfa-Proof` step-up 当成已接入 shared
RiskControl dialog 的证据。未来 account/admin endpoint 一旦接入 shared RiskControl proof transport，
其调用方必须使用同一个 coordinator，因此自动由现有 App host 承载，不得新增页面级 host 或把
admin MFA 伪装为 generic challenge。页面不再插入 challenge panel；业务调用方只提交 action、route、稳定
mutation identity 与可恢复命令。coordinator 最多持有一个 pending command，并以 generation 与
terminal latch 保证 verified/late response/route change/unmount 竞争中只恢复一次。

Dialog 通过 FsusBlog `FsusDialog` adapter 使用 FsusUI Dialog，字符媒体、输入和单一 live/error
owner 只来自 FsusUI 的公开 `FsusPerceptionCharacterChallenge` adapter。FsusBlog 只拥有 typed
AEDS、coarse state、replacement/revocation、Blob URL/RGBA 资源和业务命令；不复制 generic DOM、
内部 selector 或字符生成逻辑。refresh、representation switch、close、Escape、route change 与
unmount 都撤销当前 envelope；replacement 保留 pending command，但必须获得新的 challenge identity。

## 评论策略分层与失效

`ArticleCommentPolicyService` 在请求时组合全站匿名评论策略、`article_comment_policy` override 与 `comment_thread_policy` 锁定状态。最终写入校验和 privacy-safe slow-mode CAS 位于同一数据库事务，避免 ticket 签发后的策略变化或并发锁定穿透。文章/线程更新使用 PostgreSQL advisory lock + `policy_version` 乐观并发，并追加 `comment_policy_audit_event`；提交后复用 `InvalidateCommentPolicyAsync` 广播，多节点不持有不可失效的文章策略副本。无需重启即可将文章 `enabled=false` 或设置 `closedAtUtc`，读取链路保持不变。

## Capability registry and membership

`Runtime:Mode` selects `single`, `static-role`, or `adaptive`. `single` does not start the membership hosted service and therefore has no Redis registration dependency. The other modes create one `NodeDescriptor` per process generation and store the shared view under the runtime-scoped Redis membership hash.

`nodeId` identifies a configured deployment node while `instanceId` is a new UUID for every process start. Heartbeats update health/load/resource hints only when both identities match. This prevents a delayed heartbeat from an old process generation reviving the replacement. The failure detector retains members and progresses `Alive -> Suspect -> Dead`; `Draining` and `Maintenance` are operator-owned states and are never overwritten by timeout detection.

The stable capability catalog is the dependency boundary for later scheduler issues. Static-role and adaptive nodes publish the same descriptors; schedulers consume `ListAliveNodesAsync` and do not inspect configuration strings. Membership uses the existing Redis dependency and runtime key scope, without adding service discovery or a second application binary.

No-restart degradation is status based: set a node to `Draining` before removing responsibilities, or `Maintenance` to exclude it while preserving diagnostics. Membership failure must not disable public reads, binary API, or notification stream. The next process generation can start in `single` mode to fully bypass registration.

## Theme package 与 registry 边界

Theme 基础设施位于 `Infrastructure/Themes`。`ThemePackageValidator` 只接受
声明式 `.fstheme` ZIP，先完成 canonical path、必需文件、manifest、运行时
版本、权限、预算、config schema 与 SHA-256 校验，再允许
`ThemeLifecycleService` 进入 registry 事务。它不执行 CSS/JS、不访问主题声明
的网络或文件系统，也不承担 marketplace、admin UI 或 CSS safety scanner。
完整包契约见 [FsusBlog theme package format](themes/package-format.md)。

`LocalThemePackageStore` 通过同文件系统 staging directory + atomic rename 保存
exact package 与展开条目；registry 事务失败时只清除本次新建目录，不删除已存在
的 content-addressed package。`PostgresThemeRegistry` 持久化 manifest、config
schema、package hash/location、配置版本、activation scope 和 asset hash/size。
enable、disable、replacement uninstall
都以数据库事务保持 `theme_registry.enabled` 与 `theme_activation` 一致；安装
校验失败发生在事务前，不会改变已有 active theme。运行期无需重启的降级路径是
按 scope disable，或把 active scope 原子切换到已安装 replacement 后再卸载。
数据库 migration 是 additive；回退旧应用时保留这些表即可，不要求删除或
恢复数据库。

`ThemeTokenCompiler` 在 package lifecycle 之前把
`fsusblog.theme.tokens.v1` 的 primitive、semantic、component、context 层
编译为 `data-theme` 作用域内的稳定 `--fsus-*` 变量，并返回 exact CSS 的
SHA-256。light/dark 是完整模式，reduced-motion/high-contrast 是受限 overlay；
缺少必需 semantic token、未知 schema 字段、无效引用或引用环都 fail closed。
完整契约见 [Theme token schema and CSS variable runtime](themes/token-schema.md)。

浏览器侧 `themeAssetRuntime` 只接受 same-origin、路径含声明 SHA-256 的 CSS。
它按 user preview -> active scope -> default 解析；候选 CSS load 成功前不修改
根节点或移除当前 stylesheet，失败则退回 default。色彩模式按 explicit user
mode -> system preference -> theme default 解析，motion/contrast preference
同步为根节点属性。暴露给 UI 的 current state 是 frozen snapshot，preview
不会写入 registry activation。无需重启的降级方式是 registry scope disable /
replacement；前端加载失败也会保留现有 stylesheet 并尝试 default。

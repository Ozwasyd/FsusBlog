# API 设计哲学

本文件说明 FsusBlog API 层的设计原则与约定，是所有 API 变更的**必读前提文件**。

---

## 核心原则

### 1. 契约稳定性优先

- 一旦端点路径发布，非 breaking 语义变更在原路径叠加；breaking 变更须新开版本段（如 `/api/v2/`）。
- 所有请求/响应字段用 `src/shared/Contracts/Outputs/ServerResponseContracts.cs` 作为唯一来源，任何业务逻辑层不得自行定义与之并行的 DTO。

### 2. AEDS Binary-only 运行时协议

运行时主业务 API 只暴露 AEDS 二进制链路：

| 链路 | Content-Type | 解码方 | 路径前缀 |
|------|-------------|-------|---------|
| **AEDS Binary** | `application/octet-stream` | TypeScript adapter / C++23 Wasm Worker | `/api/binary/...` |

旧文本业务 API 不再注册；`/api/**` 非 binary 业务路径统一返回 `ApiError` AEDS frame。客户端不得把解码失败回退为文本 API 请求。例外只限作者工作台 `/api/author/**`、真人阅读 proof、健康检查和运维类 JSON 端点；其中 `/api/author/audit/**` 只用于 admin 审计查询、summary 和防篡改校验，`/api/author/moderation/**` 只承载 admin 审核系统控制台，不作为公开运行时业务 API。

HTTP shell 契约由 `src/shared/Contracts/Validation/fsusblog.openapi.json` 提供，包含 method/path/status/content-type/security 与 `x-fsus-*` 扩展；AEDS payload、frame 编号、POD schema 和 golden fixture 仍由 `aeds-protocol.json`、POD 契约和 fixture 负责。

### 3. 统一响应包装

所有运行时主业务响应体均为 AEDS v2 frame。成功写操作使用 `EmptySuccess` 或 `MutationId`；失败、鉴权拒绝、限流和异常兜底统一使用 `ApiError` frame。AEDS v1 frame 不再兼容，也不保留旧 frame fallback。

### 4. 认证一致性

鉴权要求以 `/api/binary/**` 端点声明为准。公开、登录、admin、PoW、MFA、Passkey 等边界必须在 binary 端点内直接校验；不存在文本端点作为权限参照。

---

## URL 命名约定

| 规则 | 示例 |
|------|------|
| Binary 端点统一前缀 `/api/binary/` + 小写资源名；公开热点 article 使用无 query 的 artifact 路径 | `/api/binary/article/list/home/1/10.aeds`、`/api/binary/comment/{id}` |
| 消息系统使用 binary 消息路径 | `/api/binary/messages/conversations` |
| 管理端以 binary admin 资源路径区分 | `/api/binary/admin/users`、`/api/binary/stats` |
| 作者工作台 JSON 端点限定 admin 后台工作流 | `/api/author/drafts`、`/api/author/audit`、`/api/author/moderation/overview` |
| 健康检查与通知独立于业务路径 | `/health/live`、`/api/notifications/stream` |

---

## HTTP 方法语义

| 方法 | 用途 |
|------|------|
| `GET` | 读取资源，幂等，可缓存 |
| `POST` | 创建资源或执行动作（登录/挑战/发送） |
| `PUT` | 全量更新单个资源属性（重命名） |
| `DELETE` | 删除资源 |

Binary 端点按资源语义使用 `GET/POST/PUT/DELETE`；认证、MFA、Passkey、上传和管理端写入均不得退回旧文本路径。

---

## 分页约定

系统使用两种分页模式：

### 基于页码的分页（`PageResponse<T>`）

适用于：文章列表、用户列表等需要总数的场景。

```json
{
  "items": [...],
  "total": 100,
  "page": 1,
  "pageSize": 20
}
```

查询参数：`?page=1&pageSize=20`

### 基于游标的分页（`CursorResponse<T>`）

适用于：评论线程、消息流等无限下拉场景。

```json
{
  "items": [...],
  "nextCursor": "eyJpZCI6MTIzfQ==",
  "hasMore": true
}
```

查询参数：`?cursor=<上一次返回的 nextCursor>&limit=20`

---

## 内容协商

### 请求头

| 场景 | 要求 |
|------|------|
| Binary 读取 | `Accept: application/octet-stream` |
| Binary 写入 | `Content-Type: application/octet-stream`，请求体为 AEDS frame |
| 通知连接 | WebSocket 子协议 `fsus-aeds.v2` |

### 自定义头

| 头部 | 方向 | 说明 |
|------|------|------|
| `X-Fsus-Shield` | 请求 | ShieldMiddleware 要求的来源校验头 |
| `X-Fsus-Pow-Answer` | 请求 | PoW 答案，用于注册/登录等敏感操作 |
| `X-Fsus-Pow-Challenge` | 请求 | PoW 挑战令牌 |

---

## 状态码约定

| 状态码 | 含义 |
|--------|------|
| `200 OK` | 操作成功 |
| `400 Bad Request` | 参数无效、业务校验失败 |
| `401 Unauthorized` | 未提供或无效的 Bearer Token |
| `403 Forbidden` | 权限不足（已登录但角色不满足） |
| `404 Not Found` | 资源不存在 |
| `409 Conflict` | 资源冲突（如用户名已存在） |
| `429 Too Many Requests` | 速率限制触发，响应含 `Retry-After` 头 |
| `500 Internal Server Error` | 服务端异常，错误详情不暴露给客户端 |

---

## 版本管理策略

当前 API 无统一版本前缀（历史遗留）。新增模块（如消息系统）采用 `/api/v1/` 前缀。
常规业务 **Breaking Change** 应新开 `/api/v2/` 前缀，并在至少一个主版本内保持旧端点可用。AEDS wire protocol 是运行时传输层版本，当前按破兼容发布策略直接升级为 AEDS v2，不保留 v1 兼容。

不视为 Breaking Change 的变更：
- 新增响应字段（客户端应忽略未知字段）
- 新增可选请求参数
- 新增端点

视为 Breaking Change 的变更：
- 移除或重命名现有字段
- 修改字段类型
- 移除端点
- 修改认证要求（降权除外）

---

## 通知通道设计约定

- 通知端点：`GET /api/notifications/stream`，仅接受 WebSocket upgrade
- 握手预检：`GET /api/notifications/stream/preflight`，复用 PoW/cursor/protocol 校验但不要求 WebSocket upgrade，成功返回 204
- 子协议：`fsus-aeds.v2`
- 匿名用户连接时接收公开事件（GlobalNotice、CacheControl 等）
- 已认证用户额外接收私人事件（MessageReceived、InboxConversationUpsert 等）
- 慢消费者（背压积压）自动断开连接，客户端需实现重连逻辑
- 每条消息均为 AEDS binary frame；WebSocket 握手失败返回 `ApiError` frame，并写入 `X-Fsus-Sse-Error-Code` / `X-Fsus-Sse-Status-Code`
- 客户端应优先通过 preflight 区分 `account_blocked`、`account_deleted`、`auth_failed`、`pow_failed`、`websocket_required` 等失败码，再决定是否重连或提示用户
- 客户端应存储最后收到的 cursor 值，断线重连时通过 `cursor` query 参数传递

---

## AOT 公开页约定

公开页（首页、文章详情、分类、标签、归档、关于、隐私政策、用户守则、版权声明）优先从 AOT 卷命中静态 HTML + AEDS payload，
Bundle 格式遵循 `PublicAotShellEntryContract`（见 `docs/api/contracts.md`）。
SPA 接管后由 hydration 层用同一份 Bundle 数据初始化状态，无需二次网络请求。

公开 footer 合规信息来自 `SiteComplianceConfig` AEDS frame。空配置不得输出备案号占位；admin 保存合规配置后必须同时失效 system compliance cache、SEO/distribution cache 和 Public AOT 静态页，使 sitemap/RSS/footer 在无重启情况下收敛。

公开 Binary 读模型与 HTML AOT 一样按 artifact 边界治理。`/api/binary/article/{id}.aeds`、`/api/binary/article/list/home/{page}/{size}.aeds`、`/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds`、`/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds`、`/api/binary/article/hot/{size}.aeds`、`/api/binary/category.aeds`、`/api/binary/tag.aeds` 等匿名热点路径由 `PublicHotReadFastPath` 在常规应用管线前读取内存快照并直接写出完整预编码 frame；hit 路径不查询 PostgreSQL、Redis、IMemoryCache、OutputCache 或文件系统。artifact miss 只返回可降级状态码，DB fallback 只能出现在后台 projector、修复任务或 admin/private 读取路径。L1/L2/OutputCache 仍是加速层，不等价于 CQRS read model。

公开 GET 不默认要求 PoW，以免伤害 SEO、RSS、分享卡片和无 JS 阅读；但公开评论读取、公开 taxonomy、related-reading 等动态 API 会进入 `public_read` 限流和 `RiskAwarePublicReadFilter`。风险分由 Shield、RateLimiter、PoW 与 ReadProof 拒绝事件写入；达到阈值时动态 API 要求 `X-Fsus-Pow-Proof`，持续高风险返回 429。PublicHotRead artifact 命中保持零 DB/零 Redis/零 filter 快路径。

L0 artifact 只接受 `GET`/`HEAD`；`OPTIONS` 在同源场景下返回 `405`，不在 fast path 上注入 CORS。Binary artifact 接受空 `Accept`、`*/*` 或 `application/octet-stream`；HTML artifact 只接受空 `Accept`、`*/*` 或 `text/html`；不匹配时返回 `406`。快照未进入 `Ready` 状态时返回 `503` + `Retry-After: 1`，除非显式启用 `PublicHotRead:FailOpenWhenNotReady` 降级到常规管线。`400`/`404`/`405`/`406`/`416`/`503` 等 L0 负响应固定 `Cache-Control: no-store`，`Range` 请求返回 `416`。`.aeds` 命中声明 `Accept-Ranges: none`，并可按 artifact 预生成 raw/br/gzip variant 返回 `Content-Encoding`、`Vary: Accept-Encoding` 和 variant-aware `ETag`；`If-None-Match` 命中当前 variant 时返回 `304`。HTML artifact 必须是静态 CSP 形态，不依赖 nonce placeholder 或 inline script。

`/api/binary/article/html/{pathKey}.html` 是 AOT shell 的诊断/预览 artifact 命中路径，不是 `/article/{id}`、`/category/{id}` 等真实公开 URL 的替代路由；真实页面仍由 public route + AOT shell/SPA 渲染。`routeKey` 与 URL-safe `pathKey` 分离：`article:42` 映射为 `article-42`，`category:7`/`tag:9` 同理，`tag-name:*`、包含空白、斜杠或非 ASCII 的 routeKey 使用稳定 hash pathKey。可观测诊断头 `X-Fsus-HotRead-*` 默认关闭，只能通过 `PublicHotRead:EnableDiagnosticHeaders=true` 打开。

Public AOT 预热和内容变更驱动 backfill 必须消费后端权威 route manifest，而不是脚本猜测 URL。`GET /internal/public-aot/manifest` 只暴露公开 SEO route，支持 `scope=all`、`scope=hot` 与 `changedSince`，并通过 `dependencyKeys` 连接 `article:{id}`、`category:{id}`、`tag:{id}`、`article:list`、`seo`、`compliance` 等内容依赖。配置 `PublicAot:ManifestToken` 时，调用方必须携带 `X-Fsus-Public-Aot-Token`。

Public AOT document composer 只允许通过 `<!--fsus:aot:*-->` sentinel 写入 AOT 管理区域；模板缺少 sentinel 必须失败而不是静默降级。AOT 负责维护的 description/canonical/Open Graph/Twitter/feed/JSON-LD head 节点必须统一带 `data-fsus-aot-head`，客户端 micro-navigation 只替换这些标记节点，不触碰 Vite runtime、CSP nonce 或其他非 AOT head。

公开页结构的唯一真相源是 `src/frontend/src/helpers/publicAotBundle.ts` 与
`src/frontend/src/public-renderers/renderPublicPage.ts`。服务端 AOT provider
只提供数据型 options，不手写 hydration props、不渲染 Markdown、不拼页面内部 HTML；
Node/Vue SSR worker 负责生成 `html / bootstrapPayload / hydrationPropsPayload`，服务端只做
文档包装、缓存与降级。

## 单作者内容生命周期约定

文章写入 API 可以表达 `Draft`、`Scheduled`、`Published`、`Archived`、`Deleted`，但公开读链只承认 `Published` 且已到发布时间的数据。新增公开分发端点、AOT、搜索、Binary list、feed、sitemap、related-reading 时必须复用同一套可见性语义，不能各自放宽过滤条件。

公开 article Binary 端点不再按身份混合语义。匿名公开读只能使用 `/api/binary/article/**.aeds` artifact 路径，客户端必须省略 credentials；admin/private 读写统一使用 `/api/binary/admin/article/**`，可读取所有非删除状态，并可用 `status=0/1/2/3/4` 精确管理 draft、scheduled、published、archived、deleted。任何旧 query 公开路径或匿名管理查询都不得退回文本 API 或泄露未发布标题。

作者工作台 API 放在 `/api/author/**`，全部使用 admin 授权和统一响应包装；预览、草稿、修订、管理端 taxonomy、资产、AI 辅助都属于作者私有能力。私有预览走 `/api/author/preview`，由服务端把草稿 Markdown 渲染成带 `data-preview-only=true`、`data-markdown-renderer=server-preview` 的 AOT-like HTML，前端只放进 sandboxed iframe，不进入公开路由或缓存。服务端草稿以 `ownerUserId + draftKey` 隔离并持久化正文、分类标签、发布状态和定时发布时间；编辑器发现服务端草稿比本地缓存更新时必须先提示恢复/丢弃，不能用本地缓存静默覆盖。文章修订历史必须通过 admin-only API 读取摘要和单条正文详情，编辑器只在作者工作台内比较当前表单与历史版本，回滚复用正式文章更新链路而不是直接写表。未发布正文不得进入 feed、search、sitemap、PublicAOT cache，也不得默认发送到外部 AI provider。

单作者运维能力也归入 `/api/author/**`，不得新增多作者协作或复杂 RBAC。`/api/author/ops/**` 只返回运行时健康、备份 artifact 状态和危险操作策略；`/api/author/cache/**` 暴露 AOT/PublicHotRead/search/sitemap/feed/comment cache 诊断与手动重建入口；`/api/author/integrity/**` 暴露数据一致性巡检、diff 预览和带 MFA 的 safe-fix 应用。所有写入型维护动作必须写高价值审计；不可逆或跨表修复必须先返回 diff，并通过统一危险操作策略要求强确认或 MFA proof。

SEO 预览是作者工作台内的发布前质量门，不是新路由模型：当前公开 canonical 仍由 `SeoConfigContract.baseUrl + /article/{id}` 生成，新文章落库前使用 draft-preview 占位。编辑器必须展示搜索结果和分享卡片预览，并在发布/定时发布前调用 `/api/author/prepublish-check`；错误项阻断，摘要/封面/标题长度、图片 alt、超大 Markdown 或未知站内链接等 warning 只能在作者填写跳过理由后继续提交，理由由服务端写入审计。

管理端分类/标签列表不得复用公开 `CategoryList` / `TagList` 的公开文章计数。作者工作台必须读取 `/api/author/taxonomy/categories` 与 `/api/author/taxonomy/tags`，用所有非删除状态或所有 `ArticleTag` 关联形成 `totalBlockingArticleCount` 与 `canDelete`，这样草稿、定时、归档和已删除关联不会被公开计数隐藏。标签删除采用严格锁定语义：只要仍有关联文章就拒绝删除，不静默移除文章上的标签关系。

资产库是作者工作台内的复用索引，不是公开文件浏览 API。索引只记录 `/uploads/illustration/*` 的正文图片和文章封面、alt text、来源文章、hash 与引用计数；重建操作先把失去引用的行标成 `referenceCount=0`，作者确认后再通过孤儿清理删除资产库记录。孤儿清理不删除上传文件本体；物理删除必须通过独立的文件删除动作和二次确认完成。

评论治理是公开讨论区前置门禁：新评论默认进入 `Pending`，公开评论线程和回复游标只读取 `Approved`，并按 viewer IP 解析出的地区过滤 `blocked_regions`。提交时服务端按 request IP 解析 submit region；submit region 违法时直接拒绝，合法但部分 viewer region 不可展示时写入 `comment_region_compliance.blocked_regions`。`CN-MAINLAND` 严格策略只作用于 `CN-MAINLAND` 提交者或浏览者，不因 `CN-HK`、`CN-MO`、`CN-TW` 或 `GREATER_CHINA` 分组自动外溢；submit region 未知时进入待审且公开页不展示，viewer region 未知时对存在 blocked regions 的评论采用保守隐藏。作者工作台通过 `/api/author/comments/moderation` 读取待审、已拒绝、已隐藏和已通过队列，展示敏感词、HTML 风险、密集链接、重复刷屏、人工原因和地区策略结果；单条或批量审核写入审计并清理评论游标缓存。误判恢复只需要把评论重新置为 `Approved`，但 `can_publish=false` 的发布地违法评论不得被管理员放行；拒绝/隐藏时可选择联动封禁非 admin 用户。

审核系统控制台位于 `/user/manage/moderation`，后台一级导航只保留「审核系统」，评论审核是其子栏目。控制台 JSON 端点使用 `/api/author/moderation/**`：`overview` 汇总队列、词库、地区策略和模型状态；`dictionaries` 只返回词库 metadata、checksum、term count 和聚合 `evidencePolicy`，不返回 raw terms；`policies` 返回地区策略组合和 `CN-MAINLAND` 强制检查；`regions`、`region-groups`、`policy-templates` 和 `effective-policy/*` 返回地区 catalog、大区成员、默认模板 presets 与 effective policy 继承预览；`runtime/status` 返回全局状态、地区 override、禁用词库集合和模型运行快照；`replay/preview` 只返回 diff 汇总，不执行变更；`model/status` 只展示模型配置和 latency/error 观测。地区是具体匹配对象，大区只是策略复用工具，模板是工程预设而不是法律意见；默认模板必须带 `source/version/checksum/reviewed_by/reviewed_at_utc` 字段，内置模板必须标记 not legal advice，运营者必须按实际服务地区、部署地、业务类型和法律顾问意见复核。`GREATER_CHINA` 不是 `CN-MAINLAND`，`CN-HK/CN-MO/CN-TW` 不自动继承 `CN-MAINLAND` strict policy。词库 reload/rollback、词库启停、地区状态、全局状态和模型 runtime/reload/rollback 都是高风险写操作，必须携带 `X-Fsus-Mfa-Proof` 并写高价值审计；会影响公开评论可见性的变更必须清理评论 cursor/frame 缓存。生产可用降级只允许 `disabled_to_pending`、`manual_review_only`、`no_public_display`、`read_only`、`emergency_lockdown` 等不会公开放行的状态，`disabled_pass_through` 在 production 下拒绝，除非显式本地开发配置打开。模型禁用不禁用词库，词库禁用不禁用地区策略，地区策略禁用必须回落到 `GLOBAL` baseline；`CN-MAINLAND` 严格策略变更和强制词库禁用需要 MFA、确认短语和高价值审计。replay execute 不得绕过 preview/MFA/确认短语/审计流程。第三方审核模型 Provider 只接入为风险信号层，契约由 FsusBlog 定义，不能返回最终发布、隐藏、地区屏蔽或地区合法性结论；Provider 开发入口见 [../moderation/third-party-model-development.md](../moderation/third-party-model-development.md)。

内容导入导出是作者工作台的恢复工具，不是匿名下载 API。单篇导出必须是 Markdown + frontmatter，frontmatter 同时保留可读字段和 `fsusMetadataJson` 机器元数据；全站内容包只是这些单篇导出的 JSON 聚合。导入默认按 metadata 恢复 draft/scheduled/published/archived 状态、分类、标签、封面和 revision 记录；只有作者显式传 `publish=true` 时才强制上线。

---

## 参见

- [contracts.md](contracts.md) — 所有请求/响应 DTO 的完整定义
- [quick-reference.md](quick-reference.md) — 端点路由速查表
- [schemas-and-errors.md](schemas-and-errors.md) — 错误码与二进制结构
- [../security.md](../security.md) — 安全模型（PoW / JWT / MFA）
- [../architecture.md](../architecture.md) — 缓存分层与 AEDS binary 架构

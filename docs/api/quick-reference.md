# 路由速查表

所有 FsusBlog API 端点的快速索引。

**图例**

| 符号 | 含义 |
|------|------|
| 🔓 | 匿名可访问 |
| 🔑 | 需要登录（HttpOnly Cookie session / AEDS auth frame） |
| 👑 | 需要 admin 角色 |
| 🚦 | IP 速率限制（fixed_ip 固定窗口） |
| 📦 | Binary 端点（`application/octet-stream`，AEDS v2 帧） |
| 🗄️ | 有输出缓存（L1 内存 + OutputCache） |

---

## 认证 — `/api/Auth`

### PoW 与注册登录

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/Auth/pow-challenge` | 🔓 🚦 | 获取 PoW 挑战 |
| POST | `/api/Auth/register` | 🔓 🚦 | 用户注册并自动登录（需携带 PoW 答案头） |
| POST | `/api/Auth/login` | 🔓 🚦 | 密码登录，可能触发 MFA 流程 |
| POST | `/api/Auth/refresh-token` | 🔓 🚦 | 用 HttpOnly Cookie 续签 Access Token |

### 当前用户

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/Auth/me` | 🔑 | 获取当前登录用户信息 |
| POST | `/api/Auth/logout` | 🔑 | 安全登出（吊销当前 Refresh Token） |
| POST | `/api/Auth/delete-account` | 🔑 | 注销账号 |

### 会话管理

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/Auth/sessions` | 🔑 | 获取活跃会话列表 |
| POST | `/api/Auth/sessions/{id}/revoke` | 🔑 | 吊销指定会话 |
| POST | `/api/Auth/sessions/revoke-others` | 🔑 | 吊销全部其他会话 |

### MFA / TOTP

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/Auth/mfa/setup/start` | 🔑 | 开始 MFA 设置，返回 TOTP 密钥与二维码 |
| POST | `/api/Auth/mfa/setup/verify` | 🔑 | 验证 TOTP 码，完成 MFA 启用 |
| GET | `/api/Auth/mfa/profile` | 🔑 | 查询 MFA 状态与恢复码剩余数 |
| POST | `/api/Auth/mfa/disable` | 🔑 | 禁用 MFA |
| POST | `/api/Auth/mfa/recovery/regenerate` | 🔑 | 重新生成恢复码 |
| POST | `/api/Auth/mfa/challenge/start` | 🔑 | 登录后发起 MFA 挑战（返回挑战令牌） |
| POST | `/api/Auth/mfa/challenge` | 🔓 | 提交 TOTP 码或恢复码完成 MFA |
| POST | `/api/Auth/admin/users/{id}/mfa/reset` | 👑 | 管理员重置指定用户 MFA |

---

## Passkey / WebAuthn — `/api/binary/auth/passkey`

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/binary/auth/passkey/register/begin` | 🔑 | 开始注册 Passkey |
| POST | `/api/binary/auth/passkey/register/complete` | 🔑 | 完成 Passkey 注册 |
| POST | `/api/binary/auth/passkey/login/begin` | 🔓 🚦 | 开始 Passkey 无密码登录 |
| POST | `/api/binary/auth/passkey/login/complete` | 🔓 🚦 | 完成 Passkey 登录断言 |
| GET | `/api/binary/auth/passkey/credentials` | 🔑 | 获取已注册 Passkey 列表（最多 5 枚） |
| DELETE | `/api/binary/auth/passkey/credentials/{id}` | 🔑 | 删除指定 Passkey |
| PUT | `/api/binary/auth/passkey/credentials/{id}/name` | 🔑 | 重命名指定 Passkey |

---

## 文章 — `/api/Article`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
|------|------|------|------|------|
| GET | `/api/Article/` | 🔓 | 🗄️ | 文章列表（分页），查询参数：`page`、`pageSize`、`categoryId`、`tagId` |
| GET | `/api/Article/{id}` | 🔓 | 🗄️ | 文章详情 |
| GET | `/api/Article/hot` | 🔓 | 🗄️ | 热门文章列表 |

---

## 评论 — `/api/Comment`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
|------|------|------|------|------|
| GET | `/api/Comment/{articleId}` | 🔓 | 🗄️ | 指定文章顶层评论（游标分页） |
| GET | `/api/Comment/{articleId}/thread/{rootId}` | 🔓 | 🗄️ | 指定评论的回复线程 |
| GET | `/api/Comment/me` | 🔑 | — | 当前用户评论历史 |

---

## 分类 — `/api/Category`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
|------|------|------|------|------|
| GET | `/api/Category/` | 🔓 | 🗄️ | 所有分类列表 |

---

## 标签 — `/api/Tag`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
|------|------|------|------|------|
| GET | `/api/Tag/` | 🔓 | 🗄️ | 所有标签列表 |

---

## 系统配置 — `/api/binary/system`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
|------|------|------|------|------|
| GET | `/api/binary/system/seo` | 🔓 | 🗄️ | 站点 SEO 配置，`SeoConfig` frame |
| GET | `/api/binary/system/compliance` | 🔓 | 🗄️ | 公开页 footer 合规配置，`SiteComplianceConfig` frame |
| GET | `/api/binary/system/page/{slug}` | 🔓 | 🗄️ | 指定 slug 的静态页面内容；当前只支持 `about/privacy/guidelines/copyright` |
| GET | `/api/binary/system/admin/seo` | 👑 | — | admin 读取 SEO 配置 |
| GET | `/api/binary/system/admin/compliance` | 👑 | — | admin 读取完整合规配置 |
| PUT | `/api/binary/system/seo` | 👑🚦 | — | admin 保存 SEO 配置，`SeoConfigUpdateRequest` |
| PUT | `/api/binary/system/compliance` | 👑🚦 | — | admin 保存大陆合规配置，`SiteComplianceConfigUpdateRequest` |
| PUT | `/api/binary/system/page` | 👑🚦 | — | admin 保存静态页面内容 |
| POST | `/api/binary/system/page/refresh/{slug}` | 👑🚦 | — | 强制刷新静态页面缓存 / AOT |

---

## Binary 端点 — `/api/binary`

> 所有运行时 API 输出 `Content-Type: application/octet-stream`（AEDS v2 帧）。
> 客户端必须优先使用 `/api/binary/**`；旧文本 API 不再注册。

### Binary 路由

| Binary 路径 | 权限 | FrameType | 说明 |
|------------|------|-----------|------|
| GET `/api/binary/article/list/home/{page}/{size}.aeds` | 🔓 📦 | `ArticleList`(1) | 首页文章列表 L0 artifact |
| GET `/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds` | 🔓 📦 | `ArticleList`(1) | 分类文章列表 L0 artifact |
| GET `/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds` | 🔓 📦 | `ArticleList`(1) | 标签文章列表 L0 artifact |
| GET `/api/binary/article/{id}.aeds` | 🔓 📦 | `ArticleDetail`(2) | 文章详情 L0 artifact |
| GET `/api/binary/article/hot/{size}.aeds` | 🔓 📦 | `ArticleHot`(3) | 热门文章 L0 artifact |
| GET `/api/binary/category.aeds` | 🔓 📦 | `CategoryList`(9) | 分类元数据 L0 artifact |
| GET `/api/binary/tag.aeds` | 🔓 📦 | `TagList`(10) | 标签元数据 L0 artifact |
| GET `/api/binary/article/html/{pathKey}.html` | 🔓 | `text/html` | AOT HTML 诊断/预览 artifact；不替代真实公开 URL |
| GET `/api/binary/comment/{articleId}` | 🔓 📦 | `CommentArticleCursor`(5) | 文章评论 |
| GET `/api/binary/comment/{articleId}/thread/{rootId}` | 🔓 📦 | `CommentThreadReplyCursor`(8) | 评论线程 |
| GET `/api/binary/comment/me` | 🔑 📦 | `CommentUserCursor`(6) | 用户评论历史 |
| GET `/api/binary/system/seo` | 🔓 📦 | `SeoConfig`(13) | 公开 SEO 配置 |
| GET `/api/binary/system/compliance` | 🔓 📦 | `SiteComplianceConfig`(26) | 公开合规 footer 配置 |
| GET `/api/binary/system/page/{slug}` | 🔓 📦 | `PageContent`(14) | 公开静态页内容，slug allowlist 同上 |
| POST `/api/binary/read-proof/challenge.aeds` | 🔓 🚦 📦 | `HumanReadChallengeRequest`(73) → `HumanReadChallengeResponse`(28) | 真人阅读 challenge；受 `read_proof` 限流 |
| POST `/api/binary/read-proof/submit.aeds` | 🔓 🚦 📦 | `HumanReadSubmitRequest`(74) → `HumanReadSubmitResponse`(29) | 真人阅读 proof 提交；拒绝状态写入统一风险信号 |
| POST `/api/binary/telemetry/rum` | 🔓 🚦 📦 | `RumMetricBatchRequest`(75) → `RumMetricIngestResponse`(76) | 匿名 RUM 批量 ingestion；`credentials: omit` |

### 管理端 Binary

| 方法 | 路径 | 权限 | FrameType | 说明 |
|------|------|------|-----------|------|
| GET | `/api/binary/stats` | 👑 📦 | `AdminStats`(7) | Binary 聚合统计（overview + recent comments + regions） |
| GET | `/api/binary/admin/article` | 👑 📦 | `ArticleList`(1) | 管理端文章列表，可带 `status` / `isDeleted` |
| GET | `/api/binary/admin/article/{id}` | 👑 📦 | `ArticleDetail`(2) | 管理端文章详情 |
| POST | `/api/binary/upload/init` | 👑 | `UploadInit`(20) | 初始化分片上传 |
| GET | `/api/binary/upload/{id}` | 👑 📦 | `UploadStatus`(21) | 查询上传状态 |
| PUT | `/api/binary/upload/{id}/part/{n}` | 👑 📦 | `UploadPartAck`(22) | 上传分片 |
| POST | `/api/binary/upload/{id}/complete` | 👑 📦 | `UploadComplete`(23) | 完成上传 |
| DELETE | `/api/binary/upload/{id}` | 👑 | — | 中止并清理上传 |
| GET | `/api/binary/upload/{id}/parts` | 👑 📦 | `UploadPartMap`(24) | 分片清单 |

---

## 消息系统 — `/api/binary/messages`

> 整个路由组需要登录（🔑）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/binary/messages/conversations` | 当前用户对话列表 |
| GET | `/api/binary/messages/conversations/{id}` | 对话详情与消息 |
| POST | `/api/binary/messages/conversations` | 发起新对话 |
| POST | `/api/binary/messages/conversations/{id}/reply` | 回复对话 |
| POST | `/api/binary/messages/conversations/{id}/read` | 标记对话已读 |

---

## 管理端消息 — `/api/binary/admin/messages`

> 整个路由组需要 admin 角色（👑）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/binary/admin/messages/conversations` | 所有对话列表 |
| GET | `/api/binary/admin/messages/conversations/{id}` | 对话详情 |
| POST | `/api/binary/admin/messages/conversations/{id}/reply` | 以管理员身份回复 |
| POST | `/api/binary/admin/messages/conversations/{id}/status` | 更新对话状态（open/closed） |
| POST | `/api/binary/admin/messages/system-send` | 单用户系统消息；`targetUserId` 必填 |

## 开放分发与作者工作台

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/feed/rss.xml` | 🔓 | RSS 2.0 feed |
| GET | `/api/Article/rss` | 🔓 | RSS 历史兼容路径 |
| GET | `/feed/atom.xml` | 🔓 | Atom feed |
| GET | `/feed/feed.json` | 🔓 | JSON Feed 1.1 |
| GET | `/sitemap.xml` | 🔓 | 公开 sitemap，排除私有路由 |
| GET | `/robots.txt` | 🔓 | robots + sitemap 声明 |
| GET | `/api/binary/article/{articleId}/related.aeds` | 🔓 🚦 | AEDS 延伸阅读：相关文章 / 上一篇 / 下一篇；受 `public_read` 风险感知限流 |
| GET | `/api/public/articles/{articleId}/related` | 🔓 🚦 | 废弃 JSON 兼容路径；生产前端不得调用 |
| GET | `/api/ops/crawler-ranges/status` | 🔐 admin | Crawler CIDR 同步状态 |
| GET | `/internal/public-aot/manifest` | 🔓 | Public AOT route manifest；配置 `PublicAot:ManifestToken` 时需 `X-Fsus-Public-Aot-Token` |
| POST | `/api/subscriptions` | 🔓 | 更新订阅，保存 email hash |
| DELETE | `/api/subscriptions` | 🔓 | 退订 |

> 作者工作台生产前端调用 `/api/binary/author/**` AEDS bridge，后缀与下列旧 `/api/author/**` 路径一致；旧 JSON 路径仅保留为 deprecated 后端兼容层。
| POST | `/api/author/drafts` | 👑 | 保存服务端草稿 |
| GET | `/api/author/drafts/{draftKey}` | 👑 | 读取服务端草稿 |
| DELETE | `/api/author/drafts/{draftKey}` | 👑 | 丢弃服务端草稿 |
| POST | `/api/author/preview` | 👑 | admin-only 私有 Markdown/AOT-like 预览 |
| POST | `/api/author/prepublish-check` | 👑 | 发布前 SEO/内容质量检查 |
| GET | `/api/author/articles/{articleId}/revisions` | 👑 | 文章修订列表 |
| GET | `/api/author/articles/{articleId}/revisions/{revisionId}` | 👑 | 文章修订详情 |
| POST | `/api/author/articles/{articleId}/revisions/{revisionId}/rollback` | 👑 | 回滚修订 |
| POST | `/api/author/articles/{articleId}/assets/reindex` | 👑 | 重建资产引用 |
| GET | `/api/author/assets` | 👑 | 资产库列表 |
| DELETE | `/api/author/assets/orphans` | 👑 | 删除孤儿资产库记录 |
| GET | `/api/author/taxonomy/categories` | 👑 | 管理端分类真实引用计数 |
| GET | `/api/author/taxonomy/tags` | 👑 | 管理端标签真实引用计数 |
| GET | `/api/author/analytics` | 👑 | 单作者分析 |
| GET | `/api/author/comments/moderation` | 👑 | 评论审核队列 |
| POST | `/api/author/comments/moderation/bulk` | 👑 | 批量评论审核 |
| POST | `/api/author/comments/{commentId}/moderation` | 👑 | 评论审核 |
| GET | `/api/author/moderation/overview` | 👑 | 审核系统总览 |
| GET | `/api/author/moderation/dictionaries` | 👑 | 只读审核词库和地区策略 snapshot metadata |
| POST | `/api/author/moderation/dictionaries/reload` | 👑🚦 MFA | 手动 reload 审核词库和地区策略 snapshot |
| POST | `/api/author/moderation/dictionaries/rollback` | 👑🚦 MFA | 回滚到上一份成功加载的词库/地区策略 snapshot |
| POST | `/api/author/moderation/dictionaries/{dictionaryId}/enable` | 👑🚦 MFA | 启用运行时词库 override |
| POST | `/api/author/moderation/dictionaries/{dictionaryId}/disable` | 👑🚦 MFA | 禁用运行时词库 override；CN-MAINLAND 强制词库需确认短语 |
| GET | `/api/author/moderation/policies` | 👑 | 地区策略 summary 与 CN-MAINLAND 强制检查 |
| GET | `/api/author/moderation/regions` | 👑 | 地区定义 catalog，含内置/自定义地区和模板绑定 |
| GET | `/api/author/moderation/region-groups` | 👑 | 地区大区 catalog，含成员地区和大区模板 |
| GET | `/api/author/moderation/policy-templates` | 👑 | 默认/自定义策略模板 presets、review marker 和 checksum |
| GET | `/api/author/moderation/effective-policy/{regionCode}` | 👑🚦 | 指定地区 effective policy preview |
| POST | `/api/author/moderation/effective-policy/preview` | 👑🚦 | 带 operator override 的 effective policy preview |
| POST | `/api/author/moderation/replay/preview` | 👑🚦 | 策略回放 preview diff，不执行变更 |
| GET | `/api/author/moderation/runtime/status` | 👑 | 审核运行时全局/地区/词库/模型状态 |
| POST | `/api/author/moderation/runtime/global-state` | 👑🚦 MFA | 调整全局审核运行状态 |
| POST | `/api/author/moderation/runtime/region-state` | 👑🚦 MFA | 调整地区审核运行状态并清理评论 frame 缓存 |
| GET | `/api/author/moderation/model/status` | 👑 | 审核模型配置与 latency/error 观测 |
| POST | `/api/author/moderation/model/runtime` | 👑🚦 MFA | 热切换模型 provider/profile/启停状态 |
| POST | `/api/author/moderation/model/reload` | 👑🚦 MFA | 从配置热重载模型运行快照 |
| POST | `/api/author/moderation/model/rollback` | 👑🚦 MFA | 回滚上一份模型运行快照 |
| GET | `/api/admin/security/overview` | 👑 | 安全系统总览：AntiCrawler、PoW、SecurityRisk |
| GET | `/api/admin/security/anti-crawler/overview` | 👑 | 反爬虫总览、CIDR、风险事件、规则与 list |
| GET | `/api/admin/security/anti-crawler/options` | 👑 | 反爬虫运行策略快照 |
| PUT | `/api/admin/security/anti-crawler/options` | 👑🚦 MFA | 更新 AntiCrawler mode、局部开关、阈值、限流额度和 CIDR 更新配置 |
| POST | `/api/admin/security/anti-crawler/options/rollback` | 👑🚦 MFA | 回滚上一份反爬虫策略快照 |
| GET | `/api/admin/security/anti-crawler/crawler-ranges/status` | 👑 | CIDR worker 状态、更新时间、下次同步和 range 数量 |
| POST | `/api/admin/security/anti-crawler/crawler-ranges/sync` | 👑🚦 MFA | 手动同步 Google/Bing crawler CIDR |
| GET | `/api/admin/security/anti-crawler/risk-events` | 👑 | 反爬虫风险事件列表 |
| GET | `/api/admin/security/anti-crawler/rules` | 👑 | 反爬虫规则列表 |
| POST | `/api/admin/security/anti-crawler/rules` | 👑🚦 MFA | 新增反爬虫规则 |
| PUT | `/api/admin/security/anti-crawler/rules/{id}` | 👑🚦 MFA | 更新反爬虫规则 |
| DELETE | `/api/admin/security/anti-crawler/rules/{id}` | 👑🚦 MFA | 删除反爬虫规则 |
| GET | `/api/admin/security/anti-crawler/allowlist` | 👑 | 反爬虫 allowlist |
| POST | `/api/admin/security/anti-crawler/allowlist` | 👑🚦 MFA | 新增 allowlist 条目 |
| DELETE | `/api/admin/security/anti-crawler/allowlist/{id}` | 👑🚦 MFA | 删除 allowlist 条目 |
| GET | `/api/admin/security/anti-crawler/blocklist` | 👑 | 反爬虫 blocklist |
| POST | `/api/admin/security/anti-crawler/blocklist` | 👑🚦 MFA | 新增 blocklist 条目 |
| DELETE | `/api/admin/security/anti-crawler/blocklist/{id}` | 👑🚦 MFA | 删除 blocklist 条目 |
| POST | `/api/admin/security/anti-crawler/simulate` | 👑🚦 | 反爬虫策略模拟器，不执行变更 |
| GET | `/api/admin/security/pow/overview` | 👑 | PoW 系统总览 |
| GET | `/api/admin/security/pow/options` | 👑 | PoW 独立策略快照 |
| PUT | `/api/admin/security/pow/options` | 👑🚦 MFA | 更新 PoW mode、difficulty、TTL、replay 和风险联动 |
| POST | `/api/admin/security/pow/options/rollback` | 👑🚦 MFA | 回滚上一份 PoW 策略快照 |
| GET | `/api/admin/security/pow/events` | 👑 | PoW 风险事件 |
| GET | `/api/admin/security/risk/events` | 👑 | 统一安全风险事件 |
| GET | `/api/admin/security/risk/snapshots` | 👑 | 统一安全风险主体快照 |
| POST | `/api/admin/security/risk/ip/reset` | 👑🚦 MFA | 重置指定 IP 风险分 |
| GET | `/api/author/content/export` | 👑 | 全站内容备份包 |
| GET | `/api/author/articles/{articleId}/export` | 👑 | 导出 Markdown + frontmatter |
| POST | `/api/author/articles/import` | 👑 | 导入 Markdown + frontmatter |
| GET | `/api/author/audit` | 👑🚦 | 审计日志列表，支持 actor/action/target/outcome/time 过滤 |
| GET | `/api/author/audit/summary` | 👑🚦 | 审计 facet 汇总与写入 runtime |
| GET | `/api/author/audit/{id}` | 👑🚦 | 审计详情与 context |
| GET | `/api/author/audit/{id}/verify` | 👑🚦 | 单条防篡改证据校验 |
| GET | `/api/author/ops/health` | 👑🚦 | 运维健康：DB/Redis/audit/worker/search/backup/队列 |
| GET | `/api/author/ops/backup` | 👑🚦 | 最近站点备份和 restore drill 状态 |
| GET | `/api/author/ops/dangerous-operations/policy` | 👑🚦 | 管理端危险操作确认、MFA 与 diff 策略 |
| GET | `/api/author/cache/diagnostics` | 👑🚦 | AOT/PublicHotRead/search/sitemap/feed/comment cache 与 HotArticles/Stats 失效合并状态 |
| POST | `/api/author/cache/actions` | 👑🚦 | 手动重建 search/AOT 或清理 output cache |
| GET | `/api/author/integrity` | 👑🚦 | 数据一致性巡检报告 |
| GET | `/api/author/integrity/fix-preview` | 👑🚦 | 安全修复 diff 预览 |
| POST | `/api/author/integrity/fix` | 👑🚦 MFA | 应用安全修复，要求确认短语和 MFA proof |
| POST | `/api/author/ai-assist` | 👑 | 默认关闭的作者 AI 辅助 |

---

## 通知与健康检查

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/notifications/stream/preflight` | 🔓 | WebSocket 通知握手预检，成功返回 204 |
| GET | `/api/notifications/stream` | 🔓 | WebSocket 通知通道（子协议 `fsus-aeds.v2`） |
| POST | `/api/telemetry/rum` | 🔓🚦 | 废弃 JSON RUM 兼容入口；生产前端使用 `/api/binary/telemetry/rum` |
| GET | `/health/live` | 🔓 | JSON 存活探针（仅检查进程） |
| GET | `/health/ready` | 🔓 | JSON 就绪探针（检查配置、Observability、启动状态、DB、Redis） |

通知通道是 AEDS WebSocket notification stream，不是标准 Server-Sent Events，不使用 `EventSource` 或 `text/event-stream`。

---

## 速率限制策略

带 🚦 标记的端点受 `fixed_ip` 策略约束，按客户端 IP 计数。

- 超限响应：`429 Too Many Requests`
- 响应含 `Retry-After` 头（秒数）
- IP 提取：`X-Forwarded-For`（需 Nginx 正确配置 `proxy_set_header X-Forwarded-For`）

---

## 参见

- [design.md](design.md) — API 设计哲学与约定
- [contracts.md](contracts.md) — 请求/响应 DTO 完整定义
- [schemas-and-errors.md](schemas-and-errors.md) — 错误码与 Binary 帧格式
- [../api.md](../api.md) — API 总览（含 AEDS 帧格式附录）

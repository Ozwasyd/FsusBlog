# 路由速查表

所有 FsusBlog API 端点的快速索引。

**图例**

| 符号 | 含义 |
|------|------|
| 🔓 | 匿名可访问 |
| 🔑 | 需要登录（Bearer JWT） |
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

## 系统 — `/api/System`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
|------|------|------|------|------|
| GET | `/api/System/seo` | 🔓 | 🗄️ | 站点 SEO 配置 |
| GET | `/api/System/page/{slug}` | 🔓 | 🗄️ | 指定 slug 的静态页面内容 |

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

## 消息系统 — `/api/v1/messages`

> 整个路由组需要登录（🔑）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/messages/conversations` | 当前用户对话列表 |
| GET | `/api/v1/messages/conversations/{id}` | 对话详情与消息 |
| POST | `/api/v1/messages/conversations` | 发起新对话 |
| POST | `/api/v1/messages/conversations/{id}/reply` | 回复对话 |
| POST | `/api/v1/messages/conversations/{id}/read` | 标记对话已读 |

---

## 管理端消息 — `/api/v1/admin/messages`

> 整个路由组需要 admin 角色（👑）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/admin/messages/conversations` | 所有对话列表 |
| GET | `/api/v1/admin/messages/conversations/{id}` | 对话详情 |
| POST | `/api/v1/admin/messages/conversations/{id}/reply` | 以管理员身份回复 |
| POST | `/api/v1/admin/messages/conversations/{id}/status` | 更新对话状态（open/closed） |
| POST | `/api/v1/admin/messages/system-send` | 系统广播消息 |

## 开放分发与作者工作台

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/feed/rss.xml` | 🔓 | RSS 2.0 feed |
| GET | `/api/Article/rss` | 🔓 | RSS 历史兼容路径 |
| GET | `/feed/atom.xml` | 🔓 | Atom feed |
| GET | `/feed/feed.json` | 🔓 | JSON Feed 1.1 |
| GET | `/sitemap.xml` | 🔓 | 公开 sitemap，排除私有路由 |
| GET | `/robots.txt` | 🔓 | robots + sitemap 声明 |
| GET | `/api/public/articles/{articleId}/related` | 🔓 | 延伸阅读：相关文章 / 上一篇 / 下一篇 |
| POST | `/api/subscriptions` | 🔓 | 更新订阅，保存 email hash |
| DELETE | `/api/subscriptions` | 🔓 | 退订 |
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
| GET | `/api/author/analytics` | 👑 | 单作者分析 |
| GET | `/api/author/comments/moderation` | 👑 | 评论审核队列 |
| POST | `/api/author/comments/moderation/bulk` | 👑 | 批量评论审核 |
| POST | `/api/author/comments/{commentId}/moderation` | 👑 | 评论审核 |
| GET | `/api/author/content/export` | 👑 | 全站内容备份包 |
| GET | `/api/author/articles/{articleId}/export` | 👑 | 导出 Markdown + frontmatter |
| POST | `/api/author/articles/import` | 👑 | 导入 Markdown + frontmatter |
| POST | `/api/author/ai-assist` | 👑 | 默认关闭的作者 AI 辅助 |

---

## 通知与健康检查

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/notifications/stream/preflight` | 🔓 | WebSocket 通知握手预检，成功返回 204 |
| GET | `/api/notifications/stream` | 🔓 | WebSocket 通知通道（子协议 `fsus-aeds.v2`） |
| POST | `/api/telemetry/rum` | 🔓 | 匿名 RUM 性能样本 ingestion |
| GET | `/health/live` | 🔓 | JSON 存活探针（仅检查进程） |
| GET | `/health/ready` | 🔓 | JSON 就绪探针（检查配置、Observability、启动状态、DB、Redis） |

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

# API overview / selected quick reference

本文档是 FsusBlog 当前 API overview / selected quick reference，不再手写声明覆盖所有端点。完整 HTTP shell 契约以 `src/shared/Contracts/Validation/fsusblog.openapi.json` 为准，AEDS frame/header 以 `src/shared/Contracts/Validation/aeds-protocol.json` 为准，路由速查表见 [api/quick-reference.md](api/quick-reference.md)。
详细文档请参阅 [api/](api/) 子目录：

| 文档 | 说明 |
| ------ | ------ |
| [api/design.md](api/design.md) | API 设计哲学、响应格式约定、双链路决策 |
| [api/contracts.md](api/contracts.md) | 请求/响应 DTO 完整契约、通知 WebSocket 契约、AOT 契约 |
| [api/quick-reference.md](api/quick-reference.md) | 所有端点路由速查表（含认证 / 限流 / Binary 对照） |
| [api/schemas-and-errors.md](api/schemas-and-errors.md) | 错误码枚举、AEDS v2 帧格式、compact POD 大小目录 |

---

## 图例

| 符号 | 含义 |
| ------ | ------ |
| 🔓 | 匿名可访问 |
| 🔑 | 需要登录（HttpOnly Cookie session / AEDS auth frame） |
| 👑 | 需要 admin 角色 |
| 🚦 | 有速率限制（fixed_ip / public_read / read_proof 等策略） |

---

## Current Binary API

当前客户端主链优先调用 `/api/binary/**`，响应为 `application/octet-stream` AEDS v2 frame。认证、MFA、Passkey、公开读、评论、消息、上传、RUM telemetry、作者工作台、安全后台和管理读链都通过 AEDS frame/POD 契约校验；少量 JSON 端点仅用于健康检查、外部标准协议和废弃兼容。

| Family | Prefix | Auth | Notes |
| -------- | -------- | ------ | ------- |
| Public article/read | `/api/binary/article/**` | 🔓 | 首页、分类、标签、详情、热门与搜索 frame |
| Comment cursors | `/api/binary/comment/**` | 🔓 / 🔑 | 公开评论游标与可归因评论记录 |
| Auth / MFA / Passkey | `/api/binary/auth/**` | 🔓 / 🔑 | PoW、login flow、session、MFA、WebAuthn |
| Messages | `/api/binary/messages/**` | 🔑 | 用户站内信与已读状态 |
| Admin messages / stats / upload | `/api/binary/admin/**`, `/api/binary/stats`, `/api/binary/upload/**` | 👑 | 管理端 Binary read/write |
| Authoring / moderation console | `/api/binary/author/**` | 👑 | 作者工作台、审核、审计、运维、cache/integrity 通过 AEDS bridge；外部 `/api/author/**` 已移除 |
| Admin security console | `/api/binary/admin/security/**` | 👑 | 安全总览、AntiCrawler、PoW、风险分与规则/list 管理通过 AEDS bridge；外部 `/api/admin/security/**` 已移除 |
| Telemetry | `/api/binary/telemetry/rum` | 🔓 | batched AEDS RUM ingestion；旧 `/api/telemetry/rum` 已移除 |
| Notifications | `/api/notifications/stream` | 🔓 / 🔑 | WebSocket binary notification stream，子协议 `fsus-aeds.v2` |

Notification stream 使用 WebSocket 传输、`fsus-aeds.v2` 子协议和 AEDS 二进制通知帧；它不是标准 Server-Sent Events，不使用 `EventSource` 或 `text/event-stream`。

测试 helper 里的 `toBinaryPath()` 仅是兼容层映射说明，不代表旧 JSON route 是当前产品主 API。

---

## Auth — `/api/binary/auth`

### PoW 与账号入口

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/auth/pow-challenge` | 获取 Proof of Work 挑战 | 🔓 🚦 📦 |
| POST | `/api/binary/auth/anonymous/bootstrap` | 初始化匿名账号容器并写入当前 session；不接受密码 | 🔓 🚦 📦 |
| POST | `/api/binary/auth/refresh-token` | 使用 HttpOnly Cookie 续签 Access Token | 🔓 🚦 📦 |

### 当前用户

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/auth/me` | 获取当前匿名账号容器快照 | 🔑 📦 |
| PUT | `/api/binary/auth/public-handle` | 保存或清空当前匿名账号公开称呼 | 🔑 📦 |
| POST | `/api/binary/auth/logout` | 安全登出（吊销 Refresh Token） | 🔑 📦 |
| POST | `/api/binary/auth/delete-account` | 注销账号；请求 frame 只含确认文本，敏感操作 proof 走 `X-Fsus-Mfa-Proof` | 🔑 🚦 📦 |

### 会话管理

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/auth/sessions` | 获取活跃会话列表 | 🔑 📦 |
| POST | `/api/binary/auth/sessions/{id}/revoke` | 吊销指定会话 | 🔑 📦 |
| POST | `/api/binary/auth/sessions/revoke-others` | 吊销全部其他会话 | 🔑 📦 |

### MFA / TOTP

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| POST | `/api/binary/auth/mfa/setup/start` | 开始 MFA 设置，返回 TOTP 密钥与二维码 | 🔑 📦 |
| POST | `/api/binary/auth/mfa/setup/verify` | 验证 TOTP 码，完成 MFA 启用 | 🔑 📦 |
| GET | `/api/binary/auth/mfa/profile` | 查询 MFA 启用状态与恢复码剩余数 | 🔑 📦 |
| POST | `/api/binary/auth/mfa/disable` | 禁用 MFA | 🔑 📦 |
| POST | `/api/binary/auth/mfa/recovery/regenerate` | 重新生成恢复码 | 🔑 📦 |
| POST | `/api/binary/auth/mfa/challenge/start` | 登录后触发 MFA 挑战（返回挑战令牌） | 🔑 📦 |
| POST | `/api/binary/auth/mfa/challenge` | 提交 TOTP 码或恢复码完成 MFA | 🔓 📦 |
| POST | `/api/binary/auth/step-up/passkey/begin` | 普通账号敏感操作 Passkey step-up 开始；受 `Auth:PasskeyStepUp:Enabled` 控制 | 🔑 📦 |
| POST | `/api/binary/auth/step-up/passkey/complete` | 完成普通账号 Passkey step-up，返回 action 绑定 proof；关闭时 503 fail closed | 🔑 📦 |

---

## Auth — Passkey / WebAuthn — `/api/binary/auth/passkey`

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| POST | `/api/binary/auth/passkey/register/begin` | 开始注册 Passkey（返回 CredentialCreateOptions） | 🔑 |
| POST | `/api/binary/auth/passkey/register/complete` | 完成 Passkey 注册 | 🔑 |
| POST | `/api/binary/auth/passkey/login/begin` | 开始 Passkey 无密码登录（返回 AssertionOptions） | 🔓 🚦 |
| POST | `/api/binary/auth/passkey/login/complete` | 完成 Passkey 登录断言 | 🔓 🚦 |
| GET | `/api/binary/auth/passkey/credentials` | 获取当前用户已注册的 Passkey 列表（最多 5 枚） | 🔑 |
| DELETE | `/api/binary/auth/passkey/credentials/{id}` | 删除指定 Passkey | 🔑 |
| PUT | `/api/binary/auth/passkey/credentials/{id}/name` | 重命名指定 Passkey | 🔑 |

---

## Article — `/api/Article`

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/Article/` | 文章列表（分页） | 🔓 |
| GET | `/api/Article/{id}` | 文章详情 | 🔓 |
| GET | `/api/Article/hot` | 热门文章 | 🔓 |

---

## Comment — `/api/Comment`

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/Comment/{articleId}` | 指定文章的顶层评论（游标分页） | 🔓 |
| GET | `/api/Comment/{articleId}/thread/{rootId}` | 指定评论的回复线程 | 🔓 |
| GET | `/api/Comment/me` | 当前用户可归因评论记录 | 🔑 |

---

## Category — `/api/Category`

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/Category/` | 所有分类 | 🔓 |

---

## Tag — `/api/Tag`

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/Tag/` | 所有标签 | 🔓 |

---

## System — `/api/System`

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/System/seo` | 站点 SEO 配置 | 🔓 |
| GET | `/api/System/page/{slug}` | 指定 slug 的静态页面内容 | 🔓 |

---

## Binary — `/api/binary`

Binary 端点输出 AEDS v2 帧（`Content-Type: application/octet-stream`）。
帧格式：16 字节帧头（Magic、Version、HeaderLength、Flags、FrameType、PayloadLength、PayloadCrc16）+ compact POD 载荷。AEDS v1 不再兼容，旧客户端会被直接拒绝。
客户端小载荷默认走 TypeScript adapter 主线程解码；大载荷走 Web Worker / C++23 Wasm 解码器；解码失败不得回退到文本 API。

### 公开读

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/article/list/home/{page}/{size}.aeds` | 首页文章列表 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds` | 分类文章列表 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds` | 标签文章列表 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/article/{id}.aeds` | 文章详情 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/article/hot/{size}.aeds` | 热门文章 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/comment/{articleId}` | 文章评论（Binary） | 🔓 |
| GET | `/api/binary/comment/{articleId}/thread/{rootId}` | 评论线程（Binary） | 🔓 |

### 需认证

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/comment/me` | 当前用户可归因评论记录（Binary） | 🔑 |

### 管理端

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/stats` | Binary 聚合统计（overview + recent comments + regions） | 👑 |
| POST | `/api/binary/upload/*` | 分片上传 | 👑 |
| GET | `/api/binary/upload/*` | 分片上传查询 | 👑 |
| PUT | `/api/binary/upload/*` | 分片上传操作 | 👑 |
| DELETE | `/api/binary/upload/*` | 分片上传清理 | 👑 |

---

## Messages — `/api/binary/messages`

> 整个路由组需要登录。

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/messages/conversations` | 当前用户对话列表 | 🔑 |
| GET | `/api/binary/messages/conversations/{id}` | 对话详情与消息 | 🔑 |
| POST | `/api/binary/messages/conversations` | 发起新对话 | 🔑 |
| POST | `/api/binary/messages/conversations/{id}/reply` | 回复对话 | 🔑 |
| POST | `/api/binary/messages/conversations/{id}/read` | 标记对话已读 | 🔑 |

---

## Admin Messages — `/api/binary/admin/messages`

> 整个路由组需要 admin 角色。

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/admin/messages/conversations` | 所有对话列表 | 👑 |
| GET | `/api/binary/admin/messages/conversations/{id}` | 对话详情 | 👑 |
| POST | `/api/binary/admin/messages/conversations/{id}/reply` | 以管理员身份回复 | 👑 |
| POST | `/api/binary/admin/messages/conversations/{id}/status` | 更新对话状态 | 👑 |
| POST | `/api/binary/admin/messages/system-send` | 单账号系统消息（targetAccountId 必填） | 👑 |

---

## 通知与健康检查

| 方法 | 路径 | 描述 | 权限 |
| ------ | ------ | ------ | ------ |
| GET | `/api/notifications/stream` | WebSocket 通知通道（`fsus-aeds.v2`） | 🔓 |
| GET | `/health/live` | JSON 存活探针 | 🔓 |
| GET | `/health/ready` | JSON 最小就绪探针（仅 `status` / `checkedAt`） | 🔓 |
| GET | `/api/ops/health/ready-detail` | JSON 详细就绪报告（配置、DB、Redis、runtime、observability） | 👑 |
| GET | `/api/ops/crawler-ranges/status` | Crawler CIDR 同步状态 | 👑 |

---

## 速率限制说明

带 🚦 标记的端点受速率限制策略约束：认证/写入默认使用 `fixed_ip`，公开动态读使用 `public_read`，真人阅读 proof 使用 `read_proof`。超限返回 `429 Too Many Requests`，响应头包含 `Retry-After`，并写入 crawler risk 分。

客户端 IP 由 `ForwardedHeadersMiddleware` 处理后通过 `context.GetClientIp()` 读取，需要 Nginx/OpenResty 正确传递真实 IP；业务代码不得直接信任原始转发头。

## AEDS 帧格式

```text
Offset  Size  字段
0       4     Magic (0x53444541 "AEDS")
4       1     Version (2)
5       1     Header Length (16)
6       2     Flags
8       2     Frame Type
10      4     Payload Length (bytes)
14      2     Payload CRC16
16      N     Compact POD Payload
```

offset 8 是 `FrameType`，不是记录数；记录数属于各 payload 自己的 compact layout。
协议完整规格见 [../src/core/Algorithms/AEDS_V2_PROTOCOL.md](../src/core/Algorithms/AEDS_V2_PROTOCOL.md)。
## Current binary operations

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.operations
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.operations
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.operations -->
| Key | Value |
| --- | --- |
| binary_delete_admin_article_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/admin/article/{id:int}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"ConversationStatusMutationResult","successStatus":200} |
| binary_delete_admin_article_permanent_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/admin/article/permanent/{id:int}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_delete_admin_article_trash | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/admin/article/trash","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"TrashClearResponse","successStatus":200} |
| binary_delete_admin_security_anti_crawler_allowlist_id | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/admin/security/anti-crawler/allowlist/{id}","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AntiCrawlerListEntryDeleteResponse","successStatus":200} |
| binary_delete_admin_security_anti_crawler_blocklist_id | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/admin/security/anti-crawler/blocklist/{id}","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AntiCrawlerListEntryDeleteResponse","successStatus":200} |
| binary_delete_admin_security_anti_crawler_rules_id | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/admin/security/anti-crawler/rules/{id}","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AntiCrawlerRuleDeleteResponse","successStatus":200} |
| binary_delete_auth_passkey_credentials_id_int | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/auth/passkey/credentials/{id:int}","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"PasskeySignalState","successStatus":200} |
| binary_delete_author_assets_orphans | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/author/assets/orphans","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AssetCleanupResponse","successStatus":200} |
| binary_delete_author_drafts_draftKey | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/author/drafts/{draftKey}","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AuthorDraftDiscardResponse","successStatus":200} |
| binary_delete_category_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/category/{id:int}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_delete_comment_id_long | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/comment/{id:long}","permission":"none","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_delete_file_delete | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/file/delete","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"FileDeleteRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_delete_subscriptions | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/subscriptions","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SiteSubscriptionRequest","responseFrame":"SiteSubscriptionResponse","successStatus":200} |
| binary_delete_tag_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/tag/{id:int}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_delete_upload_uploadId | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"DELETE","path":"/api/binary/upload/{uploadId}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"UploadStatus","successStatus":200} |
| binary_get_admin_anonymous_governance_nullifiers | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/anonymous-governance/nullifiers","permission":"anonymous.nullifier.block","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AnonymousGovernanceActionResponse","successStatus":200} |
| binary_get_admin_anonymous_governance_status | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/anonymous-governance/status","permission":"anonymous.comment.configure","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AnonymousGovernanceActionResponse","successStatus":200} |
| binary_get_admin_article | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/article","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ArticleList","successStatus":200} |
| binary_get_admin_article_featured | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/article/featured","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ArticleFeatured","successStatus":200} |
| binary_get_admin_article_hot | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/article/hot","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ArticleHot","successStatus":200} |
| binary_get_admin_article_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/article/{id:int}","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ArticleDetail","successStatus":200} |
| binary_get_admin_messages_conversations | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/messages/conversations","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AdminConversationList","successStatus":200} |
| binary_get_admin_messages_conversations_id_long | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/messages/conversations/{id:long}","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AdminConversationDetail","successStatus":200} |
| binary_get_admin_security_anti_crawler_allowlist | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/anti-crawler/allowlist","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AntiCrawlerListEntryList","successStatus":200} |
| binary_get_admin_security_anti_crawler_blocklist | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/anti-crawler/blocklist","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AntiCrawlerListEntryList","successStatus":200} |
| binary_get_admin_security_anti_crawler_crawler_ranges_status | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/anti-crawler/crawler-ranges/status","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"CrawlerRangesAdminStatus","successStatus":200} |
| binary_get_admin_security_anti_crawler_events | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/anti-crawler/events","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"SecurityRiskEventList","successStatus":200} |
| binary_get_admin_security_anti_crawler_options | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/anti-crawler/options","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AntiCrawlerPolicySnapshot","successStatus":200} |
| binary_get_admin_security_anti_crawler_overview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/anti-crawler/overview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AntiCrawlerOverview","successStatus":200} |
| binary_get_admin_security_anti_crawler_risk_events | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/anti-crawler/risk-events","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"SecurityRiskEventList","successStatus":200} |
| binary_get_admin_security_anti_crawler_rules | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/anti-crawler/rules","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AntiCrawlerRuleList","successStatus":200} |
| binary_get_admin_security_challenges_overview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/challenges/overview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_get_admin_security_overview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/overview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_get_admin_security_perception_v2_options | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/perception-v2/options","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_get_admin_security_perception_v2_overview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/perception-v2/overview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_get_admin_security_policies_overview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/policies/overview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_get_admin_security_pow_events | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/pow/events","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"SecurityRiskEventList","successStatus":200} |
| binary_get_admin_security_pow_options | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/pow/options","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"PowPolicySnapshot","successStatus":200} |
| binary_get_admin_security_pow_overview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/pow/overview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"PowOverview","successStatus":200} |
| binary_get_admin_security_risk_control_options | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/risk-control/options","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_get_admin_security_risk_control_overview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/risk-control/overview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_get_admin_security_risk_events | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/risk/events","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"SecurityRiskEventList","successStatus":200} |
| binary_get_admin_security_risk_snapshots | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/security/risk/snapshots","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"SecurityRiskSnapshotList","successStatus":200} |
| binary_get_admin_users | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/admin/users","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AdminUserList","successStatus":200} |
| binary_get_anonymous_credential_blind_issuer | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/anonymous-credential/blind-issuer","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"BlindCredentialIssuerMetadata","successStatus":200} |
| binary_get_anonymous_credential_circuit | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/anonymous-credential/circuit","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"AnonymousCredentialRootSnapshot","successStatus":200} |
| binary_get_anonymous_credential_revocation_delta | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/delta/{baseVersion:long}.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"AnonymousCredentialRevocationDelta","successStatus":200} |
| binary_get_anonymous_credential_revocation_full | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/full.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"AnonymousCredentialRevocationSnapshot","successStatus":200} |
| binary_get_anonymous_credential_root | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/anonymous-credential/root","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"AnonymousCredentialRootSnapshot","successStatus":200} |
| binary_get_article_articleId_int_related_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/article/{articleId:int}/related.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ArticleRelatedReading","successStatus":200} |
| binary_get_article_featured_size_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/article/featured/{size}.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ArticleFeatured","successStatus":200} |
| binary_get_article_hot_size_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/article/hot/{size}.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ArticleHot","successStatus":200} |
| binary_get_article_id_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/article/{id}.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ArticleDetail","successStatus":200} |
| binary_get_article_list_archive_page_size_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/article/list/archive/{page:int}/{size:int}.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ArticleList","successStatus":200} |
| binary_get_article_list_category_categoryId_page_size_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/article/list/category/{categoryId:int}/{page:int}/{size:int}.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ArticleList","successStatus":200} |
| binary_get_article_list_home_page_size_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/article/list/home/{page:int}/{size:int}.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ArticleList","successStatus":200} |
| binary_get_article_list_tag_tagId_page_size_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/article/list/tag/{tagId:int}/{page:int}/{size:int}.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ArticleList","successStatus":200} |
| binary_get_auth_admin_me | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/admin/me","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AdminPrincipalSnapshot","successStatus":200} |
| binary_get_auth_admin_sessions | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/admin/sessions","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AdminSessionList","successStatus":200} |
| binary_get_auth_enrollment_status | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/enrollment/status","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AuthLoginFlow","successStatus":200} |
| binary_get_auth_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/{id:int}","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"CurrentUserSnapshot","successStatus":200} |
| binary_get_auth_me | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/me","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"IdentityAccountSnapshot","successStatus":200} |
| binary_get_auth_mfa_profile | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/mfa/profile","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"MfaProfile","successStatus":200} |
| binary_get_auth_passkey_credentials | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/passkey/credentials","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"PasskeyCredentialList","successStatus":200} |
| binary_get_auth_passkey_signal_state | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/passkey/signal-state","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"PasskeySignalState","successStatus":200} |
| binary_get_auth_pow_challenge | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/pow-challenge","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PowChallenge","successStatus":200} |
| binary_get_auth_sessions | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/auth/sessions","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AuthSessionList","successStatus":200} |
| binary_get_author_analytics | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/analytics","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AuthorAnalytics","successStatus":200} |
| binary_get_author_articles_articleId_int_export | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/articles/{articleId:int}/export","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ContentExport","successStatus":200} |
| binary_get_author_articles_articleId_int_revisions | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/articles/{articleId:int}/revisions","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ArticleRevisionList","successStatus":200} |
| binary_get_author_articles_articleId_int_revisions_revisionId_long | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ArticleRevisionDetail","successStatus":200} |
| binary_get_author_articles_articleId_int_revisions_revisionId_long_responsibility | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/responsibility","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ArticleResponsibilityHistory","successStatus":200} |
| binary_get_author_assets | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/assets","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AssetLibraryList","successStatus":200} |
| binary_get_author_audit | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/audit","permission":"audit.read","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AuditLogList","successStatus":200} |
| binary_get_author_audit_id_long | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/audit/{id:long}","permission":"audit.read","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AuditLogDetail","successStatus":200} |
| binary_get_author_audit_id_long_verify | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/audit/{id:long}/verify","permission":"audit.read","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AuditTamperVerifyResponse","successStatus":200} |
| binary_get_author_audit_summary | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/audit/summary","permission":"audit.read","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AuditLogSummary","successStatus":200} |
| binary_get_author_cache_diagnostics | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/cache/diagnostics","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"CacheDiagnostics","successStatus":200} |
| binary_get_author_comments_commentId_long_moderation_timeline | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/comments/{commentId:long}/moderation-timeline","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"CommentModerationTimeline","successStatus":200} |
| binary_get_author_comments_commentId_long_revisions | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/comments/{commentId:long}/revisions","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"CommentRevisionList","successStatus":200} |
| binary_get_author_comments_moderation | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/comments/moderation","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"CommentModerationQueue","successStatus":200} |
| binary_get_author_content_export | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/content/export","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ContentBackupExport","successStatus":200} |
| binary_get_author_drafts_draftKey | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/drafts/{draftKey}","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AuthorDraftResponse","successStatus":200} |
| binary_get_author_integrity | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/integrity","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"IntegrityReport","successStatus":200} |
| binary_get_author_integrity_fix_preview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/integrity/fix-preview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"IntegrityFixPreview","successStatus":200} |
| binary_get_author_moderation_anonymous_comment_policy | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/anonymous-comment-policy","permission":"anonymous.comment.configure","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"CommentPolicySnapshot","successStatus":200} |
| binary_get_author_moderation_articles_articleId_int_comment_policy | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/articles/{articleId:int}/comment-policy","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"CommentPolicySnapshot","successStatus":200} |
| binary_get_author_moderation_dictionaries | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/dictionaries","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ModerationDictionarySnapshot","successStatus":200} |
| binary_get_author_moderation_effective_policy_regionCode | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/effective-policy/{regionCode}","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"ModerationEffectivePolicy","successStatus":200} |
| binary_get_author_moderation_model_status | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/model/status","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ModerationModelStatus","successStatus":200} |
| binary_get_author_moderation_overview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/overview","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ModerationOverview","successStatus":200} |
| binary_get_author_moderation_policies | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/policies","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"RegionPolicySummaryList","successStatus":200} |
| binary_get_author_moderation_policy_templates | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/policy-templates","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ModerationPolicyTemplateList","successStatus":200} |
| binary_get_author_moderation_region_groups | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/region-groups","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ModerationRegionGroupList","successStatus":200} |
| binary_get_author_moderation_regions | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/regions","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ModerationRegionList","successStatus":200} |
| binary_get_author_moderation_runtime_status | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/moderation/runtime/status","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ModerationRuntimeStatus","successStatus":200} |
| binary_get_author_ops_backup | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/ops/backup","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"BackupStatus","successStatus":200} |
| binary_get_author_ops_dangerous_operations_policy | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/ops/dangerous-operations/policy","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"DangerousOperationPolicy","successStatus":200} |
| binary_get_author_ops_health | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/ops/health","permission":"audit.read","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"OpsHealth","successStatus":200} |
| binary_get_author_plugins | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/plugins","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PluginAdminSnapshot","successStatus":200} |
| binary_get_author_plugins_pluginId | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/plugins/{pluginId}","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PluginAdminSnapshot","successStatus":200} |
| binary_get_author_taxonomy_categories | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/taxonomy/categories","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AuthorTaxonomyCategoryList","successStatus":200} |
| binary_get_author_taxonomy_tags | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/author/taxonomy/tags","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AuthorTaxonomyTagList","successStatus":200} |
| binary_get_category | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/category","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"CategoryList","successStatus":200} |
| binary_get_category_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/category.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"CategoryList","successStatus":200} |
| binary_get_comment_articleId_int | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/comment/{articleId:int}","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"CommentTreeRootCursor","successStatus":200} |
| binary_get_comment_articleId_int_children_parentId_long | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/comment/{articleId:int}/children/{parentId:long}","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"CommentChildCursor","successStatus":200} |
| binary_get_comment_articleId_int_context_commentId_long | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/comment/{articleId:int}/context/{commentId:long}","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"CommentPermalinkContext","successStatus":200} |
| binary_get_comment_articleId_int_thread_rootId_long | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/comment/{articleId:int}/thread/{rootId:long}","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"CommentThreadReplyCursor","successStatus":200} |
| binary_get_comment_me | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/comment/me","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"CommentUserCursor","successStatus":200} |
| binary_get_comment_policy | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/comment/policy","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"CommentPolicySnapshot","successStatus":200} |
| binary_get_locale_preference | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/locale-preference","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"UserLocalePreference","successStatus":200} |
| binary_get_messages_conversations | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/messages/conversations","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ConversationList","successStatus":200} |
| binary_get_messages_conversations_id_long | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/messages/conversations/{id:long}","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"ConversationDetailV3","successStatus":200} |
| binary_get_stats | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/stats","permission":"audit.read","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AdminStats","successStatus":200} |
| binary_get_stats_recent_comments | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/stats/recent-comments","permission":"audit.read","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"RecentCommentStats","successStatus":200} |
| binary_get_stats_regions | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/stats/regions","permission":"audit.read","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"RegionStats","successStatus":200} |
| binary_get_system_admin_compliance | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/system/admin/compliance","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SiteComplianceConfig","successStatus":200} |
| binary_get_system_admin_page_slug | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/system/admin/page/{slug}","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"PageContent","successStatus":200} |
| binary_get_system_admin_seo | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/system/admin/seo","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SeoConfig","successStatus":200} |
| binary_get_system_compliance | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/system/compliance","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SiteComplianceConfig","successStatus":200} |
| binary_get_system_page_slug | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/system/page/{slug}","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"PageContent","successStatus":200} |
| binary_get_system_seo | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/system/seo","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"SeoConfig","successStatus":200} |
| binary_get_tag | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/tag","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"TagList","successStatus":200} |
| binary_get_tag_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"GET","path":"/api/binary/tag.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"TagList","successStatus":200} |
| binary_get_upload_uploadId_status | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/upload/{uploadId}/status","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"UploadStatus","successStatus":200} |
| binary_get_upload_uploadId_status_parts | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"GET","path":"/api/binary/upload/{uploadId}/status/parts","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"UploadPartMap","successStatus":200} |
| binary_post_admin_anonymous_governance_credentials_revoke | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/anonymous-governance/credentials/revoke","permission":"anonymous.credential.revoke","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AnonymousGovernanceActionRequest","responseFrame":"AnonymousGovernanceActionResponse","successStatus":200} |
| binary_post_admin_anonymous_governance_nullifiers_block | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/anonymous-governance/nullifiers/block","permission":"anonymous.nullifier.block","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AnonymousGovernanceActionRequest","responseFrame":"AnonymousGovernanceActionResponse","successStatus":200} |
| binary_post_admin_article | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/article","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"ArticleWriteRequest","responseFrame":"MutationId","successStatus":200} |
| binary_post_admin_messages_conversations_id_long_reply | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/messages/conversations/{id:long}/reply","permission":"admin.manage","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"ConversationReplyRequest","responseFrame":"ConversationMessage","successStatus":200} |
| binary_post_admin_messages_conversations_id_long_status | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/messages/conversations/{id:long}/status","permission":"admin.manage","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"ConversationStatusRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_admin_messages_system_send | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/messages/system-send","permission":"admin.manage","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"SystemMessageRequest","responseFrame":"ConversationDetailV2","successStatus":200} |
| binary_post_admin_security_anti_crawler_allowlist | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/anti-crawler/allowlist","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AntiCrawlerListEntryRequest","responseFrame":"AntiCrawlerListEntryResponse","successStatus":200} |
| binary_post_admin_security_anti_crawler_blocklist | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/anti-crawler/blocklist","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AntiCrawlerListEntryRequest","responseFrame":"AntiCrawlerListEntryResponse","successStatus":200} |
| binary_post_admin_security_anti_crawler_crawler_ranges_sync | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/anti-crawler/crawler-ranges/sync","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"CrawlerRangeSyncResponse","successStatus":200} |
| binary_post_admin_security_anti_crawler_options_rollback | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/anti-crawler/options/rollback","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"AntiCrawlerPolicySnapshot","successStatus":200} |
| binary_post_admin_security_anti_crawler_rules | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/anti-crawler/rules","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AntiCrawlerRuleRequest","responseFrame":"AntiCrawlerRuleResponse","successStatus":200} |
| binary_post_admin_security_anti_crawler_simulate | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/anti-crawler/simulate","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AntiCrawlerSimulationRequest","responseFrame":"AntiCrawlerSimulationResult","successStatus":200} |
| binary_post_admin_security_perception_v2_options_rollback | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/perception-v2/options/rollback","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_post_admin_security_pow_options_rollback | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/pow/options/rollback","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PowPolicySnapshot","successStatus":200} |
| binary_post_admin_security_pow_simulate | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/pow/simulate","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AntiCrawlerSimulationRequest","responseFrame":"AntiCrawlerSimulationResult","successStatus":200} |
| binary_post_admin_security_risk_control_options_rollback | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/risk-control/options/rollback","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"SecurityOverview","successStatus":200} |
| binary_post_admin_security_risk_control_simulate | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/risk-control/simulate","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SecurityOverview","responseFrame":"SecurityOverview","successStatus":200} |
| binary_post_admin_security_risk_dimension_reset | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/admin/security/risk/{dimension}/reset","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SecurityRiskResetRequest","responseFrame":"SecurityRiskResetResponse","successStatus":200} |
| binary_post_anonymous_credential_blind_issue | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/anonymous-credential/blind-issue","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"BlindCredentialIssueRequest","responseFrame":"BlindCredentialIssueResponse","successStatus":200} |
| binary_post_anonymous_credential_revocation_retired | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/anonymous-credential/revocation-witness","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"none","responseFrame":"ApiError","successStatus":410} |
| binary_post_auth_admin_bootstrap_passkey_begin | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/bootstrap/passkey/begin","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PasskeyRegisterBegin","successStatus":200} |
| binary_post_auth_admin_bootstrap_passkey_complete | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/bootstrap/passkey/complete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PasskeyRegisterCompleteRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_admin_login_passkey_begin | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/login/passkey/begin","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PasskeyLoginBegin","successStatus":200} |
| binary_post_auth_admin_login_passkey_complete | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/login/passkey/complete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PasskeyLoginCompleteRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_admin_logout | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/logout","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_admin_sessions_revoke_others | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/sessions/revoke-others","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_admin_sessions_sessionId_revoke | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/sessions/{sessionId}/revoke","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_admin_step_up_passkey_begin | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/step-up/passkey/begin","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PasskeyLoginBegin","successStatus":200} |
| binary_post_auth_admin_step_up_passkey_complete | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/admin/step-up/passkey/complete","permission":"admin.manage","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PasskeyLoginCompleteRequest","responseFrame":"MfaChallengeResult","successStatus":200} |
| binary_post_auth_anonymous_bootstrap | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/anonymous/bootstrap","permission":"none","pow":true,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AuthAnonymousBootstrapRequest","responseFrame":"AuthLoginFlow","successStatus":200} |
| binary_post_auth_delete_account | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/delete-account","permission":"none","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"AuthDeleteAccountRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_enrollment_cancel | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/enrollment/cancel","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_enrollment_passkey_register_begin | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/enrollment/passkey/register/begin","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PasskeyRegisterBegin","successStatus":200} |
| binary_post_auth_enrollment_passkey_register_complete | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/enrollment/passkey/register/complete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PasskeyRegisterCompleteRequest","responseFrame":"AuthLoginFlow","successStatus":200} |
| binary_post_auth_logout | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/logout","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_mfa_challenge | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/mfa/challenge","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"MfaChallengeVerifyRequest","responseFrame":"MfaChallengeResult","successStatus":200} |
| binary_post_auth_mfa_challenge_start | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/mfa/challenge/start","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"MfaChallengeStartRequest","responseFrame":"MfaChallengeResult","successStatus":200} |
| binary_post_auth_mfa_disable | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/mfa/disable","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_mfa_recovery_regenerate | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/mfa/recovery/regenerate","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"MfaSetupVerify","successStatus":200} |
| binary_post_auth_mfa_setup_start | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/mfa/setup/start","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"MfaSetupStart","successStatus":200} |
| binary_post_auth_mfa_setup_verify | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/mfa/setup/verify","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"MfaSetupVerifyRequest","responseFrame":"MfaSetupVerify","successStatus":200} |
| binary_post_auth_passkey_login_begin | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/passkey/login/begin","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"PasskeyLoginBegin","successStatus":200} |
| binary_post_auth_passkey_login_complete | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/passkey/login/complete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PasskeyLoginCompleteRequest","responseFrame":"AuthLoginFlow","successStatus":200} |
| binary_post_auth_passkey_register_begin | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/passkey/register/begin","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"PasskeyRegisterBegin","successStatus":200} |
| binary_post_auth_passkey_register_complete | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/passkey/register/complete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"PasskeyRegisterCompleteRequest","responseFrame":"PasskeySignalState","successStatus":200} |
| binary_post_auth_recovery_key_create | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/recovery-key/create","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"RecoveryKeyCreateResponse","successStatus":200} |
| binary_post_auth_recovery_key_passkey_register_begin | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/recovery-key/passkey/register/begin","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"RecoveryKeySessionRequest","responseFrame":"PasskeyRegisterBegin","successStatus":200} |
| binary_post_auth_recovery_key_passkey_register_complete | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/recovery-key/passkey/register/complete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PasskeyRegisterCompleteRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_recovery_key_rotate | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/recovery-key/rotate","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"RecoveryKeyCreateResponse","successStatus":200} |
| binary_post_auth_recovery_key_verify | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/recovery-key/verify","permission":"none","pow":true,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"RecoveryKeyVerifyRequest","responseFrame":"RecoveryKeyVerifyResponse","successStatus":200} |
| binary_post_auth_refresh_token | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/refresh-token","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_sessions_id_revoke | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/sessions/{id}/revoke","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_sessions_revoke_others | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/sessions/revoke-others","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_auth_step_up_passkey_begin | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/step-up/passkey/begin","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"MfaChallengeStartRequest","responseFrame":"PasskeyLoginBegin","successStatus":200} |
| binary_post_auth_step_up_passkey_complete | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/auth/step-up/passkey/complete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PasskeyLoginCompleteRequest","responseFrame":"MfaChallengeResult","successStatus":200} |
| binary_post_author_ai_assist | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/ai-assist","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"AiAssistRequest","responseFrame":"AiAssistResponse","successStatus":200} |
| binary_post_author_articles_articleId_int_assets_reindex | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/articles/{articleId:int}/assets/reindex","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"AssetLibraryList","successStatus":200} |
| binary_post_author_articles_articleId_int_revisions_revisionId_long_rollback | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/rollback","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"ArticleRevisionRollbackRequest","responseFrame":"MutationId","successStatus":200} |
| binary_post_author_articles_import | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/articles/import","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"ContentImportRequest","responseFrame":"ContentImportResponse","successStatus":200} |
| binary_post_author_cache_actions | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/cache/actions","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AdminCacheActionRequest","responseFrame":"AdminCacheActionResponse","successStatus":200} |
| binary_post_author_comments_commentId_long_moderation | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/comments/{commentId:long}/moderation","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentModerationRequest","responseFrame":"CommentModerationResult","successStatus":200} |
| binary_post_author_comments_commentId_long_moderation_claim | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/comments/{commentId:long}/moderation/claim","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentModerationClaimRequest","responseFrame":"CommentModerationClaimResponse","successStatus":200} |
| binary_post_author_comments_commentId_long_moderation_claim_release | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/comments/{commentId:long}/moderation/claim/release","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentModerationClaimMutationRequest","responseFrame":"CommentModerationClaimResponse","successStatus":200} |
| binary_post_author_comments_commentId_long_moderation_claim_renew | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/comments/{commentId:long}/moderation/claim/renew","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentModerationClaimMutationRequest","responseFrame":"CommentModerationClaimResponse","successStatus":200} |
| binary_post_author_comments_moderation_anonymous_credentials_credentialId_revoke | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/comments/moderation/anonymous-credentials/{credentialId:long}/revoke","permission":"anonymous.credential.revoke","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AnonymousGovernanceActionRequest","responseFrame":"AnonymousGovernanceActionResponse","successStatus":200} |
| binary_post_author_comments_moderation_bulk | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/comments/moderation/bulk","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentModerationBulkRequest","responseFrame":"CommentModerationBulkResponse","successStatus":200} |
| binary_post_author_comments_moderation_nullifiers_block | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/comments/moderation/nullifiers/block","permission":"anonymous.nullifier.block","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AnonymousGovernanceActionRequest","responseFrame":"AnonymousGovernanceActionResponse","successStatus":200} |
| binary_post_author_drafts | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/drafts","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"AuthorDraftSaveRequest","responseFrame":"AuthorDraftResponse","successStatus":200} |
| binary_post_author_integrity_fix | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/integrity/fix","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"IntegrityFixRequest","responseFrame":"IntegrityFixResponse","successStatus":200} |
| binary_post_author_moderation_appeals_appealId_long_decision | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/appeals/{appealId:long}/decision","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentAppealDecisionRequest","responseFrame":"CommentAppealDecisionResult","successStatus":200} |
| binary_post_author_moderation_dictionaries_dictionaryId_disable | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/dictionaries/{dictionaryId}/disable","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"ModerationDictionaryStateRequest","responseFrame":"ModerationRuntimeStatus","successStatus":200} |
| binary_post_author_moderation_dictionaries_dictionaryId_enable | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/dictionaries/{dictionaryId}/enable","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"ModerationDictionaryStateRequest","responseFrame":"ModerationRuntimeStatus","successStatus":200} |
| binary_post_author_moderation_dictionaries_reload | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/dictionaries/reload","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"ModerationDictionaryReloadResponse","successStatus":200} |
| binary_post_author_moderation_dictionaries_rollback | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/dictionaries/rollback","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"ModerationDictionarySnapshot","successStatus":200} |
| binary_post_author_moderation_effective_policy_preview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/effective-policy/preview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"ModerationEffectivePolicyPreviewRequest","responseFrame":"ModerationEffectivePolicy","successStatus":200} |
| binary_post_author_moderation_model_reload | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/model/reload","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"ModerationRuntimeStatus","successStatus":200} |
| binary_post_author_moderation_model_rollback | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/model/rollback","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"ModerationRuntimeStatus","successStatus":200} |
| binary_post_author_moderation_model_runtime | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/model/runtime","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"ModerationModelRuntimeRequest","responseFrame":"ModerationRuntimeStatus","successStatus":200} |
| binary_post_author_moderation_replay_preview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/replay/preview","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"ModerationReplayPreviewRequest","responseFrame":"ModerationReplayPreview","successStatus":200} |
| binary_post_author_moderation_runtime_global_state | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/runtime/global-state","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"ModerationRuntimeGlobalStateRequest","responseFrame":"ModerationRuntimeStatus","successStatus":200} |
| binary_post_author_moderation_runtime_region_state | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/moderation/runtime/region-state","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"ModerationRuntimeRegionStateRequest","responseFrame":"ModerationRuntimeStatus","successStatus":200} |
| binary_post_author_plugins_install | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/plugins/install","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PluginPackageInstallRequest","responseFrame":"PluginAdminSnapshot","successStatus":200} |
| binary_post_author_plugins_pluginId_actions | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/plugins/{pluginId}/actions","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PluginAdminMutationRequest","responseFrame":"PluginAdminSnapshot","successStatus":200} |
| binary_post_author_prepublish_check | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/prepublish-check","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"PrepublishCheckRequest","responseFrame":"PrepublishCheckResponse","successStatus":200} |
| binary_post_author_preview | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/author/preview","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"ArticlePreviewRequest","responseFrame":"ArticlePreviewResponse","successStatus":200} |
| binary_post_category | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/category","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"CategoryWriteRequest","responseFrame":"MutationId","successStatus":200} |
| binary_post_comment | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment","permission":"none","pow":true,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentCreateV2Request","responseFrame":"CommentCreateResult","successStatus":200} |
| binary_post_comment_anonymous | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/anonymous","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"AnonymousCommentCreateRequest","responseFrame":"AnonymousCommentCreateResult","successStatus":200} |
| binary_post_comment_anonymous_ticket | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/anonymous-ticket","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"public_read","requestFrame":"AnonymousCommentTicketRequest","responseFrame":"AnonymousCommentTicketResponse","successStatus":200} |
| binary_post_comment_id_long_anonymous_report | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/anonymous-report","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentReportRequest","responseFrame":"CommentReportResult","successStatus":200} |
| binary_post_comment_id_long_author_appeal | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/author/appeal","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentAuthorAppealRequest","responseFrame":"CommentAuthorMutationResult","successStatus":200} |
| binary_post_comment_id_long_author_challenge | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/author/challenge","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentManagementChallengeRequest","responseFrame":"CommentManagementChallengeResponse","successStatus":200} |
| binary_post_comment_id_long_author_delete | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/author/delete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentAuthorStatusRequest","responseFrame":"CommentAuthorMutationResult","successStatus":200} |
| binary_post_comment_id_long_author_edit | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/author/edit","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentAuthorEditRequest","responseFrame":"CommentAuthorMutationResult","successStatus":200} |
| binary_post_comment_id_long_management_appeal | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/management/appeal","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentAuthorAppealRequest","responseFrame":"CommentAuthorMutationResult","successStatus":200} |
| binary_post_comment_id_long_management_challenge | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/management/challenge","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentManagementChallengeRequest","responseFrame":"CommentManagementChallengeResponse","successStatus":200} |
| binary_post_comment_id_long_management_delete | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/management/delete","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentAuthorStatusRequest","responseFrame":"CommentAuthorMutationResult","successStatus":200} |
| binary_post_comment_id_long_management_edit | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/management/edit","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentAuthorEditRequest","responseFrame":"CommentAuthorMutationResult","successStatus":200} |
| binary_post_comment_id_long_management_status | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/management/status","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentAuthorStatusRequest","responseFrame":"CommentAuthorStatusResult","successStatus":200} |
| binary_post_comment_id_long_report | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/comment/{id:long}/report","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentReportRequest","responseFrame":"CommentReportResult","successStatus":200} |
| binary_post_messages_conversations | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/messages/conversations","permission":"none","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"ConversationCreateRequest","responseFrame":"ConversationDetailV2","successStatus":200} |
| binary_post_messages_conversations_id_long_read | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/messages/conversations/{id:long}/read","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"ConversationReadRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_messages_conversations_id_long_reply | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/messages/conversations/{id:long}/reply","permission":"none","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"AccountConversationReplyRequest","responseFrame":"ConversationMessage","successStatus":200} |
| binary_post_read_proof_challenge_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/read-proof/challenge.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"read_proof","requestFrame":"HumanReadChallengeRequest","responseFrame":"HumanReadChallengeResponse","successStatus":200} |
| binary_post_read_proof_submit_aeds | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/read-proof/submit.aeds","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"read_proof","requestFrame":"HumanReadSubmitRequest","responseFrame":"HumanReadSubmitResponse","successStatus":200} |
| binary_post_security_challenge | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/security/challenge","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SecurityChallengeIssueRequest","responseFrame":"SecurityChallengeIssueResponse","successStatus":200} |
| binary_post_security_challenge_cancel | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/security/challenge/cancel","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SecurityChallengeCancelRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_security_challenge_verify | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/security/challenge/verify","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SecurityChallengeVerifyRequest","responseFrame":"SecurityChallengeVerifyResponse","successStatus":200} |
| binary_post_subscriptions | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/subscriptions","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SiteSubscriptionRequest","responseFrame":"SiteSubscriptionResponse","successStatus":200} |
| binary_post_system_page_refresh_slug | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/system/page/refresh/{slug}","permission":"system.config","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_post_tag | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/tag","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"TagWriteRequest","responseFrame":"MutationId","successStatus":200} |
| binary_post_telemetry_rum | {"aedsVersion":2,"auth":"anonymous","cache":"public-read","errorFrame":"ApiError","method":"POST","path":"/api/binary/telemetry/rum","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"RumMetricBatchRequest","responseFrame":"RumMetricIngestResponse","successStatus":200} |
| binary_post_upload_init | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/upload/init","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"UploadInitRequest","responseFrame":"UploadInit","successStatus":200} |
| binary_post_upload_uploadId_complete | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"POST","path":"/api/binary/upload/{uploadId}/complete","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"UploadCompleteRequest","responseFrame":"UploadComplete","successStatus":200} |
| binary_put_admin_article_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/admin/article/{id:int}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"ArticleWriteRequest","responseFrame":"MutationId","successStatus":200} |
| binary_put_admin_article_restore_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/admin/article/restore/{id:int}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"none","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_admin_security_anti_crawler_options | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/admin/security/anti-crawler/options","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AntiCrawlerOptionsUpdateRequest","responseFrame":"AntiCrawlerPolicySnapshot","successStatus":200} |
| binary_put_admin_security_anti_crawler_rules_id | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/admin/security/anti-crawler/rules/{id}","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AntiCrawlerRuleRequest","responseFrame":"AntiCrawlerRuleResponse","successStatus":200} |
| binary_put_admin_security_perception_v2_options | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/admin/security/perception-v2/options","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SecurityOverview","responseFrame":"SecurityOverview","successStatus":200} |
| binary_put_admin_security_pow_options | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/admin/security/pow/options","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"PowOptionsUpdateRequest","responseFrame":"PowPolicySnapshot","successStatus":200} |
| binary_put_admin_security_risk_control_options | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/admin/security/risk-control/options","permission":"system.config","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"SecurityOverview","responseFrame":"SecurityOverview","successStatus":200} |
| binary_put_admin_users_status | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/admin/users/status","permission":"admin.manage","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"AdminChangeUserStatusRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_auth_passkey_credentials_id_int_name | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/auth/passkey/credentials/{id:int}/name","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"PasskeyCredentialFriendlyNameUpdateRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_auth_public_handle | {"aedsVersion":2,"auth":"user","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/auth/public-handle","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"AuthUpdatePublicHandleRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_author_articles_articleId_int_revisions_revisionId_long_responsibility | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/responsibility","permission":"article.write","pow":false,"protocol":"AEDS","rateLimit":"none","requestFrame":"ArticleResponsibilityRequest","responseFrame":"ArticleResponsibilityResponse","successStatus":200} |
| binary_put_author_moderation_anonymous_comment_policy | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/author/moderation/anonymous-comment-policy","permission":"anonymous.comment.configure","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentPolicyUpdateRequest","responseFrame":"CommentPolicySnapshot","successStatus":200} |
| binary_put_author_moderation_articles_articleId_int_comment_policy | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/author/moderation/articles/{articleId:int}/comment-policy","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentPolicyUpdateRequest","responseFrame":"CommentPolicySnapshot","successStatus":200} |
| binary_put_author_moderation_articles_articleId_int_comment_threads_rootId_long | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/author/moderation/articles/{articleId:int}/comment-threads/{rootId:long}","permission":"comment.moderate","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"CommentPolicyUpdateRequest","responseFrame":"CommentPolicySnapshot","successStatus":200} |
| binary_put_category_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/category/{id:int}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"CategoryWriteRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_locale_preference | {"aedsVersion":2,"auth":"anonymous","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/locale-preference","permission":"none","pow":false,"protocol":"AEDS","rateLimit":"fixed_ip","requestFrame":"UserLocalePreferenceUpdateRequest","responseFrame":"UserLocalePreference","successStatus":200} |
| binary_put_system_compliance | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/system/compliance","permission":"system.config","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"SiteComplianceConfigUpdateRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_system_page | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/system/page","permission":"system.config","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"PageContentUpdateRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_system_seo | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/system/seo","permission":"system.config","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"SeoConfigUpdateRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_tag_id_int | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/tag/{id:int}","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"TagWriteRequest","responseFrame":"EmptySuccess","successStatus":200} |
| binary_put_upload_uploadId_part | {"aedsVersion":2,"auth":"admin","cache":"no-store","errorFrame":"ApiError","method":"PUT","path":"/api/binary/upload/{uploadId}/part","permission":"article.write","pow":true,"protocol":"AEDS","rateLimit":"none","requestFrame":"none","responseFrame":"UploadPartAck","successStatus":200} |
<!-- FSUSBLOG-GENERATED:END api.operations -->

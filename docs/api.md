# API overview / selected quick reference

本文档是 FsusBlog 当前 API overview / selected quick reference，不再手写声明覆盖所有端点。完整 HTTP shell 契约以 `src/shared/Contracts/Validation/fsusblog.openapi.json` 为准，AEDS frame/header 以 `src/shared/Contracts/Validation/aeds-protocol.json` 为准，路由速查表见 [api/quick-reference.md](api/quick-reference.md)。
详细文档请参阅 [api/](api/) 子目录：

| 文档 | 说明 |
|------|------|
| [api/design.md](api/design.md) | API 设计哲学、响应格式约定、双链路决策 |
| [api/contracts.md](api/contracts.md) | 请求/响应 DTO 完整契约、通知 WebSocket 契约、AOT 契约 |
| [api/quick-reference.md](api/quick-reference.md) | 所有端点路由速查表（含认证 / 限流 / Binary 对照） |
| [api/schemas-and-errors.md](api/schemas-and-errors.md) | 错误码枚举、AEDS v2 帧格式、compact POD 大小目录 |

---

**图例**

| 符号 | 含义 |
|------|------|
| 🔓 | 匿名可访问 |
| 🔑 | 需要登录（HttpOnly Cookie session / AEDS auth frame） |
| 👑 | 需要 admin 角色 |
| 🚦 | 有速率限制（fixed_ip / public_read / read_proof 等策略） |

---

## Current Binary API

当前客户端主链优先调用 `/api/binary/**`，响应为 `application/octet-stream` AEDS v2 frame。认证、MFA、Passkey、公开读、评论、消息、上传、RUM telemetry、作者工作台、安全后台和管理读链都通过 AEDS frame/POD 契约校验；少量 JSON 端点仅用于健康检查、外部标准协议和废弃兼容。

| Family | Prefix | Auth | Notes |
|--------|--------|------|-------|
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

## Legacy Aliases

## Auth — `/api/binary/auth`

### PoW 与账号入口

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/auth/pow-challenge` | 获取 Proof of Work 挑战 | 🔓 🚦 📦 |
| POST | `/api/binary/auth/anonymous/bootstrap` | 初始化匿名账号容器并写入当前 session；不接受密码 | 🔓 🚦 📦 |
| POST | `/api/binary/auth/refresh-token` | 使用 HttpOnly Cookie 续签 Access Token | 🔓 🚦 📦 |

### 当前用户

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/auth/me` | 获取当前匿名账号容器快照 | 🔑 📦 |
| PUT | `/api/binary/auth/public-handle` | 保存或清空当前匿名账号公开称呼 | 🔑 📦 |
| POST | `/api/binary/auth/logout` | 安全登出（吊销 Refresh Token） | 🔑 📦 |
| POST | `/api/binary/auth/delete-account` | 注销账号；请求 frame 只含确认文本，敏感操作 proof 走 `X-Fsus-Mfa-Proof` | 🔑 🚦 📦 |

### 会话管理

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/auth/sessions` | 获取活跃会话列表 | 🔑 📦 |
| POST | `/api/binary/auth/sessions/{id}/revoke` | 吊销指定会话 | 🔑 📦 |
| POST | `/api/binary/auth/sessions/revoke-others` | 吊销全部其他会话 | 🔑 📦 |

### MFA / TOTP

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
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
|------|------|------|------|
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
|------|------|------|------|
| GET | `/api/Article/` | 文章列表（分页） | 🔓 |
| GET | `/api/Article/{id}` | 文章详情 | 🔓 |
| GET | `/api/Article/hot` | 热门文章 | 🔓 |

---

## Comment — `/api/Comment`

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/Comment/{articleId}` | 指定文章的顶层评论（游标分页） | 🔓 |
| GET | `/api/Comment/{articleId}/thread/{rootId}` | 指定评论的回复线程 | 🔓 |
| GET | `/api/Comment/me` | 当前用户可归因评论记录 | 🔑 |

---

## Category — `/api/Category`

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/Category/` | 所有分类 | 🔓 |

---

## Tag — `/api/Tag`

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/Tag/` | 所有标签 | 🔓 |

---

## System — `/api/System`

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/System/seo` | 站点 SEO 配置 | 🔓 |
| GET | `/api/System/page/{slug}` | 指定 slug 的静态页面内容 | 🔓 |

---

## Binary — `/api/binary`

Binary 端点输出 AEDS v2 帧（`Content-Type: application/octet-stream`）。
帧格式：16 字节帧头（Magic、Version、HeaderLength、Flags、FrameType、PayloadLength、PayloadCrc16）+ compact POD 载荷。AEDS v1 不再兼容，旧客户端会被直接拒绝。
客户端小载荷默认走 TypeScript adapter 主线程解码；大载荷走 Web Worker / C++23 Wasm 解码器；解码失败不得回退到文本 API。

### 公开读

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/article/list/home/{page}/{size}.aeds` | 首页文章列表 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds` | 分类文章列表 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds` | 标签文章列表 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/article/{id}.aeds` | 文章详情 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/article/hot/{size}.aeds` | 热门文章 L0 artifact（Binary） | 🔓 |
| GET | `/api/binary/comment/{articleId}` | 文章评论（Binary） | 🔓 |
| GET | `/api/binary/comment/{articleId}/thread/{rootId}` | 评论线程（Binary） | 🔓 |

### 需认证

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/comment/me` | 当前用户可归因评论记录（Binary） | 🔑 |

### 管理端

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/stats` | Binary 聚合统计（overview + recent comments + regions） | 👑 |
| POST | `/api/binary/upload/*` | 分片上传 | 👑 |
| GET | `/api/binary/upload/*` | 分片上传查询 | 👑 |
| PUT | `/api/binary/upload/*` | 分片上传操作 | 👑 |
| DELETE | `/api/binary/upload/*` | 分片上传清理 | 👑 |

---

## Messages — `/api/binary/messages`

> 整个路由组需要登录。

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/messages/conversations` | 当前用户对话列表 | 🔑 |
| GET | `/api/binary/messages/conversations/{id}` | 对话详情与消息 | 🔑 |
| POST | `/api/binary/messages/conversations` | 发起新对话 | 🔑 |
| POST | `/api/binary/messages/conversations/{id}/reply` | 回复对话 | 🔑 |
| POST | `/api/binary/messages/conversations/{id}/read` | 标记对话已读 | 🔑 |

---

## Admin Messages — `/api/binary/admin/messages`

> 整个路由组需要 admin 角色。

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/admin/messages/conversations` | 所有对话列表 | 👑 |
| GET | `/api/binary/admin/messages/conversations/{id}` | 对话详情 | 👑 |
| POST | `/api/binary/admin/messages/conversations/{id}/reply` | 以管理员身份回复 | 👑 |
| POST | `/api/binary/admin/messages/conversations/{id}/status` | 更新对话状态 | 👑 |
| POST | `/api/binary/admin/messages/system-send` | 单账号系统消息（targetAccountId 必填） | 👑 |

---

## 通知与健康检查

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/notifications/stream` | WebSocket 通知通道（`fsus-aeds.v2`） | 🔓 |
| GET | `/health/live` | JSON 存活探针 | 🔓 |
| GET | `/health/ready` | JSON 最小就绪探针（仅 `status` / `checkedAt`）| 🔓 |
| GET | `/api/ops/health/ready-detail` | JSON 详细就绪报告（配置、DB、Redis、runtime、observability） | 👑 |
| GET | `/api/ops/crawler-ranges/status` | Crawler CIDR 同步状态 | 👑 |

---

## 速率限制说明

带 🚦 标记的端点受速率限制策略约束：认证/写入默认使用 `fixed_ip`，公开动态读使用 `public_read`，真人阅读 proof 使用 `read_proof`。超限返回 `429 Too Many Requests`，响应头包含 `Retry-After`，并写入 crawler risk 分。

客户端 IP 由 `ForwardedHeadersMiddleware` 处理后通过 `context.GetClientIp()` 读取，需要 Nginx/OpenResty 正确传递真实 IP；业务代码不得直接信任原始转发头。

## AEDS 帧格式

```
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

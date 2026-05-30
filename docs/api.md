# API 快速参考

本文档列出 FsusBlog 所有公开 API 端点。
详细文档请参阅 [api/](api/) 子目录：

| 文档 | 说明 |
|------|------|
| [api/design.md](api/design.md) | API 设计哲学、响应格式约定、双链路决策 |
| [api/contracts.md](api/contracts.md) | 请求/响应 DTO 完整契约、SSE 信封、AOT 契约 |
| [api/quick-reference.md](api/quick-reference.md) | 所有端点路由速查表（含认证 / 限流 / Binary 对照） |
| [api/schemas-and-errors.md](api/schemas-and-errors.md) | 错误码枚举、AEDS v2 帧格式、compact POD 大小目录 |

---

**图例**

| 符号 | 含义 |
|------|------|
| 🔓 | 匿名可访问 |
| 🔑 | 需要登录（Bearer JWT） |
| 👑 | 需要 admin 角色 |
| 🚦 | 有 IP 速率限制（fixed_ip 固定窗口） |

---

## Auth — `/api/Auth`

### PoW 与注册登录

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/Auth/pow-challenge` | 获取 Proof of Work 挑战 | 🔓 🚦 |
| POST | `/api/Auth/register` | 用户注册（需携带 PoW 解答） | 🔓 🚦 |
| POST | `/api/Auth/login` | 密码登录（可能触发 MFA 流程） | 🔓 🚦 |
| POST | `/api/Auth/refresh-token` | 使用 HttpOnly Cookie 续签 Access Token | 🔓 🚦 |

### 当前用户

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/Auth/me` | 获取当前登录用户信息 | 🔑 |
| POST | `/api/Auth/logout` | 安全登出（吊销 Refresh Token） | 🔑 |
| POST | `/api/Auth/delete-account` | 注销账号 | 🔑 |

### 会话管理

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/Auth/sessions` | 获取活跃会话列表 | 🔑 |
| POST | `/api/Auth/sessions/{id}/revoke` | 吊销指定会话 | 🔑 |
| POST | `/api/Auth/sessions/revoke-others` | 吊销全部其他会话 | 🔑 |

### MFA / TOTP

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/Auth/mfa/setup/start` | 开始 MFA 设置，返回 TOTP 密钥与二维码 | 🔑 |
| POST | `/api/Auth/mfa/setup/verify` | 验证 TOTP 码，完成 MFA 启用 | 🔑 |
| GET | `/api/Auth/mfa/profile` | 查询 MFA 启用状态与恢复码剩余数 | 🔑 |
| POST | `/api/Auth/mfa/disable` | 禁用 MFA | 🔑 |
| POST | `/api/Auth/mfa/recovery/regenerate` | 重新生成恢复码 | 🔑 |
| POST | `/api/Auth/mfa/challenge/start` | 登录后触发 MFA 挑战（返回挑战令牌） | 🔑 |
| POST | `/api/Auth/mfa/challenge` | 提交 TOTP 码或恢复码完成 MFA | 🔓 |
| POST | `/api/Auth/admin/users/{id}/mfa/reset` | 管理员重置指定用户的 MFA | 👑 |

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
| GET | `/api/Comment/me` | 当前用户评论历史 | 🔑 |

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
| GET | `/api/binary/article` | 文章列表（Binary） | 🔓 |
| GET | `/api/binary/article/{id}` | 文章详情（Binary） | 🔓 |
| GET | `/api/binary/article/hot` | 热门文章（Binary） | 🔓 |
| GET | `/api/binary/comment/{articleId}` | 文章评论（Binary） | 🔓 |
| GET | `/api/binary/comment/{articleId}/thread/{rootId}` | 评论线程（Binary） | 🔓 |

### 需认证

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/comment/me` | 当前用户评论历史（Binary） | 🔑 |

### 管理端

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/binary/stats` | Binary 聚合统计（overview + recent comments + regions） | 👑 |
| POST | `/api/binary/upload/*` | 分片上传 | 👑 |
| GET | `/api/binary/upload/*` | 分片上传查询 | 👑 |
| PUT | `/api/binary/upload/*` | 分片上传操作 | 👑 |
| DELETE | `/api/binary/upload/*` | 分片上传清理 | 👑 |

---

## Messages — `/api/v1/messages`

> 整个路由组需要登录。

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/v1/messages/conversations` | 当前用户对话列表 | 🔑 |
| GET | `/api/v1/messages/conversations/{id}` | 对话详情与消息 | 🔑 |
| POST | `/api/v1/messages/conversations` | 发起新对话 | 🔑 |
| POST | `/api/v1/messages/conversations/{id}/reply` | 回复对话 | 🔑 |
| POST | `/api/v1/messages/conversations/{id}/read` | 标记对话已读 | 🔑 |

---

## Admin Messages — `/api/v1/admin/messages`

> 整个路由组需要 admin 角色。

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/v1/admin/messages/conversations` | 所有对话列表 | 👑 |
| GET | `/api/v1/admin/messages/conversations/{id}` | 对话详情 | 👑 |
| POST | `/api/v1/admin/messages/conversations/{id}/reply` | 以管理员身份回复 | 👑 |
| POST | `/api/v1/admin/messages/conversations/{id}/status` | 更新对话状态 | 👑 |
| POST | `/api/v1/admin/messages/system-send` | 系统广播消息 | 👑 |

---

## 通知与健康检查

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/api/notifications/stream` | WebSocket 通知通道（`fsus-aeds.v2`） | 🔓 |
| GET | `/health/live` | JSON 存活探针 | 🔓 |
| GET | `/health/ready` | JSON 就绪探针（Redis + DB + 启动状态）| 🔓 |

---

## 速率限制说明

带 🚦 标记的端点受 `fixed_ip` 速率限制策略约束，按客户端 IP 计数，超限返回 `429 Too Many Requests`，响应头包含 `Retry-After`。

客户端 IP 通过 `X-Forwarded-For` 提取（`context.GetClientIp()`），需要 Nginx 正确传递真实 IP。

## AEDS 帧格式

```
Offset  Size  字段
0       4     Magic (0x53455341 "AEDS")
4       1     Version (2)
5       1     Header Length (16)
6       2     Flags
8       2     Frame Type
10      4     Payload Length (bytes)
14      2     Payload CRC16
16      N     Compact POD Payload
```

offset 8 是 `FrameType`，不是记录数；记录数属于各 payload 自己的 compact layout。
协议完整规格见 [../src/core/FsusBlog.Core/Algorithms/AEDS_V1_PROTOCOL.md](../src/core/FsusBlog.Core/Algorithms/AEDS_V1_PROTOCOL.md)。

# Changelog

本文件记录 FsusBlog 的版本历史，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### 新增

- 防爬虫闭环：`CrawlerRiskService` 统一沉淀 Shield、RateLimiter、PoW、ReadProof 和公开动态读风险分，`RiskAwarePublicReadFilter` 在高风险公开 GET API 上动态要求 PoW 或返回 429。
- Crawler CIDR 同步支持远程官方 JSON、last-known-good snapshot、配置项 fallback 与 admin-only `/api/ops/crawler-ranges/status` 状态接口。

### 变更

- `ShieldMiddleware` 将 search crawler、social preview bot、unknown bot 和工具型 UA 分层处理，保留路径攻击硬 abort，其余拒绝返回轻量 403 并记录安全指标。
- RSS、Atom、JSON Feed、sitemap 和 robots 响应统一使用 CDN 友好缓存头与 ETag；`robots.txt` 明确禁止 `/api/`、搜索索引和私有路径。

---

## [1.0.0] — 2026-04-27

### 新增

#### 公开内容

- 文章列表端点，支持分页（`GET /api/Article/`）
- 文章详情端点（`GET /api/Article/{id}`）
- 热门文章端点（`GET /api/Article/hot`）
- 评论线程端点，游标分页（`GET /api/Comment/{articleId}`，`/{articleId}/thread/{rootId}`）
- 分类列表端点（`GET /api/Category/`）
- 标签列表端点（`GET /api/Tag/`）
- SEO 配置端点（`GET /api/System/seo`）
- 静态页面内容端点（`GET /api/System/page/{slug}`）

#### Binary 传输（AEDS v2）

- `api/binary` 端点组，所有公开读链支持 `application/octet-stream` 输出
- AEDS v2 协议：16 字节帧头 + CRC16 payload 校验；v1 frame 不再兼容
- C++23 Wasm 解码器（Freestanding，无 STL 堆分配，CMake + Emscripten 构建）
- `AedsBinaryWriter` / `BinaryFrameResult` 分段写出 header + payload
- 解码失败暴露协议错误，不回退 JSON 读链
- 管理员 Binary 统计端点（`GET /api/binary/stats`，需 admin 角色）
- 多分片上传端点组（`/api/binary/upload/*`，需 admin 角色）

#### 认证与安全

- Proof of Work (PoW) 前置机制，覆盖注册/登录等敏感操作
- 用户注册（`POST /api/Auth/register`，带 PoW 验证）
- 密码登录（`POST /api/Auth/login`，含 MFA 流程）
- JWT Access Token（15 分钟过期）+ HttpOnly Refresh Token Cookie
- Token 续期（`POST /api/Auth/refresh-token`）
- 当前用户信息（`GET /api/Auth/me`）
- 安全登出（`POST /api/Auth/logout`，吊销 Refresh Token）
- 注销账号（`POST /api/Auth/delete-account`）
- BCrypt 密码哈希（cost factor 10+）

#### 通行密钥 / Passkey（WebAuthn / FIDO2）

- FIDO2 Discoverable Credential，无用户名流程（usernameless）
- 注册流程（`POST /api/binary/auth/passkey/register/begin` + `register/complete`，需登录，AEDS frame）
- 无密码登录流程（`POST /api/binary/auth/passkey/login/begin` + `login/complete`，匿名，IP 速率限制，AEDS frame）
- 凭证列表（`GET /api/binary/auth/passkey/credentials`，每用户最多 5 枚）
- 凭证删除（`DELETE /api/binary/auth/passkey/credentials/{id}`）
- 凭证重命名（`PUT /api/binary/auth/passkey/credentials/{id}/name`）
- 注册 MFA 前置保护（已启用 MFA 的用户注册新密钥需提供 proofToken）
- Passkey 登录视为双因素，直接跳过 MFA 挑战

#### 多因素认证（MFA / TOTP）

- MFA 设置启动（`POST /api/Auth/mfa/setup/start`）
- MFA 设置验证（`POST /api/Auth/mfa/setup/verify`）
- MFA 个人配置信息（`GET /api/Auth/mfa/profile`）
- MFA 禁用（`POST /api/Auth/mfa/disable`）
- 恢复码重新生成（`POST /api/Auth/mfa/recovery/regenerate`）
- MFA 登录挑战启动（`POST /api/Auth/mfa/challenge/start`）
- MFA 登录挑战完成（`POST /api/Auth/mfa/challenge`）
- 管理员重置用户 MFA（`POST /api/Auth/admin/users/{id}/mfa/reset`，需 admin 角色）

#### 多会话管理

- 活跃会话列表（`GET /api/Auth/sessions`）
- 吊销单个会话（`POST /api/Auth/sessions/{id}/revoke`）
- 吊销全部其他会话（`POST /api/Auth/sessions/revoke-others`）

#### 实时通知（SSE）

- SSE 增量事件流端点（`GET /api/notifications/stream`）
- 慢消费者自动断开保护
- SignalR + Redis backing store

#### 站内消息

- 用户对话列表（`GET /api/binary/messages/conversations`）
- 用户对话详情（`GET /api/binary/messages/conversations/{id}`）
- 发起新对话（`POST /api/binary/messages/conversations`）
- 回复对话（`POST /api/binary/messages/conversations/{id}/reply`）
- 标记已读（`POST /api/binary/messages/conversations/{id}/read`）
- 管理员对话列表（`GET /api/binary/admin/messages/conversations`）
- 管理员对话详情与回复
- 管理员对话状态管理（`POST /api/binary/admin/messages/conversations/{id}/status`）
- 管理员单用户系统消息（`POST /api/binary/admin/messages/system-send`）

#### 用户评论历史

- 当前用户评论历史（`GET /api/Comment/me`，需登录）
- 同时支持 JSON 与 Binary 双读链（`GET /api/binary/comment/me`）

#### AOT 公开页缓存

- 预渲染 HTML shell 输出，静态文件优先命中
- 未命中回退到 SPA `index.html`，由客户端 hydration 接管
- AOT 缓存卷挂载（`fsus-aot-cache`）

#### 前端（Vue 3 SPA）

- 公开页：首页、归档、分类、标签、文章详情
- Passkey 登录入口（Login 页面）
- Passkey 管理面板（用户控制台 Profile 页面）
- MFA 设置与验证流程
- 站内消息收发页面
- 管理员后台界面
- WebAssembly 解码引擎（C++23，Web Worker 隔离主线程）
- 本地搜索（Service Worker 缓存静态索引 + Wasm 本地排序）
- 响应式设计，深色/浅色主题

#### 运维与可观测性

- 健康检查：`GET /health/live`（存活探针），`GET /health/ready`（就绪探针）
- Serilog 结构化日志，异步滚动文件（卷挂载 `fsus-logs`）
- 多分层测试基础设施（fast / integration / acceptance / visual / security / resilience / load / production）
- 生产 Docker 多阶段构建（Wasm → .NET 发布 → Alpine 运行时）
- 数据库 CodeFirst 自动迁移

---

[Unreleased]: https://github.com/example/FsusBlog/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/example/FsusBlog/releases/tag/v1.0.0

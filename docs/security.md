# 安全模型

本文档说明 FsusBlog 采用的安全机制及其实现要点。

## 纵深防御层次

```text
网络层      Nginx/OpenResty：SSL 终端、HTTPS 强制、未知 Host 拒绝、真实 IP 传递
传输层      HTTPS only（生产启动拒绝 HTTP CORS Origin）
应用层      PoW → 速率限制 → 认证 → MFA / Passkey → RBAC
数据层      BCrypt 密码哈希、JWT 短寿命、会话隔离、密码学安全随机数
客户端      SameSite Cookie、HttpOnly、Secure；CSP、XFO、XCTO、Referrer-Policy、Permissions-Policy；真人阅读 proof
```

---

## Proof of Work (PoW)

在密码注册、登录等高风险操作之前，客户端须先解决 PoW 挑战，以提高批量自动化攻击的成本。

- 挑战端点：`GET /api/binary/auth/pow-challenge`（匿名，IP 速率限制，AEDS `PowChallenge` frame）
- 有效期：挑战存入 Redis，TTL 过期后自动失效
- 服务端验证：注册 / 登录端点在执行业务逻辑前校验 PoW 解答，失败拒绝请求
- 安全门控覆盖：缺失、篡改、重放形态的 PoW 请求不得产生 2xx，且不得写入业务状态。
- 难度语义：`difficulty` 表示 SHA-256 摘要的 bit 级前导零数量，而不是半字节 / nibble 数；默认阶梯为 16/20/24/28 bits。
- 客户端求解器：PoW 延迟优化只发生在 `src/frontend/wasm/pow` 的 C++23/Wasm 层，proof wire 格式与 Redis/HMAC 绑定语义不变。
- Wasm 分层：运行时按 `threads -> relaxed SIMD -> SIMD128 -> basic` 选择可用资产；任一高阶资产初始化或求解失败时自动降级到下一层，不影响 API 语义。
- 多核约束：threads 层只在 `crossOriginIsolated`、`SharedArrayBuffer` 和 Wasm atomics 可用时启用，worker 数上限为 `min(4, hardwareConcurrency - 1)`。

---

## 速率限制（Rate Limiting）

- 基础策略：`fixed_ip`（固定窗口，按客户端 IP 计数），作为认证、PoW、写入和审核端点的 fallback。
- 公开读策略：`public_read` 按 `IP + path` 分区；verified search crawler 使用独立高额度分区，social preview bot 使用低额度公开 HTML/静态资源分区，普通匿名公开 API 使用中等配额。
- 真人阅读策略：`read_proof` 专门保护 `/api/read-proof/challenge` 与 `/api/read-proof/submit`，按 `IP + route` 或 `IP + deviceFp + route` 分区，避免匿名 challenge/submit 被无限打。
- 超限响应：`429 Too Many Requests`，响应头携带 `Retry-After`，并向 `CrawlerRiskService` 写入 `RateLimited` 风险事件。
- 客户端 IP 提取：`GetClientIp()` 只读取 `ForwardedHeadersMiddleware` 按 `ReverseProxy:KnownProxies` / `ReverseProxy:KnownNetworks` 处理后的 `Connection.RemoteIpAddress`；业务代码不得直接信任原始 `X-Forwarded-For` / `X-Real-IP` 请求头。
- 受保护端点：PoW 挑战、注册、密码登录、Token 续签、Passkey 登录开始/完成、评论审核队列和单条/批量审核写入、ReadProof challenge/submit、公开评论读取、公开 taxonomy 与 related-reading。

## 防爬虫闭环

`ShieldMiddleware` 在常规 endpoint 前分类处理请求：

- search crawler：`Googlebot` / `Google-InspectionTool` / `bingbot` / `msnbot` 先按 CIDR 验证，`Baiduspider` / `Sogou` 继续使用 rDNS + forward DNS；验证通过后写 `HttpContext.Items["VerifiedCrawler"] = true`。
- social preview bot：`Twitterbot`、`facebookexternalhit`、`Discordbot`、`Slackbot`、`TelegramBot`、`LinkedInBot`、`WhatsApp` 只允许公开 HTML、OG/静态资源、`robots.txt` 的 GET/HEAD，不允许访问 `/api/**`。
- unknown bot、工具型 UA、空 UA：返回轻量 403，记录 `fsus.security.event.count`，并向风险分写入原因；路径穿越、双斜杠、反斜杠和双重编码路径仍直接 `Abort()`，同时记录指标。

`CrawlerUpdateWorker` 每 24 小时按优先级加载搜索引擎 CIDR：远程官方 JSON（Google `googlebot.json`、Bing `bingbot.json`）→ 本地 last-known-good snapshot → `Security:CrawlerCidrs:*` 配置 → empty degraded。状态通过 admin-only `GET /api/ops/crawler-ranges/status` 暴露，只包含 range 数量、来源、最近同步时间、最近成功时间和错误摘要。

`CrawlerRiskService` 把 Shield、RateLimiter、PoW、ReadProof 和 risk-aware public read 的异常事件累积到 `SecurityPowRisk`。`AdaptivePowGovernor` 继续消费同一 risk key 提高 PoW 难度；`RiskAwarePublicReadFilter` 在风险分达到 50 时要求公开 GET API 携带 `X-Fsus-Pow-Proof`，达到 100 时直接返回 429。该策略只作用于动态公开 API，不影响 PublicHotRead artifact 命中路径。

---

## 真人阅读计数 proof

浏览计数不再由公开 GET 请求副作用产生。文章 `Views` 和后台访问统计统一来自 `HumanReadProofService` 接受的真人阅读事件：

- Challenge：`GET /api/read-proof/challenge?scope=site|article&routeKey=...&articleId=...`
- Submit：`POST /api/read-proof/submit`
- 客户端要求：SPA hydration 后，主内容进入视口并累计可见停留至少 8 秒，再携带 `X-Fsus-Device-Fp` 提交 proof。
- 服务端绑定：HMAC token 绑定 scope、routeKey、articleId、设备指纹哈希、IP 哈希、UA 哈希、签发时间、过期时间、最小停留时间和 nonce。
- 拒绝条件：无 JS/AOT 未 hydration、直接 API 请求、缺失 Fetch Metadata、跨站 Origin/Referer、爬虫 UA、已验证 crawler、停留不足、过期 token、篡改 token、重放 proof。
- 拒绝与超限会写入 `CrawlerRiskService`，但不会阻断公开内容访问；HumanReadProof 只决定阅读事件是否计数。
- 降级开关：`HumanReadProof:Mode=paused` 暂停计数写入，但不影响内容读取。

该机制提高浏览计数的真人口径，不用于身份认证，也不承诺识别所有未知自动化行为。

---

## 实时通知通道

- 通道：`/api/notifications/stream` 使用 WebSocket，子协议固定为 `fsus-aeds.v2`
- 预检：`/api/notifications/stream/preflight` 复用认证、PoW、cursor 和协议校验，不要求 WebSocket upgrade；成功返回 204，失败返回 JSON 错误信封与 `X-Fsus-Sse-*` 头
- 载荷：所有通知、心跳和正式 WebSocket 握手失败均为 AEDS binary frame；握手失败返回 `ApiError` frame
- 匿名订阅：必须携带 `pow` query 参数，值为二进制 FPOW 证明的 base64 文本形式
- 登录订阅：复用同站点认证 Cookie，不接受文本事件流降级
- 续传：客户端用 `cursor` query 参数提交最后消费的事件 ID
- 封禁/删除账号：握手层返回 `account_blocked` 或 `account_deleted`，前端必须停止重连并展示账户状态错误

---

## 密码存储

- 算法：BCrypt（BCrypt.Net-Next 4.1.0）
- Work Factor：cost ≥ 10（生产建议 12）
- 永不明文存储，注册/修改密码时即时哈希
- 密码注册成功后立即创建标准登录会话，并下发 HttpOnly 认证 Cookie

---

## JWT 认证

| 参数 | 值 |
|------|-----|
| Access Token 有效期 | 15 分钟 |
| Refresh Token 形式 | HttpOnly Cookie（SameSite=Strict，Secure） |
| 续签方式 | `POST /api/Auth/refresh-token`，基于 `UserSession.RefreshTokenHash` 的原子 CAS 轮换（旧 Token 立即失效） |
| 签名算法 | HS256（密钥来自环境变量，生产启动时强制校验非占位值） |

Refresh Token 只以哈希形式保存在 `sys_user_session`；`sys_user` 不再保存明文 Refresh Token 或全局刷新过期时间。刷新请求必须同时匹配当前 session id、旧 refresh hash、未撤销状态、idle/absolute 过期窗口；CAS 失败或旧 Token 重用会撤销对应 session 并清理客户端 Cookie。

**生产启动保护**：如果 JWT 密钥与已知占位值相同，服务器拒绝启动，防止弱密钥上线。

---

## 多因素认证（MFA / TOTP）

- 标准：RFC 6238 TOTP（Time-based OTP，30 秒窗口）
- 启用流程：`/mfa/setup/start` 只写 `MfaPendingSecretEncrypted` / `MfaPendingCreatedAt`，展示二维码 + 密钥；`/mfa/setup/verify` 验证 pending secret 成功后才原子切换到 `MfaSecretEncrypted` 并启用 MFA
- 重新绑定流程：已启用 MFA 的用户调用 `/mfa/setup/start` 必须提交当前密码和当前 TOTP/恢复码，旧 `MfaSecretEncrypted` 与 `MfaEnabled` 在新 secret 验证前保持不变
- 登录流程：密码验证通过后，如用户已启用 MFA，颁发临时挑战令牌，等待 TOTP 码验证
- MFA challenge：`/auth/mfa/challenge` 受 `fixed_ip` 限流保护，并对 ticket、user、IP 三个维度记录失败次数；达到阈值后消费 challenge，所有失败返回通用错误
- 恢复码：启用 MFA 时生成一批 128-bit 分组恢复码，服务端保存 per-code salt + PBKDF2-SHA256 慢哈希；恢复码单次使用，耗尽后可通过 `/mfa/recovery/regenerate` 重新生成
- 管理员重置：`POST /api/Auth/admin/users/{id}/mfa/reset`（需 admin 角色），用于用户丢失设备时兜底
- Passkey 免 MFA：使用 Passkey 登录的用户视为已完成双因素，直接跳过 MFA 挑战

---

## 通行密钥（Passkey / WebAuthn / FIDO2）

- 规范：W3C Web Authentication Level 3（FIDO2）
- 凭证类型：Discoverable Credential（resident key），支持无用户名流程（usernameless）
- 库：Fido2 4.0.1
- 上限：每用户最多 5 枚 Passkey
- 注册保护：已启用 MFA 的用户注册新 Passkey 须提供有效的 MFA proofToken
- 传输契约：Passkey 注册/登录选项、attestation、assertion 与凭证管理均走 `/api/binary/auth/passkey/**`，请求与响应为 `application/octet-stream` AEDS frame；不再暴露文本字符串载荷
- 服务端配置：

  ```
  ServerDomain: 来自 Fido2:ServerDomain 配置（默认 localhost）
  ServerName:   来自 Fido2:ServerName 配置（默认 FsusBlog）
  Origins:      来自 Fido2:Origins 配置（HashSet<string>）
  TimestampDriftTolerance: 300000 ms
  ```

- 注册与登录均要求 `UserVerification=Required`；登录断言的 `assertionResponse.Id` 为 Base64Url 字符串（直接使用，不重复编码）
- 凭证唯一性：注册时校验凭证 ID 全局唯一（`IsCredentialIdUniqueToUserCallback`）
- 传输方式：存储 `RegisteredPublicKeyCredential.Transports` 数组（`.Length`）

---

## 会话管理

- 每次登录创建会话记录（设备、IP、时间），存储于 PostgreSQL + Redis
- 密码注册自动登录与密码登录复用同一会话创建逻辑（`CompleteLoginAsync`），默认创建非 remember-me 标准会话
- `GET /api/Auth/sessions`：列出当前活跃会话
- `POST /api/Auth/sessions/{id}/revoke`：主动吊销单个会话
- `POST /api/Auth/sessions/revoke-others`：仅保留当前会话，吊销全部其他
- 登出（`/logout`）：立即吊销当前 Refresh Token，清除 Cookie

---

## 角色与访问控制（RBAC）

FsusBlog 采用三级角色体系：

| 角色 | 覆盖 | 典型操作 |
|------|------|----------|
| `anonymous` | 所有人 | 阅读公开文章、评论、搜索 |
| `authenticated` | 已登录用户 | 发评论、管理 Passkey/MFA、会话管理、消息 |
| `admin` | 管理员 | 用户管理、MFA 重置、Binary 统计、系统广播 |

权限通过 ASP.NET Core `[Authorize]` / `RequireAuthorization()` 在端点级别声明。

封禁用户写入限制由 `BannedUserMiddleware` 在 endpoint routing 之后执行。允许封禁用户完成的安全收尾操作必须在端点上显式声明 `AllowBannedUserWrite()` metadata，例如登出、删除账号和消息已读/回复收口；不得再通过 URL 片段、HTTP path 或 group 名称推导放行策略。

认证安全流响应的 `Cache-Control: no-store` 由端点 `RequireNoStoreResponse()` metadata 驱动，统一中间件在响应开始前写入 no-store / no-cache 头。PoW challenge、登录、登出、refresh、删除账号等认证端点必须同时声明该 metadata，而不是新增路径分支。

---

## CORS

- 仅允许明确配置的 Origin（`appsettings.json / Cors:AllowedOrigins`）
- 生产启动保护：如 `AllowedOrigins` 中包含任何 `http://` 来源，服务器拒绝启动
- 开发环境：允许 `http://localhost:*` 以支持 Vite HMR

---

## CSRF 防护

- Refresh Token 使用 `SameSite=Strict, HttpOnly, Secure` Cookie
- 生产环境认证 Cookie 使用 `__Host-*` 前缀、`Path=/`、无 `Domain`、`HttpOnly`、`Secure`、`SameSite=Strict`
- `SameSite=Strict` 阻止跨站请求自动携带 Cookie
- 前端主调用凭据是 HttpOnly Cookie session / AEDS auth frame；如服务端内部仍签发短期 JWT，它不是浏览器主调用的 Bearer Header 事实。高风险写操作还会叠加 PoW、MFA proof、RBAC 与 no-store metadata，避免只依赖自动携带 Cookie。

## 作者工作台、订阅与 RUM 隐私

- `/api/author/**` 全部要求 admin role；草稿、预览、修订、资产、评论审核、导入导出和 AI 辅助不得匿名访问。
- 服务端草稿按 `ownerUserId + draftKey` 唯一保存，浏览器本地缓存仅作为断网兜底；跨设备恢复必须通过 admin cookie 读取 `/api/author/drafts/{draftKey}`，不得落入公开 AOT、Service Worker shell cache 或搜索索引。
- 修订历史正文详情只允许 admin 在作者工作台读取；回滚必须走正式文章更新服务以写入新修订、审计记录和分发缓存失效，不允许通过 SQL/API 直接覆盖公开正文。
- 未发布正文只允许出现在 admin-only JSON 响应中；预览 HTML 带 `data-preview-only=true` 和 `data-markdown-renderer=server-preview`，所有 Markdown HTML 输入先转义，前端写入 `srcdoc` 前再次剥离可执行标签/事件属性，并仅以 sandboxed unique-origin iframe 展示，不得写入 PublicAOT cache、search index、feed、sitemap 或 related-reading。
- related-reading 只基于公开文章的分类、标签、正文关键词和发布时间生成，不使用点赞、收藏、关注、登录用户、订阅邮箱或用户画像；端点和 PublicAOT 共用同一服务，防止 SPA/AOT 暴露面分叉。
- SEO 预览只读取当前表单和站点 SEO 配置；canonical/slug/OG image 预览不得对外生成路由或缓存。发布/定时发布前检查返回的 `error` 必须阻断提交，覆盖危险 HTML、未闭合代码块、不安全协议、私有站内路径和无效 public route 格式；`warning` 只能在作者填写跳过理由后继续提交，并由服务端记录 `prepublish-warning-override` 审计事件，不能自动降级为公开可见内容。
- 资产库只在 admin-only 作者工作台可见；重建索引只采集 `/uploads/illustration/*` 正文图片与封面 URL，孤儿清理只删除 `referenceCount=0` 的资产库索引行，不删除上传文件本体，也不得暴露为匿名目录浏览能力。运维保留期脚本默认也不删除上传资产；若显式启用上传资产扫描，必须提供 `FSUSBLOG_RETENTION_REFERENCED_ASSETS`，脚本会保护仍被文章引用的 `/uploads/illustration/*` 文件并在 `assetGuard.protectedReferencedAssets` 中记录证据。
- PWA 离线缓存仅限公开 shell 路由和搜索索引；`/user`、`/admin`、`/login` 与私有 API 不得被 service worker 离线命中。离线公开文章 smoke 通过 `check:pwa-offline-smoke` 验证 `X-Fsus-Offline-Stale: 1`，并验证私有 console 路由在离线时失败。
- 作者分析 dashboard 只读取 admin-only `/api/author/analytics`。后端聚合 `VisitLog.routeKey`、`dwellMs` 和 PublicAOT miss 审计；公开搜索词与 404 路径会被截断并聚合展示，不采集正文输入、账号、email、token、cookie 或可识别行为链。
- 评论创建默认进入待审状态，公开评论 API 只返回 `Approved` 项。创建入口必须先做 endpoint payload 上限、字符数和 UTF-8 字节数校验，再进入内容过滤，避免超大正文消耗过滤器；回复只能挂到同文章、未删除且已通过的父评论/根评论。
- 审核队列、单条审核、批量审核和封禁联动全部位于 admin-only `/api/author/comments/**`。审核读取和写入受 `fixed_ip` 限流；单条/批量审核还必须提交当前 admin 会话一次性 `X-Fsus-Mfa-Proof`，proof action 固定为 `admin-sensitive`，缺失或消费失败返回 step-up required。审核动作写入 `comment-moderation` / `comment-moderation-bulk` 审计；拒绝/隐藏时的封禁联动只作用于非 admin、非注销用户，并同步黑名单缓存。
- 作者 AI 辅助默认 `Authoring:AiAssist:Enabled=false`；默认路径只做本地摘要/标签/结构建议，不把未发布正文发往外部 provider。外部 provider 只有在 `Authoring:AiAssist:Enabled=true`、`Authoring:AiAssist:Provider` 非 `local`、`Authoring:AiAssist:AllowExternalProvider=true` 且 `Authoring:AiAssist:ExternalProviderReviewed=true` 同时满足时才标记为 allowed；当前服务不直接持有 `HttpClient` 外发正文，每次调用都会写入 `author-ai-assist` 审计事件。
- `site_subscription` 只保存 `SHA256(email)`、channel、启用状态和退订时间，不保存明文 email，不构建读者画像或社交关系链。默认实现不接入 SMTP、第三方邮件或 Web Push provider；RSS/Atom/JSON Feed 是主订阅通道，`channel=email` 仅记录显式订阅偏好，后续外发能力必须先补配置开关、退订 smoke 和安全评审。
- PWA Service Worker 只缓存公开 shell 路由；`/user`、`/admin`、`/login` 和 `/api/binary/**` 不进入 shell cache。离线公开页必须带 `X-Fsus-Offline-Stale`。
- RUM 仅采集公开页 `pageType`、`aotSource`、LCP、CLS、hydration time、Wasm decode/render timing、navigation timing 等匿名性能指标；私有页面不发送 Core Web Vitals，payload 不包含账号、email、token、cookie、正文输入。`POST /api/telemetry/rum` 使用 `credentials: omit` 并受 `fixed_ip` 限流，服务端只允许固定 metric 名称和 `value/domInteractive/responseStart/durationMs` 数值字段，未知字段会被丢弃；净化后写入独立 `frontend_rum_metric` 表，不再混入安全审计表。
- 结构化审计写入 `sys_audit_log`：保留 `source/type/action/outcome/severity/actor/target`、trace/path/method、原因码和低基数 context；IP、User-Agent、session id、设备指纹只保存 SHA-256 hash。高价值 admin/security/audit 事件通过 `IAuditEventService` 同步写库，失败时写入 `FSUSBLOG_DATA_ROOT/audit-fallback/critical-audit-*.jsonl`，避免关键审计静默丢失。每条审计生成 `record_hash`，配置 `Audit:TamperEvidenceKey` 或 `Security:AuditTamperEvidenceKey` 时额外生成 `record_mac`；`/user/manage/audit` 可查询详情并校验单条防篡改证据。
- OpenTelemetry 自定义属性只允许 `fsus.*` 枚举字段，覆盖 route kind、状态码、组件、缓存 policy、AOT source、搜索模式、后台任务计数等低基数维度；不得写入原始路径参数、请求/响应正文、Authorization、Cookie、token、email、用户名、IP 或 User-Agent。`X-Fsus-Trace-Id` 仅用于用户报告和日志/trace 关联，不表示认证身份。

## Secret Rotation And Recovery

单作者生产环境的 secret 轮换必须先生成站点备份包：

```bash
tools/operations/backup-site.sh
```

- `Jwt__SecretKey`：生成新 secret 后滚动重启应用；旧 JWT 立即失效，依赖 refresh cookie 的会话也应通过用户 session 撤销或强制重新登录收口。
- DataProtection keyring：默认追加新 key，不删除旧 key；只有确认旧 cookie、MFA pending payload 和恢复窗口全部过期后，才在离线维护窗口清理旧 key。迁移服务器时必须恢复 `data-protection-keyring.tar.gz`，否则受保护 cookie/MFA payload 不可读。
- Redis password：先更新 Redis ACL/密码，再更新 `ConnectionStrings__Redis` / `RedisOptions__Configuration`，重启后用 `/api/author/ops/health` 验证 Redis 状态。Redis 数据不作为业务恢复来源。
- PostgreSQL password：先创建或切换数据库凭据，再更新 `ConnectionStrings__DefaultConnection`，重启前保留旧凭据到 readiness 通过。失败时恢复旧连接串或用最近数据库 dump 恢复。
- 域名/服务器迁移：同步恢复数据库、uploads、DataProtection keyring 和必要配置；更新 `SITE_BASEURL`、`CORS_ALLOWED_HOSTS`、`APP_ALLOWED_HOSTS`、Fido2/WebAuthn domain/origin 后，执行 `/health/ready`、`/user/manage/ops`、sitemap/feed 和登录/MFA smoke。

Secret 轮换、站点备份导出、数据巡检修复、批量封禁、密码重置等高价值操作必须写结构化审计。管理 UI 的危险操作策略来自 `/api/author/ops/dangerous-operations/policy`：系统设置、导入、revision rollback、taxonomy 修改和 integrity fix 必须先展示 changed-fields diff；批量封禁、重置密码、站点备份导出和 integrity fix 必须使用 MFA step-up。

## 安全测试矩阵

`./tools/test.sh security` 是安全边界的发布阻断门控，并被 `./tools/test.sh production` 调用。

- **生产入口配置**：Kestrel 只绑定宿主机回环地址、生产网关模板拒绝未知 Host、登录/admin/global 限流、隐藏文件和备份文件拒绝、SSE/WebSocket 代理头完整；`tools/security/check-production-network-baseline.sh` 同时运行 `tools/security/check-production-exposure-prereqs.sh` 与 `tools/security/test-production-exposure-tools.sh`，用合成证据回归测试 firewall policy verifier、DNS readiness/delegation evidence、live evidence verifier、status report、handoff/returned evidence 脚本与 TODO closeout 脚本。Prereq 会 fail-closed 校验 handoff bundle、returned evidence、returned handoff closeout 入口和 tar/find/xargs 等打包依赖存在且可执行。
- **生产公网暴露面 live 核验**：默认不在本地/CI 自动运行；设置 `FSUSBLOG_RUN_PRODUCTION_EXPOSURE_LIVE=1` 后，`./tools/test.sh security` 会调用 `tools/security/check-production-exposure-live.sh`，对生产域名的 DNS、`80/443`、禁止公开端口、HTTPS 与 HSTS 做实际网络探测。设置 `FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json` 可额外校验云安全组/主机防火墙策略证据：证据必须带新鲜 `generatedAt`、支持的 `evidenceSource.kind`、`evidenceSource.sourceSha256` 原始导出摘要、用 `appliesToHosts` 覆盖完整生产 host 列表，只允许公网 `80/443`，拒绝非私网来源上的非 Web 额外端口、覆盖额外端口的范围规则和 all-protocol 规则，SSH 必须限定为固定管理 IP、VPN 或私有管理网段，其中 `fixed-management-ip` 必须是单主机 CIDR，`private-management-network` 必须是真私网来源，Redis/PostgreSQL 只能来自私网来源，固定公网 CIDR 也会被拒绝；`tools/security/production-firewall-policy.evidence.example.jsonc` 只是占位模板，最终证据必须从真实云安全组或主机防火墙导出规范化而来。UFW 管理的生产主机可运行 `tools/security/collect-host-firewall-policy-evidence.sh` 从 `ufw status` 生成并立即校验 normalized evidence，采集器会解析 IPv4 与 `(v6)` 行、记录原始 UFW status sha256，并拒绝公网 IPv6 SSH；AWS EC2 security group 可先导出 `aws ec2 describe-security-groups`，再用 `tools/security/normalize-cloud-firewall-policy-evidence.sh` 转换并立即校验，normalizer 会记录原始 cloud export sha256。两个入口都会拒绝不完整或不安全规则；如果 normalized evidence 指向的 `sourceFile`/`statusFile` 在当前机器可读，verifier 会比对 `sourceSha256` 与原始文件。`tools/security/collect-production-hosts.sh` 会从 `FSUSBLOG_LIVE_HOSTS` 或生产 env 推导统一 host 集合，包括 SITE/SEO/CORS/AllowedHosts/Fido2 来源，并拒绝 wildcard、localhost、IP literal 或非法 hostname；`tools/security/check-production-dns-delegation.sh` 会为根生产域生成 DNS delegation evidence，要求公共 resolver 有 NS/SOA 且 TLD authoritative nameserver 有 NS 委派；`tools/security/check-production-dns-readiness.sh` 会为完整 host 集合单独生成 DNS readiness evidence，要求本地 resolver 和每个公共 resolver 至少有 A/AAAA 答案；live evidence 会写入 `generatedAt` 与 `requiredHosts`，verifier 会拒绝过期、缺少 `requiredHosts` 或遗漏任一 required host 的证据，DNS readiness 的 `requiredHosts` 与 DNS delegation 的 `delegationDomains` 也会在 status report/TODO closeout 中强制覆盖完整生产 scope；verifier、status report、direct TODO closeout 都支持脚本生成的空格分隔字段或外部运维交回的 JSON array。status report 还会把 live evidence 的 host 集合与完整生产 host 集合交叉比对，direct TODO closeout 也会用 evidence `requiredHosts` 约束 firewall policy，并要求 DNS readiness/delegation evidence 与 status report 同时通过。设置 `FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE=.tmp/security/production-exposure-live.json` 可保留机器可读 live 证据，并在 security gate 中追加 `tools/security/verify-production-exposure-evidence.sh` 机器校验；`tools/security/report-production-exposure-status.sh` 可把 firewall policy verifier、强制的新鲜 DNS readiness/delegation evidence 与 live evidence verifier 的当前阻塞原因汇总为 `.tmp/security/production-exposure-status.json`，用于 release notes 和 TODO 注释。脚本默认记录 `1.1.1.1` 和 `8.8.8.8` 的 A/AAAA 公共解析结果，可用 `FSUSBLOG_DNS_RESOLVERS` 覆盖。DNS 切换前可用 `FSUSBLOG_LIVE_TARGETS=fsus.blog=203.0.113.10,www.fsus.blog=203.0.113.10` 对指定地址做 Host/SNI 探测，但 TODO 中的生产子域名项仍必须以真实 DNS 解析成功为完成依据。最终收口使用 `tools/security/complete-production-exposure-closeout.sh`；它会按顺序执行本地依赖检查、配置基线、DNS delegation、firewall policy verifier、DNS readiness、live probe、evidence verifier、TODO closeout，并拒绝任何不完整证据。
- **生产收口失败证据**：`tools/security/complete-production-exposure-closeout.sh` 遇到 DNS/firewall/live 阻塞时会尽量继续执行后续 evidence-generating checks，再写出 `FSUSBLOG_PRODUCTION_EXPOSURE_STATUS` 指向的 status report，默认是 `.tmp/security/production-exposure-status.json`，用于保留 firewall/DNS/live 阻塞原因和 release evidence 采集。失败路径不会修改 `TODO.md` 勾选状态；只有所有 verifier、status report 与 `NB-P0-001` 的 `Comment:` 证据槽都通过后才会进入 TODO closeout。
- **生产证据请求包**：`tools/security/write-production-exposure-evidence-request.sh` 会从同一套 production host source 生成 `.tmp/security/production-exposure-evidence-request.json`，列出 required hosts、delegation domains、DNS resolver、必须开放/禁止开放端口、firewall policy 要求、云安全组或 UFW 采集入口、最终 closeout 命令、returned-evidence/returned-handoff closeout 命令和 release evidence 命令。请求包还会内嵌 `requiredEvidence`、`verificationCommands` 与 `handoffChecks`，明确每个必交 artifact 的目标文件、标准 release artifact 名称、直接 closeout、回传证据 verifier、回传目录 closeout、回传 handoff closeout 和 handoff 校验命令。请求包还会内嵌当前 status report 的 `currentStatus`、`blockers`、按 blocker source 生成的 `nextActions`，以及机器可读 `unblockPlan`；`unblockPlan` 会为每个 blocker source 写出 blocker count、对应 artifact 名称、evidence file path 和生成/验证命令，便于外部运维按源头补证据。`tools/security/complete-production-exposure-closeout.sh` 会在执行开始生成请求包，并在 status report 写出后再刷新一次请求包。该文件用于交给运维/云侧人员收集真实证据，不是通过证据。
- **生产证据 handoff 校验**：`tools/security/check-production-exposure-handoff.sh` 校验 request 与 status report 的 status、blocker count、blocker sources、blocker 明细、requiredHosts、delegationDomains、nextActions 覆盖、`unblockPlan` 覆盖和 `firewallPolicy`/`dnsReadiness`/`dnsDelegation`/`liveExposure`/`statusReport` evidence file 路径一致性；request 的 `requiredEvidence` 必须覆盖每个 evidence file 并声明标准 artifact 名称，firewallPolicy 条目必须声明 `sourceSha256Required=true`，`firewallPolicyRequirements.rawSourceSha256Required` 必须为 `true`，`verificationCommands`、顶层 closeout command 字段与 `handoffChecks` 必须包含直接 closeout、returned evidence verifier、returned evidence closeout、returned handoff closeout、release evidence 和 handoff 校验入口。传入 release manifest 时还会校验 bundle 内复制的 request/status/live/DNS/firewall artifact 是否使用标准文件名、是否存在且与源证据一致，并校验这些 artifact 的 `artifactDigests` sha256 摘要以及 `evidenceSummary.externalExposure.valid`、`evidenceSummary.externalExposure.blockers`、`evidenceSummary.externalExposure.request` 的 status、blocker count、blocker sources、nextActionSources、unblockPlanSources、unblockPlanCount、requiredHosts、delegationDomains、requiredEvidenceKeys、requiredEvidenceCount、firewallSourceSha256Required、rawSourceSha256Required、handoffCheckCount、verificationCommandNames、verificationCommandCount、returnedCloseoutCommandCount 与 closeoutCommands 是否与 request/status JSON 对齐。manifest 的 `firewallPolicy`、`dnsReadiness`、`dnsDelegation`、`liveExposure` 组件状态也必须与当前源证据推导结果一致，避免组件摘要被手工改写为通过。缺失 artifact 必须同时缺失 digest，避免旧 digest 被误读为通过证据。默认拒绝 `/tmp/tmp...` evidence path，避免自测 fixture 污染真实 handoff；只有测试场景可显式设置 `FSUSBLOG_ALLOW_TEMP_EVIDENCE=1`。`tools/security/export-production-exposure-handoff-bundle.sh <manifest.json>` 在 handoff 校验通过后才会生成外部交付包，包内包含 release evidence、`handoff-summary.json`、`operator-checklist.json`、`returned-evidence/expected-evidence-manifest.json`、`SHA256SUMS` 和 tarball 摘要，并在返回成功前自校验输出目录与 tarball，但 blocked manifest 仍不能作为生产 closeout 通过信号；`operator-checklist.json` 是给外部运维使用的短格式 blocker-source 清单，必须与 request 的 `unblockPlan`、artifact 名称和 closeout 命令一致；`returned-evidence/` 只是给运维回填标准 JSON 文件的空槽和 scope 清单，并保留 returned-evidence subset 的 unblock plan、plan source 列表与数量。`tools/security/check-production-exposure-handoff-bundle.sh <handoff-dir-or-tar.gz>` 会校验 bundle 目录或 tarball sha256、复制出的 release manifest artifactDigests、handoff summary、operator checklist、handoff README、returned-evidence manifest/README，并在解压前拒绝绝对路径、`..` archive member 或非普通文件/目录 entry，且拒绝 bundle 内任何 symlink，防止发送或回收时 artifact 摘要被改写、unblock plan/returned closeout 命令被丢失、标准文件名被删掉、scope 被改窄或校验过程跟随链接读取外部文件。外部证据回传后先运行 `tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>`；它会拒绝 returned evidence 目录自身或目录内文件为 symlink，要求标准文件名、先用当前 production host source 固定 requiredHosts/delegationDomains，校验可选的 `expected-evidence-manifest.json` 是否仍覆盖完整 scope、四个标准回传文件、manifest source metadata、returned `unblockPlan` sources/count 以及 plan evidence key/file/artifact/command/verifier 映射，并拒绝缩窄 scope 的 returned request 或 expected manifest，再复用 firewall/DNS/live/status verifier，刷新 returned 目录中的 status/request，生成并 handoff 校验 release manifest，避免把未验证的运维回传文件直接用于 TODO closeout。只有 returned status 为 `ok` 且目录保留 `expected-evidence-manifest.json` 时，`tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>` 才会调用标准 TODO closeout 并断言不存在未勾选项。
- **回传 handoff 一键收口**：如果外部运维回传的是整个 handoff 目录或 `.tar.gz`，先运行 `tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>`。该入口会校验 tarball `.sha256`，并在输入包含 release evidence、`SHA256SUMS` 或 `handoff-summary.json` 时先运行 `check-production-exposure-handoff-bundle.sh`，确保 release manifest、summary、operator checklist、expected manifest 和 checksum 都未被改写或缩窄；之后才定位 `returned-evidence/`、要求 `expected-evidence-manifest.json` 保留完整 scope，再复用 returned-evidence verifier 和标准 TODO closeout。直接把完整 handoff 下的 `returned-evidence/` 目录传给 `complete-production-exposure-from-returned-evidence.sh` 时，也会先检测并校验父级 handoff bundle。空回传槽、blocked evidence、scope 缩窄或 handoff bundle metadata 漂移都不得修改 `TODO.md`。tarball 输入在 verifier 写出 blocked artifacts 后失败时，会把解包后的证据保留到 `.tmp/security/production-exposure-returned-handoff/`，避免失败诊断随临时目录一起丢失。
- **Firewall evidence 自动收口**：`tools/security/complete-production-exposure-closeout.sh` 支持显式接入 `FSUSBLOG_CLOUD_FIREWALL_SOURCE`、`FSUSBLOG_COLLECT_HOST_FIREWALL_POLICY=1` 或 `FSUSBLOG_UFW_STATUS_FILE`，先生成并校验 firewall evidence，再进入 live probe 和 TODO closeout；未提供这些输入时仍要求已有 `FSUSBLOG_FIREWALL_POLICY_EVIDENCE`。
- **认证 / 会话**：注册、登录、refresh、logout、MFA、Passkey、会话吊销、伪造 Cookie/JWT。
- **鉴权 / RBAC**：匿名、普通登录用户、admin 对公开读、用户写、管理写、binary 路由的权限矩阵。
- **输入攻击**：XSS-like、SQL-like（登录用户名、admin keyword、数值查询 / 路由边界）、路径穿越、双重编码、method override、超长 payload、错误 content-type。
- **Binary / SSE**：AEDS v2、截断 frame、错误 frame type、错误版本、WebSocket 非升级、错误子协议、匿名缺 PoW。
- **真人计数**：无 proof 读取不增加浏览数，challenge 篡改、route/article 不匹配、停留不足、重放、直接 API、crawler/scanner 不写入计数事件。
- **浏览器安全面**：CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy、CORS allow/deny/preflight、auth/PoW no-store。
- **DAST**：OWASP ZAP baseline 对本地运行目标执行 spider + passive scan；FAIL 级告警会阻断发布，报告保存在 `.tmp/security/zap/`。
- **ASVS / WSTG / WebAuthn 追踪**：`security/asvs-v5.0.0-matrix.yml`、`security/wstg-v4.2-matrix.yml` 与 `security/webauthn-matrix.yml` 将安全控制映射到代码、测试、证据与 owner；`tools/security/check-security-matrices.mjs` 会在 `security` / `production` 门禁中校验矩阵结构、版本化 ID 和本地路径。
- **ZAP WARN 策略**：`security/zap-warn-policy.yml` 为每个 ZAP WARN 规则登记 owner、接受理由、修复期限、状态和升级为 FAIL 的条件；`tools/security/check-zap-warn-policy.mjs` 在 ZAP baseline 前校验清单，并保持关键规则为 FAIL。
- **供应链审计**：`tools/security/check-supply-chain-audit.sh` 执行 `dotnet list package --vulnerable --include-transitive --format json` 与 `npm audit --omit=dev --audit-level=high --json`，并要求 `src/frontend/package-lock.json` 以及每个 audited `.csproj` 旁的 `packages.lock.json` 存在；高危或严重漏洞会阻断 `security` / `production` 门禁，结果保存在 `.tmp/security/supply-chain/`。
- **依赖变更审查**：`.github/dependabot.yml` 覆盖 npm、NuGet 与 GitHub Actions 更新；`.github/workflows/dependency-review.yml` 在 PR 上阻断 high/critical advisory，并对 AGPL/GPL/LGPL license 风险 fail closed。
- **SBOM**：`tools/security/generate-sbom.sh` 从 NuGet lock files、`src/frontend/package-lock.json` 和 `FSUSBLOG_IMAGE_DIGEST` 生成 CycloneDX 1.5 SBOM，包含私有 GitHub Packages 组件和容器 digest 状态；release evidence 会复制 `.tmp/security/sbom/`。
- **隐私快照**：RUM、subscription、author AI assist、OpenTelemetry 和 audit log 都有静态或单元测试保护；audit context mapper 会丢弃 `Authorization`、cookie、token、email、request body、原始 client IP、原始 user agent 和 username 字段，只保留 trace correlation、低基数字段以及 IP/UA/session/fingerprint hash。
- **安全证据留存**：`check-security-attack-matrix.mjs` 和 `check-permission-matrix.mjs` 会分别写入 `.tmp/security/attack-matrix.json` 与 `.tmp/security/permission-matrix.json`。`tools/operations/collect-release-evidence.sh` 会把这些文件、DAST/ZAP 目录、production exposure status、DNS readiness/delegation、live exposure 和可用 firewall policy evidence 复制到 `.tmp/release-evidence/<timestamp>/`，并在 `manifest.json.securityEvidenceIndex` 中索引。`manifest.json.evidenceSummary.externalExposure` 记录外部证据是否有效；`valid=false` 表示 release 被阻塞而不是可发布。缺失的真实 firewall/DNS/live 证据不能用合成通过件替代；缺失状态应保留为 `null` 加 `production-exposure-status.json` blocker。

测试矩阵覆盖已知攻击类和回归风险，不构成对未知攻击的绝对安全承诺；新增风险必须补到矩阵或 ZAP 配置中。

---

## 生产安全检查清单

生产环境通过 `ProductionStartupValidator`、`/health/ready` 与 `./tools/test.sh security` 执行以下校验。启动阶段校验失败会 fail-closed 阻止应用启动；只有显式设置危险开关 `FSUSBLOG_ALLOW_INSECURE_STARTUP=true` 时才允许降级启动并写出 critical 告警。readiness 仍会返回 `503` 并报告失败明细，发布流程必须把该状态视为阻断。

- [ ] JWT 密钥不为默认占位值（非 `your-secret-key` 类占位）
- [ ] Redis 密码不为空
- [ ] `SITE_BASEURL` 以 `https://` 开头
- [ ] `AllowedHosts` 显式列出生产域名，且不使用 `*`
- [ ] `ReverseProxy:KnownProxies` 或 `ReverseProxy:KnownNetworks` 只包含真实网关 IP / 私网 CIDR
- [ ] CORS AllowedOrigins 中无 `http://` 来源
- [ ] `AuthCookies:AllowInsecureTransportCookies=false`，Development 以外认证 Cookie 强制 `Secure` 与 `__Host-` 前缀
- [ ] Fido2 `ServerDomain` 与实际部署域名一致
- [ ] `Fido2:Origins` 包含实际部署来源
- [ ] `Fido2:Origins` 与 `SITE_BASEURL` / `CORS_ALLOWED_HOSTS` 对齐，且生产来源全部使用 HTTPS
- [ ] Docker compose 不把 Kestrel `8080`、Redis `6379`、PostgreSQL `5432` 暴露到公网
- [ ] 生产 OpenResty/Nginx 默认拒绝未知 Host，并为 `/login`、`/admin`、`/api/Auth` 配置限流
- [ ] 使用 `FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE=.tmp/security/production-exposure-live.json tools/security/complete-production-exposure-closeout.sh`，确认生产 DNS 已解析、只有 `80/443` 对公网开放、SSH 仅允许固定管理 IP/VPN/私有管理网段、`6379/5432/8080` 不可公网访问，且所有生产域名 HTTPS + HSTS 正常；脚本验证通过后会更新 `TODO.md`

外部云安全组、防火墙和 Redis/PostgreSQL 私网访问控制仍需在基础设施层执行；仓库内检查只能防止应用配置和部署模板回退。

---

## 依赖与版本

| 依赖 | 版本 | 用途 |
|------|------|------|
| BCrypt.Net-Next | 4.1.0 | 密码哈希 |
| Fido2 | 4.0.1 | WebAuthn / FIDO2 |
| System.Buffers.Text.Base64Url | .NET 10 BCL | WebAuthn ID 编解码（替代旧版 FIDO2 helper 的 `Base64Url` 类） |
| ASP.NET Core Data Protection | 10 | Cookie 保护 |
| ASP.NET Core RateLimiting | 10 | IP 速率限制 |

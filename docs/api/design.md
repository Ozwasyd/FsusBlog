# API 设计哲学

本文件说明 FsusBlog API 层的设计原则与约定，是所有 API 变更的**必读前提文件**。

> 最近更新：2026-06-21 — Recovery Key verify request 不再携带 account id，改由 key 内 lookup id 定位候选记录。

---

## 核心原则

### 1. 契约稳定性优先

- 一旦端点路径发布，非 breaking 语义变更在原路径叠加；breaking 变更须通过新 frame type、payload layout、显式 route segment 或新端点表达，不能随意复用旧路径语义。
- 所有请求/响应字段用 `src/shared/Contracts/Outputs/ServerResponseContracts.cs` 作为唯一来源，任何业务逻辑层不得自行定义与之并行的 DTO。

### 2. AEDS Binary-only 运行时协议

运行时主业务 API 只暴露 AEDS 二进制链路：

| 链路 | Content-Type | 解码方 | 路径前缀 |
|------|-------------|-------|---------|
| **AEDS Binary** | `application/octet-stream` | TypeScript adapter / C++23 Wasm Worker | `/api/binary/...` |
| **Public AOT hydration sidecar** | `application/vnd.fsus.aeds` | public hydration bootstrap / shell navigation | `/aot-cache/payloads/.../*.aeds` |

旧文本业务 API 不再注册；`/api/**` 非 binary 业务路径统一返回 `ApiError` AEDS frame。客户端不得把解码失败回退为文本 API 请求。例外只限 [AEDS-only policy](aeds-only-policy.md) 登记的标准协议、健康探针和工具入口。通知 preflight 失败返回 AEDS `ApiError` frame，不再返回 JSON error envelope；`/api/read-proof/**`、`/api/public/articles/{id}/related`、`/api/telemetry/rum`、`/api/subscriptions`、`/api/author/**` 与 `/api/admin/security/**` 旧 JSON 入口已移除。

HTTP shell 契约由 `src/shared/Contracts/Validation/fsusblog.openapi.json` 提供，包含 method/path/status/content-type/security 与 `x-fsus-*` 扩展；AEDS payload、frame 编号、POD schema 和 golden fixture 仍由 `aeds-protocol.json`、POD 契约和 fixture 负责。

### 3. 统一响应包装

所有运行时主业务响应体均为 AEDS v2 frame。成功写操作使用 `EmptySuccess` 或 `MutationId`；失败、鉴权拒绝、限流和异常兜底统一使用 `ApiError` frame。AEDS v1 frame 不再兼容，也不保留旧 frame fallback。

### 4. 原生 AEDS 内部 API 原则

作者工作台 `/api/binary/author/**` 与管理端 security `/api/binary/admin/security/**` 的生产入口必须直接实现 AEDS v2 frame：endpoint 自己读取 route-specific request frame，成功响应直接写 route-specific response frame，错误统一写 `ApiError` frame。RiskControl 控制面读取与运行态写入（`risk-control/overview`、`risk-control/options`、`risk-control/options/rollback`、`challenges/overview`、`policies/overview`）也只允许通过原生 binary endpoint 暴露，不能恢复 `/api/admin/security/**` JSON fallback。

`JsonApiResponse<T>`、`Results.Ok(JsonApiResponse<...>)` 与 `/_fsus/internal/binary-bridge/**` 不得用于运行时内部业务 API。浏览器可达的 `/api/binary/**` 端点不得直接暴露 JSON envelope；新增业务端点默认按 [aeds-only-policy.md#内部应用-api-定义](aeds-only-policy.md#内部应用-api-定义) 设计，不新增 runtime compatibility bridge。装载点见 `src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs`，allowlist 见 [aeds-only-policy.md#允许豁免](aeds-only-policy.md#允许豁免)。

### 5. 认证一致性

鉴权要求以 `/api/binary/**` 端点声明为准。公开、登录、admin、PoW、MFA、Passkey 等边界必须在 binary 端点内直接校验；不存在文本端点作为权限参照。

高价值认证动作可以在既有 binary 路径上叠加 RiskControl proof，而不是新增平行登录 API。生产用户登录入口只保留 Passkey、Recovery Key 与必要 step-up；`auth.passkey.begin`、`auth.passkey.complete`、`recovery-key.verify` 必须通过 endpoint metadata 声明 action，并统一用 `RequiresRiskControlFilter` 返回 AEDS `ApiError`；缺 challenge proof 返回 428，block/throttle 返回 429。叠加 RiskControl 不删除 legacy PoW、admin step-up 或 MFA proof 边界；需要两个 proof 的端点必须明确登记到 [contracts.md](contracts.md#安全挑战契约) 与本文件头部表。`auth.login` 只作为 legacy 风控 action 名保留，不对应生产用户侧 password endpoint。

账号安全凭据变更的 step-up 证明必须是 action 绑定的一次性 proof token，经 `X-Fsus-Mfa-Proof` 传递。匿名身份模式下，Recovery Key create/rotate、Passkey delete/rename、account delete 等生产敏感操作不得把旧 `MfaPasswordProofRequest` body 当作 proof；非匿名 legacy password fallback 如保留，必须隔离到兼容路径，不能进入匿名生产 endpoint。

Recovery Key verify 的 AEDS request 只携带 Recovery Key 明文本体与撤销选项，不接受用户输入 account id。新 Recovery Key 明文格式为 `frk_<lookupId>_<secret>`，其中 `lookupId` 是 128-bit hex 随机值；服务端只用 peppered `lookup_id_hash` 定位候选记录，再校验完整 key 的 peppered PBKDF2 hash。旧无 lookup id 的 key 不扫描全表兼容，会按通用失败和限流处理，用户需重新生成新格式 Recovery Key。

强匿名凭证签发是登录态到匿名态的单向领取边界：`POST /api/binary/anonymous-credential/issue` 只能验证当前账号领取资格和频率，响应必须 `no-store`，签发审计只能保存 HMAC 盲化后的 `subject_hash` 维度领取计数、epoch、trace id 与结果状态。服务端不得把 raw `user_id` 与最终 credential commitment、nullifier、proof witness 或 credential secret 建立持久映射；后续匿名评论 ticket / submit 也不得依赖该端点留下可反查账号的状态。

强匿名 root/circuit metadata 是公开读取边界：`GET /api/binary/anonymous-credential/root` 和 `/circuit` 只返回公开的 credential root、epoch、expiry、circuit id、verifying key hash、public input layout version 与 ZK/verifier 配置位。`verifierConfigured` 只来自生产 `IZkProofVerifier.IsConfigured`，用于告诉 prover 当前服务端是否有完整 verifier adapter，不在该读取路径验证 proof。该读取路径必须匿名、`public_read` 限流、AEDS-only，不读取 Cookie、session、Authorization 或当前账号；root 不可用时 fail closed 为 AEDS `anonymous_root_unavailable`。服务端缓存对象必须按 root version/TTL 失效，negative cache 只短暂吸收 miss，不承担 root rotation worker 职责。

强匿名撤销 witness 是公开匿名元数据的派生读取边界：`POST /api/binary/anonymous-credential/revocation-witness` 只接受 AEDS `AnonymousCredentialRevocationWitnessRequest`，必须匿名、`public_read` 限流、`no-store` 并拒绝登录态污染。端点只用请求内公开 root/circuit/issuer 字段、不可逆 revocation handle hash、当前 root snapshot 和 epoch 撤销集合生成 `circuit-friendly-non-membership.v1` witness；它不读取用户身份、不签发 credential、不生成 ticket、不验证 Groth16 proof，也不能作为 production circuit 完成信号。

强匿名评论 ticket 是匿名评论写入前的无登录态准入边界：`POST /api/binary/comment/anonymous-ticket` 只接受 `AnonymousCommentTicketRequest` AEDS frame，必须 `AllowAnonymous`、`public_read` 限流并拒绝任何 Cookie/session/Authorization 污染。服务端先做 article/scope/hash/reply context/frame 大小等廉价校验，再使用当前 root snapshot 和 `IZkAnonymousProofService` 预验证 proof；通过后只返回一次 opaque ticket，缓存层只保存 ticket hash 对应的短 TTL 二进制 payload，并以 consume-once 语义交给 `POST /api/binary/comment/anonymous`。匿名 submit 只接受 `AnonymousCommentCreateRequest`，同样拒绝登录态污染；成功后写入 `comment.user_id = null`、`author_mode = zk_anonymous`、`reply_to_user_id = null`、匿名治理字段、地区合规记录和 Pending 审核状态，不把 ticket/proof/credential 原文写入评论。公开评论读取只能从评论行作者快照生成展示名：匿名/强匿名使用 `anonymous_display_name` 或匿名兜底，public send 使用 `public_handle` 或未署名兜底，不能回退 `sys_user.username`。回复展示只能通过 `reply_to_comment_id` 指向的评论作者快照生成，不依赖 `reply_to_user_id` 或 `sys_user` join 还原匿名作者。ticket 端点不得写评论正文、不得建立 user id 到 nullifier/credential 的映射，也不得把 proof 失败细节返回给客户端。

---

## URL 命名约定

| 规则 | 示例 |
|------|------|
| Binary 端点统一前缀 `/api/binary/` + 小写资源名；公开热点 article 使用无 query 的 artifact 路径 | `/api/binary/article/list/home/1/10.aeds`、`/api/binary/comment/{id}` |
| 消息系统使用 binary 消息路径 | `/api/binary/messages/conversations` |
| 管理端以 binary admin 资源路径区分 | `/api/binary/admin/users`、`/api/binary/stats` |
| 作者工作台生产前端使用原生 AEDS endpoint；不保留 legacy JSON runtime 兼容层 | `/api/binary/author/drafts`、`/api/binary/author/audit`、`/api/binary/author/moderation/overview` |
| 健康检查与通知独立于业务路径 | `/health/live`、`/health/ready`、`/api/ops/health/ready-detail`、`/api/notifications/stream` |

---

## HTTP 方法语义

| 方法 | 用途 |
|------|------|
| `GET` | 读取资源，幂等，可缓存；AEDS read request frame 必须使用 `Flags = 0` |
| `HEAD` | 只读取 HTTP metadata；仅用于 L0 artifact / 静态分发探测，不返回 AEDS body |
| `POST` | 创建资源或执行动作（登录/挑战/发送） |
| `PUT` | 全量更新单个资源属性（重命名） |
| `DELETE` | 删除资源 |
| `OPTIONS` | 不作为业务 API；L0 artifact fast path 在同源场景返回 `405 Method Not Allowed`，CORS 不在 fast path 注入 |

Binary 端点按资源语义使用 `GET/POST/PUT/DELETE`；认证、MFA、Passkey、上传和管理端写入均不得退回旧文本路径。
Binary 写入请求必须使用 `Content-Type: application/octet-stream` 和 AEDS v2 request frame；当前生产协议拒绝 request non-zero flags，`Flags = 64` 等 future flag 只能在 `aeds-protocol.json`、负向 contract matrix、TypeScript/Worker/Wasm decoder 与 [schemas-and-errors.md#flags-登记](schemas-and-errors.md#flags-登记) 同步登记后启用。
匿名身份模式下，新账号 onboarding 必须走 `POST /api/binary/auth/anonymous/bootstrap`，请求 frame 为 `AuthAnonymousBootstrapRequest`；该路径只初始化匿名账号容器和当前 session，不接受用户提供的登录密码，也不得复用旧 username/password 契约。旧 `/api/binary/auth/register` 与 `/api/binary/auth/login` password endpoints 不再是生产 API；旧 password-auth request 编号已经从 AEDS frame catalog 下线，不能作为 legacy/test frame 继续消费。AEDS 数值 `43`/`44`/`45`/`46` 已作为 legacy username/password auth slots 退休，不再生成 frame 名、POD、codec 或 OpenAPI 契约。
`GET /api/binary/auth/me` 只输出 `IdentityAccountSnapshot` 匿名账号容器：account/internal id、`identityKind`、`publicHandle`、Passkey/Recovery/TOTP 状态、anonymous credential 状态和账号封禁/注销状态。该响应不得暴露内部 `sys_user.username` 或 `sys_user.role`，客户端也不得从普通账号快照推断 admin 权限；后台权限只能来自 independent admin principal 与 admin session Cookie。
管理端账号定位只允许通过 accountId 查询 `/api/binary/auth/{id:int}` 或 `/api/binary/admin/users` 的匿名账号搜索维度完成；旧 `/api/binary/auth/find/{username}` 已下线，`sys_user.username` 不再作为常规管理 API 查询键。
TOTP 在匿名身份模式下只作为敏感操作 step-up。TOTP issuer account label 必须使用非识别 `FsusBlog:account:{accountId}`，`/mfa/setup/start`、`/mfa/disable` 和 `/mfa/recovery/regenerate` 必须通过 `X-Fsus-Mfa-Proof` 消费对应 action 的一次性 proof，不接收旧 username/password body proof；TOTP recovery code 不得混同账户 `Recovery Key`。
`PUT /api/binary/auth/public-handle` 是唯一用户侧公开称呼写入入口，使用 `AuthUpdatePublicHandleRequest` + `StringMutationRequestPod`；空字符串表示清空。评论 public send 只能读取已持久化的 `public_handle`，未设置时拒绝 public mode，不能回退内部 username 或合成 user id。
账号侧 `GET /api/binary/comment/me` 是可归因评论记录，只返回当前账号显式 public/公开发送的评论；强匿名评论不进入该记录，也不能通过账号 ID 自删。`comment.user_id` 在评论最终态中只允许服务 public attribution，必须同时绑定 `author_mode = public`，旧 generic `idx_comment_user_id_desc` 不得作为默认匿名评论查询入口恢复。强匿名撤回若需要支持，必须另走 receipt、capability token 或 nullifier proof 方案；在此之前只允许管理员按治理权限删除。

---

## 分页约定

系统使用两种分页模式：

### 基于页码的分页（`PageResponse<T>`）

适用于：文章列表、匿名账号治理列表等需要总数的场景。

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

| 类别 | 头部 | 方向 | 说明 |
|------|------|------|------|
| 安全强制 | `X-Fsus-Mfa-Proof` | 请求 | admin-sensitive、高价值作者/安全写操作和普通用户敏感凭据操作的一次性 step-up proof；消费语义见 [contracts.md#user-mfa--totp-step-up](contracts.md#user-mfa--totp-step-up)、[contracts.md#admin-作者工作台](contracts.md#admin-作者工作台) 与 [contracts.md#admin-安全系统](contracts.md#admin-安全系统)。 |
| 安全强制 | `X-Fsus-Admin-Bootstrap-Token` | 请求 | 首次 root admin Passkey bootstrap 的显式环境守门 token；必须匹配 `FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN` / `Admin:BootstrapToken`，root admin 存在后不再生效。 |
| 安全强制 | `X-Fsus-Admin-Handle` | 请求 | 首次 root admin Passkey bootstrap 的后台 handle；只用于 admin principal，不写入普通匿名账号。 |
| 安全强制 | `X-Fsus-Pow-Proof` | 请求 | legacy PoW proof，用于匿名账号 bootstrap、Recovery Key verify、匿名 notification stream 或 `public_read` 风险升级后的动态公开 API；不用于 PublicHotRead L0 artifact 命中路径。 |
| 安全强制 | `X-Fsus-Challenge-Proof` | 请求 | RiskControl challenge verify 成功后签发的一次性 opaque proof；业务 endpoint 只能由 `RequiresRiskControlFilter` 消费。 |
| 安全强制 | `X-Fsus-Challenge-Id` | 请求 | 与 `X-Fsus-Challenge-Proof` 绑定的 challenge id；缺失、重放或 action / route / IP / device mismatch 返回 428。 |
| 安全强制 | `X-Fsus-Challenge-Kind` | 请求 | 与 `X-Fsus-Challenge-Proof` 绑定的 provider kind，例如 `sha256PowV1`；legacy alias `security.pow` 只作为兼容输入规范化。 |
| 安全强制 | `X-Fsus-Subscription-Proof` | 请求 | 公开站点订阅退订的一次性 opaque proof；必须由服务端 proof API 签发并绑定 `SHA256(normalizedEmail)` 与归一化 channel，`DELETE /api/binary/subscriptions` 消费，缺失、重放、过期或绑定不匹配返回 428。 |
| 安全强制 | `X-Fsus-Device-Fp` | 请求 | 认证、HumanReadProof、审计和风险信号使用的设备指纹；不得包含可逆身份信息。 |
| 通知通道 | `X-Fsus-Notification-Stream-Protocol` | 请求 | notification preflight fallback 协议头；正式 WebSocket 仍使用 `Sec-WebSocket-Protocol: fsus-aeds.v2`。 |
| 通知通道 | `X-Fsus-Notification-Stream-Error-Code` | 响应 | notification preflight / WebSocket 握手失败业务码，例如 `account_blocked`、`auth_failed`、`pow_failed`、`risk_challenge_required`。 |
| 通知通道 | `X-Fsus-Notification-Stream-Status-Code` | 响应 | notification preflight / WebSocket 握手失败映射的 HTTP status。 |
| 测试工具 | `X-Fsus-Notification-Drill-Secret` | 请求 | 仅 Development/Test 映射的 notification slow-consumer resilience drill 凭据；必须匹配 `FSUSBLOG_NOTIFICATION_DRILL_SECRET` / `NotificationStream:DrillSecret`。 |
| AOT 运维 | `X-Fsus-Public-Aot-Token` | 请求 | `GET /internal/public-aot/manifest` 与 `GET /internal/public-aot/health` 在配置 `PublicAot:ManifestToken` 时要求的 tooling token。 |
| 可观测性 | `X-Fsus-Trace-Id` | 响应 | 与 `HttpContext.TraceIdentifier`、OpenTelemetry trace 和审计上下文对齐的排障 ID；不是认证凭据。 |
| L0 artifact | `X-Fsus-Frame-Encoding` | 响应 | `.aeds` artifact 命中时标记 raw/br/gzip variant。 |
| L0 诊断 | `X-Fsus-HotRead-Version` / `X-Fsus-HotRead-Artifact` / `X-Fsus-HotRead-Key` | 响应 | PublicHotRead 诊断头，默认关闭；只能通过 `PublicHotRead:EnableDiagnosticHeaders=true` 打开。 |

不存在额外的 Shield 来源校验头或旧文本 PoW answer/challenge 头运行时契约；新增 `X-Fsus-*` 头必须先登记到本表、OpenAPI `x-fsus-*` 扩展或对应 contract 文档。

### FPOW proof 信封

HTTP 动态公开 API 使用 `X-Fsus-Pow-Proof`，notification stream 匿名连接的 legacy 兼容路径使用 `pow` query 参数；两者都承载同一种 base64 文本形式的二进制 FPOW 信封。前端实现位于 `src/frontend/src/services/powProofCodec.ts`。

FPOW 信封字段顺序为：`magic[4] = "FPOW"`（字节 `46 50 4f 57`）、`version:uint8 = 1`、`difficulty:int32LE`、`timestamp:int64LE`，随后是若干 `uint16LE length + utf8 bytes` 字段。HTTP header proof 字段为 `salt, nonce, signature, browserFp`；notification stream proof 字段为 `salt, nonce, signature, fp`。服务端按 proof 绑定的 challenge、时间戳、nonce、签名、设备指纹和 `ForwardedHeadersMiddleware` 规范化后的客户端 IP 校验，不接受旧文本 PoW answer/challenge 头，也不在 PoW 验证层回退到 raw remote IP、localhost 或 Docker bridge IP。

RiskControl 新 challenge provider 不得自定义平行 assignment 结构。PoW、Captcha、PoSpace、HumanReadProof、Passkey step-up、匿名凭证和 ZK 匿名评论 proof 都必须使用 `SecurityChallengeAssignment` / `SecurityChallengeEnvelope` AEDS frame，统一携带 challengeId、traceparent、tenantId、kind、action、routeKey、subject/client IP/device fingerprint hash、issued/expires 和 escalationLevel；provider 只扩展自己的 proof 验证载荷。

受 RiskControl 保护的业务请求不得把 provider proof 直接发给业务 endpoint；客户端必须先调用 `/api/binary/security/challenge/verify` 换取一次性 `X-Fsus-Challenge-Proof`，再与 `X-Fsus-Challenge-Id`、`X-Fsus-Challenge-Kind` 一起提交到业务 endpoint。notification stream 匿名订阅的 `notification.subscribe` action 同样走该 proof 绑定：preflight 可使用 `X-Fsus-Challenge-*` header，正式 WebSocket 因浏览器无法自定义握手 header，可使用 `challengeProof`、`challengeId`、`challengeKind` query 参数；preflight 不消费一次性 proof，只校验存在性和 kind，正式 WebSocket 握手才消费。Passkey assertion 失败只能写风险信号，不改变登录响应 frame；Passkey assertion 成功可写负分风险信号，并继续以 Passkey 作为 MFA 已满足的登录凭据。

`/api/binary/security/challenge/verify` 的尝试次数限制是服务端 hot-path 安全控制，不改变 AEDS request / response contract。端点只依赖 `ISecurityChallengeVerifyRateLimiter`；限流状态必须落在统一缓存 `SecurityChallengeVerifyRateLimit` policy 下，按 1 分钟窗口、客户端 IP hash、device fingerprint hash、规范化 action 和 challengeId hash 计数，超过 3 次时仍返回通用 `challenge_failed`，并写 `SecurityChallengeRejected` 风险信号。

---

## 状态码约定

| 状态码 | 含义 |
|--------|------|
| `200 OK` | 操作成功 |
| `204 No Content` | 预检或无 body 操作成功，例如 notification preflight 成功 |
| `304 Not Modified` | L0 artifact 的 variant-aware `ETag` 命中当前 `Accept-Encoding` variant |
| `400 Bad Request` | 参数无效、业务校验失败 |
| `401 Unauthorized` | 未提供或无效的 Bearer Token |
| `403 Forbidden` | 权限不足（已登录但角色不满足） |
| `404 Not Found` | 资源不存在 |
| `405 Method Not Allowed` | 方法不允许；L0 artifact 只接受 `GET` / `HEAD` |
| `406 Not Acceptable` | `Accept` 与 artifact 类型不匹配 |
| `409 Conflict` | 资源冲突（如用户名已存在） |
| `416 Range Not Satisfiable` | L0 artifact 不支持 Range；`.aeds` 命中声明 `Accept-Ranges: none` |
| `423 Locked` | 登录用户处于封禁/受限状态，notification stream 使用 `account_blocked`，普通业务写入锁使用 Binary `ApiError.Details = ACCOUNT_BANNED_WRITE_LOCKED` |
| `429 Too Many Requests` | 速率限制触发，响应含 `Retry-After` 头 |
| `500 Internal Server Error` | 服务端异常，错误详情不暴露给客户端 |
| `503 Service Unavailable` | L0 快照未进入 `Ready` 状态，默认带 `Retry-After: 1`；除非显式启用 fail-open 到常规管线 |

L0 artifact 的 `400` / `404` / `405` / `406` / `416` / `503` 负响应固定 `Cache-Control: no-store`，避免中间层缓存未就绪或协商失败结果。

---

## 版本管理策略

当前运行时业务 API 不使用 `/api/v1/`、`/api/v2/` 这类统一 URL 版本前缀；新模块继续落在 `/api/binary/**`、`/api/notifications/stream` 或明确登记的标准协议路径下。常规业务 **Breaking Change** 优先通过新增 frame type、payload layout、显式 route segment 或新端点表达，并在 [aeds-only-policy.md](aeds-only-policy.md) 与 [quick-reference.md](quick-reference.md) 同步登记。

AEDS wire protocol 是传输层版本，不等同于 URL 版本。当前运行时只接受 AEDS v2 header；AEDS v1 frame、未知版本和错误 header length 直接拒绝，服务端和前端不保留 v1 fallback。未来 wire-level 破兼容必须先进入 `aeds-protocol.json`、`schemas-and-errors.md`、golden fixture、TypeScript/Worker/Wasm decoder 与负向 contract matrix。

匿名身份与评论作者模式扩展使用新增 AEDS frame，而不是改写已发布 payload layout。登录态 `/api/binary/comment` 只服务显式公开/可归因发送，仍使用 `CommentCreateV2Request`，但必须同时声明 `authorMode=public` 与 `publicSendExplicitlySelected=true`；默认匿名或强匿名提交必须走 ticket + `AnonymousCommentCreateRequest` 主路径。退休的数值 37 frame 不再作为业务请求执行，必须按未知 frame / 协议错误拒绝。匿名 scope、public opt-in、语言提示和普通 proof token 必须走 `CommentCreateV2Request`，但 `ProofToken` 不得作为 ZK credential commitment/root 或 nullifier source。匿名凭证、root snapshot、匿名评论 ticket 和匿名评论创建请求使用 177-183 的独立 frame；root/circuit/policy/ticket/submit 已注册的路径必须在 quick reference 中登记，未注册的 frame 仍只代表跨栈 POD/codec 契约。评论 composer 必须先从 `GET /api/binary/comment/policy` 解码 `CommentPolicySnapshot`，以服务端策略决定 anonymous/public/ZK author mode，而不是在组件内硬编码默认策略。服务端写入时统一通过 `CommentActor` 或匿名 ticket payload 解析作者，默认 anonymous，public/real-name 只在显式 opt-in 后写入 `public_handle`，`zk_anonymous` 的 nullifier 只能来自 proof public input 并经 verifier 校验；普通匿名/伪匿名才允许使用工程匿名 fallback。Passkey 和 Recovery Key 仍复用现有 frame，匿名身份不得新增平行 Passkey 协议栈。

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

真相源：[`NotificationStreamHandshakeService.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamHandshakeService.cs)、[`NotificationStreamHandler.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamHandler.cs)、[`NotificationStreamSessionService.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamSessionService.cs)。

### 通道

- 正式通知端点：`GET /api/notifications/stream`，仅接受 WebSocket upgrade。
- 子协议：`Sec-WebSocket-Protocol: fsus-aeds.v2`；preflight fallback 可用 `X-Fsus-Notification-Stream-Protocol: fsus-aeds.v2`。
- 每条业务消息都是 AEDS binary frame；事件 frame 使用 `AedsFrameType.NotificationEvent = 69`，心跳 frame 使用 `AedsFrameType.NotificationHeartbeat = 70`，错误使用 `ApiError = 251`（见 [schemas-and-errors.md#aedsframetype-枚举](schemas-and-errors.md#aedsframetype-枚举)）。

### 握手预检

`GET /api/notifications/stream/preflight` 复用认证、匿名 RiskControl / legacy PoW、cursor 和协议校验，但不要求 WebSocket upgrade；成功返回 `204`，失败返回 AEDS `ApiError` frame，并写入 `X-Fsus-Notification-Stream-Error-Code` / `X-Fsus-Notification-Stream-Status-Code`。匿名 preflight 可通过 `X-Fsus-Challenge-*` header 提交 `notification.subscribe` RiskControl proof，也继续兼容 `pow` query 参数；正式 WebSocket 可用 `challengeProof` / `challengeId` / `challengeKind` query 参数提交 RiskControl proof，或继续使用 legacy `pow` query 参数。公开事件不绕过匿名订阅准入。

### 匿名 vs 认证

匿名连接只接收公开事件（GlobalNotice、CacheControl 等），但匿名不等于零门槛：`NotificationStreamHandshakeService` 在 `!isAuthenticated` 时先接受有效 legacy `pow`，否则按 `notification.subscribe` RiskControl 裁决要求 proof、升级 PoSpaceV1 或阻断，失败映射为 `risk_challenge_required`、`risk_challenge_rejected`、`risk_control_blocked` 等握手失败码。已认证用户额外接收私人事件（MessageReceived、InboxConversationUpsert 等）；如果请求携带认证头但认证失败，握手返回 `auth_failed`。

### 错误码与持久化对照

| 失败码 | 持久化源 | 缓存层 | miss 回查 | HTTP status | AEDS frame |
|--------|----------|--------|-----------|-------------|------------|
| `websocket_required` | WebSocket upgrade 语义 | 无 | 无 | `426` | `ApiError` |
| `protocol_mismatch` | `fsus-aeds.v2` 子协议 | 无 | 无 | `409` | `ApiError` |
| `auth_failed` | JWT / cookie auth 结果 | 认证栈内部 | 认证栈处理 | `401` | `ApiError` |
| `pow_failed` | PoW challenge / replay proof | SecurityPowProof / risk cache | PoW service 校验 | `401` 或 `400` | `ApiError` |
| `risk_challenge_required` | RiskControl `notification.subscribe` 裁决 | SecurityChallengeProof / risk cache | RiskControl policy 校验 | `428` | `ApiError` |
| `risk_control_blocked` | RiskControl `notification.subscribe` 裁决 | SecurityRisk | RiskControl policy 校验 | `429` | `ApiError` |
| `account_blocked` | `sys_user.Status` / `BanReason` | Redis 黑名单快路径 | 必须回查 DB 并回填 | `423` | `ApiError` |
| `account_deleted` | `sys_user` 不存在、删除或停用 | admission cache | 必须回查 DB | `401` | `ApiError` |

封禁账号认证成功后可以持有受限会话完成安全收尾，但普通业务写入必须由服务端返回 `423 Locked` + `ACCOUNT_BANNED_WRITE_LOCKED`；客户端禁用控件只能作为体验优化，不能替代后端写锁。完整失败码表见 [schemas-and-errors.md#notification-stream-握手失败码](schemas-and-errors.md#notification-stream-握手失败码)。

### Heartbeat 与重连

服务端用 `AedsFrameType.NotificationHeartbeat = 70` 发送 `int64 timestampUnixMs` 心跳；连接 pump 通过发送锁串行写业务 frame 与 heartbeat，避免并发写 WebSocket。客户端应存储最后收到的 cursor 值，断线重连时通过 `cursor` query 参数传递；`Last-Event-ID` 只作为兼容读取，不是首选浏览器 API。

### 测试 drill 入口

`POST /_fsus/testing/notification-stream/publish` 只在 `Development` / `Test` 环境映射，且必须携带 `X-Fsus-Notification-Drill-Secret`。它通过真实 `INotificationStreamPublisher` 发布 `CacheControl` 测试事件，返回发布 event id 与 route key，用于 resilience lane 验证慢消费者关闭、心跳未饿死、正常连接业务帧投递和 cursor backlog replay。该路径不属于生产业务 API；生产环境不映射，未配置 secret 时返回 `404`。

### 审计与缓存清理

慢消费者（背压积压）自动断开连接，客户端需实现重连逻辑。写消息、连接中断、重连和封禁/删除状态变化必须保留可观测性；公开评论审核导致已公开评论新增、隐藏、拒绝或删除时，必须同步清理 comment cursor/frame 缓存，并通过 notification stream 推送 `CommentAdded` 或 `CommentRemoved`。

---

## AOT 公开页约定

公开页（首页、文章详情、分类、标签、归档、关于、隐私政策、用户守则、版权声明）优先从 AOT 卷命中静态 HTML + AEDS payload。Bundle 格式遵循 [`PublicAotShellEntryContract`](contracts.md#aot-公开页契约)；SPA 接管后由 hydration 层用同一份 Bundle 数据初始化状态，无需二次网络请求。

代码证据：[`PublicAotDocumentComposer.cs`](../../src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs)、[`PublicHotReadFastPath.cs`](../../src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs)、[`PublicAotEndpoints.cs`](../../src/backend/Modules/Endpoints/PublicAotEndpoints.cs)。

### 页面输入与 SSR 真相源

公开 footer 合规信息来自 `SiteComplianceConfig` AEDS frame。空配置不得输出备案号占位；admin 保存合规配置后必须同时失效 system compliance cache、SEO/distribution cache 和 Public AOT 静态页，使 sitemap/RSS/footer 在无重启情况下收敛。

统一 SEO 与品牌资产来自同一个 `SeoConfig` AEDS frame，不新增 `/system/brand` 并行主端点。`/api/binary/system/seo` 同时承载基础 SEO、OpenGraph 预览图、favicon/browser icon、Apple Touch Icon、PWA manifest 名称/图标/theme/background、公开站点 logo/wordmark、后台 logo/折叠图标和登录 logo/icon。保存后必须通过 SEO 配置失效链路刷新 HTML head、动态 `manifest.webmanifest`、Public AOT shell、公开 shell hydration、后台与登录页品牌展示；旧配置缺失新增字段时按默认静态路径或空值补齐。资产 URL 只接受站内绝对路径或 `http/https` 绝对 URL，不接受 `javascript:`、`data:` 或协议相对 URL。

公开页结构的 SSR 入口是 [`src/frontend/src/public-renderers/renderPublicPage.ts`](../../src/frontend/src/public-renderers/renderPublicPage.ts)，该入口向 server SSR worker 暴露 `buildPublicEntry`、payload codec 与 renderer version；具体页面组合由 `publicEntryRegistry.ts`、`pageAssemblies.ts` 与 `scaffold.ts` 维护。文档和实现不得再引入额外 helper 作为公开页结构真相源。服务端 AOT provider 只提供数据型 options，不手写 hydration props、不渲染 Markdown、不拼页面内部 HTML；Node/Vue SSR worker 负责生成 `html / bootstrapPayload / hydrationPropsPayload`，服务端只做文档包装、hydration `.aeds` sidecar 写出、缓存与降级。hydration sidecar 是 content-hash URL，使用 `application/vnd.fsus.aeds` 与 immutable cache；运行时 `/api/binary/**` 仍使用 `application/octet-stream`。

`GET /api/public/navigation-snapshot.aeds?path={publicPath}` 是公开 SPA micro-navigation 的原子接管快照端点。它只接受同站相对路径，并通过 Public AOT route registry fail closed 校验首页、归档、文章详情、分类、标签和固定静态页；账号、搜索、admin、协议相对 URL 和绝对外链不进入快照链路。响应使用 `application/vnd.fsus.aeds`，AEDS frame 复用 `PublicAotBootstrap`，外层 envelope 的 `kind` 固定为 `public-navigation-snapshot`，内层 `bootstrapPayload` / `hydrationPropsPayload` 仍由同一个 Node/Vue SSR worker `buildEntry` 生成，避免 HTML、bootstrap 与 hydration 分裂为三套真相源。

### feed / sitemap / robots 缓存约束

feed、sitemap 与 robots 等开放分发文本端点只负责生成标准格式正文、声明 `Cache-Control: public, max-age=60, stale-while-revalidate=300` 并挂载 OutputCache ArticleList/Seo tag；端点本身不得按响应正文手写 ETag、解析 `If-None-Match` 或绕过统一缓存失效链路。

代码证据：[`DistributionEndpoints.cs`](../../src/backend/Modules/Endpoints/DistributionEndpoints.cs)、[`BlogDistributionService.cs`](../../src/backend/Services/Distribution/BlogDistributionService.cs)；JSON/feed 豁免见 [`aeds-only-policy.md#允许豁免`](aeds-only-policy.md#允许豁免)。

### 公开 AOT artifact 路径

公开 Binary 读模型与 HTML AOT 一样按 artifact 边界治理。匿名热点路径包括：

- `/api/binary/article/{id}.aeds`
- `/api/binary/article/list/home/{page}/{size}.aeds`
- `/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds`
- `/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds`
- `/api/binary/article/hot/{size}.aeds`
- `/api/binary/category.aeds`
- `/api/binary/tag.aeds`

这些路径由 `PublicHotReadFastPath` 在常规应用管线前读取内存快照并直接写出完整预编码 frame；hit 路径不查询 PostgreSQL、Redis、IMemoryCache、OutputCache 或文件系统。artifact miss 只返回可降级状态码，DB fallback 只能出现在后台 projector、修复任务或 admin/private 读取路径。L1/L2/OutputCache 仍是加速层，不等价于 CQRS read model。路由清单以 [`quick-reference.md#开放分发与作者工作台`](quick-reference.md#开放分发与作者工作台) 为人工速查真相源。

公开 GET 不默认要求 PoW，以免伤害 SEO、RSS、分享卡片和无 JS 阅读；但公开评论读取、公开 taxonomy、related-reading 等动态 API 会进入 `public_read` 限流和 `RiskAwarePublicReadFilter`。风险分由 Shield、RateLimiter、PoW 与 ReadProof 拒绝事件写入；达到阈值时动态 API 要求 `X-Fsus-Pow-Proof`，持续高风险返回 429。PublicHotRead artifact 命中保持零 DB/零 Redis/零 filter 快路径。

### L0 artifact HTTP 语义

L0 artifact 只接受 `GET`/`HEAD`；`OPTIONS` 在同源场景下返回 `405`，不在 fast path 上注入 CORS。Binary artifact 接受空 `Accept`、`*/*` 或 `application/octet-stream`；HTML artifact 只接受空 `Accept`、`*/*` 或 `text/html`；不匹配时返回 `406`。快照未进入 `Ready` 状态时返回 `503` + `Retry-After: 1`，除非显式启用 `PublicHotRead:FailOpenWhenNotReady` 降级到常规管线。`400`/`404`/`405`/`406`/`416`/`503` 等 L0 负响应固定 `Cache-Control: no-store`，`Range` 请求返回 `416`。`.aeds` 命中声明 `Accept-Ranges: none`，并可按 artifact 预生成 raw/br/gzip variant 返回 `Content-Encoding`、`Vary: Accept-Encoding` 和 variant-aware `ETag`；`If-None-Match` 命中当前 variant 时返回 `304`。HTML artifact 必须是静态 CSP 形态，不依赖 nonce placeholder 或 inline script。

状态码与 frame 目录见 [`schemas-and-errors.md#aedsframetype-枚举`](schemas-and-errors.md#aedsframetype-枚举)。

### AOT 路由 vs 真实公开 URL

`/api/binary/article/html/{pathKey}.html` 是 AOT shell 的诊断/预览 artifact 命中路径，不是 `/article/{id}`、`/category/{id}` 等真实公开 URL 的替代路由；真实页面仍由 public route + AOT shell/SPA 渲染。

### pathKey 与 routeKey 映射

`routeKey` 与 URL-safe `pathKey` 分离：`article:42` 映射为 `article-42`，`category:7`/`tag:9` 同理；`tag-name:*`、包含空白、斜杠或非 ASCII 的 routeKey 使用 `route-<sha256 前 8 字节 hex>` 稳定 hash pathKey。实现见 [`PublicHotReadFastPath.cs`](../../src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs) 的 `StableRouteHash`。

### 诊断头 `X-Fsus-HotRead-*`

可观测诊断头 `X-Fsus-HotRead-Version`、`X-Fsus-HotRead-Artifact` 与 `X-Fsus-HotRead-Key` 默认关闭，只能通过 `PublicHotRead:EnableDiagnosticHeaders=true` 打开；成功命中才写出诊断头，负响应不得泄露 artifact key。实现见 [`PublicHotReadFastPath.cs`](../../src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs)。

### AOT route manifest 与 `X-Fsus-Public-Aot-Token`

Public AOT 预热和内容变更驱动 backfill 必须消费后端权威 route manifest，而不是脚本猜测 URL。`GET /internal/public-aot/manifest` 只暴露公开 SEO route，支持 `scope=all`、`scope=hot` 与 `changedSince`，并通过 `dependencyKeys` 连接 `article:{id}`、`category:{id}`、`tag:{id}`、`article:list`、`seo`、`compliance` 等内容依赖。`GET /internal/public-aot/health` 暴露 SSR worker resource check、Node probe、`validateBundle` sample probe、队列计数、breaker 状态和 route quarantine 快照，供 release/ops 诊断；它不是浏览器运行时 API。配置 `PublicAot:ManifestToken` 时，两个内部 tooling endpoint 都必须携带 `X-Fsus-Public-Aot-Token`。

代码证据：[`PublicAotEndpoints.cs`](../../src/backend/Modules/Endpoints/PublicAotEndpoints.cs)。

### AOT sentinel 与 `data-fsus-aot-head`

Public AOT document composer 只允许通过以下 5 个具名 sentinel 写入 AOT 管理区域；sentinel 是字符串相等匹配，不接受通配符。

| sentinel | 用途 |
|----------|------|
| `<!--fsus:aot:head-start-->` | SEO/head 注入起点 |
| `<!--fsus:aot:head-end-->` | SEO/head 注入终点 |
| `<!--fsus:aot:app-->` | SPA/AOT shell 挂载点 |
| `<!--fsus:aot:payloads-->` | bootstrap AEDS 注入点与 hydration `.aeds` sidecar marker 注入点 |
| `<!--fsus:aot:spa-boot-->` | deferred SPA boot 注入点 |

模板缺少任一 sentinel 必须失败而不是静默降级。AOT 负责维护的 description/canonical/Open Graph/Twitter/feed/JSON-LD head 节点必须统一带 `data-fsus-aot-head`，客户端 micro-navigation 只替换这些标记节点，不触碰 Vite runtime、CSP nonce 或其他非 AOT head。新增 sentinel 必须同步更新 [`PublicAotDocumentComposer.cs`](../../src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs)、本节列表、[`contracts.md#aot-公开页契约`](contracts.md#aot-公开页契约) 与 [`tests/frontend/checks/public/check-public-aot-contracts.mjs`](../../tests/frontend/checks/public/check-public-aot-contracts.mjs) 的完整性断言。

## 单作者内容生命周期约定

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)、[`useAdminArticleWrite.ts`](../../src/frontend/src/composables/useAdminArticleWrite.ts)。高价值审计定义见 [`../security.md#审计级别`](../security.md#审计级别)。

### 文章状态枚举

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)。

文章状态的单一语义如下；AEDS `ArticleList` record 中的 `status:int32` 必须按此表解释，公开读链只承认 `Published` 且已到发布时间的数据。

| status | 名称 | 作者/管理端含义 | 公开可读 | 公开 artifact/feed/sitemap/search |
|--------|------|----------------|----------|----------------------------------|
| `0` | `Draft` | 草稿，可预览、保存、发布或丢弃 | 否 | 不进入 |
| `1` | `Scheduled` | 定时发布，未到点前只在作者/管理端可见 | 仅当调度 worker 转为 `Published` 后 | 未发布前不进入 |
| `2` | `Published` | 已发布文章；还需满足发布时间已到 | 是 | 进入公开 Binary、AOT、feed、sitemap、search、related-reading |
| `3` | `Archived` | 归档保留，仍可由作者/管理端管理 | 否 | 不进入 |
| `4` | `Deleted` | 回收站 / 删除状态；仅管理端按删除语义读取 | 否 | 不进入 |

新增公开分发端点、AOT、搜索、Binary list、feed、sitemap、related-reading 时必须复用此表，不能各自放宽过滤条件。

### 公开 / 管理读写分离

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AedsJsonResults.cs`](../../src/backend/Infrastructure/Results/AedsJsonResults.cs)。

公开 article Binary 端点不再按身份混合语义。匿名公开读只能使用 `/api/binary/article/**.aeds` artifact 路径，客户端必须省略 credentials；admin/private 读写统一使用 `/api/binary/admin/article/**`，可读取所有非删除状态，并可用 `status=0/1/2/3/4` 精确管理 draft、scheduled、published、archived、deleted。任何旧 query 公开路径或匿名管理查询都不得退回文本 API 或泄露未发布标题。

作者工作台生产 API 放在 `/api/binary/author/**`，全部使用 admin 授权和 AEDS frame；浏览器不可访问 JSON envelope，仓内不保留 runtime internal compatibility 层。预览、草稿、修订、管理端 taxonomy、资产、AI 辅助都属于作者私有能力。未发布正文不得进入 feed、search、sitemap、PublicAOT cache，也不得默认发送到外部 AI provider。

### 预览

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)。

私有预览走 `/api/binary/author/preview`，由服务端把草稿 Markdown 渲染成带 `data-preview-only=true`、`data-markdown-renderer=server-preview` 的 AOT-like HTML，前端只放进 sandboxed iframe，不进入公开路由或缓存。

### 草稿与本地缓存

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)、[`useAdminArticleWrite.ts`](../../src/frontend/src/composables/useAdminArticleWrite.ts)。

服务端草稿以 `ownerAdminPrincipalId + draftKey` 隔离并持久化正文、分类标签、发布状态、定时发布时间和 `clientRevision`；该 owner 来自 independent admin principal 的 `admin_id`，不复用普通匿名账号 `sys_user.id`。浏览器本地缓存是 `useAdminArticleWrite.ts` 管理的 localStorage AEDS payload（`fsus:article-draft:create` / `fsus:article-draft:edit:{id}`），只作为断网和刷新恢复兜底；Pinia 表单状态不是持久草稿真相源。编辑器发现服务端草稿比本地缓存更新时必须先提示恢复/丢弃，不能用本地缓存静默覆盖服务端草稿。

### 修订与回滚

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)、[`useAdminArticleWrite.ts`](../../src/frontend/src/composables/useAdminArticleWrite.ts)。

文章修订历史必须通过 admin-only API 读取摘要和单条正文详情：`GET /api/binary/author/articles/{articleId}/revisions` 与 `GET /api/binary/author/articles/{articleId}/revisions/{revisionId}`。响应只暴露 `createdByAdminPrincipalId`，不暴露旧 `createdByUserId`。回滚使用 `POST /api/binary/author/articles/{articleId}/revisions/{revisionId}/rollback`，服务层复用正式文章更新/失效链路写入新修订、刷新 AOT/search/feed/binary cache 并写审计；仓内不存在 issue 中提到的单数 article update 猜测路径，文档不得引用该旧猜测路径。编辑器只在作者工作台内比较当前表单与历史版本，回滚不得直接写表。

### 运维与危险操作

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AdminOperationsService.cs`](../../src/backend/Infrastructure/Operations/AdminOperationsService.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)。

单作者运维能力也归入 `/api/binary/author/**`，不得新增多作者协作或复杂 RBAC。`/api/binary/author/ops/**` 只返回运行时健康、备份 artifact 状态、结构化最近错误和危险操作策略；最近错误必须在审计行物化后做摘要、清理和分组，不得在 ORM projection 内拼接格式化字符串或向前端泄露 SQL 表达式片段。`/api/binary/author/cache/**` 暴露 AOT/PublicHotRead/search/sitemap/feed/comment cache 诊断、VisitLog 驱动 HotArticles/Stats 失效合并状态与手动重建入口；`/api/binary/author/integrity/**` 暴露数据一致性巡检、diff 预览和带 admin step-up 的 safe-fix 应用。所有写入型维护动作必须写高价值审计；不可逆或跨表修复必须先返回 diff，并通过统一危险操作策略要求强确认或 admin step-up proof。

### SEO 预览

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)。

SEO 预览是作者工作台内的发布前质量门，不是新路由模型：当前公开 canonical 仍由 `SeoConfigContract.baseUrl + /article/{id}` 生成，新文章落库前使用 draft-preview 占位。编辑器必须展示搜索结果和分享卡片预览，并在发布/定时发布前调用 `/api/binary/author/prepublish-check`；错误项阻断，摘要/封面/标题长度、图片 alt、超大 Markdown 或未知站内链接等 warning 只能在作者填写跳过理由后继续提交，理由由服务端写入审计。

### Taxonomy

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`useAdminCategoryManage.ts`](../../src/frontend/src/composables/useAdminCategoryManage.ts)、[`useAdminTagManage.ts`](../../src/frontend/src/composables/useAdminTagManage.ts)。

管理端分类/标签列表不得复用公开 `CategoryList` / `TagList` 的公开文章计数。作者工作台必须读取 `/api/binary/author/taxonomy/categories` 与 `/api/binary/author/taxonomy/tags`，用所有非删除状态或所有 `ArticleTag` 关联形成 `totalBlockingArticleCount` 与 `canDelete`，这样草稿、定时、归档和已删除关联不会被公开计数隐藏。标签删除采用严格锁定语义：只要仍有关联文章就拒绝删除，不静默移除文章上的标签关系。

### 资产库

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)、[`useImageUploadRuntime.ts`](../../src/frontend/src/composables/useImageUploadRuntime.ts)。

资产库是作者工作台内的复用索引，不是公开文件浏览 API。索引只记录 `/uploads/illustration/*` 的正文图片和文章封面、alt text、来源文章、hash 与引用计数；重建操作先把失去引用的行标成 `referenceCount=0`，作者确认后再通过孤儿清理删除资产库记录。孤儿清理不删除上传文件本体；物理删除必须通过独立的文件删除动作和二次确认完成。

分片上传会话的 `uploadId` 是服务端能力 token，不是客户端可构造路径。所有 `/api/binary/upload/{uploadId}` 后续动作只接受可规范化为 32 位 GUID `N` 格式的值；服务层在进入 session lock、manifest、parts 和 abort cleanup 前统一规范化，并用 `.upload-sessions` full path containment 作为最终文件系统边界。非法 `uploadId` 只能得到 validation/not found，不得触发目录遍历、递归删除或物理路径泄露。

### 评论治理

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)、[`RegionLegalModerationService.cs`](../../src/backend/Services/Moderation/RegionLegalModerationService.cs)。

评论治理是公开讨论区前置门禁：新评论默认进入 `Pending`，公开评论线程和回复游标只读取 `Approved`，并按 viewer IP 解析出的地区过滤 `blocked_regions`。提交时服务端按 request IP 解析 submit region；submit region 违法时直接拒绝，合法但部分 viewer region 不可展示时写入 `comment_region_compliance.blocked_regions`。`CN-MAINLAND` 严格策略只作用于 `CN-MAINLAND` 提交者或浏览者，不因 `CN-HK`、`CN-MO`、`CN-TW` 或 `GREATER_CHINA` 分组自动外溢；submit region 未知时进入待审且公开页不展示，viewer region 未知时对存在 blocked regions 的评论采用保守隐藏。作者工作台通过 `/api/binary/author/comments/moderation` 读取待审、已拒绝、已隐藏和已通过队列，展示敏感词、HTML 风险、密集链接、重复刷屏、人工原因和地区策略结果；匿名评论还展示 author mode、display language、moderation subject hash、scope、credential level 和 reputation/account-age bucket，不反查真实账号身份。审核队列、审核通过实时推送和回复站内通知复用同一个评论快照展示名投影：public 只看 `public_handle`，匿名/强匿名只看 `anonymous_display_name` 与匿名兜底；reply-to 名称来自 `reply_to_comment_id` 指向的父评论快照，不能通过 `user_id` / `reply_to_user_id` join `sys_user`。普通评论审核队列、单条审核和批量审核均要求 `comment.moderate`，单条或批量审核还写入审计并清理评论游标缓存。误判恢复只需要把评论重新置为 `Approved`，但 `can_publish=false` 的发布地违法评论不得被管理员放行；拒绝/隐藏时可选择联动封禁非 admin 用户。匿名治理动作使用独立 admin permission：策略开关走 `/api/binary/author/moderation/anonymous-comment-policy`，治理后台状态、nullifier 列表、nullifier 封禁和凭证撤销走 `/api/binary/admin/anonymous-governance/**`；审核队列保留快捷封禁/撤销入口。所有匿名治理写入和后台读取均要求 admin Passkey step-up，并写入脱敏高价值审计；匿名治理权限不替代 `comment.moderate`。

### 审核系统控制台

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`ModerationDictionaryService.cs`](../../src/backend/Services/Moderation/ModerationDictionaryService.cs)、[`RegionLegalModerationService.cs`](../../src/backend/Services/Moderation/RegionLegalModerationService.cs)。

审核系统控制台位于 `/user/manage/moderation`，后台一级导航只保留「审核系统」，评论审核是其子栏目。控制台端点使用 `/api/binary/author/moderation/**` 原生 AEDS endpoint；JSON envelope 不作为浏览器可达 runtime API 暴露。

### 审核端点契约表

| 端点 | 语义 |
|------|------|
| `overview` | 汇总队列、词库、地区策略和模型状态 |
| `dictionaries` | 只返回词库 metadata、checksum、term count 和聚合 `evidencePolicy`，不返回 raw terms |
| `policies` | 返回地区策略组合和 `CN-MAINLAND` 强制检查 |
| `regions` / `region-groups` | 返回地区 catalog 与大区成员 |
| `policy-templates` / `effective-policy/*` | 返回默认模板 presets 与 effective policy 继承预览 |
| `runtime/status` | 返回全局状态、地区 override、禁用词库集合和模型运行快照 |
| `replay/preview` | 只返回 diff 汇总，不执行变更 |
| `model/status` | 只展示模型配置和 latency/error 观测 |

### 地区 catalog 与策略继承

地区是具体匹配对象，大区只是策略复用工具，模板是工程预设而不是法律意见；默认模板必须带 `source/version/checksum/reviewed_by/reviewed_at_utc` 字段，内置模板必须标记 not legal advice，运营者必须按实际服务地区、部署地、业务类型和法律顾问意见复核。`GREATER_CHINA` 不是 `CN-MAINLAND`，`CN-HK/CN-MO/CN-TW` 不自动继承 `CN-MAINLAND` strict policy。

### 词库与策略 lifecycle

词库 reload/rollback、词库启停、地区状态、全局状态和模型 runtime/reload/rollback 都是高风险写操作，必须携带 `X-Fsus-Mfa-Proof` 并写高价值审计；会影响公开评论可见性的变更必须清理评论 cursor/frame 缓存。生产可用降级只允许 `disabled_to_pending`、`manual_review_only`、`no_public_display`、`read_only`、`emergency_lockdown` 等不会公开放行的状态，`disabled_pass_through` 在 production 下拒绝，除非显式本地开发配置打开。

### 运行时 reload / rollback

模型禁用不禁用词库，词库禁用不禁用地区策略，地区策略禁用必须回落到 `GLOBAL` baseline；`CN-MAINLAND` 严格策略变更和强制词库禁用需要 MFA、确认短语和高价值审计。`replay execute` 不得绕过 preview、MFA、确认短语和审计流程。

### 第三方模型 Provider 边界

第三方审核模型 Provider 只接入为风险信号层，契约由 FsusBlog 定义，不能返回最终发布、隐藏、地区屏蔽或地区合法性结论；Provider 开发入口见 [../moderation/third-party-model-development.md](../moderation/third-party-model-development.md)。

### 导入导出

代码证据：[`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs)、[`AuthoringWorkflowService.cs`](../../src/backend/Services/Authoring/AuthoringWorkflowService.cs)。

内容导入导出是作者工作台的恢复工具，不是匿名下载 API。单篇导出必须是 Markdown + frontmatter，frontmatter 同时保留可读字段和 `fsusMetadataJson` 机器元数据；全站内容包只是这些单篇导出的 JSON 聚合。导入默认按 metadata 恢复 draft/scheduled/published/archived 状态、分类、标签、封面和 revision 记录；只有作者显式传 `publish=true` 时才强制上线。

---

## Out of Scope

本文件只定义 API 设计哲学和跨模块约束，不重复维护以下真相源：

- `JsonApiResponse<T>` 豁免、AEDS-only gate 和原生 binary endpoint 约束：见 [`aeds-only-policy.md#允许豁免`](aeds-only-policy.md#允许豁免)、[`contracts.md#admin-作者工作台`](contracts.md#admin-作者工作台) 与 [`contracts.md#admin-安全系统`](contracts.md#admin-安全系统)。
- 错误码、AEDS frame 编号、POD 大小和 L0 负响应结构：见 [`schemas-and-errors.md`](schemas-and-errors.md)。
- 审计级别、高价值审计落库和 fallback 文件：见 [`../security.md#审计级别`](../security.md#审计级别)。
- 缓存分层、Public AOT 单一渲染链和请求路径：见 [`../architecture.md#public-aot-单一渲染链`](../architecture.md#public-aot-单一渲染链) 与 [`../architecture.md#缓存分层`](../architecture.md#缓存分层)。
- 路由速查表和端点列表：见 [`quick-reference.md#开放分发与作者工作台`](quick-reference.md#开放分发与作者工作台)。

Admin security dry-run 端点只能复用生产决策服务，不得直接复制阈值逻辑或绕过审计。`/api/binary/admin/security/risk-control/simulate` 是控制面预演入口：它可读取当前风险分或使用请求给定 riskScore，输出 `riskScore/decision/reasons/requiredChallenges/policyVersion`，但不得签发 `security_challenge`、不得修改 `SecurityRisk`、不得变更 active policy。该类 dry-run 仍要求 admin principal + `system.config`，并写入 admin security audit；若未来扩展为其他安全模拟器，也必须保持“真实决策链 + 无业务状态写入”的边界。

RiskControl 运行态写入只能使用 `/api/binary/admin/security/risk-control/options` 和 `/api/binary/admin/security/risk-control/options/rollback`。写入必须要求 admin principal、`system.config` 和一次性 `X-Fsus-Mfa-Proof`，并持久化 `security_policy_snapshot(policy_id=risk-control)`；active 损坏时启动加载只能回退 last-known-good，不得从请求路径临时拼装未审计策略。该写入只更新 RiskControl global mode、CaptchaV1 / PoSpaceV1 / PublicReadChallenge / CommentRiskControl / AuthRiskControl 开关和 strict multiplier，不改变 AntiCrawler mode 的语义。

---

## 参见

- [contracts.md#基础包装结构](contracts.md#基础包装结构) — 请求/响应 DTO、AOT 契约和 AEDS frame 边界
- [aeds-only-policy.md#允许豁免](aeds-only-policy.md#允许豁免) — 内部应用 API AEDS-only 治理、JSON 豁免与回归 gate
- [quick-reference.md#开放分发与作者工作台](quick-reference.md#开放分发与作者工作台) — 公开分发、Public AOT manifest 与作者工作台端点速查
- [schemas-and-errors.md#负响应](schemas-and-errors.md#负响应) / [#AedsFrameType 枚举](schemas-and-errors.md#aedsframetype-枚举) — 负响应、错误码、AEDS frame 编号与二进制结构
- [../security.md#proof-of-work-pow](../security.md#proof-of-work-pow) — PoW、JWT、MFA、审计和安全模型
- [../architecture.md#public-aot-单一渲染链](../architecture.md#public-aot-单一渲染链) — Public AOT 单一渲染链、缓存分层与 AEDS binary 架构

### 实现参考

- [`PublicAotDocumentComposer.cs`](../../src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs) — AOT 文档组装、5 个 sentinel 和 `data-fsus-aot-head` 注入
- [`PublicHotReadFastPath.cs`](../../src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs) — PublicHotRead fast path、pathKey hash、L0 诊断头和 artifact HTTP 语义
- [`PublicAotEndpoints.cs`](../../src/backend/Modules/Endpoints/PublicAotEndpoints.cs) — route manifest 与 `X-Fsus-Public-Aot-Token`
- [`DistributionEndpoints.cs`](../../src/backend/Modules/Endpoints/DistributionEndpoints.cs) — RSS / Atom / JSON Feed / sitemap / robots 缓存约束
- [`NotificationStreamHandshakeService.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamHandshakeService.cs) — notification stream protocol、匿名 RiskControl / legacy PoW、认证和 admission 校验
- [`NotificationStreamHandler.cs`](../../src/backend/Infrastructure/NotificationStream/NotificationStreamHandler.cs) — notification stream 握手失败头与 AEDS `ApiError` 写出
- [`AuthoringEndpoints.cs`](../../src/backend/Modules/Endpoints/AuthoringEndpoints.cs) — 作者工作台原生 AEDS endpoint 边界
- [`SecurityEndpoints.cs`](../../src/backend/Modules/Endpoints/SecurityEndpoints.cs) — 管理端 security 原生 AEDS endpoint 边界
- [`AedsJsonResults.cs`](../../src/backend/Infrastructure/Results/AedsJsonResults.cs) — typed JSON DTO bytes 与 AEDS frame 编码边界
- [`renderPublicPage.ts`](../../src/frontend/src/public-renderers/renderPublicPage.ts) — server SSR worker 加载的公开页 renderer 入口
- [`publicEntryRegistry.ts`](../../src/frontend/src/public-renderers/publicEntryRegistry.ts) — 公开页 SSR entry registry 与页面 assembly 调度

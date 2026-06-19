# API 契约文档

本文件是 FsusBlog 所有请求/响应 DTO、通知 WebSocket 信封与 AOT 契约的**完整参考**。
所有定义的权威源码位于 `src/shared/Contracts/` 目录。

> 最近更新：2026-06-18 — 同步 auth login / passkey / recovery-key verify 接入 RiskControl challenge 与风险信号边界。

---

## 目录

- [基础包装结构](#基础包装结构)
- [分页与游标信封](#分页与游标信封)
- [认证系统契约](#认证系统契约)
- [文章契约](#文章契约)
- [真人阅读 proof 契约](#真人阅读-proof-契约)
- [评论契约](#评论契约)
- [分类与标签契约](#分类与标签契约)
- [消息系统契约](#消息系统契约)
- [通知 WebSocket 契约](#通知-websocket-契约)
- [文件上传契约](#文件上传契约)
- [系统配置契约](#系统配置契约)
- [管理端统计契约](#管理端统计契约)
- [AOT 公开页契约](#aot-公开页契约)
- [PoW 契约](#pow-契约)
- [安全挑战契约](#安全挑战契约)

---

## 基础包装结构

运行时主 API 已收敛到 AEDS Binary：`/api/binary/**` 响应使用 AEDS v2 frame，错误也通过 `ApiError` frame 表达，不再通过旧文本响应包装。所有内部应用 API 按 [aeds-only-policy.md](aeds-only-policy.md) 治理；`JsonApiResponse<T>` 只允许出现在 public AOT tooling 和受保护的 author/security internal bridge implementation 中，不能作为浏览器运行时 API 暴露。

HTTP 层契约源是 `src/shared/Contracts/Validation/fsusblog.openapi.json`。该 OpenAPI snapshot 描述 method/path/status/content-type/security 与 `x-fsus-*` AEDS metadata；AEDS frame 名称、header magic/version/size 仍以 `src/shared/Contracts/Validation/aeds-protocol.json` 为权威来源。cross-stack matrix、前端 route constants、runtime contract smoke 与 release evidence 通过 `tools/contracts/*` 从这两个源校验或生成。

公开 binary 读模型使用预编码 artifact：匿名 `GET /api/binary/article/{id}.aeds`、`GET /api/binary/article/list/home/{page}/{size}.aeds`、`GET /api/binary/article/list/category/{categoryId}/{page}/{size}.aeds`、`GET /api/binary/article/list/tag/{tagId}/{page}/{size}.aeds`、`GET /api/binary/article/hot/{size}.aeds`、`GET /api/binary/category.aeds`、`GET /api/binary/tag.aeds` 只读取进程内 `PublicHotReadSnapshot` 的完整 AEDS v2 frame。artifact build 阶段同时生成 raw/br/gzip variant；命中时服务端按 `Accept-Encoding` 选择最优 variant，写出 variant-aware `ETag`、`Vary: Accept-Encoding`、可选 `Content-Encoding` 和 `X-Fsus-Frame-Encoding`。`If-None-Match` 匹配当前 variant 时返回 `304 Not Modified`，不发送 frame body。miss/not-ready 返回状态码，不会在请求线程同步查询 PostgreSQL、Redis、IMemoryCache、OutputCache 或文件系统。`GET /api/binary/article/{articleId}/related.aeds` 是动态 AEDS public-read endpoint，沿 `RelatedReadingService` 与 output cache 构建 ArticleRelatedReading frame，不属于 PublicHotRead L0 artifact。admin/private 读取走 `/api/binary/admin/article/**` 和非 `.aeds` taxonomy mutation path，以便草稿、定时、归档、删除状态和分类标签管理。

L0 `Accept` 语义固定为：空值、`*/*`、`application/octet-stream` 可读取 binary artifact；HTML artifact 只接受空值、`*/*`、`text/html`；其他类型返回 `406`。L0 不承担跨域公开接口，`OPTIONS` 返回 `405`，CORS 仍由常规管线治理。快照状态通过 `/api/ops/health/ready-detail` 的 `runtime.publicHotRead` 暴露 `NotStarted` / `Building` / `Ready` / `Failed`、版本、artifact 计数、最后构建原因和错误；未 Ready 时 fast path 返回 `503` + `Retry-After: 1`。L0 负响应固定 `Cache-Control: no-store`；`Range` 不支持并返回 `416` + `Accept-Ranges: none`；命中的 `.aeds` artifact 只使用 artifact-level HTTP 预压缩，浏览器 fetch 解压后仍得到原始 AEDS frame，payload 语义与 CRC 不变。

HTML L0 只暴露 `/api/binary/article/html/{pathKey}.html` 诊断/预览路径，真实公开 URL 仍是 `/`、`/article/{id}`、`/category/{id}`、`/tag/{id}` 等 public route。`pathKey` 必须 URL-safe：`article:42` -> `article-42`，`category:7` -> `category-7`，`tag:9` -> `tag-9`；`tag-name:*` 与包含空白、斜杠、非 ASCII 的 routeKey 使用稳定 hash。`PublicHotRead:EnableDiagnosticHeaders` 默认关闭；打开后成功响应才带 `X-Fsus-HotRead-Version`、`X-Fsus-HotRead-Artifact`、`X-Fsus-HotRead-Key`。

所有 HTTP 响应都会带 `X-Fsus-Trace-Id`，值与当前 OpenTelemetry `Activity.TraceId`、`HttpContext.TraceIdentifier`、Serilog/audit `TraceId` 对齐。客户端可用该值报告问题；它不是认证凭据，也不得包含用户身份或请求正文。

### AEDS 通用响应 POD

源码：`src/shared/Contracts/Models/CommonPods.cs`

| FrameType | POD | 说明 |
|-----------|-----|------|
| `EmptySuccess` (`240`) | `EmptySuccessPod` | 无数据成功响应，`Ok = 1` |
| `MutationId` (`241`) | `MutationIdPod` | 写操作返回的 `int64 Id` |
| `ApiError` (`251`) | `ApiErrorPod` | Binary 错误响应，包含 `Code`、`Category`、`HttpStatus`、`Message`、`Details`、`TraceId` |

### AEDS v2 payload layout

AEDS v2 frame header 固定 16 字节，字段顺序为 `Magic:uint32`、`Version:uint8`、`HeaderLength:uint8`、`Flags:uint16`、`FrameType:uint16`、`PayloadLength:uint32`、`PayloadCrc16:uint16`。服务端、TypeScript adapter、Worker 与 Wasm decoder 只接受 v2；v1 frame 不再兼容。当前运行时不采用 `NoPayloadCrc` 或协议内 `PayloadCompressed` flag；request frame 的非零 flags 会被拒绝，response 默认写 `0`，后续 flags 必须先进入 contract matrix negative/downgrade case。

高频读取 frame 改为 compact POD：

| FrameType | Payload layout |
|-----------|----------------|
| `ArticleList` | `total:int32` + `count:int32` + `tagRecordCount:int32` + shared UTF-8 blob + 76B article records + 12B tag records |
| `ArticleSearch` | `total:int32` + `count:int32` + `tagRecordCount:int32` + shared UTF-8 blob + 52B search records + 12B tag records |
| `ArticleHot` | `count:int32` + shared UTF-8 blob + 16B article records |
| `CategoryList` / `TagList` | `count:int32` + shared UTF-8 blob + 16B taxonomy records |
| `AdminStats` | `SiteStatsPod` + shared UTF-8 blob + 16B popular records + 32B recent-comment records + 12B region records |
| `SiteComplianceConfig` | `SiteComplianceConfigPod`，固定宽度 UTF-8 字段；空配置不写占位备案号 |

compact record 内所有文本字段均为 `Utf8SliceRef`，指向当前 payload 的共享 blob。`ArticleList` 的 76B record 在原 56B 公开字段后追加 `status:int32`、`scheduledPublishAtUnixMs:int64`、`publishedAtUnixMs:int64`；`status` 值固定为 `Draft=0`、`Scheduled=1`、`Published=2`、`Archived=3`、`Deleted=4`，公开可见性以 [design.md#文章状态枚举](design.md#文章状态枚举) 为准。写请求、Passkey、上传、`ArticleDetail` 和复杂评论游标仍使用 v2 header 包裹的 POD + blob 结构，但不再允许旧 v1 header。

payload 字典化的第一阶段采用兼容 layout：ArticleList/ArticleSearch/Conversation 等重复文本均落到单个 shared UTF-8 blob，records 只保存 `Utf8SliceRef`；前端 ArticlePage decode 不再创建 object records 数组，也不使用 `tagRecords.slice(...)` 复制 tag range。后续若引入 `ArticleListV4` category/tag dictionary，必须保持现有 frame type 的 downgrade 路径和 golden fixture。

### Read-proof AEDS frames

`/api/binary/read-proof/**` 使用 request/response AEDS frame；错误语义统一为 `ApiError`。旧 `/api/read-proof/**` JSON endpoint 已移除，前端运行时不得调用或回退。

| FrameType | 值 | POD | 用途 |
|-----------|----|-----|------|
| `HumanReadChallengeResponse` | 28 | `HumanReadChallengeResponsePod` + UTF-8 blob | challenge 响应 |
| `HumanReadSubmitResponse` | 29 | `HumanReadSubmitResponsePod` + UTF-8 blob | submit 响应 |
| `HumanReadChallengeRequest` | 73 | `HumanReadChallengeRequestPod` + UTF-8 blob | challenge 请求体 |
| `HumanReadSubmitRequest` | 74 | `HumanReadSubmitRequestPod` + UTF-8 blob | submit 请求体 |

### RUM telemetry AEDS frames

生产前端只向 `/api/binary/telemetry/rum` 发送 RUM，使用 `credentials: omit`、`Content-Type: application/octet-stream` 和 `Accept: application/octet-stream`。旧 `/api/telemetry/rum` JSON endpoint 已移除，不允许生产前端回退。

| Frame | Value | Payload | 用途 |
|-------|-------|---------|------|
| `RumMetricBatchRequest` | 75 | `RumMetricBatchRequestPod` + `RumMetricItemPod[]` + `RumMetricValuePod[]` + `RumMetricDimensionPod[]` + UTF-8 blob | 批量 RUM 请求体 |
| `RumMetricIngestResponse` | 76 | `RumMetricIngestResponsePod` | accepted / acceptedCount / rejectedCount |

请求限制：单帧最大 8192 bytes，单批最多 16 条 metric，metric name 最多 64 bytes，单条最多 4 个数值字段和 4 个低基数字符串 dimension。服务端只接受 `web_vital_lcp`、`web_vital_cls`、`navigation_timing`、`hydration_time`、`wasm_decode_timing`、`markdown_render_timing`，数值字段只允许 `value/domInteractive/responseStart/durationMs`，dimension key/value 只能进入白名单低基数集合；不接受任意 JSON blob。

### 安全挑战契约

RiskControl challenge assignment 使用统一 AEDS 契约，不在 PoW、Captcha、PoSpace、HumanReadProof、Passkey step-up 或匿名 proof provider 中各自定义不同字段。`SecurityChallengeAssignment` 必须包含 `challengeId`、`traceparent`、`tenantId`、`kind`、`escalationLevel`、`action`、`routeKey`、`subjectHash`、`clientIpHash`、`deviceFpHash`、`issuedAtUnixMs` 和 `expiresAtUnixMs`；`expiresAtUnixMs` 必须大于 `issuedAtUnixMs`。`challengeId` 默认使用 UUID v7；`captchaV1` 读取端兼容 UUID v4/v7。`subjectHash`、`clientIpHash`、`deviceFpHash` 均为 64 字符 SHA-256 hex，不携带原文。

支持的 `SecurityChallengeKind` wire name 为：`sha256PowV1`、`argon2idPoSpaceV1`、`captchaV1`、`humanReadProofV1`、`passkeyStepUpV1`、`adminPasskeyStepUpV1`、`recoveryKeyProofV1`、`anonymousCredentialProofV1`、`zkAnonymousCommentProofV1`。

challenge 签发与验证审计由 `security_challenge` 和 `security_challenge_attempt` 持久化，Redis 只作为一次性消费 / 热路径缓存。持久化 metadata 对应 assignment 字段和策略上下文：kind、algorithm、action、routeKey、subjectHash、clientIpHash、deviceFpHash、policyVersion、payloadHash、traceId、traceparent、issued/expires 时间，以及 attempt outcome。payload / proof 原文不得进入持久化表；状态只允许 `issued | verified | expired | replayed | failed | revoked`。

成功完成 challenge provider 校验后，统一 proof token 使用 `X-Fsus-Challenge-Proof` header 传递。该 token 是 opaque 值；Redis `SecurityChallengeProof` cache 保存一次性 claims，并绑定 `challengeId`、`kind`、`action`、`routeKey`、`subjectHash`、`clientIpHash`、`deviceFpHash`、`issuedAt`、`expiresAt`、`nonce` 和 `policyVersion`。服务端消费时必须先执行 consume-once，再校验绑定字段；replay / Redis miss、action 或 route mismatch、IP/device mismatch、过期 proof 都不得进入业务写入，并必须写 challenge attempt。该 header 不替代 `X-Fsus-Mfa-Proof`、legacy `X-Fsus-Pow-Proof` 或 HumanReadProof 阅读计数 proof。

challenge provider 统一通过 `ISecurityChallengeProvider` 接入，wire kind 与上表 `SecurityChallengeKind` 一致。`SecurityChallengeOrchestrator` 根据 `RiskDecision.RequiredChallenges` 调用 provider，可返回单个或多个 `SecurityChallengeAssignment`，并可携带按 `challengeId` 分组的 provider payload 供 binary response 编码；provider missing、provider failure、assignment 无效或 proof mint failure 必须返回可观测错误并 fail closed，不得落入具体业务 endpoint 的 fallback 分支。

`sha256PowV1` provider 的 issue payload 只包含 legacy PoW challenge 必需字段：`salt`、`difficulty`、`timestamp`、`signature`。verify payload 必须包含 `proof`，其值为旧 `X-Fsus-Pow-Proof` 使用的 Base64 FPOW binary proof；服务端复用同一解析器、`IPowService.VerifyAsync` 和 `AdaptivePowGovernor` difficulty 裁决。该 provider 不引入公开 JSON fallback，不改变现有 FPOW wire format，也不删除 `GET /api/binary/auth/pow-challenge` 或 `X-Fsus-Pow-Proof` legacy 路径。

`captchaV1` provider 使用 `fsu.captcha/chebyshev-noise@v1` wire algorithm。issue payload 包含 `algorithm`、`polynomialSeedHex`、`noiseSeedHex`、`seedPayloadBase64`、`signatureHex`、`gridWidth`、`gridHeight`、`distortionLevel`、`powDifficultyBits`、`issuedAtUnixMs` 和 `expiresAtUnixMs`；服务端不生成 PNG、像素或图片字段，只下发可由客户端渲染的 seed 与参数。`seedPayloadBase64` 绑定 challengeId、action、routeKey、subject/client/device hash、policyVersion、seed、参数和时间窗口，`signatureHex` 为服务端 HMAC-SHA256 签名。verify payload 必须回传 issue payload 字段，并追加 `answerText`、`responseTokenHex`、`nonceHex`、`solveDurationMs`。服务端先验证签名和绑定字段，再通过 `SecurityCaptchaChallenge` cache 一次性消费 challenge，随后派生期望答案、校验 nonce 前导零证明、校验 response token 和 solve duration。错误答案、签名/seed 篡改、token/nonce 错误写 `CaptchaInvalid` 风险 detail；重放写 `CaptchaReplay`；过快 / 过慢分别写 `CaptchaSolveTooFast` / `CaptchaSolveTooSlow`。默认 V2 policy 中，`auth.login` 在中风险阈值触发 `captchaV1`，高风险阈值触发 `captchaV1 + sha256PowV1`；`recovery-key.verify` 从 0 风险分起要求 `captchaV1` proof，并在高风险时升级到组合 challenge。

`argon2idPoSpaceV1` provider 使用 `fsu.pospace/argon2id@v1` wire algorithm，默认 `Security:PoSpaceV1:Mode=disabled`，只有策略显式 enable 且 RiskDecision 选择该 kind 时才可签发。issue payload 包含 `algorithm`、`saltHex`、`memoryKib`、`iterations`、`lanes` 和 `targetDurationMs`；服务端约束 `memoryKib=1024..65536`、移动端最大 `8192`、`iterations=1..6`、`lanes=1..4`、`targetDurationMs=100..5000`。verify payload 必须回传 issue payload 字段，并追加 `nonceHex` 和 `proofHex`。服务端通过 `SecurityPoSpaceChallenge` cache 一次性消费 challenge，使用 challengeId/action/routeKey/subject/client/device/policyVersion/nonce 作为 Argon2id material 重新派生 proof；参数越界、payload 错误、proof mismatch 或 replay 均 fail closed 并写 `SecurityChallengeRejected` 风险事件。移动 UA 或 disabled policy 会由 RiskDecision 降级到 `captchaV1`，不得签发 PoSpace。

`humanReadProofV1` provider 使用 `fsu.human-read-proof@v1` wire algorithm，且只允许 `action=public.read`。issue payload 包含 `algorithm`、`token`、`scope`、`routeKey`、`articleId`、`minDwellMs`、`issuedAtUnixMs` 和 `expiresAtUnixMs`；持久化层只保存 payload hash，不保存 token 原文。verify payload 必须提交 `token`、`scope`、`routeKey`、`articleId` 和 `dwellMs`，服务端复用 HumanReadProof submit 绑定校验；成功只签发绑定 public-read action / route / IP / device 的统一 proof token，并额外写 `ReadProofAccepted` 负分风险信号以降低后续 public-read 风险。`comment.*`、`auth.*`、`admin.*` 或任何非 public-read action 使用该 kind 都必须 fail closed；`RequiresRiskControlFilter` 也必须在 required kind 不匹配时返回 428，不得消费 HumanReadProof proof 或进入写操作 handler。

统一 challenge 签发与验证只通过 binary endpoint 暴露，不提供公开 JSON fallback。`POST /api/binary/security/challenge` 接收 `SecurityChallengeIssueRequest` (`173`) 并返回 `SecurityChallengeIssueResponse` (`175`)；`POST /api/binary/security/challenge/verify` 接收 `SecurityChallengeVerifyRequest` (`174`) 并返回 `SecurityChallengeVerifyResponse` (`176`)。两个端点均为匿名、`fixed_ip` 限流、`no-store` 响应，request `Content-Type` 必须是 `application/octet-stream`，response `Accept` 只接受空值、`*/*` 或 `application/octet-stream`；不匹配时返回 AEDS `ApiError`，`Accept` 不匹配使用 HTTP 406。请求 frame 上限为 64 KiB，所有业务失败、unsupported kind、provider missing、provider failure、proof replay / mismatch 均 fail closed 返回 `ApiError` frame。

`SecurityChallengeIssueRequest` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `action` | string | RiskControl action，例如 `public.read`、`comment.create`；必填 |
| `routeKey` | string | 业务 route key，例如 `article:42`；必填 |
| `deviceFp` | string | 可选设备指纹；服务端只使用规范化状态和 SHA-256 hash |
| `attributes` | string | 可选 JSON 字符串，当前仅作为 wire 契约预留，不进入持久化 payload 原文 |

`SecurityChallengeIssueResponse` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `decision` | enum | `allow`、`challenge`、`stepUp`、`queueForModeration`、`throttle`、`block` 或 `unknown` |
| `riskScore` / `effectiveRiskScore` | int | 原始风险分与策略模式调整后的风险分 |
| `escalationLevel` | int | 策略要求的升级等级 |
| `policyVersion` | string | 产生该裁决的 RiskControl policy version |
| `retryAfterMs` | int | 限流 / 排队建议等待时间；当前 endpoint 返回 0 |
| `envelope` | `SecurityChallengeEnvelope?` | `challenge` / `stepUp` 时返回 assignment 集合；非 challenge 裁决为空 |
| `providerPayloads` | array | 按 `challengeId` 返回 provider payload JSON；`sha256PowV1` 包含 `salt`、`difficulty`、`timestamp`、`signature` |

`SecurityChallengeVerifyRequest` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `challengeId` | string | issue response 中的 assignment id；必填 |
| `kind` | enum | `SecurityChallengeKind`；未知或未支持 kind fail closed |
| `action` | string | 必须与 issue / 后续业务 endpoint 绑定的 action 一致 |
| `routeKey` | string | 必须与 issue / 后续业务 endpoint 绑定的 route key 一致 |
| `payload` | string | provider payload JSON；`sha256PowV1` 必须包含 Base64 FPOW `proof`，`captchaV1` 必须包含 issue payload 字段加 `answerText`、`responseTokenHex`、`nonceHex`、`solveDurationMs` |

`SecurityChallengeVerifyResponse` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `verified` | bool | provider 校验是否通过；成功响应固定为 `true` |
| `challengeId` | string | 被验证的 challenge id |
| `kind` | enum | 被验证的 provider kind |
| `policyVersion` | string | proof 绑定的 policy version |
| `proofToken` | string | 一次性 opaque proof，后续业务请求放入 `X-Fsus-Challenge-Proof` |
| `reason` | string | 成功为 `ok`；失败走 `ApiError` frame |
| `retryAfterMs` | int | 当前成功响应为 0 |

受 `RequiresRiskControlFilter` 保护的 endpoint 必须具备 `RiskActionEndpointMetadata`，服务端用 action、routeKey、subjectHash、clientIpHash、deviceFpHash 和 policyVersion 消费统一 proof。客户端提交已签发 proof 时必须同时发送 `X-Fsus-Challenge-Proof`、`X-Fsus-Challenge-Id`、`X-Fsus-Challenge-Kind`；缺 proof、proof 重放 / Redis miss、action 或 route mismatch、IP/device mismatch 均返回 428，block / throttle 类裁决返回 429。`queue` 裁决只允许业务端显式读取 `RiskControlDecisionContext` 后继续执行；评论创建会把 queue 映射为待审队列并记录 `risk_control_queue`，其他未接入 queue 语义的写入口不得默默放行。当前高价值入口使用的 action 为：`POST /api/binary/comment` root create -> `comment.create`，同一路径 reply payload -> `comment.reply`，`POST /api/binary/auth/login` -> `auth.login`，`POST /api/binary/auth/passkey/login/begin` -> `auth.passkey.begin`，`POST /api/binary/auth/passkey/login/complete` -> `auth.passkey.complete`，`POST /api/binary/auth/recovery-key/verify` -> `recovery-key.verify`，匿名 `GET /api/notifications/stream/preflight` / WebSocket handshake -> `notification.subscribe`。旧 `RequiresPowFilter` endpoint 仍使用 `X-Fsus-Pow-Proof`；同时保留 PoW 的 auth/comment endpoint 需要同时提交 legacy PoW proof 与 RiskControl proof，notification stream 继续兼容 legacy `pow` query proof。

| FrameType | 值 | POD | 用途 |
|-----------|----|-----|------|
| `SecurityChallengeAssignment` | 171 | `SecurityChallengeAssignmentPod` | 单个 challenge assignment |
| `SecurityChallengeEnvelope` | 172 | `SecurityChallengeEnvelopePod` + `SecurityChallengeAssignmentPod[]` | 一次裁决返回的 challenge assignment 集合，最多 8 个 |
| `SecurityChallengeIssueRequest` | 173 | `SecurityChallengeIssueRequestPod` + UTF-8 blob | RiskControl challenge 签发请求 |
| `SecurityChallengeVerifyRequest` | 174 | `SecurityChallengeVerifyRequestPod` + UTF-8 blob | RiskControl challenge provider proof 验证请求 |
| `SecurityChallengeIssueResponse` | 175 | `SecurityChallengeIssueResponsePod` + assignment / provider payload records + UTF-8 blob | RiskControl challenge 签发响应 |
| `SecurityChallengeVerifyResponse` | 176 | `SecurityChallengeVerifyResponsePod` + UTF-8 blob | 一次性 proof token 响应 |

### Passkey AEDS frames

Passkey/WebAuthn 载荷不再以文本字符串传输。服务端返回 AEDS POD，前端 adapter 将 POD 还原为浏览器 WebAuthn API 需要的选项对象；浏览器返回的 attestation/assertion 由前端编码为二进制 request POD。

匿名身份模式下，`PasskeyRegisterBegin` 的 WebAuthn `user.id` 使用稳定的内部 account id 字节；`user.name` 使用 `fsus-account-{id}` 形式的非识别内部标签，`user.displayName` 仅在用户显式设置 `public_handle` 时使用公开 handle，否则同样使用内部标签。注册与 discoverable login 仍复用同一套 `passkey_credential` 表、challenge cache、sign-count 和 last-used 更新路径，不新增平行 Passkey 栈。匿名模式下删除最后一枚 Passkey 需要已启用 Recovery Key / recovery path；否则服务端返回 `409` + AEDS `ApiError`，错误消息为 `CannotRemoveLastCredentialWithoutRecovery`。Passkey login begin/complete 受 RiskControl 保护；assertion 失败写 `PasskeyAssertionFailed` 正分风险信号，assertion 成功写 `PasskeyAssertionAccepted` 负分风险信号并以 `mfaVerified=true` 完成登录，不再额外要求普通 TOTP MFA。

| FrameType | POD | 端点 / 用途 |
|-----------|-----|-------------|
| `PasskeyRegisterBegin` (`63`) | `PasskeyRegisterBeginPod` | `POST /api/binary/auth/passkey/register/begin`；admin bootstrap begin 复用该响应 frame |
| `PasskeyLoginBegin` (`64`) | `PasskeyLoginBeginPod` | `POST /api/binary/auth/passkey/login/begin`；admin login begin 复用该响应 frame |
| `PasskeyCredentialList` (`65`) | `PasskeyCredentialSummaryPod[]` | `GET /api/binary/auth/passkey/credentials` |
| `PasskeyRegisterCompleteRequest` (`66`) | `PasskeyRegisterCompleteRequestPod` | 注册完成请求体；admin bootstrap complete 复用该请求 frame |
| `PasskeyLoginCompleteRequest` (`67`) | `PasskeyLoginCompleteRequestPod` | 登录完成请求体；admin login complete 复用该请求 frame |
| `PasskeyRenameRequest` (`68`) | `StringMutationRequestPod` | 设备名更新请求体 |

### Independent admin principal AEDS endpoints

后台控制面身份独立于 `sys_user`，只使用 admin principal / session / passkey 表。首次 root admin bootstrap 必须带 `X-Fsus-Admin-Bootstrap-Token`，该 token 只从 `FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN` 或 `Admin:BootstrapToken` 读取；存在 active root admin 后 bootstrap 端点固定拒绝。`X-Fsus-Admin-Handle` 只在 bootstrap begin 指定后台 handle，不写入匿名账号。所有后台控制面端点必须校验 `identity_kind=admin_principal` 与具体 `admin_permission` claim，不得接受 legacy `sys_user.role=admin`。

| 方法 | 路径 | 请求 / 响应 frame | 权限 |
|------|------|-------------------|------|
| POST | `/api/binary/auth/admin/bootstrap/passkey/begin` | 响应 `PasskeyRegisterBegin` | 匿名 + bootstrap token |
| POST | `/api/binary/auth/admin/bootstrap/passkey/complete` | 请求 `PasskeyRegisterCompleteRequest`，响应 `EmptySuccess` | 匿名 + bootstrap token |
| POST | `/api/binary/auth/admin/login/passkey/begin` | 响应 `PasskeyLoginBegin` | 匿名 |
| POST | `/api/binary/auth/admin/login/passkey/complete` | 请求 `PasskeyLoginCompleteRequest`，响应 `EmptySuccess` | 匿名 |
| POST | `/api/binary/auth/admin/step-up/passkey/begin` | 响应 `PasskeyLoginBegin` | admin principal + `admin.manage` |
| POST | `/api/binary/auth/admin/step-up/passkey/complete` | 请求 `PasskeyLoginCompleteRequest`，响应 `MfaChallengeResult` | admin principal + `admin.manage` |
| GET | `/api/binary/auth/admin/me` | 响应 `EmptySuccess` | admin principal + `admin.manage` |
| POST | `/api/binary/auth/admin/logout` | 响应 `EmptySuccess` | admin principal + `admin.manage` |
| GET | `/api/binary/auth/admin/sessions` | 响应 `AdminSessionList` | admin principal + `admin.manage` |
| POST | `/api/binary/auth/admin/sessions/{sessionId}/revoke` | 响应 `EmptySuccess` | admin principal + `admin.manage` |
| POST | `/api/binary/auth/admin/sessions/revoke-others` | 响应 `EmptySuccess` | admin principal + `admin.manage` |

admin 登录只接受 Passkey/Security Key assertion。成功会写入独立 `AdminAccessToken` / `AdminSessionId` Cookie；JWT 必须包含 `identity_kind=admin_principal`、`admin_id`、`admin_sid` 与多值 `admin_permission` claim。请求期认证必须按 `admin_sid` 回查 `admin_session` 并校验 principal active、session 未撤销、idle/absolute 未过期、`AccessTokenHash` 与当前 token 匹配、session principal id 与 `admin_id` 一致；失败返回未认证/未授权并删除 admin session cookies，成功更新 `LastSeenAtUtc`。admin-sensitive step-up 只接受 `/api/binary/auth/admin/step-up/passkey/begin|complete` 的管理员 Passkey 再认证，不读取普通 `sys_user` MFA 状态，也不接受普通用户 MFA proof。

admin step-up challenge 绑定 `identity_kind=admin_principal`、`admin_id`、当前 `admin_sid`、action=`admin-sensitive`、challenge token 和过期时间。complete 成功后返回 `MfaChallengeResult(verified=true, action=admin-sensitive, proofToken=...)`；proof 存储使用 `CachePolicyId.SecurityMfaProof`，key 形如 `admin:{adminId}:{adminSid}:admin-sensitive:{token}`，只能消费一次，不能跨 admin principal 或 session 使用。敏感写入继续通过 `X-Fsus-Mfa-Proof` 传递该 proof header；缺失、过期、复用或 session 不匹配返回 `428` + `MFA_PROOF_REQUIRED`。

`POST /api/binary/auth/admin/logout` 会把当前 `admin_session.RevokedAtUtc` 置为当前 UTC 时间、`RevokeReason=logout`，并只清理 `AdminAccessToken` / `AdminSessionId` 及 `__Host-*` admin Cookie，不触碰普通用户 Cookie。`POST /api/binary/auth/admin/sessions/revoke-others` 必须保留当前 `admin_sid` 对应 session。

### Recovery Key AEDS frames

Recovery Key 是匿名账号的账户恢复凭据，独立于 TOTP MFA recovery code。服务端只存储 `account_recovery_key.key_hash`、`key_version`、`created_at`、`used_at`、`revoked_at`，哈希使用服务端 `RecoveryKeyPepper` 加固；明文 Recovery Key 只在 create/rotate 响应中返回一次，不写数据库、日志、telemetry 或 browser storage。

验证成功会把当前 Recovery Key 标记为 used，返回 10 分钟 recovery session token。该 token 只允许调用 recovery passkey begin/complete 端点绑定新 Passkey；如果 verify 请求设置 `revokeSessions`，服务端会撤销该账号现有会话；如果设置 `revokePasskeys`，新 Passkey 绑定完成后删除旧凭据。TOTP MFA recovery code 仍只用于 MFA bypass，不得作为账户恢复。

| FrameType | POD | 端点 / 用途 |
|-----------|-----|-------------|
| `RecoveryKeyCreateResponse` (`159`) | `RecoveryKeyCreateResponsePod` | `POST /api/binary/auth/recovery-key/create` 和 `/rotate` 响应 |
| `RecoveryKeyVerifyRequest` (`160`) | `RecoveryKeyVerifyRequestPod` | `POST /api/binary/auth/recovery-key/verify` 请求体；匿名、`fixed_ip` 限流、RiskControl challenge、PoW、no-store |
| `RecoveryKeyVerifyResponse` (`161`) | `RecoveryKeyVerifyResponsePod` | verify 成功后返回短期 recovery session token |
| `RecoveryKeySessionRequest` (`162`) | `StringMutationRequestPod` | `POST /api/binary/auth/recovery-key/passkey/register/begin` 请求体；complete 复用 `PasskeyRegisterCompleteRequest.MfaProofToken` 传 recovery session token |

### Anonymous identity and comment policy AEDS frames

匿名身份不新增平行 Passkey 协议：注册、登录、credential list、rename、admin bootstrap 和 recovery bind 仍复用上面的 Passkey frame；账户恢复仍复用 `RecoveryKeyCreateResponse` / `RecoveryKeyVerifyRequest` / `RecoveryKeyVerifyResponse` / `RecoveryKeySessionRequest`。已发布运行时 frame 覆盖账户快照、评论策略、CommentCreateV2 和作者展示投影。177-183 是匿名凭证/root/ticket/匿名评论创建的 contract-only frame：本阶段只定义跨栈 POD/codec、AEDS 编号、前端 adapter 和 golden fixture，不注册业务 endpoint，也不把未实现路径写入 OpenAPI paths。

| FrameType | POD | 用途 |
|-----------|-----|------|
| `IdentityAccountSnapshot` (`163`) | `IdentityAccountSnapshotPod` + UTF-8 blob | account/internal id、nullable public handle、Passkey/Recovery/TOTP step-up 状态、anonymous credential status/level |
| `CommentPolicySnapshot` (`164`) | `CommentPolicySnapshotPod` + UTF-8 blob | `GET /api/binary/comment/policy` 响应；评论 composer 渲染前读取 anonymous/public/ZK 开关、默认 author mode、支持语言 `zh-CN` / `en` |
| `CommentPolicyUpdateRequest` (`165`) | `CommentPolicyUpdateRequestPod` + UTF-8 blob | admin 匿名评论策略 patch；bool 字段用 `Has*` flag 表示未设置 |
| `CommentCreateV2Request` (`166`) | `CommentCreateV2RequestPod` + UTF-8/blob payload | 新评论创建请求，包含 article/reply 上下文、author mode、public opt-in、anonymous scope、语言提示、proof token、ZK proof placeholder 和 content |
| `CommentAuthorView` (`167`) | `CommentAuthorViewPod` + UTF-8 blob | 评论读取侧作者投影：mode、display name、display language、badge/status/scope label、credential level |
| `AnonymousCredentialIssueRequest` (`177`) | `AnonymousCredentialIssueRequestPod` + shared blob | 匿名凭证签发请求契约：epoch、circuit id、credential level、blinded request、client nonce |
| `AnonymousCredentialIssueResponse` (`178`) | `AnonymousCredentialIssueResponsePod` + shared blob | 匿名凭证签发响应契约：issuer response、credential commitment、root expiry；不返回可逆用户身份 |
| `AnonymousCredentialRootSnapshot` (`179`) | `AnonymousCredentialRootSnapshotPod` + shared blob | 匿名凭证 root/verifying-key snapshot：epoch、root expiry、circuit id、verifying key hash、credential/revocation root |
| `AnonymousCommentTicketRequest` (`180`) | `AnonymousCommentTicketRequestPod` + shared blob | 匿名评论 ticket 申请请求：article/reply 上下文、credential epoch、scope、nullifier hash、ZK proof/public inputs |
| `AnonymousCommentTicketResponse` (`181`) | `AnonymousCommentTicketResponsePod` + shared blob | 匿名评论 ticket 响应：opaque ticket、moderation subject hash、anonymous nullifier hash；不得包含 user id、username 或 public handle |
| `AnonymousCommentCreateRequest` (`182`) | `AnonymousCommentCreateRequestPod` + shared blob | 匿名评论创建请求：article/reply 上下文、credential epoch、scope、language、ticket、content；不携带用户身份或 Authorization token |
| `AnonymousPrivacyStateSnapshot` (`183`) | `AnonymousPrivacyStateSnapshotPod` + shared blob | 前端隐私状态快照：active credential、issue/submit capability、root/ticket expiry、circuit/verifying-key/status/level |

`CommentPolicySnapshot` 通过 `GET /api/binary/comment/policy` 公开读取，匿名访问、`public_read` 限流，用于让公开文章评论 composer 在渲染前应用当前服务端策略。`DefaultAuthorMode` byte 映射为 `1=anonymous`、`2=pseudonymous`、`3=public`、`4=zk_anonymous`；`0` 只作为读端兼容值并解释为 `anonymous`。`SupportedDisplayLanguages` 使用换行分隔文本，当前只允许 `zh-CN` 与 `en`。前端 binary adapter 必须能在评论 composer 渲染前解码该 frame，不得从组件内硬编码策略。

`CommentCreateV2Request` 是旧 `CommentCreateRequest` 的并行新 frame，不改变旧 `CommentCreateRequestPod` 布局。`AuthorMode` 使用同一 byte 映射；`PublicSendExplicitlySelected` 只在 public mode opt-in 时为 `1`；`AnonymousScope` 用于 nullifier/scope 绑定；`DisplayLanguage` 是展示语言提示；`ProofToken` 预留普通 proof token；`ZkProof` 是二进制 proof placeholder，默认 verifier 未启用时服务端仍 fail closed。ZK strong-anonymous 模式必须保留为 `zk_anonymous`，不能降级成普通 `anonymous`。`POST /api/binary/comment` 同时接受旧 frame 和 V2 frame：旧 frame 不携带作者选择时，服务端按当前策略解析为默认 anonymous；需要 public opt-in、scope、language hint 或 ZK proof 的客户端必须使用 V2。

匿名凭证与匿名评论 ticket frame 使用固定宽度 POD + shared blob，不走 JSON hot path。所有二进制字段都通过 `Utf8SliceRef` 指向 blob slice，包括 blinded request、issuer response、credential root、revocation root、ZK proof、public inputs 和 opaque ticket。公共元数据固定字段包括 `credentialEpoch:int64`、`rootExpiresAtUnixMs:int64`、`ticketExpiresAtUnixMs:int64`（仅 ticket/state）、`circuitNumericId:uint32`、`circuitId:Utf8SliceRef`、`verifyingKeyHash:Utf8SliceRef` 和 `publicInputLayoutVersion:uint16`。decoder 必须拒绝 malformed slice、尾随字节和超过 16 KiB 的匿名隐私 payload。

`AnonymousCommentCreateRequest` 不包含 `userId`、`replyToUserId`、`username`、`Authorization` token 或 `publicHandle` 字段；服务端后续实现只能通过 ticket/nullifier 和策略上下文解析匿名 actor。所有强匿名 ticket / submit endpoint 必须挂 `RequireStrongAnonymousRequest()`，拒绝 `Cookie`、`Authorization`、session/bearer bridge header 和已认证 principal；拒绝时返回 AEDS `ApiError`，`Details=anonymous_identity_contaminated`。`AnonymousCommentTicketResponse` 同样不得返回可逆用户身份，只能返回 opaque ticket、moderation subject hash、anonymous nullifier hash 和 credential level。旧 `CommentCreateV2RequestPod` 布局保持不变；需要完整匿名凭证/ticket 流程的客户端必须使用 177-183 对应新 frame，不得把新字段塞回 `CommentCreateV2Request`。

评论写入不再把 `comment.user_id` 作为作者展示的必填外键。`CommentActor` 会写入 `author_mode`、`public_handle`、`anonymous_handle`、`anonymous_display_name`、`anonymous_display_language`、`anonymous_nullifier_hash`、`anonymous_scope`、`moderation_subject_hash`、`credential_level`、`reputation_bucket` 和 `account_age_bucket`。公开评论读取优先使用 `anonymous_display_name` / `public_handle`，再回退 legacy `sys_user.username`；匿名 display name 由服务端按 `zh-CN` / `en` 的内置常见姓名列表生成，并在 scope 内稳定，不暴露 account id、username、public handle、credential id 或 nullifier 原文。

---

## 分页与游标信封

源码：`src/shared/Contracts/Envelopes/PodEnvelopes.cs`

### `PageResponse<T>`（基于页码）

```json
{
  "items": [ /* T[] */ ],
  "total": 100,
  "page": 1,
  "pageSize": 20
}
```

### `CursorResponse<T>`（基于游标）

```json
{
  "items": [ /* T[] */ ],
  "nextCursor": "base64-encoded-cursor",
  "hasMore": true
}
```

游标值为 `long` 类型经编码后的字符串，通常为最后一条记录的 ID 或时间戳。

### Binary POD 信封

用于 AEDS 帧内的分页元数据：

| 结构 | 字段 | 类型 | 说明 |
|------|------|------|------|
| `PodEnvelopeHeader` | Version | byte | 信封版本 |
| | Count | int | 记录数 |
| | PayloadLength | int | 载荷字节长度 |
| | Reserved | int | 保留（填 0）|
| `PageEnvelope` | Total | int | 总记录数 |
| | Count | int | 当前页记录数 |
| `CursorEnvelope` | NextCursor | long | 下一页游标值（-1 表示无更多） |
| | HasMore | bool | 是否有更多 |

---

## 认证系统契约

源码：`src/shared/Contracts/AuthSystem/AuthSystemContracts.cs`
源码：`src/shared/Contracts/Outputs/ServerResponseContracts.cs`

### `TokenResponseDto`（内部令牌载荷）

```json
{
  "accessToken": "eyJhbG...",
  "refreshToken": "随机刷新令牌"
}
```

- 该结构主要用于服务端内部登录/续签流程，不直接作为公开认证 API 的最终响应体
- 对外认证接口成功后统一返回 `AuthLoginFlowDto`，认证 Cookie 通过 `Set-Cookie` 下发

### `AuthLoginFlowDto`（注册 / 登录成功响应）

```json
{
  "user": {
    "id": 1,
    "username": "alice",
    "role": "guest"
  },
  "authPhase": "authenticated",
  "mfaMode": null,
  "challengeToken": null
}
```

- `authPhase`：`"authenticated"` 或 `"mfa_required"`
- `mfaMode`：`"risk"` / `"standard"` / `null`
- `challengeToken`：仅在 `authPhase = "mfa_required"` 时存在
- `POST /api/binary/auth/register` 成功时同样返回该结构，并在同一响应内写入登录 Cookie，实现“注册后自动登录”
- 密码、MFA challenge 或 Passkey 断言完成后仍必须经过服务端最终会话签发校验；封禁账号在认证通过后返回 `AuthLoginFlowDto` 并写入受限会话 Cookie，用于读取账号状态、登出、撤销会话、删除本人账号等安全收尾操作。注销账号（`Deleted` / `DeletedAt`）仍不得返回该结构，也不得写入 access / refresh / session Cookie。
- 封禁状态以 `sys_user.Status/BanReason` 为权威来源；`SecurityBlacklistUser` Redis 缓存只做加速且不设置 L2 过期。登录、写入过滤器和 notification stream 遇到缓存 miss 时必须回查数据库，不能因 Redis 丢失而恢复封禁用户权限。受限会话的普通业务写入由服务端返回 `423 Locked`，Binary `ApiError.Details = "ACCOUNT_BANNED_WRITE_LOCKED"`；客户端不得只靠前端状态拦截来实现安全边界。

### `CurrentUserSnapshotDto`（当前用户信息，`GET /api/binary/auth/me`）

```json
{
  "id": 1,
  "username": "alice",
  "role": "authenticated",
  "avatarUrl": "/uploads/avatars/1.jpg",
  "email": "alice@example.com",
  "isMfaEnabled": true,
  "createdAt": "2026-01-01T00:00:00Z"
}
```

- `role`：`"anonymous"` / `"authenticated"` / `"admin"`

### `UserSessionItemDto`（会话列表项）

```json
{
  "sessionId": "uuid-v4",
  "device": "Chrome on Windows",
  "ip": "1.2.3.4",
  "region": "CN-BJ",
  "createdAt": "2026-01-01T00:00:00Z",
  "lastActiveAt": "2026-01-01T01:00:00Z",
  "isCurrent": true
}
```

### `AdminSessionSummaryDto`（管理员会话列表项）

```json
{
  "sessionId": "admin-session-id",
  "deviceFingerprint": "sha256-or-client-fp",
  "lastIp": "127.0.0.1",
  "userAgent": "Mozilla/5.0 ...",
  "createdAtUtc": "2026-01-01T00:00:00Z",
  "lastSeenAtUtc": "2026-01-01T01:00:00Z",
  "idleExpiresAtUtc": "2026-01-01T09:00:00Z",
  "absoluteExpiresAtUtc": "2026-01-01T12:00:00Z",
  "isCurrent": true,
  "isRevoked": false
}
```

### `MfaSetupStartDto`（MFA 设置响应）

```json
{
  "totpSecret": "BASE32ENCODEDKEY",
  "qrCodeDataUri": "data:image/png;base64,...",
  "recoveryCodes": ["XXXX-XXXX", "XXXX-XXXX"]
}
```

`recoveryCodes` 仅在初始设置时返回，此后只能通过重新生成获取。

### `MfaProfileDto`（MFA 状态）

```json
{
  "isEnabled": true,
  "recoveryCodesRemaining": 6
}
```

---

## 文章契约

源码：`src/shared/Contracts/Outputs/ServerResponseContracts.cs`

### `ArticleListItemResponse`

```json
{
  "id": 1,
  "title": "文章标题",
  "summary": "摘要文本，最多 300 字",
  "coverUrl": "/uploads/covers/1.jpg",
  "categoryId": 2,
  "categoryName": "技术",
  "tags": [{ "id": 1, "name": "C#" }],
  "viewCount": 1000,
  "commentCount": 20,
  "status": 2,
  "scheduledPublishAt": null,
  "publishedAt": "2026-01-01T00:00:00Z",
  "slug": "article-slug"
}
```

### `ArticleDetailResponse`

包含 `ArticleListItemResponse` 所有字段，额外增加：

```json
{
  "content": "Markdown 或 HTML 正文",
  "tocJson": "[{\"level\":2,\"text\":\"标题\",\"anchor\":\"#标题\"}]",
  "prevArticle": { "id": 0, "title": "..." },
  "nextArticle": { "id": 2, "title": "..." }
}
```

### Binary Article POD

源码：`src/shared/Contracts/Models/ArticlePods.cs`

Article POD 为定长结构体，字段按 C++ 内存对齐排列：
- `Id`：int64
- `Title`：Utf8Fixed256（256 字节固定宽度 UTF-8）
- `Summary`：Utf8SliceRef（指向载荷末尾的 blob 区）
- `CategoryName`：Utf8Fixed128
- `Tags`：以 Utf8SliceRef 数组形式编码
- `ViewCount`、`CommentCount`：int32
- `PublishedAt`：Unix 毫秒时间戳（int64）

---

## 真人阅读 proof 契约

浏览计数不由文章详情 GET 触发。前端 hydration 后通过 AEDS proof 端点产生真人阅读事件。

### `POST /api/binary/read-proof/challenge.aeds`

请求 frame：`HumanReadChallengeRequest` (`73`)

| 字段 | 类型 | 说明 |
|------|------|------|
| `scope` | string | `site` 或 `article` |
| `routeKey` | string | 公开页 route key，例如 `home`、`article:42` |
| `articleId` | int? | `scope=article` 时必填 |

请求头必须包含浏览器上下文：`X-Fsus-Device-Fp`、`Sec-Fetch-Site`、`Sec-Fetch-Mode`、`Sec-Fetch-Dest`，并由可信 `Origin` 或 `Referer` 发起。

该端点受 `read_proof` 专用限流保护。被拒绝的 challenge 不产生有效 token，拒绝原因会进入 crawler risk 分，但公开内容访问不会因此被阻断。

响应 frame：`HumanReadChallengeResponse` (`28`)

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | string | HMAC-bound proof token；拒绝时为空字符串 |
| `scope` | string | 规范化后的 `site` 或 `article` |
| `routeKey` | string | 规范化后的公开页 route key |
| `articleId` | int? | 文章阅读对应 article id |
| `minDwellMs` | int | 最小可见停留时间，默认 8000 |
| `issuedAt` | unix ms | 签发时间 |
| `expiresAt` | unix ms | 过期时间 |

### `POST /api/binary/read-proof/submit.aeds`

请求 frame：`HumanReadSubmitRequest` (`74`)

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | string | challenge 返回的 proof token |
| `scope` | string | `site` 或 `article` |
| `routeKey` | string | 与 challenge 绑定的 route key |
| `articleId` | int? | 与 challenge 绑定的 article id |
| `dwellMs` | int | 客户端累计可见停留毫秒数 |

Submit 同样受 `read_proof` 专用限流保护。`counted=true` 会写入 `ReadProofAccepted` 负分风险信号，仅用于降低后续 `public.read` 风险或避免重复 challenge；`proof_replayed`、`proof_binding_mismatch`、`fetch_metadata_invalid`、`origin_invalid`、`fingerprint_missing` 等拒绝状态会写入 crawler risk；`duplicate_viewer` 只表示 24 小时去重，不计入风险。一次性 proof 消费必须先失效进程内 L1 cache，再执行 Redis consume-once transaction；请求取消后不得继续执行 registry 清理或留下可从 L1 再读取的 proof。

响应 frame：`HumanReadSubmitResponse` (`29`)

| 字段 | 类型 | 说明 |
|------|------|------|
| `counted` | bool | 是否写入真人阅读事件 |
| `status` | string | `counted`、`paused`、`duplicate_viewer`、`proof_replayed`、`proof_binding_mismatch`、`fetch_metadata_invalid`、`origin_invalid`、`fingerprint_missing` 等状态 |

旧 JSON 端点 `GET /api/read-proof/challenge` 与 `POST /api/read-proof/submit` 已移除；生产前端不得调用，也不得作为 AEDS 解码失败 fallback。

`counted=false` 表示 proof 被拒绝或重复提交；内容读取不受影响。HumanReadProof submit / `humanReadProofV1` challenge proof 都不能授权 comment/auth/admin 写操作。

---

## 评论契约

源码：`src/shared/Contracts/Outputs/ServerResponseContracts.cs`

### `CommentItemDto`（顶层评论）

```json
{
  "id": 1,
  "articleId": 10,
  "authorId": 5,
  "authorName": "alice",
  "authorAvatarUrl": "/uploads/avatars/5.jpg",
  "content": "评论内容",
  "replyCount": 3,
  "createdAt": "2026-01-01T00:00:00Z",
  "isDeleted": false
}
```

### `CommentReplyItemDto`（回复）

与 `CommentItemDto` 相同，额外增加：

```json
{
  "parentId": 1,
  "rootId": 1,
  "replyToAuthorName": "bob"
}
```

### `CommentThreadItemDto`（线程聚合）

```json
{
  "root": { /* CommentItemDto */ },
  "replies": { /* CursorResponse<CommentReplyItemDto> */ }
}
```

公开评论读取会按 viewer IP 解析出的地区过滤 `comment_region_compliance.blocked_regions`，并把 viewer region 纳入 `CommentCursorFrame` cache identity。`CN-MAINLAND` 严格策略只对 `CN-MAINLAND` viewer 隐藏，不会自动套用到 `CN-HK`、`CN-MO`、`CN-TW`；viewer region 解析为 `UNKNOWN` 时，任意非空 `blocked_regions` 都会被保守隐藏。评论提交同样按 request IP 解析 submit region：submit region 为 `CN-MAINLAND` 且命中大陆严格类别时直接返回 validation error；其他地区可发布但会记录对应 blocked regions；submit region 为 `UNKNOWN` 时评论进入 `Pending`，同时标记 `hide_until_reviewed=true`。

地区合规结果存储在 `comment_region_compliance`：`comment_id`、`submit_region`、`submit_region_confidence`、`region_provider`、`submit_ip_hash`、`policy_version`、`can_publish`、`requires_manual_review`、`hide_until_reviewed`、`blocked_regions`、`risk_labels`、`decision_reason`、`rule_hits_json`、`created_at_utc`、`updated_at_utc`。IP 只保存 HMAC hash。策略 replay 通过服务层生成 `RegionPolicyReplayDiff`，用于比较 blocked regions、risk labels、publishability 和公开可见性变化。

---

## 分类与标签契约

### `CategoryItemResponse`

```json
{
  "id": 1,
  "name": "技术",
  "slug": "tech",
  "articleCount": 42,
  "description": "技术类文章"
}
```

### `TagItemResponse`

```json
{
  "id": 1,
  "name": "C#",
  "slug": "csharp",
  "articleCount": 15
}
```

公开 `CategoryList` / `TagList` 的 `articleCount` 只统计公开可见文章，不能作为后台删除判断。管理端 taxonomy 读取必须使用 `/api/binary/author/taxonomy/categories` 与 `/api/binary/author/taxonomy/tags`，返回真实阻断引用：

```ts
interface AdminCategoryItemResponse {
  id: number
  name: string
  publicArticleCount: number
  draftArticleCount: number
  scheduledArticleCount: number
  archivedArticleCount: number
  totalBlockingArticleCount: number
  canDelete: boolean
}

interface AdminTagItemResponse extends AdminCategoryItemResponse {
  deletedArticleCount: number
}
```

分类删除的 `totalBlockingArticleCount` 与后端规则一致：统计所有 `!IsDeleted && Status != Deleted` 的文章。标签删除采用更严格的锁定语义：只要仍存在 `ArticleTag` 关联，`canDelete=false`，后端拒绝删除，不会静默移除草稿、定时、归档或已删除文章上的标签关系。

---

## 消息系统契约

源码：`src/shared/Contracts/Outputs/ServerResponseContracts.cs`

### `ConversationListItemResponse`

```json
{
  "id": "uuid",
  "participantName": "alice",
  "participantAvatarUrl": "/uploads/avatars/1.jpg",
  "lastMessage": "最新一条消息预览",
  "lastMessageAt": "2026-01-01T00:00:00Z",
  "unreadCount": 2,
  "status": "open"
}
```

- `status`：`"open"` / `"closed"`

管理员系统消息使用 `POST /api/binary/admin/messages/system-send` 的 `SystemMessageRequest` frame。当前契约只支持单用户目标，`targetUserId` 必须存在且大于 0；`targetUserId=null` 不表示广播，后端会返回 validation error。前端管理入口位于 `/user/manage/messages`，普通 `/user/messagebox` 只承载个人消息和工单。

### `ConversationMessageResponse`

```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "senderId": 5,
  "senderName": "alice",
  "senderRole": "authenticated",
  "content": "消息内容",
  "sentAt": "2026-01-01T00:00:00Z",
  "isRevoked": false
}
```

---

## 通知 WebSocket 契约

源码：`src/shared/Contracts/NotificationStream/NotificationStreamContracts.cs`

### 通道

- 路径：`GET /api/notifications/stream`
- 预检路径：`GET /api/notifications/stream/preflight`
- 协议：WebSocket，子协议固定为 `fsus-aeds.v2`
- 消息类型：binary
- 每条消息：完整 AEDS v2 frame
- 传输语义：notification stream 不是标准 Server-Sent Events，不使用 `EventSource` 或 `text/event-stream`
- Origin 语义：preflight 与正式 WebSocket 握手共用 allowlist 校验；允许 `Seo:BaseUrl`、`Fido2:Origins`、`CORS_ALLOWED_HOSTS` 与开发 localhost，生产跨站、非 HTTPS/WSS 或浏览器缺失 Origin 返回 AEDS `ApiError`，错误码 `origin_not_allowed`
- 匿名连接：优先走 `notification.subscribe` RiskControl 准入；preflight 使用 `X-Fsus-Challenge-*` header，浏览器 WebSocket 使用 `challengeProof` / `challengeId` / `challengeKind` query 参数传递一次性 proof。旧 `pow` query 参数继续兼容，用于传递二进制 FPOW 证明的 base64 文本形式
- 断线续传：使用 `cursor` query 参数传递最后确认的事件 ID

### 握手预检

客户端在打开 WebSocket 前可以先调用：

```http
GET /api/notifications/stream/preflight?pow=<base64-fpow>&cursor=<last-event-id>
X-Fsus-Notification-Stream-Protocol: fsus-aeds.v2
```

成功时返回 `204 No Content`，不返回 body。失败时返回 AEDS `ApiError` frame，并带上可观测头：

```http
X-Fsus-Notification-Stream-Error-Code: account_blocked
X-Fsus-Notification-Stream-Status-Code: 423
```

失败 body 使用 `AedsFrameType.ApiError` payload，前端通过 `X-Fsus-Notification-Stream-Error-Code` 映射业务失败码：

```json
{
  "ok": false,
  "statusCode": 423,
  "errorCode": "account_blocked",
  "message": "account_blocked",
  "data": null
}
```

预检不要求 WebSocket upgrade；正式通道仍必须使用 `Sec-WebSocket-Protocol: fsus-aeds.v2`。WebSocket 主通道握手失败时继续返回 AEDS `ApiError` frame，同时写入相同的 `X-Fsus-Notification-Stream-*` 头。`account_blocked` 来源于持久化用户状态，Redis 黑名单缓存 miss 会先回查数据库并回填后再决定是否拒绝连接。

### `NotificationEvent`

对应 `AedsFrameType.NotificationEvent = 69`。

载荷布局：

```text
int64 eventId
int64 timestampUnixMs
int32 notificationStreamEventType
int32 reserved
binary-value payload
```

`binary-value payload` 使用 AEDS 通知值编码：`0=null`、`1=string`、`2=int32`、`3=int64`、`4=double`、`5=bool`、`6=object`、`7=array`。对象字段名按 camelCase 写入。

### `NotificationHeartbeat`

对应 `AedsFrameType.NotificationHeartbeat = 70`。

载荷布局：

```text
int64 timestampUnixMs
```

### Development/Test drill publish

`POST /_fsus/testing/notification-stream/publish` 只在 Development/Test 环境映射，并要求 `X-Fsus-Notification-Drill-Secret` 匹配 `FSUSBLOG_NOTIFICATION_DRILL_SECRET` / `NotificationStream:DrillSecret`。请求体为 JSON tooling payload：

```json
{
  "drillId": "notification-slow-consumer-...",
  "count": 384,
  "payloadBytes": 1024,
  "routeKey": "content-feed"
}
```

服务端通过真实 `INotificationStreamPublisher` 写入 backlog 并触发本机 fanout，响应包含 `status`、`drillId`、`routeKey`、`eventType`、`count` 与 `eventIds`。该入口只供 resilience evidence 使用，生产环境不映射，未配置 secret 时返回 `404`。

### `NotificationStreamEventType` 枚举

| 值 | 名称 | 载荷类型 | 说明 |
|----|------|---------|------|
| 1 | `NoticeReceived` | `GlobalNoticePayload` | 用户收到通知 |
| 2 | `GlobalNoticePublished` | `GlobalNoticePayload` | 全站广播（公开） |
| 3 | `UnreadCountUpdated` | `UnreadCountPayload` | 未读数变更 |
| 4 | `UserStatusChanged` | `UserStatusPayload` | 用户状态变化（封禁等） |
| 5 | `CommentAdded` | `CommentAddedNotifyDto` | 新评论通知 |
| 6 | `CommentRemoved` | `CommentRemovedPayload` | 评论删除通知 |
| 7 | `MessageReceived` | `MessageReceivedPayload` | 收到新消息 |
| 8 | `ArticleChanged` | `ArticleChangedPayload` | 文章更新（缓存失效） |
| 9 | `MessageRevoked` | `MessageRevokedPayload` | 消息撤回 |
| 10 | `CacheControl` | `CacheControlPayload` | 缓存控制指令 |
| 11 | `SearchIndexUpdated` | `SearchIndexUpdatePayload` | 搜索索引更新 |
| 12 | `InboxConversationUpsert` | `InboxConversationUpsertPayload` | 对话新增/更新 |
| 13 | `InboxMessageAppend` | `InboxMessageAppendPayload` | 对话消息追加 |
| 14 | `InboxReadUpdated` | `InboxReadUpdatedPayload` | 对话已读状态更新 |
| 15 | `InboxConversationClosed` | `InboxConversationClosedPayload` | 对话关闭 |

### `CacheControlPayload`

```json
{
  "type": "invalidate",
  "scope": "article",
  "cache": "L1",
  "keys": ["article:list:1:20", "article:detail:42"]
}
```

### `SearchIndexUpdatePayload`

```text
AEDS NotificationEvent payload:
version=/search index build version
manifestUrl=/search/index.manifest.aeds
generatedAt=UTC ticks encoded by the SearchIndexUpdated POD
```

---

## 文件上传契约

源码：`src/shared/Contracts/Outputs/ServerResponseContracts.cs`

所有上传端点在 `/api/binary/upload/` 路径下，需要 admin principal + `article.write` 权限。`uploadId` 由服务端生成并返回，wire 格式固定为 32 位 GUID `N` 格式；status、part map、part upload、complete 和 abort 路由只接受该形态并规范化为小写 canonical 值，非法值返回 validation error，不会被当作文件系统路径继续解析。

### `UploadInitDto`（初始化响应）

```json
{
  "uploadId": "32-char-guid-n",
  "partSize": 5242880,
  "totalParts": 3,
  "expiresAt": "2026-01-01T01:00:00Z"
}
```

### `UploadPartAckDto`（分片确认）

```json
{
  "partNumber": 1,
  "checksum": "md5hex",
  "received": true
}
```

### `UploadCompleteDto`（完成响应）

```json
{
  "fileUrl": "/uploads/content/image.jpg",
  "fileSize": 15728640,
  "mimeType": "image/jpeg",
  "uploadedAt": "2026-01-01T00:30:00Z"
}
```

---

## 系统配置契约

源码：`src/shared/Contracts/AuthSystem/AuthSystemContracts.cs`

### `SeoConfigContract`

`SeoConfig` 同时用于公开 SEO/head/PWA manifest、admin 统一 SEO 设置页和运行时品牌资产。公开端点为 `GET /api/binary/system/seo`，admin 读取为 `GET /api/binary/system/admin/seo`，保存为 `PUT /api/binary/system/seo` + `SeoConfigUpdateRequest`，写入必须携带 PoW。保存后必须失效 system SEO cache、Public AOT shell、动态 `manifest.webmanifest` 和公开 shell hydration。

```json
{
  "title": "Fsu's Blog",
  "description": "站点描述",
  "keywords": "博客,技术,写作",
  "author": "Fsu",
  "ogImage": "/og-image.jpg",
  "baseUrl": "https://fsus.blog",
  "faviconSvgUrl": "/favicon.svg",
  "faviconIcoUrl": "/favicon.ico",
  "faviconPngUrl": "/icons/favicon-96.png",
  "appleTouchIconUrl": "/apple-touch-icon.png",
  "manifestName": "Fsus Blog",
  "manifestShortName": "Fsus",
  "pwaIcon192Url": "/icons/icon-192.png",
  "pwaIcon512Url": "/icons/icon-512.png",
  "pwaMaskableIconUrl": "/icons/maskable-512.png",
  "themeColor": "#0f0f11",
  "backgroundColor": "#fcfcfc",
  "siteLogoUrl": "/brand/site-logo.svg",
  "siteLogoDarkUrl": "/brand/site-logo-dark.svg",
  "siteWordmarkUrl": "/brand/site-wordmark.svg",
  "adminLogoUrl": "/brand/admin-logo.svg",
  "adminCollapsedIconUrl": "/brand/admin-icon.svg",
  "loginLogoUrl": "/brand/login-logo.svg",
  "loginIconUrl": "/brand/login-icon.svg"
}
```

URL 字段只接受空值、站内绝对路径 `/...` 或 `http/https` 绝对 URL；`javascript:`、`data:`、协议相对 URL 和空字节会被后端归一化为默认值或空值。`themeColor` 与 `backgroundColor` 只接受 `#RGB` / `#RRGGBB`。后台不得新增 `/system/brand` 并行主配置端点，品牌资产必须挂在同一个 SEO 配置模型上。

### `SiteComplianceConfigContract`

`SiteComplianceConfig` 同时用于公开 footer 与 admin 表单。公开端点为 `GET /api/binary/system/compliance`，admin 读取为 `GET /api/binary/system/admin/compliance`，保存为 `PUT /api/binary/system/compliance` + `SiteComplianceConfigUpdateRequest`，写入必须携带 PoW。

```json
{
  "enabled": true,
  "regionMode": "mainland-cn",
  "copyrightOwner": "Fsu",
  "copyrightStartYear": 2024,
  "copyrightText": "保留所有权利。",
  "contentLicenseName": "CC BY-NC-SA 4.0",
  "contentLicenseUrl": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
  "icpRecordNumber": "京ICP备00000000号-1",
  "icpRecordUrl": "https://beian.miit.gov.cn/",
  "policeRecordNumber": "京公网安备00000000000000号",
  "policeRecordUrl": "https://beian.mps.gov.cn/",
  "policeBadgeIconUrl": "/assets/police-badge.png",
  "operatorName": "站点运营者",
  "contactEmail": "contact@example.com"
}
```

当 `enabled=false` 或备案字段为空时，公开 footer 不输出备案占位文案，只保留真实存在的版权、许可和静态页链接。保存成功后服务端会失效 `SystemCompliance` L1/L2/OutputCache、SEO/distribution cache 与相关 Public AOT 静态页，并通过 notification stream `CacheControl` 通知 shell 失效。

### `PageContentContract`

```json
{
  "slug": "about",
  "title": "关于",
  "content": "Markdown 内容",
  "updatedAt": "2026-01-01T00:00:00Z"
}
```

静态页面当前是固定页集合，读写范围必须一致：`about`、`privacy`、`guidelines`、`copyright`。匿名读取 `/api/binary/system/page/{slug}`、admin 读取 `/api/binary/system/admin/page/{slug}`、admin 写入 `/api/binary/system/page` 与缓存刷新 `/api/binary/system/page/refresh/{slug}` 都必须拒绝 allowlist 之外的 slug。页面保存后服务端会刷新相关缓存和对应 Public AOT 静态页；刷新端点是管理端强制刷新入口，前端设置页可手动调用。

---

## 管理端统计契约

### `AdminStatsQueryDto`（`GET /api/binary/stats`，Binary 响应）

对应 `AedsFrameType.AdminStats`，POD 结构包含：

```
SiteStatsPod、共享 UTF-8 blob、popular article records、recent comment records、region records
```

服务端对外 query model 是 `AdminStatsQueryDto`：`Overview` 对应统计摘要与热门文章，`RecentComments` 对应最近评论，`Regions` 对应地区分布。前端 dashboard 从单个 `AdminStats` frame 派生三个视图区块；`/api/binary/stats/recent-comments` 与 `/api/binary/stats/regions` 仅保留为兼容窄读入口。

---

## AOT 公开页契约

源码：`src/shared/Contracts/Outputs/PublicPageContracts.cs`

### `PublicPageId` 枚举

| 值 | 页面 | 路由键格式 |
|----|------|-----------|
| 1 | `Home` | `"home"` |
| 2 | `ArticleDetail` | `"article:{id}"` |
| 3 | `Filter` | `"category:{id}"`、`"tag:{id}"`、`"tag-name:{name}"` |
| 4 | `Archive` | `"archive"` |
| 5 | `About` | `"about"` |
| 6 | `Account` | `"account"`，非 SEO |
| 7 | `Privacy` | `"privacy"` |
| 8 | `Guidelines` | `"guidelines"` |
| 9 | `Copyright` | `"copyright"` |

### Public AOT 单一产物要求

每个公开页 AOT 条目都必须来自同一条渲染链：

```text
bootstrap model
  → hydration payload
  → Vue SSR renderer
  → document composer
  → html / inline bootstrap AEDS / hydration .aeds sidecar
```

HTML bootstrap 仍以 `script type="application/octet-stream"` 嵌入；hydration props 默认写为 raw AEDS `.aeds` sidecar，并在 HTML 中用 `#fsus-aot-hydration-props[data-aeds-src]` 轻量 marker 引用。客户端保留旧内联文本读取作为迁移 fallback，但新 AOT HTML 不再内联完整 hydration base64url frame。`islandsPayload` 已退役。

Hydration sidecar HTTP 合同与运行时 `/api/binary/**` 分开：`/aot-cache/payloads/{bucket}/{sha256}.aeds` 返回 `Content-Type: application/vnd.fsus.aeds`，`Cache-Control: public,max-age=31536000,immutable`，并移除 `ETag` / `Last-Modified` validators。URL 使用 payload frame 的 SHA-256 content hash，因此内容或站点设置变化会生成新 URL；旧 sidecar 可异步清理，不允许通过稳定 URL 复用导致 HTML 与 payload 独立陈旧。

AOT document cache entry 必须记录 hydration sidecar 的 URL、SHA-256 和相对路径；旧 artifact 缺少 metadata 时，读取路径必须能从 HTML marker 解析出等价引用。读取 document cache 时，如果 referenced sidecar 不存在或磁盘 bytes 的 SHA-256 与 content-hash URL 不一致，服务端必须把该 HTML entry 当作 cache miss 并触发重建，不能返回会在首访 hydration 时失败的 shell。按 key/prefix/all 失效时删除 HTML document cache entry；content-hash sidecar 可以按不可变策略保留并由后台清理，因为没有仍然可返回的 HTML 会指向已失效 document。

约束：

- `html`、`bootstrapPayload`、`hydrationPropsPayload` 不能分别由不同模板层独立拼装。
- AOT 产物只允许由服务端 `server-ssr` backfill 写入；客户端、管理端和脚本不得上传 AOT bundle。
- `Filter` / `ArticleDetail` 不允许持久化错误态壳层，例如 markdown fallback/error 文案。
- 服务端 backfill 使用 `PublicAot:SsrWorkerMode=Pooled` 的 Node/Vue SSR worker 池生成条目；
  如缓存未命中或 worker 不可用，公开页请求返回 SPA index fallback，并通过
  `X-Fsus-Public-Aot-Backfill` 标记 `queued` 或 `dropped`。
- 过期但 renderer/frontend asset version 兼容的条目可作为 stale HTML 返回，同时排队刷新；
  响应头用 `X-Fsus-Public-Aot-State: fresh|stale|fallback` 与
  `X-Fsus-Public-Aot-Stale: 1` 区分 fresh 命中、SWR stale 命中和 SPA fallback。
- AOT HTML 缓存同时校验 `rendererVersion` 与 frontend asset version；前端 `index.html` 或
  `.vite/manifest.json` 变化会自动拒绝旧缓存，并按 frontend asset version 隔离文件 artifact。
- AOT HTML 模板只接受以下 5 个具名 sentinel；sentinel 是字符串相等匹配，不接受通配式标记：
  - `<!--fsus:aot:head-start-->`：SEO/head 注入起点。
  - `<!--fsus:aot:head-end-->`：SEO/head 注入终点。
  - `<!--fsus:aot:app-->`：SPA/AOT shell 挂载点。
  - `<!--fsus:aot:payloads-->`：bootstrap AEDS 注入点与 hydration `.aeds` sidecar marker 注入点。
  - `<!--fsus:aot:spa-boot-->`：deferred SPA boot 注入点。
- 由 Public AOT 管理的 SEO head 节点必须带 `data-fsus-aot-head`。新增 sentinel 必须同步 `src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs`、`docs/api/design.md` 和 `tests/frontend/checks/public/check-public-aot-contracts.mjs`。

### Public AOT Route Manifest

`GET /internal/public-aot/manifest` 返回后端权威公开 SEO route 清单，供预热脚本和内容变更驱动 backfill 使用。该端点只列出公开可访问 route；文章 route 必须满足 `Published`、未删除、已到 `PublishedAt` / `ScheduledPublishAt` 时间。若配置 `PublicAot:ManifestToken`，调用方必须携带 `X-Fsus-Public-Aot-Token`，否则返回 `403`。

`GET /internal/public-aot/health` 返回 Public AOT SSR worker 诊断快照，同样受 `X-Fsus-Public-Aot-Token` 保护并返回 `Cache-Control: no-store`。响应包含 resource check（client root、worker script、prebuilt bundle 与 bundle path）、Node executable probe、`validateBundle` sample worker probe、backfill queue depth/capacity、scheduled/dropped/completed/failed counters、timeout/restart/stderr warning counters、last failure、circuit breaker 状态和 route quarantine 列表。breaker 打开或 route 被 quarantine 时只阻断新的 backfill 调度；公开读必须继续通过 fresh/stale AOT 命中或 SPA fallback 服务，不能因为 SSR worker degraded 阻断匿名阅读。

查询参数：

| 参数 | 说明 |
|------|------|
| `scope=all` | 默认，列出 Home / About / Privacy / Guidelines / Copyright / Archive / 全部公开文章 / 有公开文章的分类与标签 |
| `scope=hot` | 列出固定页与最近公开文章相关 route，用于轻量预热 |
| `changedSince=<ISO-8601>` | 列出指定时间后变更/发布的公开文章及其关联分类、标签 route |

响应包装为 `JsonApiResponse<PublicAotRouteManifestResponse>`：

```json
{
  "success": true,
  "data": {
    "scope": "all",
    "generatedAtUtc": "2026-06-01T00:00:00Z",
    "routes": [
      {
        "pageId": 2,
        "kind": "ArticleDetail",
        "routeKey": "article:42",
        "path": "/article/42",
        "canonicalPath": "/article/42",
        "dependencyKeys": ["seo", "article:list", "article:42", "category:7", "tag:3"],
        "priority": 100
      }
    ]
  },
  "message": null
}
```

`dependencyKeys` 是预生成和失效收敛的稳定键：`article:{id}`、`category:{id}`、`tag:{id}`、`tag-name:{name}`、`article:list`、`seo`、`compliance`。内容变更后服务端会根据已知依赖主动调度 Home、Archive、ArticleDetail、Category/Tag Filter 与静态页的 AOT backfill；SEO 或 compliance 变更会按 manifest 调度所有 public routes。

### Public Navigation Snapshot

`GET /api/public/navigation-snapshot.aeds?path={publicPath}` 返回公开路由的原子接管快照，供 SPA 在路由切换前预取并写入 `PublicRouteSeedStore`。该端点匿名可读，`Accept` 允许空值、`*/*`、`application/octet-stream` 或 `application/vnd.fsus.aeds`；成功响应固定为 `Content-Type: application/vnd.fsus.aeds`，AEDS frame type 复用 `PublicAotBootstrap`。

`path` 必须是同站相对 URL，可包含 query；服务端会丢弃 fragment，并通过 Public AOT route registry 校验目标。允许范围与 SEO/AOT 公开页一致：`/`、`/archive`、`/article/{id}`、`/category/{id}`、`/tag/{id|name}`、`/about`、`/privacy`、`/guidelines`、`/copyright`。`/account`、`/search`、`/admin`、空 path、协议相对 URL 和绝对外链必须 fail closed。

成功 body 是 `PublicAotBootstrap` frame 包裹的对象：

```json
{
  "kind": "public-navigation-snapshot",
  "pageKind": "Archive",
  "pageId": 4,
  "routeKey": "archive",
  "path": "/archive",
  "queryString": "",
  "fullPath": "/archive",
  "canonicalPath": "/archive",
  "rendererVersion": "public-app-ssr@2026-05-01-1",
  "frontendAssetVersion": "manifest-sha256",
  "payloadHash": "sha256-hex",
  "generatedAtUtc": "2026-06-18T00:00:00.0000000Z",
  "bootstrapPayload": "<base64url AEDS frame>",
  "hydrationPropsPayload": "<base64url AEDS frame>"
}
```

`bootstrapPayload` 与 `hydrationPropsPayload` 必须来自 `PublicAotRenderRequest` -> `PublicAotShellEntryContract` 的同一条 renderer 输出，不能由 endpoint 自行重建。成功响应写入 `ETag`、`Cache-Control: public, max-age=30, stale-while-revalidate=300`、`Vary: Accept`，并暴露 `X-Fsus-Public-Aot-Route-Key`、`X-Fsus-Public-Aot-Renderer-Version`、`X-Fsus-Public-Aot-Frontend-Asset-Version`。`If-None-Match` 命中返回 `304`。path 语法错误返回 `400`，不支持或不可公开的 route 返回 `404`，内容协商失败返回 `406`，renderer/provider/gate 失败返回 `503`；所有负响应固定 `Cache-Control: no-store`。

### `PublicAotShellEntryContract`

```text
{
  "pageId": 2,
  "routeKey": "article:42",
  "rendererVersion": "public-app-ssr@2026-05-01-1",
  "bootstrapPayload": "<base64url AEDS frame>",
  "hydrationPropsPayload": "<base64url AEDS frame>",
  "html": "<div id=\"fsus-aot-shell\">...</div>",
  "title": "文章标题",
  "baseUrl": "https://fsus.blog"
}
```

- `bootstrapPayload`：页面初始数据 AEDS payload，供 SPA 直接初始化 Pinia store
- `hydrationPropsPayload`：hydration props AEDS payload，服务端 compose 时写为 `/aot-cache/payloads/{bucket}/{sha256}.aeds` raw frame，并通过 HTML marker 的 `data-aeds-src` 传递给客户端渲染器；该 sidecar 使用 `application/vnd.fsus.aeds` 与 immutable hash URL 缓存
- `html`：Vue SSR 产出的页面 shell HTML；上传模板仍可含占位符（如 `{{articleId}}`），写入前会规范化


`islandsPayload` 已退役。文章评论区接管统一使用 `hydrationPropsPayload.commentsIsland.articleId`。

### `Home` AOT payload shape

`bootstrapPayload` 与 `hydrationPropsPayload` 使用扁平文章字段。旧的嵌套 `response.items` 结构不再属于 AOT 契约。

```json
{
  "pageKind": "Home",
  "routeKey": "home",
  "pageIndex": 1,
  "pageSize": 10,
  "total": 12,
  "articles": [],
  "featuredArticles": [],
  "hotArticles": []
}
```

### `Filter` 页面最小契约

`bootstrapPayload` 与 `hydrationPropsPayload` 至少需要共享以下字段：

```json
{
  "pageKind": "Filter",
  "routeKey": "tag-name:AcceptanceTag",
  "title": "AcceptanceTag",
  "filter": {
    "filterType": "tag",
    "filterKey": "tag-name:AcceptanceTag",
    "filterId": 1,
    "filterName": "AcceptanceTag",
    "isInvalidTarget": false,
    "pageIndex": 1,
    "pageSize": 10,
    "total": 2,
    "articles": []
  }
}
```

补充约束：

- `filterKey` 是筛选页稳定身份，必须能区分 `category:1`、`tag:1`、`tag-name:AcceptanceTag`。
- 无效分类/标签目标必须设置 `isInvalidTarget=true`，且 `articles` 必须为空。
- 客户端不得再从 path string 反推标题或筛选语义。


### `ArticleDetail` AOT payload shape

文章详情 hydration 使用 `bodyContent` 承载原始 Markdown，使用 `bodyHtml` 承载 SSR 渲染后的 HTML。`content` 不再是 AOT 契约字段。

```json
{
  "pageKind": "ArticleDetail",
  "routeKey": "article:42",
  "articleId": 42,
  "bodyContent": "# Heading",
  "bodyHtml": "<h1>Heading</h1>",
  "commentsIsland": { "articleId": 42 }
}
```

### `ArticleDetail` 标签链接契约

文章详情页中的标签项必须显式包含 `label + href`，例如：

```json
{
  "label": "#AcceptanceTag",
  "href": "/tag/AcceptanceTag"
}
```

分类链接也必须直接由页面模型提供，不能交由组件层二次推导。

---

## PoW 契约

### `PowChallenge`（`GET /api/binary/auth/pow-challenge`）

```json
{
  "challenge": "hex-encoded-challenge-string",
  "difficulty": 16,
  "expiresAt": "2026-01-01T00:05:00Z"
}
```

- `difficulty`：bit 级前导零个数，客户端需找到使 `SHA256(salt + ":" + nonce + ":" + browserFp)` 有 `difficulty` 个前导零 bit 的 `nonce`
- 挑战令牌存入 Redis，5 分钟过期，使用后立即删除（防重放）

### PoW 请求头

携带 PoW 答案的请求需附带以下 HTTP 请求头：

```
X-Fsus-Pow-Challenge: <challenge 值>
X-Fsus-Pow-Answer: <nonce 值>
```

---

## 开放分发与作者工作台契约（2026-05-18）

### Feed / Sitemap / Robots

公开分发端点只暴露 `published` 且到达发布时间的文章；`draft`、`scheduled`、`archived`、`deleted` 不得出现在 feed、sitemap、related-reading、搜索索引或 PublicAOT 公开缓存中。

| 方法 | 路径 | 响应 | 说明 |
|------|------|------|------|
| GET | `/feed/rss.xml` | `application/rss+xml` | RSS 2.0，包含 title、canonical URL、summary、author、published/update time、cover enclosure |
| GET | `/api/Article/rss` | `application/rss+xml` | 历史兼容路径，内容等同 `/feed/rss.xml` |
| GET | `/feed/atom.xml` | `application/atom+xml` | Atom feed |
| GET | `/feed/feed.json` | `application/feed+json` | JSON Feed 1.1 |
| GET | `/sitemap.xml` | `application/xml` | 首页、文章、归档、关于、隐私政策、用户守则、版权声明、分类、标签；排除登录、用户、admin |
| GET | `/robots.txt` | `text/plain` | 声明 sitemap，并拒绝私有路由 |
| GET | `/api/binary/article/{articleId}/related.aeds` | `AedsFrameType.ArticleRelatedReading` | 基于分类、标签、全文关键词和发布时间的公开延伸阅读 |

feed、sitemap 与 robots 响应使用 `Cache-Control: public, max-age=60, stale-while-revalidate=300` 并挂载 OutputCache ArticleList/Seo tag；端点不按正文手写 ETag，也不在请求线程解析 `If-None-Match`。RSS channel 的 copyright 来源于合规配置；`robots.txt` 明确禁止 `/api/`、`/user`、`/admin`、搜索索引二进制与 patch 目录，同时保留 `/api/public/`、`/feed/`、`/sitemap.xml` 与公开路由可抓取。

公开评论读取、公开 taxonomy 与 `related-reading` AEDS 端点受 `public_read` 限流和风险感知过滤保护。风险分达到 50 时动态 API 要求 `X-Fsus-Pow-Proof`，达到 100 时返回 429；verified crawler 走独立高额度，social preview bot 不允许访问 `/api/**`。

### Crawler Range Ops

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/ops/crawler-ranges/status` | admin | 返回 Google/Bing CIDR 数量、最近同步时间、最近成功时间、来源和错误摘要 |

该状态来自 `CrawlerUpdateWorker` 的远程官方 JSON → last-known-good snapshot → 配置项 → empty degraded 加载链，只用于运维诊断，不返回客户端 IP、User-Agent 或用户数据。

### Site Subscription

订阅表单使用 AEDS，不保存明文 email；服务端只写入 `SHA256(normalizedEmail)` 与归一化 channel。

| 方法 | 路径 | 请求帧 | 响应帧 | 说明 |
|------|------|--------|--------|------|
| POST | `/api/binary/subscriptions` | `SiteSubscriptionRequest` | `SiteSubscriptionResponse` | 启用订阅，响应只包含 `subscribed=true` 与归一化 channel |
| DELETE | `/api/binary/subscriptions` | `SiteSubscriptionRequest` | `SiteSubscriptionResponse` | 退订，响应只包含 `unsubscribed` 与归一化 channel |

`SiteSubscriptionRequest` payload 是 `SiteSubscriptionRequestPod`：fixed UTF-8 `Email(256)` + `Channel(32)`。`SiteSubscriptionResponse` payload 是 `SiteSubscriptionResponsePod`：`subscribed:byte`、`unsubscribed:byte`、reserved、fixed UTF-8 `Channel(32)`。非法 email 返回 HTTP 400 + `ApiError` frame，响应不得回显明文 email。

`ArticleRelatedReading` frame payload 使用 `RelatedReadingHeaderPod` + `RelatedReadingItemPod[]` + UTF-8 blob 编码；业务视图为 `RelatedReadingResponse`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `related` | `RelatedReadingItem[]` | 最多 6 条相关文章，按同分类、共同标签、全文关键词命中和发布时间接近度综合排序 |
| `previous` | `RelatedReadingItem \| null` | 按 `publishedAt ?? createTime` 定位的上一篇公开文章 |
| `next` | `RelatedReadingItem \| null` | 按 `publishedAt ?? createTime` 定位的下一篇公开文章 |

`RelatedReadingItem` 包含 `id`、`title`、`summary`、`createTime`、`reason`。`reason` 只允许来自公开内容关系，例如 `同分类`、`共同标签`、`全文关键词`、`发布时间接近`、`上一篇`、`下一篇`；不得使用点赞、收藏、关注、用户画像或登录态行为。文章详情页的 SPA 与 PublicAOT 均消费同一个 `relatedReading` 视图契约，避免首屏静态输出与 hydration 后页面结构漂移。

当目标文章不存在、未发布、已删除或尚未到达公开发布时间时，AEDS endpoint 返回 `AedsFrameType.ApiError`，语义错误码为 `ErrorCode.NotFound`，消息为 `article_not_found`。

### SEO Discovery

`PublicAotDocumentComposer` 为 AOT 公开页输出 canonical、description、OpenGraph、Twitter card 与 feed discovery。JSON-LD 使用单个 `@graph`，必须包含站点级 `WebSite` + `SearchAction`、页面路径 `BreadcrumbList`，文章详情页额外包含 `BlogPosting`。`check:public-seo-smoke` 会对 home、article detail、archive、about、privacy、guidelines、copyright、category、tag 的 AOT 命中和 shell-only SPA fallback 做一致性校验。

### 文章生命周期

`Article.Status` 的服务端枚举为：

| 值 | 语义 |
|----|------|
| `Draft` | 草稿，不进入公开读链 |
| `Scheduled` | 定时发布候选，到点后由 worker 转为 `Published` |
| `Published` | 公开可读 |
| `Archived` | 归档隐藏，不进入公开分发 |
| `Deleted` | 逻辑删除，保留原有回收站语义 |

`CreateArticleRequest` 与 `UpdateArticleRequest` 支持 `status`、`scheduledPublishAt`。公开读路径必须同时检查 `IsDeleted=false`、`Status=Published`、`PublishedAt<=now`、`ScheduledPublishAt<=now`。

Binary 写入帧 `ArticleWriteRequest` 使用旧 `ArticleWriteRequestPod` + `tagIds` + blob 作为主体，并在尾部追加 `status:int32` 与 `scheduledPublishAtUnixMs:int64`；缺省尾部按 `Published`、无定时发布处理。`ArticleDetail` 在 cover blob 与 `isDeleted:byte` 后追加 `status:int32`、`scheduledPublishAtUnixMs:int64`、`publishedAtUnixMs:int64`，admin 读取未发布文章时依赖该尾部恢复编辑器状态。

`GET /api/binary/admin/article` 的 `status` 查询参数仅 admin 可用。公开 `/api/binary/article/**.aeds` 不接受 query string、请求体或 credentials；admin 不带 `status` 时读取所有非删除状态，带 `status=0/1/2/3/4` 时读取对应 draft/scheduled/published/archived/deleted 集合。

公开与管理端文章响应矩阵：

| 路径族 | 身份 | 状态范围 | 失败语义 |
|--------|------|----------|----------|
| `/api/binary/article/**.aeds` | 匿名公开，客户端 `credentials: omit` | 仅 `Published` 且发布时间已到、`IsDeleted=false`；帧内管理尾字段只允许公开安全值 | L0 miss/not-ready/协议错误只返回 HTTP 状态；前端按 `404`/`503`/`400`/`406` 分别处理 |
| `/api/binary/admin/article/**` | admin | draft/scheduled/published/archived/deleted 按 `status` 查询参数精确读取 | AEDS `ApiError` frame，错误码与 JSON 语义保持一致 |

旧公开 query 路径（如 `/api/binary/article?page=1`、`/api/binary/article/hot?size=10`）不再 fallback；fast path 返回 `400 no-store`，并通过 `X-Fsus-Required-Route` 提示新的 segment artifact 路径。

### Admin 作者工作台

生产前端使用 `/api/binary/author/**`，外层为 AEDS v2 frame。写入请求使用 route-specific request frame（如 `AuthorDraftSaveRequest`、`ModerationRuntimeGlobalStateRequest`、`ContentImportRequest`），响应使用 route-specific response frame（如 `AuthorDraftResponse`、`ModerationRuntimeStatus`、`AuditLogList`）；payload 当前承载类型化 JSON DTO bytes，浏览器不可访问 `JsonApiResponse<T>` envelope，错误统一为 `ApiError` frame。`AuthoringBinaryBridgeMiddleware` 复用 authoring endpoint 逻辑的授权、MFA、fixed_ip rate limit、审计和缓存失效边界；被复用的 JSON envelope 只挂在 `/_fsus/internal/binary-bridge/author/**`，受 `BinaryBridgeInternalOnlyFilter` 保护。外部 `/api/author/**` JSON endpoint 已移除：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/binary/author/drafts` | 保存服务端草稿，按 `ownerUserId + draftKey` 幂等覆盖；payload 包含 `status` 与 `scheduledPublishAt` |
| GET | `/api/binary/author/drafts/{draftKey}` | 读取服务端草稿；不存在时返回 `success=true,data=null`，存在时返回 `updatedAt`、`clientRevision`、发布状态与定时发布时间 |
| DELETE | `/api/binary/author/drafts/{draftKey}` | 丢弃服务端草稿；编辑器同步清除浏览器本地兜底缓存 |
| POST | `/api/binary/author/preview` | admin-only 私有预览，输出经过转义的 Markdown/AOT-like HTML，根节点带 `data-preview-only=true`、`data-markdown-renderer=server-preview`，不写 PublicAOT cache |
| POST | `/api/binary/author/prepublish-check` | 发布前检查标题、SEO 描述、封面 URL、Markdown 结构、链接、图片 alt 与危险 HTML |
| GET | `/api/binary/author/articles/{articleId}/revisions` | 最近 50 条修订摘要 |
| GET | `/api/binary/author/articles/{articleId}/revisions/{revisionId}` | 单个修订详情，包含标题、摘要、正文、分类、标签和审计时间，用于编辑器内比较 |
| POST | `/api/binary/author/articles/{articleId}/revisions/{revisionId}/rollback` | 回滚到指定修订并触发文章更新链 |
| POST | `/api/binary/author/articles/{articleId}/assets/reindex` | 从正文和封面重建资产引用 |
| GET | `/api/binary/author/assets` | 资产库列表 |
| DELETE | `/api/binary/author/assets/orphans` | 删除引用计数为 0 的孤儿资产库记录 |
| GET | `/api/binary/author/taxonomy/categories` | 管理端分类真实引用计数和删除锁定状态 |
| GET | `/api/binary/author/taxonomy/tags` | 管理端标签真实引用计数和删除锁定状态 |
| GET | `/api/binary/author/analytics` | 单作者公开内容与真实阅读事件概览 |
| GET | `/api/binary/author/comments/moderation?status={0..3}&limit={1..100}` | 评论审核队列，默认读取待审项；要求 `comment.moderate` |
| POST | `/api/binary/author/comments/moderation/bulk` | 批量通过、拒绝或隐藏评论，可联动封禁用户；要求 `comment.moderate`，必须携带 `X-Fsus-Mfa-Proof` |
| POST | `/api/binary/author/comments/{commentId}/moderation` | 评论审核状态更新；要求 `comment.moderate`，必须携带 `X-Fsus-Mfa-Proof` |
| GET | `/api/binary/author/moderation/overview` | 审核系统总览，返回队列计数、词库/地区策略数量、`CN-MAINLAND` strict policy 状态和模型配置摘要 |
| GET | `/api/binary/author/moderation/anonymous-comment-policy` | 读取匿名评论策略 snapshot；要求 `anonymous.comment.configure` |
| PUT | `/api/binary/author/moderation/anonymous-comment-policy` | 更新匿名评论 enable/disable、public/ZK 开关和默认 author mode；必须携带 `X-Fsus-Mfa-Proof` 并写高价值审计 |
| POST | `/api/binary/author/comments/moderation/nullifiers/block` | 按 hash + scope 封禁匿名评论 nullifier；必须携带 `X-Fsus-Mfa-Proof`、要求 `anonymous.nullifier.block` |
| POST | `/api/binary/author/comments/moderation/anonymous-credentials/{credentialId}/revoke` | 撤销匿名凭证；必须携带 `X-Fsus-Mfa-Proof`、要求 `anonymous.credential.revoke` |
| GET | `/api/binary/author/moderation/dictionaries` | 只读词库/地区策略 snapshot metadata，不返回高风险词条明文 |
| POST | `/api/binary/author/moderation/dictionaries/reload` | 手动 reload 词库/地区策略 snapshot；必须携带 `X-Fsus-Mfa-Proof`，写高价值审计 |
| POST | `/api/binary/author/moderation/dictionaries/rollback` | 回滚上一份成功加载的词库/地区策略 snapshot；必须携带 `X-Fsus-Mfa-Proof`，写高价值审计 |
| POST | `/api/binary/author/moderation/dictionaries/{dictionaryId}/enable` | 移除指定词库的 runtime disabled override；必须携带 `X-Fsus-Mfa-Proof` |
| POST | `/api/binary/author/moderation/dictionaries/{dictionaryId}/disable` | 添加指定词库的 runtime disabled override；CN-MAINLAND 强制词库需要确认短语；必须携带 `X-Fsus-Mfa-Proof` |
| GET | `/api/binary/author/moderation/policies` | 地区策略 summary，包含 `criticalChecks`，用于校验 `CN-MAINLAND` 必需词库与动作 |
| GET | `/api/binary/author/moderation/regions` | 地区定义 catalog，包含内置和自定义地区、父地区、大区、模板绑定与启用状态 |
| GET | `/api/binary/author/moderation/region-groups` | 地区大区 catalog，包含成员地区、默认模板、内置/自定义标记 |
| GET | `/api/binary/author/moderation/policy-templates` | 策略模板 presets，包含 source/version/checksum/review marker 和 not-legal-advice 标记 |
| GET | `/api/binary/author/moderation/effective-policy/{regionCode}` | 指定地区 effective policy preview，显示继承顺序、最终规则和 checksum |
| POST | `/api/binary/author/moderation/effective-policy/preview` | 带 operator override rules 的 effective policy preview，不执行 replay 或持久变更 |
| POST | `/api/binary/author/moderation/replay/preview` | 策略回放 preview，只返回 diff 汇总和受影响评论，不执行变更 |
| GET | `/api/binary/author/moderation/runtime/status` | 当前审核运行时状态，包含全局状态、地区 override、禁用词库集合和模型快照 |
| POST | `/api/binary/author/moderation/runtime/global-state` | 设置全局审核运行状态；必须携带 `X-Fsus-Mfa-Proof`，写高价值审计并清理评论缓存 |
| POST | `/api/binary/author/moderation/runtime/region-state` | 设置地区审核运行状态；CN-MAINLAND 非 enabled 需要确认短语；必须携带 `X-Fsus-Mfa-Proof`，写高价值审计并清理评论缓存 |
| GET | `/api/binary/author/moderation/model/status` | 反垃圾模型状态，返回 provider/mode/contract/timeout/failOpen 和最近成功/错误/latency 指标 |
| POST | `/api/binary/author/moderation/model/runtime` | 热切换模型 enabled/provider/modelProfile/thresholdProfile；必须携带 `X-Fsus-Mfa-Proof` |
| POST | `/api/binary/author/moderation/model/reload` | 从配置热重载模型运行快照，provider/schema 校验失败时保留旧快照；必须携带 `X-Fsus-Mfa-Proof` |
| POST | `/api/binary/author/moderation/model/rollback` | 回滚上一份模型运行快照；必须携带 `X-Fsus-Mfa-Proof` |
| GET | `/api/binary/author/content/export` | 全站内容备份包，包含每篇 Markdown + frontmatter |
| GET | `/api/binary/author/articles/{articleId}/export` | Markdown + frontmatter 导出 |
| POST | `/api/binary/author/articles/import` | Markdown + frontmatter 导入 |
| GET | `/api/binary/author/audit` | 结构化审计日志列表，支持 actor/action/target/outcome/severity/time 过滤 |
| GET | `/api/binary/author/audit/summary` | 当前过滤条件下的审计 facet 与写入 runtime |
| GET | `/api/binary/author/audit/{id}` | 审计详情、context JSON 与防篡改校验结果 |
| GET | `/api/binary/author/audit/{id}/verify` | 单条审计 `record_hash` / `record_mac` 与同链 `prev_hash` 前驱校验 |
| GET | `/api/binary/author/ops/health` | 运维健康面板数据：PostgreSQL、Redis、audit、Crawler CIDR、备份、PublicHotRead、search、worker、队列和结构化最近错误 |
| GET | `/api/ops/health/ready-detail` | 受保护详细 readiness JSON：配置、PostgreSQL、Redis、资源、runtime、observability；要求 admin principal `audit.read` |
| GET | `/api/binary/author/ops/backup` | 最近站点备份状态，扫描 database/uploads/DataProtection keyring/config/site-package/restore-drill artifacts |
| GET | `/api/binary/author/ops/dangerous-operations/policy` | 管理端危险操作等级、admin passkey step-up、强确认和 diff 策略 |
| GET | `/api/binary/author/cache/diagnostics?articleId={id}` | AOT/PublicHotRead/search/sitemap/feed/comment cache/output cache 诊断，可选单文章定位 |
| POST | `/api/binary/author/cache/actions` | 手动维护动作：`search-rebuild`、`aot-rebuild`、`public-hot-rebuild`、`output-cache-clear`、`sitemap-feed-refresh` |
| GET | `/api/binary/author/integrity` | 数据一致性巡检报告，覆盖文章正文/修订、taxonomy、评论链、session、uploads/assets、search/sitemap visibility |
| GET | `/api/binary/author/integrity/fix-preview` | 安全修复 diff 预览；当前只预览无效 `article_tag` 和注销用户 session 撤销 |
| POST | `/api/binary/author/integrity/fix` | 应用安全修复，必须携带 `X-Fsus-Mfa-Proof` 且 `confirmPhrase=APPLY_SAFE_FIXES` |
| POST | `/api/binary/author/ai-assist` | 作者 AI 辅助；默认 provider disabled/local fallback，不把未发布正文发往外部服务 |

`ModerationOverviewResponse` 返回 `pendingCount/rejectedCount/hiddenCount/dictionaryCount/regionPolicyCount/mainlandStrictStatus/dictionaryLastError/modelEnabled/modelProvider/modelMode/modelContractVersion/modelTimeoutMs`。`mainlandStrictStatus` 为 `enabled/disabled/invalid`，用于管理台提示大陆严格策略是否完整。

`ModerationDictionaryRuntimeSnapshot` 只用于 admin 作者工作台读取当前词库运行时 metadata：`snapshotId/version/checksum/createdAtUtc/lastError`、词库 `dictionaryId/version/scope/region/category/source/reviewedBy/updatedAtUtc/checksum/evidencePolicy/termCount`，以及地区策略 `region/version/inherits/dictionaryIds/checksum/ruleCount/rules`。该响应不包含 `terms`、命中词、alias 或高风险词条明文；`evidencePolicy=redact` 时管理台只能展示 metadata。词库 action 不会从词库项下发，发布/展示动作仍由服务端地区策略执行。

`RegionPolicySummaryResponse` 返回 `region/version/inherits/dictionaryIds/checksum/ruleCount/criticalChecks`。`CN-MAINLAND` 必须检查继承 `GLOBAL`、加载 `cn-mainland.political-sensitive`、`cn-mainland.porn-strict`、`cn-mainland.public-order`、`cn-mainland.national-security`，并保证 `political_sensitive` 与 `pornographic` 的 submit action 为 `reject_submit`、display action 为 `geo_block`。

`ModerationRegionDefinition` 返回 `regionCode/displayName/parentRegion/primaryGroup/policyTemplate/enabled/builtin/description`；`ModerationRegionGroupDefinition` 返回 `groupCode/displayName/policyTemplate/builtin/enabled/regions/description`；`ModerationPolicyTemplateDefinition` 返回 `templateId/version/scope/region/regionGroup/source/reviewedBy/reviewedAtUtc/builtin/enabled/notLegalAdvice/description/checksum/rules`。默认模板是 engineering presets，不是法律意见；内置模板必须带 `source/version/checksum/reviewed_by/reviewed_at_utc` 字段并标记 `notLegalAdvice=true`。`GREATER_CHINA` 大区不配置 `cn-mainland-strict` 模板，`CN-HK/CN-MO/CN-TW` 默认不继承中国大陆严格策略。

`ModerationEffectivePolicyPreview` 返回 `region/displayName/regionGroups/inheritance/rules/checksum/warnings`。继承顺序为 `GLOBAL baseline -> region group policy -> parent region policy -> concrete region policy -> operator overrides`，后者覆盖同 category 的前者。`GET /effective-policy/{regionCode}` 只使用当前 catalog 与地区策略 snapshot；`POST /effective-policy/preview` 可传 `operatorOverrides` 进行 dry-run，不写入配置、不重算历史评论。preview 会写普通审计 `admin.moderation.effective_policy_previewed`，执行型 replay 仍必须另走 MFA、确认短语和高价值审计。

`ModerationDictionaryReloadResponse` 返回 `reloaded/snapshotId/checksum/error/reloadedAtUtc`。该端点是高风险写操作，必须先通过 admin passkey step-up 获取 action=`admin-sensitive` 的一次性 proof，并在请求头传入 `X-Fsus-Mfa-Proof`；失败时旧 snapshot 保持不变。

`ModerationReplayPreviewRequest` 包含可选 `region/policyVersion/dictionaryId/limit`。响应 `ModerationReplayPreviewResponse` 只返回 `scannedCount/affectedCommentCount/addedBlockedRegionCount/removedBlockedRegionCount/addedRiskLabelCount/removedRiskLabelCount/publishabilityChangedCount/manualReviewChangedCount/publicVisibilityChangedCount/highRiskChangeCount/items`，`items` 只含 comment id、policy version 和 diff，不返回评论正文或 raw terms。该 preview 不执行 replay；执行型 replay 必须另走 MFA、确认短语、高价值审计和可中断进度控制。

`ModerationModelStatusResponse` 返回模型配置与观测：`enabled/provider/mode/contractVersion/timeoutMs/failOpen/externalProviderAllowed/externalProviderReviewed/lastSuccessAtUtc/lastErrorCode/lastErrorAtUtc/averageLatencyMs/p95LatencyMs`。这些字段只描述模型风险信号层，不代表最终审核动作；地区法律策略、硬词库和人工审核状态优先级更高。

`ModerationRuntimeStatusResponse` 返回 `snapshotId/globalState/regionStates/disabledDictionaryIds/model/changedAtUtc/changedBy/reason/expiresAtUtc/lastError`。`model` 是 `ModerationModelRuntimeResponse`，包含 `snapshotId/enabled/provider/modelProfile/thresholdProfile/contractVersion/configChecksum/loadedAtUtc/loadedBy/status/timeoutMs/failOpen/externalProviderAllowed/externalProviderReviewed/lastError`。全局状态支持 `enabled/read_only/disabled_to_pending/emergency_lockdown`，服务层仍能表达 `disabled_pass_through`，但 production 默认拒绝该状态；地区状态支持 `enabled/manual_review_only/no_public_display/read_only/disabled`。请求体包括：`ModerationRuntimeGlobalStateRequest(state, reason?, expiresAtUtc?)`、`ModerationRuntimeRegionStateRequest(region, state, reason?, expiresAtUtc?, confirmPhrase?)`、`ModerationDictionaryStateRequest(reason?, confirmPhrase?)`、`ModerationModelRuntimeRequest(enabled?, provider?, modelProfile?, thresholdProfile?, reason?)`。`CN-MAINLAND` 地区非 `enabled` 变更和强制词库禁用必须传 `confirmPhrase="CONFIRM CN-MAINLAND MODERATION CHANGE"`；`CN-MAINLAND` 地区状态不得设为 `disabled`。

### Admin 安全系统

生产前端使用 `/api/binary/admin/security/**`，外层为 AEDS v2 frame。写入请求使用 route-specific request frame（如 `AntiCrawlerOptionsUpdateRequest`、`SecurityRiskResetRequest`、`AntiCrawlerRuleRequest`、`PowOptionsUpdateRequest`），响应使用 route-specific response frame（如 `SecurityOverview`、`AntiCrawlerPolicySnapshot`、`SecurityRiskEventList`、`PowPolicySnapshot`）；payload 当前承载类型化 JSON DTO bytes，浏览器不可访问 `JsonApiResponse<T>` envelope，错误统一为 `ApiError` frame。`SecurityBinaryBridgeMiddleware` 复用 security endpoint 逻辑的 admin principal + `system.config` permission、MFA、fixed_ip rate limit、device fingerprint、审计和运行时策略更新边界；被复用的 JSON envelope 只挂在 `/_fsus/internal/binary-bridge/admin/security/**`，受 `BinaryBridgeInternalOnlyFilter` 保护。外部 `/api/admin/security/**` JSON endpoint 已移除。

`/api/binary/admin/security/**` 全部要求 admin principal + `system.config` 权限。写入型和高价值操作必须携带 admin passkey step-up 产生的 action=`admin-sensitive` 一次性 `X-Fsus-Mfa-Proof`，并写入高价值安全审计。`X-Fsus-Mfa-Proof` 与 PoW replay proof 共用 consume-once cache primitive：L1 先失效，Redis 删除成功后同一进程内也不能再次读取该 proof。

安全系统 IA 与 API 边界：

- `GET /api/binary/admin/security/overview` 返回 `SecurityOverviewResponse(status, checkedAtUtc, antiCrawler, pow, risk)`。
- `GET /api/binary/admin/security/anti-crawler/overview` 返回 `AntiCrawlerOverviewResponse(policy, summary, crawlerRanges, recentEvents, rules, allowlist, blocklist)`。
- `GET|PUT /api/binary/admin/security/anti-crawler/options` 读取或更新 `AntiCrawlerPolicySnapshot`。
- `POST /api/binary/admin/security/anti-crawler/options/rollback` 回滚上一份反爬虫策略快照。
- `GET|POST /api/binary/admin/security/anti-crawler/crawler-ranges/status|sync` 查看 CIDR worker 状态或手动同步。
- `GET /api/binary/admin/security/anti-crawler/risk-events`、`GET /api/binary/admin/security/risk/events`、`GET /api/binary/admin/security/risk/snapshots` 分别读取反爬虫事件、统一风险事件和风险主体快照。
- `GET|POST|PUT|DELETE /api/binary/admin/security/anti-crawler/rules` 管理运行时反爬虫规则。
- `GET|POST|DELETE /api/binary/admin/security/anti-crawler/allowlist|blocklist` 管理运行时 allow/blocklist。
- `POST /api/binary/admin/security/anti-crawler/simulate` 只返回 dry-run 结果，不修改策略或风险分。
- `GET|PUT /api/binary/admin/security/pow/options` 和 `GET /api/binary/admin/security/pow/overview` 管理 PoW 独立策略。
- `POST /api/binary/admin/security/risk/ip/reset` 重置指定 IP 的统一风险分。

`AntiCrawlerPolicyOptions` 包含 `mode`（`disabled|observe|enforce|strict`）、局部开关 `publicReadChallengeEnabled/searchCrawlerVerificationEnabled/socialPreviewGuardEnabled/riskScoringEnabled/eventPersistenceEnabled/dashboardAggregationEnabled/cidrAutoUpdateEnabled/illegalPathHardAbortEnabled`、阈值 `requireChallengeScore/blockScore/maxRiskScore`、TTL、crawler-aware rate limiter 额度、CIDR 更新时间和 Google/Bing URL。`disabled` 只关闭 crawler 类处置，不关闭 PoW、认证、授权、CORS、Fetch Metadata 或基础路径安全；`observe` 记录事件但不拦截、不触发 public read challenge 升级；`strict` 提高 crawler 类风险分。更新时间运行时热更新，最小间隔默认 30 分钟。

`PowPolicyOptions` 独立包含 `mode/defaultDifficulty/adaptiveDifficultyEnabled/proofTtlSeconds/replayProtectionEnabled/riskScoreLinkEnabled/challengeEndpoint/verificationStrategy`。PoW 是安全系统下与 AntiCrawler 并列的 challenge 能力；反爬虫页面只展示 `securityChallengeReference`，不得把 PoW 作为反爬虫子配置。

统一风险抽象为 `SecurityRisk`：`ISecurityRiskSignalSink` 写入 `anti-crawler/rate-limiter/pow/human-read-proof/public-read` 来源事件，`ISecurityRiskScoreReader` 读取和重置主体风险分，`ISecurityRiskPolicyProvider` 提供 `SecurityRiskPolicySnapshot`。旧 `CrawlerRiskService` 作为兼容实现保留，但 API 与前端不再把 PoW、ReadProof、RateLimiter 归入 AntiCrawler。

`AiAssistResponse` 返回 `providerEnabled`、`providerMode`、`externalProviderAllowed`、`auditEvent`、`suggestedSummary`、`suggestedTags`、`titleCandidates`、`translationDraft`、`structureIssues`。前端编辑器只能在 admin 作者工作台内调用该接口；调用结果可用于使用摘要草稿、匹配已有标签、使用标题备选、使用翻译草稿或查看结构检查。外部 provider 必须同时满足 `Authoring:AiAssist:Enabled=true`、非 `local` provider、`AllowExternalProvider=true`、`ExternalProviderReviewed=true`，否则 `externalProviderAllowed=false` 且服务端只返回本地建议。

`ArticlePreviewResponse` 只用于作者工作台内嵌预览：`html` 是服务端按公开阅读页常用 Markdown block/inline 语义生成的安全片段，前端放入 sandboxed iframe；`plainText` 用于字数和摘要提示；`issues` 复用发布前检查结果。该响应不得被缓存为公开 AOT、不得进入 feed/sitemap/search/related-reading，也不得被匿名接口返回。

编辑器侧栏必须基于当前表单和 `SeoConfigContract.baseUrl` 实时给出搜索/分享预览：标题、description、canonical URL、OG image 与当前公开路由 slug。提交 `Published` 或 `Scheduled` 前必须调用 `/api/binary/author/prepublish-check`；`severity=error` 阻断提交，`severity=warning` 必须在确认发布弹窗中要求作者填写 `warningOverrideReason` 后才能跳过，服务端写入 `prepublish-warning-override` 审计事件。检查项覆盖标题/摘要/封面、危险 HTML 标签和事件属性、Markdown 未闭合代码块、超大/密集 Markdown 结构、正文图片 alt text、空链接、不安全协议、私有站内路径以及 `/article|category|tag/{id}` 格式错误。当前真实公开文章路由仍以 `/article/{id}` 为准，新文章在落库前只显示 draft-preview slug，不新增持久化 slug 字段。

`AssetLibraryItemResponse` 暴露 `id`、`url`、`altText`、`sourceArticleId`、`referenceCount`、`sha256`、`updatedAt`。重建资产索引会扫描所有文章正文中的 Markdown 图片和文章封面，只接受 `/uploads/illustration/*` 图片 URL；正文图片的 alt text 写入资产库，封面作为可复用资产参与引用计数。仍被正文或封面引用的资产 `referenceCount > 0`，失去引用的资产先保留为 `referenceCount=0` 供作者审计，只有 `DELETE /api/binary/author/assets/orphans` 会删除这些孤儿资产库行；该清理不删除上传文件本体。物理删除文件必须走 `/api/binary/file/delete`，并由管理 UI 通过二次确认区分“仅移除配置/索引”和“删除服务器文件”。

`AuditLogListResponse` 返回 `items`、`total`、`page`、`pageSize` 和 `runtime`。列表查询参数包括 `source`、`type`、`actor`、`action`、`targetType`、`targetId`、`outcome`、`severity`、`fromUtc`、`toUtc`；`actor` 会匹配 actor id/type/role，target 可按 type 和 id 分别过滤。`AuditLogItemResponse` 暴露 `source/type/action/outcome/severity/isHighValue`、`actorType/actorId/actorRole`、`targetType/targetId`、`reasonCode`、`eventInfo`、trace/path/method、`ipHash/userAgentHash/sessionIdHash/deviceFingerprintHash` 和 `chainId/prevHash/recordHash/recordMac`。`AuditLogDetailResponse` 额外返回 `contextJson` 与 `tamperEvidenceValid`；`AuditTamperVerifyResponse` 校验当前记录 hash/mac，并按 `chainId` 查询前一条记录，要求当前 `prevHash` 等于前驱 `recordHash`，首条记录则要求不存在前驱。所有审计查询端点位于 admin-only `/api/binary/author/audit/**`，并会写入 `admin.audit.queried` 审计事件。

`OpsHealthResponse` 的 `services` 至少包含 `postgres`、`redis`、`audit`、`crawler-cidr`、`backup`、`public-hot-read`、`search-index`；`workers` 包含 `scheduled-publish` 和启动任务快照；`queueBacklog` 包含 `articleMutationPending`、`articleMutationFailed`、`auditQueued`、`auditDropped`；`backup` 内嵌 `BackupStatusResponse`，用于 `/user/manage/ops` 的后台状态展示。`recentErrors` 返回 `RecentOpsErrorResponse[]`，每项包含 `occurredAt`、`severity`、`action`、`message`、`detail` 和 `count`；服务端只查询审计行的原始字段，物化后清理 `CAST(...)` 等 SQL 投影残片、提取短摘要、保留可展开详情，并按 `action + normalized message` 合并重复错误。`BackupStatusResponse` 只暴露 artifact 路径、mtime、size 和状态，不返回 secret 内容。

`CacheDiagnosticsResponse` 返回 `aot`、`search`、`distribution`、`commentCache`、`hotStatsInvalidation`、`outputCache`、`publicHotReadCounters` 和可选 `article`。`aot` 来自 `PublicHotReadStore` 和 `PublicAotInvalidationTracker`；`search` 读取 `/search/index.manifest.aeds` 的 schema/version/shard count；`distribution` 通过实际生成 sitemap/rss 统计 URL/item 数；`commentCache` 来自 `CacheInvalidationRuntimeState`。`hotStatsInvalidation` 来自 `IHotStatsInvalidationCoalescer`，暴露当前 HotArticles version、dirty/flush 次数、coalesced dirty 数、pending 状态和最近 dirty/flush reason，用于 VisitLog 驱动失效压力 evidence。`POST /api/binary/author/cache/actions` 会写入 `admin.cache.action_executed` 高价值审计。

`IntegrityReportResponse` 返回 `checks`，每项包含 `code/title/status/severity/count/autoFixAvailable/detail/sampleKeys/previewDiffs`。巡检覆盖 `article_missing_body`、`article_body_without_revision`、`article_missing_category`、`article_tag_missing_tag`、`article_tag_missing_article`、`comment_missing_article`、`comment_chain_invalid`、`session_deleted_user`、`upload_untracked`、`asset_missing_file`、`sitemap_visibility`、`search_visibility`、`taxonomy_count_runtime`。`IntegrityFixPreviewResponse` 和 `IntegrityFixResponse` 使用 `AdminDiffResponse(field,before,after)` 表示变更摘要；实际修复端点只应用 safe fixes，并写入 `admin.integrity.safe_fix_applied` 高价值审计。

`AuthorAnalyticsResponse` 聚合单作者运营数据：文章状态计数、`totalHumanReadEvents`、`totalSearchableArticles`、`aotHitRate`、`averageDwellMs`、`readingCompletionRate`，以及 `topSearchKeywords`、`topSourceRoutes`、`notFoundHotspots`、`rumMetrics`、`rumPageTypes`、`rumAotSources`。阅读列表来自 `VisitLog.routeKey` 的匿名化公开路由读证明，不包含账号、email、token、cookie 或正文输入；AOT 命中率由真实阅读事件与 `Public AOT cache miss` 审计日志估算。RUM 列表来自匿名 `POST /api/binary/telemetry/rum` 写入的 `frontend_rum_metric`，只接受 `web_vital_lcp`、`web_vital_cls`、`navigation_timing`、`hydration_time`、`wasm_decode_timing`、`markdown_render_timing` 和低基数 `pageType/aotSource/value/duration` 字段。`accepted=false` 或 `rejectedCount>0` 表示部分/全部样本被丢弃但不向公开读链泄露校验细节；服务端只保存净化后的 `frontend_rum_metric` 行，不写入 `sys_audit_log`。

评论创建默认进入 `CommentModerationStatus.Pending`，公开评论线程、回复预览和回复游标只返回 `Approved`；用户自己的评论历史只按非空 `user_id` 查询，匿名评论通过 actor projection 展示而不是强制绑定 `user_id`。公开评论 composer 必须先读取 `GET /api/binary/comment/policy` 的 `CommentPolicySnapshot`，admin 关闭匿名评论时前端隐藏匿名/强匿名入口，后端仍以 `IAnonymousCommentPolicyService` fail closed 拒绝匿名写入。旧 `CommentCreateRequest` 只保留 article/reply/content 布局；匿名 scope、public opt-in、language hint、proof token 和 ZK placeholder 必须使用 `CommentCreateV2Request`，不得塞回旧 frame。创建请求的 AEDS frame 上限为 16 KiB，`content` 先 trim，再在内容过滤前校验 `<=1000` 字符且 UTF-8 `<=4096` bytes；目标文章必须是未删除、已发布且发布时间/定时发布时间已到达的公开文章。回复必须引用同文章、未删除、已通过的父评论和根评论，回复展示使用 `reply_to_comment_id` 对应的作者投影，不要求父评论存在非空 `reply_to_user_id`。`POST /api/binary/comment` 先通过 `CommentRiskActionFilter` 预读 AEDS frame 判定 root create / reply 并写 RiskControl action metadata；低风险继续要求 legacy `X-Fsus-Pow-Proof`，中风险要求 `captchaV1` proof 后再校验 PoW，高风险 `queue` 写入待审并把审核原因标记为 `risk_control_queue`，极高风险 `block` 返回 429。内容过滤、地区合规和匿名 nullifier 重复/封禁会写入 comment 风险信号，但不得反查匿名 nullifier 到真实账号，也不得改写匿名 display name 生成规则。

`CommentModerationItemResponse.id` 使用字符串承载 Snowflake ID，避免前端整数精度损失；响应同时包含文章、用户、内容、状态、审核原因、审核人、审核时间、`hitReasons`、`submitRegion`、`submitRegionConfidence`、`blockedRegions`、`regionPolicyVersion`、`regionDecisionReason`、`regionCanPublish`、`regionRequiresManualReview`、`regionHideUntilReviewed`。匿名作者投影字段包括 `authorMode`、`anonymousDisplayLanguage`、`moderationSubjectHash`、`anonymousNullifierHash`、`anonymousScope`、`credentialLevel`、`reputationBucket` 和 `accountAgeBucket`；这些字段用于审核解释、nullifier 封禁和本地队列过滤，不暴露 account id、username、public handle、credential commitment 或 nullifier 原文。启用可选反垃圾模型后，响应追加最新 `modelSignals` 及摘要字段 `modelLabel/modelConfidence/modelPrimaryReason/modelProvider/modelUnavailable`；这些字段只表示风险信号，不包含或代表最终审核动作。`hitReasons` 来自内容过滤器、HTML 风险、密集链接、重复刷屏、人工原因、地区风险标签和 `model:{category}`，用于解释敏感词/垃圾评论/地区策略/模型命中；管理端可按命中原因、blocked region、模型标签、provider 和匿名作者投影做本地队列过滤。审核读取和写入受 `fixed_ip` 限流，并显式要求 `comment.moderate`；该权限只覆盖普通评论审核，不覆盖匿名评论策略、nullifier 封禁或匿名凭证撤销。单条与批量审核需要先完成 `/api/binary/auth/admin/step-up/passkey/begin` / `/api/binary/auth/admin/step-up/passkey/complete`，再把返回的 action=`admin-sensitive` 一次性 proof 放入 `X-Fsus-Mfa-Proof`。proof 缺失、过期、跨 session 或已被消费时返回 `428` + `MFA_PROOF_REQUIRED`；普通用户 MFA proof 不能用于 admin-sensitive 操作。

单条与批量审核都会写入 `comment-moderation` / `comment-moderation-bulk` 审计，服务层用旧 `ModerationStatus` 做 CAS 条件更新并限制状态机转换。`Pending/Rejected/Hidden -> Approved` 会通过 notification stream 推送 `CommentAdded`，但合规记录 `can_publish=false` 的发布地违法评论不能被批准；`Approved -> Rejected/Hidden` 和删除会推送 `CommentRemoved`。评论游标缓存按 article/root/user scope 清理，公开读取的 frame identity 额外包含 viewer region，不再全局清 `CacheTag.Comment`；当 `status=Rejected|Hidden` 且 `banUser(s)=true` 时，服务端会把非 admin、非注销用户更新为封禁状态并同步黑名单缓存。误判恢复使用 `status=Approved`，不会触发封禁联动。

第三方审核模型 Provider 契约由 FsusBlog 定义，Provider 只返回风险类别、置信度、严重度、证据策略和模型元数据，不得返回 `reject_submit`、`geo_block`、`blocked_regions`、发布、隐藏或地区合法性字段。`comment_moderation_signal` 存储 `provider/model/contract_version/label/severity/confidence/primary_reason/needs_second_round/risk_categories/evidence_json/raw_reason/latency_ms/status/error_code/threshold_profile/created_at_utc`；`metadata_json` 保留匿名安全元数据，包括 `author_mode`、`anonymous_display_language`、`moderation_subject_hash`、`anonymous_nullifier_hash`、`anonymous_scope`、`credential_level`、`reputation_bucket`、`account_age_bucket`、`anonymous_comments_enabled` 和 `zk_anonymous_enabled`。外部 provider 不接收真实账号 identity；匿名评论的 `user_id` 可为空，审核 context 仍携带内容、地区、策略和 actor projection。`status=ok|timeout|unavailable|contract_invalid|error` 均 fail-open，不阻断评论进入 Pending。模型 runtime reload 会校验 provider/schema/checksum；失败时保留旧模型快照，rollback 只恢复上一份成功模型快照。模型 runtime 禁用只停止模型风险信号，不禁用硬词库、地区策略或人工审核。HTTP/CLI JSON schema、错误响应和 conformance 工具见 [../moderation/third-party-model-development.md](../moderation/third-party-model-development.md)，运行时配置见 [../moderation.md](../moderation.md)。

硬词库和地区策略由 `configs/moderation/**` 加载为 immutable snapshot。词库只输出 `category/severity/reason/evidence_policy`，地区策略负责把 category 映射为 `submit_action/display_action`；reload 构建失败时保留旧 snapshot 并记录 `lastError`，rollback 只回到上一份成功 snapshot。运行时禁用某个词库只从匹配集合移除该词库，不禁用模型或地区策略；运行时禁用某个地区策略时必须回落到 `GLOBAL` baseline，不进入无审核状态。`GET /api/binary/author/moderation/dictionaries` 返回 `snapshotId/version/checksum/createdAtUtc/lastError`、词库 metadata（id/version/scope/region/category/source/reviewedBy/checksum/termCount）和地区策略 metadata（region/version/inherits/dictionaryIds/checksum/ruleCount）。详见 [../moderation/dictionary-architecture.md](../moderation/dictionary-architecture.md)。

内容导出使用 `ContentExportResponse`：`fileName`、`markdownWithFrontmatter`、`metadata`。frontmatter 固定写入 `fsusFormat: content-export-v1`、`sourceArticleId`、`title`、`summary`、`cover`、`categoryId`、`status`、`scheduledPublishAt`、`tagIds`、`revisionCount` 与 `fsusMetadataJson`；`fsusMetadataJson` 是 base64url 编码的 `ContentExportMetadataResponse`，用于无损恢复分类、标签、封面、文章状态和修订元数据。`GET /api/binary/author/content/export` 返回 `ContentBackupExportResponse`，以 JSON 包含所有文章的导出结果。导入时 `publish=true` 会强制导入为 `Published`，否则按 metadata 的 `status` 恢复；`preserveRevisions=true` 会用导出包中的 revisions 替换导入时生成的初始 revision。

### 订阅

`POST /api/binary/subscriptions` 与 `DELETE /api/binary/subscriptions` 使用 `SiteSubscriptionRequest` / `SiteSubscriptionResponse` AEDS frame，只保存 `SHA256(email)`、`channel`、启用状态和退订时间，不保存明文 email。订阅能力是 RSS/Atom 的增强，不构成关注、点赞、收藏或社交关系链。默认实现不发送邮件或 Web Push；`channel=email` 只记录读者显式偏好，外发增强必须以后续配置开关和退订 smoke 为准。

---

## 参见

- [design.md](design.md) — API 设计哲学与格式约定
- [quick-reference.md](quick-reference.md) — 端点路由速查表
- [schemas-and-errors.md](schemas-and-errors.md) — 错误码枚举与 Binary 帧格式
- `src/shared/Contracts/Outputs/ServerResponseContracts.cs` — 所有 DTO 权威源码
- `src/shared/Contracts/NotificationStream/NotificationStreamContracts.cs` — notification stream 信封权威源码

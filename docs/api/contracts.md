# API 契约文档

本文件是 FsusBlog 所有请求/响应 DTO、通知 WebSocket 信封与 AOT 契约的**完整参考**。
所有定义的权威源码位于 `src/shared/Contracts/` 目录。

> 最近更新：2026-06-28 — 强匿名评论只允许 `anonymous-ticket` + `anonymous` 单次 ticket 链路；ZK root snapshot 增加 root attestation、Grace freshness 和 accumulator profile pathDepth 约束。

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
- [匿名凭证签发契约](#匿名凭证签发契约)

---

## 基础包装结构

运行时主 API 已收敛到 AEDS Binary：`/api/binary/**` 响应使用 AEDS v2 frame，错误也通过 `ApiError` frame 表达，不再通过旧文本响应包装。所有内部应用 API 按 [aeds-only-policy.md](aeds-only-policy.md) 治理；`JsonApiResponse<T>` 只允许出现在 public AOT tooling 等已登记工具边界中，不能作为浏览器运行时 API 暴露。

HTTP 层契约源是 `src/shared/Contracts/Validation/fsusblog.openapi.json`。该 OpenAPI snapshot 描述 method/path/status/content-type/security 与 `x-fsus-*` AEDS metadata；AEDS frame 名称、header magic/version/size 仍以 `src/shared/Contracts/Validation/aeds-protocol.json` 为权威来源。cross-stack matrix、前端 route constants、runtime contract smoke 与 release evidence 通过 `tools/contracts/*` 从这两个源校验或生成。

公开 binary 读模型使用预编码 artifact：匿名 `GET /api/binary/article/{id}.aeds`、`GET /api/binary/article/list/home/{page}/{size}.aeds`、`GET /api/binary/article/list/category/{categoryId}/{page}/{size}.aeds`、`GET /api/binary/article/list/tag/{tagId}/{page}/{size}.aeds`、`GET /api/binary/article/hot/{size}.aeds`、`GET /api/binary/category.aeds`、`GET /api/binary/tag.aeds` 只读取进程内 `PublicHotReadSnapshot` 的完整 AEDS v2 frame。artifact build 阶段同时生成 raw/br/gzip variant；命中时服务端按 `Accept-Encoding` 选择最优 variant，写出 variant-aware `ETag`、`Vary: Accept-Encoding`、可选 `Content-Encoding` 和 `X-Fsus-Frame-Encoding`。`If-None-Match` 匹配当前 variant 时返回 `304 Not Modified`，不发送 frame body。miss/not-ready 返回状态码，不会在请求线程同步查询 PostgreSQL、Redis、IMemoryCache、OutputCache 或文件系统。`GET /api/binary/article/{articleId}/related.aeds` 是动态 AEDS public-read endpoint，沿 `RelatedReadingService` 与 output cache 构建 ArticleRelatedReading frame，不属于 PublicHotRead L0 artifact。admin/private 读取走 `/api/binary/admin/article/**` 和非 `.aeds` taxonomy mutation path，以便草稿、定时、归档、删除状态和分类标签管理。

常规 L1/L2 binary frame cache 同样保存完整预编码 AEDS frame，并通过 `TryGetRawReadonlyAsync` 以 cache-owned `ReadOnlyMemory<byte>` 同步直出；public list/hot/comment/taxonomy 与 admin stats 命中时不得先解码 read model 再重新编码。`SetRawAsync` 仍保存防御性副本，caller 不得保留或写入 cache backing storage；ETag/version identity 和 `ICacheInvalidationDispatcher` 失效语义不变。动态 frame、payload frame 和预编码 frame 的 HTTP body 均只执行一次有效 PipeWriter write/flush；取消、response abort 与 backpressure 继续按 ASP.NET Core transport 语义传播，不新增文本 fallback 或 wire 字段。

L0 `Accept` 语义固定为：空值、`*/*`、`application/octet-stream` 可读取 binary artifact；HTML artifact 只接受空值、`*/*`、`text/html`；其他类型返回 `406`。L0 不承担跨域公开接口，`OPTIONS` 返回 `405`，CORS 仍由常规管线治理。快照状态通过 `/api/ops/health/ready-detail` 的 `runtime.publicHotRead` 暴露 `NotStarted` / `Building` / `Ready` / `Failed`、版本、artifact 计数、最后构建原因和错误；同一对象的 `residency` 暴露 `totalBytes/rawAedsBytes/brotliBytes/gzipBytes/htmlBytes/htmlTemplateBytes/keyIndexBytes/articleBytes/listBytes/taxonomyBytes/htmlResidentBytes/baseBytes/overlayBytes/removedSetBytes/artifactCount/objectCount/arrayCount/lohEligibleArrayCount/lohEligibleArrayBytes`，并携带 `budgets`、`snapshotOverlapBytes`、`retiringSnapshotBytes`、`budgetViolations`、`lifecycleStage`、overlay/removed count、storage/compression policy。author ops response 的 `publicHotReadCounters` 额外暴露 `identityVariant/brotliVariant/gzipVariant` 实际 negotiation 计数，作为下一次 release 调整压缩常驻份额的输入。同一受保护详情的 `release` check 暴露非敏感 `releaseId`、`releaseSlot`、完整 commit SHA、不可变 image ref/digest，且生产环境缺失或不一致时整体 readiness fail closed。所有应用响应统一带非敏感 `X-Fsus-Release-Id` 与 `X-Fsus-Release-Slot`，供 Blue/Green 网关在 loopback 和公网路径核对实际命中的 release；不得在这些 header 中加入 token、密钥、完整配置或用户身份。公开 `/health/ready` body 仍只返回 `status` 与 `checkedAt`。未 Ready 时 fast path 返回 `503` + `Retry-After: 1`。L0 负响应固定 `Cache-Control: no-store`，并带与公开 HTML artifact 相同的静态浏览器安全头：`Content-Security-Policy`、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、`Cross-Origin-Embedder-Policy`、`Cross-Origin-Opener-Policy` 与 `Cross-Origin-Resource-Policy`；`Range` 不支持并返回 `416` + `Accept-Ranges: none`；命中的 `.aeds` artifact 只使用 artifact-level HTTP 预压缩，浏览器 fetch 解压后仍得到原始 AEDS frame，payload 语义与 CRC 不变。

HTML L0 只暴露 `/api/binary/article/html/{pathKey}.html` 诊断/预览路径，真实公开 URL 仍是 `/`、`/article/{id}`、`/category/{id}`、`/tag/{id}` 等 public route。`pathKey` 必须 URL-safe：`article:42` -> `article-42`，`category:7` -> `category-7`，`tag:9` -> `tag-9`；`tag-name:*` 与包含空白、斜杠、非 ASCII 的 routeKey 使用稳定 hash。`PublicHotRead:EnableDiagnosticHeaders` 默认关闭；打开后成功响应才带 `X-Fsus-HotRead-Version`、`X-Fsus-HotRead-Artifact`、`X-Fsus-HotRead-Key`。

所有 HTTP 响应都会带 `X-Fsus-Trace-Id`，值与当前 OpenTelemetry `Activity.TraceId`、`HttpContext.TraceIdentifier`、Serilog/audit `TraceId` 对齐。客户端可用该值报告问题；它不是认证凭据，也不得包含用户身份或请求正文。

未被业务显式捕获的异常只能返回固定、客户端安全的错误消息。`ArgumentException` / malformed request / auth / not-found 等 4xx 映射不得把 `exception.Message`、SQL、配置键、文件路径、后端类型名或 token 片段写入 `ApiError.Message` / `Details`；Development 500 诊断输出仅限本地开发，不构成运行时 API 契约。生产和共享环境的 binary/json 错误响应只暴露稳定错误码、HTTP 状态、固定文案和 trace id。

### Public integrity verification manifests

Integrity verification endpoints are public JSON sidecars, not `/api/binary/**` runtime endpoints. They exist so external verifiers can read public keys, publish proofs, local transparency log heads, and Merkle checkpoints without depending on internal AEDS frames.

| Method | Path | Content-Type | Cache | 说明 |
|--------|------|--------------|-------|------|
| GET | `/integrity/keys.json` | `application/json; charset=utf-8` | short public manifest cache | Public signing key registry; never exposes private keys. |
| GET | `/integrity/article/{articleId}` | `application/json; charset=utf-8` | immutable for ready/superseded proof; `no-store` otherwise | Current public publish proof for an article. |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}` | `application/json; charset=utf-8` | same as proof | Publish proof for one public article revision number. |
| GET | `/integrity/article/{articleId}/rights` | `application/json; charset=utf-8` | immutable for ready/superseded proof; `no-store` otherwise | Current public Rights V3 proof for an article. |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}/rights` | `application/json; charset=utf-8` | same as proof | Rights V3 proof for one public article revision number. |
| GET | `/integrity/revisions/{articleRevisionId}` | `application/json; charset=utf-8` | same as proof | Publish proof by persisted `ArticleRevision.Id`. |
| GET | `/integrity/checkpoints/latest` | `application/json; charset=utf-8` | short public manifest cache | Latest signed Merkle checkpoint. |
| GET | `/integrity/checkpoints/{date}` | `application/json; charset=utf-8` | short public manifest cache | Daily checkpoint using `yyyy-MM-dd`. |
| GET | `/integrity/log/head` | `application/json; charset=utf-8` | short public manifest cache | Current transparency log head. |

Ready and superseded publish proof manifests contain `articleId`, `articleRevisionId`, `revisionNo`, canonical hash, artifact digests, signing key id, signature, and transparency log pointer. Ready and superseded Rights V3 proof manifests contain `articleId`, `articleRevisionId`, `revisionNo`, `articleRightsSnapshotId`, `publishProofId`, `rightsPolicyHash`, `contentCanonicalHash`, signing key id, signature, and transparency log pointer. Pending, failed, retrying, not-public, missing, private, hidden, or deleted cases expose only stable low-sensitive status or an error manifest; they must not expose stack traces, failure details, admin principal context, draft content, user data, IP, user agent, device, session, token, private key material, comments, private messages, or secret material. See [Public Verification API](../integrity/public-verification-api.md) for schema and manual verification.

### AEDS 通用响应 POD

源码：`src/shared/Contracts/Models/CommonPods.cs`

| FrameType | POD | 说明 |
|-----------|-----|------|
| `EmptySuccess` (`240`) | `EmptySuccessPod` | 无数据成功响应，`Ok = 1` |
| `MutationId` (`241`) | `MutationIdPod` | 写操作返回的 `int64 Id` |
| `ApiError` (`251`) | `ApiErrorPod` | Binary 错误响应，包含 `Code`、`Category`、`HttpStatus`、`Message`、`Details`、`TraceId`；非业务错误不得回显内部 exception/message |

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

compact record 内所有文本字段均为 `Utf8SliceRef`，指向当前 payload 的共享 blob。`ArticleList` 的 76B record 在原 56B 公开字段后追加 `status:int32`、`scheduledPublishAtUnixMs:int64`、`publishedAtUnixMs:int64`；`status` 值固定为 `Draft=0`、`Scheduled=1`、`Published=2`、`Archived=3`、`Deleted=4`，公开可见性以 [design.md#文章状态枚举](design.md#文章状态枚举) 为准。写请求、Passkey、上传和复杂评论游标仍使用 v2 header 包裹的 POD + blob 结构；`ArticleDetail` 外层仍是 AEDS v2 frame，但 payload 自身使用 `ARD3` V3 envelope，不再允许旧 detail tail payload。

payload 字典化的第一阶段采用兼容 layout：ArticleList/ArticleSearch/Conversation 等重复文本均落到单个 shared UTF-8 blob，records 只保存 `Utf8SliceRef`；前端 ArticlePage decode 不再创建 object records 数组，也不使用 `tagRecords.slice(...)` 复制 tag range。后续若引入 `ArticleListV4` category/tag dictionary，必须保持现有 frame type 的 downgrade 路径和 golden fixture。

搜索运行时拒绝超过 128 字符的 keyword，避免在 DB fallback、runtime token hashing 和 snippet 构建前处理超大输入。搜索索引构建对正文 tokenization 只处理前 256 KiB，CJK 连续 segment 超过 4096 rune 时退回 bounded unigram fallback。

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

支持的 `SecurityChallengeKind` wire name 为：`sha256PowV1`、`argon2idPoSpaceV1`、`captchaV1`、`humanReadProofV1`、`passkeyStepUpV1`、`adminPasskeyStepUpV1`、`recoveryKeyProofV1`、`anonymousCredentialProofV1`、`zkAnonymousCommentProofV1`、`perceptionTextTaskV2`、`perceptionCharacterV2`、`perceptionLocalizationV2`、`perceptionMicroInteractionV2`。

RiskControl 风险事件使用稳定 source wire value 与 reason enum 名称做跨端归因。旧 reason `VerifiedCrawler` 到 `CommentNullifierAbuse` 的枚举数值保持不变，新生产 challenge reason 只能追加：`CaptchaInvalid`、`CaptchaReplay`、`CaptchaSolveTooFast`、`DeviceFingerprintMissing`、`DeviceFingerprintChanged`、`RegionPolicyHit`、`CommentSpamPatternHit`、`AnonymousNullifierAbuse`、`AuthFailureBurst`、`PasskeyAssertionFailure`、`AdminStepUpRequired`、`AdminStepUpFailed`、`ChallengeExpired`、`ChallengeKindMismatch`、`ChallengeSignatureInvalid`。稳定 source wire value 包括 `anti-crawler`、`auth`、`rate-limiter`、`pow`、`human-read-proof`、`passkey`、`public-read`、`pospace`、`risk-control`、`captcha`、`device-fingerprint`、`region-policy`、`comment-governance` 和 `admin-step-up`。未知 reason 枚举值进入日志/事件时保留原始数值字符串，避免老节点读取新 reason 时失败。

challenge 签发与验证审计由 `security_challenge` 和 `security_challenge_attempt` 持久化，Redis 只作为一次性消费 / 热路径缓存。持久化 metadata 对应 assignment 字段和策略上下文：kind、algorithm、action、routeKey、subjectHash、clientIpHash、deviceFpHash、policyVersion、payloadHash、traceId、traceparent、issued/expires 时间，以及 attempt outcome。payload / proof 原文不得进入持久化表；状态只允许 `issued | verified | expired | replayed | failed | revoked`。`verified`、`revoked`、`expired` 是终态；后续失败、重放或过期 attempt 可以审计落表，但不得把主 challenge 状态降级。

成功完成 challenge provider 校验后，统一 proof token 使用 `X-Fsus-Challenge-Proof` header 传递。该 token 是 opaque 值；Redis `SecurityChallengeProof` cache 保存一次性 claims，并绑定 `challengeId`、`kind`、`action`、`routeKey`、`subjectHash`、`clientIpHash`、`deviceFpHash`、`issuedAt`、`expiresAt`、`nonce` 和 `policyVersion`。服务端消费时必须先执行 consume-once，再校验绑定字段；replay / Redis miss、action 或 route mismatch、IP/device mismatch、过期 proof 都不得进入业务写入，并必须写 challenge attempt。该 header 不替代 `X-Fsus-Mfa-Proof`、legacy `X-Fsus-Pow-Proof` 或 HumanReadProof 阅读计数 proof。

challenge provider 统一通过 `ISecurityChallengeProvider` 接入，wire kind 与上表 `SecurityChallengeKind` 一致。provider 必须先持久化 challenge，再返回可下发 assignment；`SecurityChallengeOrchestrator` 根据 `RiskDecision.RequiredChallenges` 调用 provider，可返回单个或多个 `SecurityChallengeAssignment`，并可携带按 `challengeId` 分组的 provider payload 供 binary response 编码；provider missing、provider failure、assignment 无效或 proof mint failure 必须返回可观测错误并 fail closed，不得落入具体业务 endpoint 的 fallback 分支。

`sha256PowV1` provider 的 issue payload 只包含 legacy PoW challenge 必需字段：`salt`、`difficulty`、`timestamp`、`signature`。`signature` 是无 padding Base64Url HMAC，不能使用旧标准 Base64 `+`、`/`、`=` 兼容格式。verify payload 必须包含 `proof`，其值为旧 `X-Fsus-Pow-Proof` 使用的 Base64 FPOW binary proof；服务端复用同一解析器、`IPowService.VerifyAsync` 和 `AdaptivePowGovernor` difficulty 裁决。该 provider 不引入公开 JSON fallback，不改变现有 FPOW wire format，也不删除 `GET /api/binary/auth/pow-challenge` 或 `X-Fsus-Pow-Proof` legacy 路径。

`captchaV1` provider 使用 `fsu.captcha/chebyshev-noise@v1` wire algorithm。issue payload 包含 `algorithm`、`polynomialSeedHex`、`noiseSeedHex`、`seedPayloadBase64`、`signatureHex`、`gridWidth`、`gridHeight`、`distortionLevel`、`powDifficultyBits`、`issuedAtUnixMs` 和 `expiresAtUnixMs`；服务端不生成 PNG、像素或图片字段，只下发可由客户端渲染的 seed 与参数。`seedPayloadBase64` 是无 padding Base64Url，绑定 challengeId、action、routeKey、subject/client/device hash、policyVersion、seed、参数和时间窗口，不接受旧标准 Base64 `+`、`/`、`=` 兼容格式；`signatureHex` 为服务端 HMAC-SHA256 签名，签名 key 不得为空、不得使用仓库占位值或已知开发 key。provider 持久化 payload hash 使用字段名排序后的 length-prefixed canonical encoding，不得用分隔符拼接字段。verify payload 必须回传 issue payload 字段，并追加 `answerText`、`responseTokenHex`、`nonceHex`、`solveDurationMs`。服务端先验证签名和绑定字段，再通过 `SecurityCaptchaChallenge` cache 一次性消费 challenge，随后派生期望答案、校验 nonce 前导零证明、校验 response token 和 solve duration。错误答案、签名/seed 篡改、token/nonce 错误写 `CaptchaInvalid` 风险 detail；重放写 `CaptchaReplay`；过快 / 过慢分别写 `CaptchaSolveTooFast` / `CaptchaSolveTooSlow`。默认 V2 policy 中，`auth.login` 仅是 legacy reserved action，不再对应生产用户侧 password endpoint；`recovery-key.verify` 从 0 风险分起要求 `captchaV1` proof，并在高风险时升级到组合 challenge。

`perceptionTextTaskV2`、`perceptionCharacterV2`、`perceptionLocalizationV2` 与 `perceptionMicroInteractionV2` provider 使用固定 wire algorithm `fsu.challenge/perception-sealed@v2`，并使用独立 AEDS frame，不复用 V1 纯字符验证码 payload。issue payload 为 `PerceptionSealedChallengeV2` (`184`)：`assignment`、`algorithm`、`taskKind`、`renderRecipeBase64`、`recipeHashHex`、`sealedTokenBase64`、`signatureHex`、`gridWidth`、`gridHeight`、`family`、`variant`、`issuedAtUnixMs` 和 `expiresAtUnixMs`。`taskKind` 固定映射为 `character`、`localization` 或 `microInteraction`；`perceptionTextTaskV2` 是 `character` task 的 policy-facing wire kind，sealed token 仍绑定 task/action/route/subject/client/device/policy/recipe。`algorithm` 必须逐字等于 `fsu.challenge/perception-sealed@v2`。`renderRecipeBase64` 只承载渲染 recipe，`recipeHashHex` 绑定 canonical recipe bytes，`sealedTokenBase64` 与 `signatureHex` 只承载服务端 sealed/binding material；公开 issue payload 不包含期望文本、语义解码 ID 或字符 ID 字段。

perception verify payload 为 `PerceptionSealedResultV2` (`185`)：`assignment`、`algorithm`、`taskKind`、`payloadKind`、`responsePayloadBase64`、`recipeHashHex`、`sealedTokenBase64`、`signatureHex`、`issuedAtUnixMs` 和 `expiresAtUnixMs`。`payloadKind` 只允许 `character`、`coordinates` 或 `steps`，并分别对应 Character、Localization、MicroInteraction task；响应内容统一放入 `responsePayloadBase64`，以便后续 provider 在 sealed token 校验后解释，不在公共 schema 中展开语义字段。该契约只登记 AEDS payload 与 kind；不实现 AEAD、renderer、provider、Redis gate 或业务 endpoint wiring，也不新增公开 JSON fallback。

perception-sealed@v2 payload 是 sealed perception challenge 契约，不是普通图片验证码契约。issue payload 禁止出现 `answerText`、`expectedAnswer`、`expectedX`、`expectedY`、`expectedStep`、`labelId`、`semanticId`、`objectClass`、`clientIp`、`deviceFp`、`userId`、raw UA、`proofToken`、`mfaProof`、admin session 或任何可直接推导解答的字段；verify payload 只能携带公共绑定字段、sealed token/signature、recipe hash、`solveDurationMs` 和按 task kind 编码后的响应。服务端 issue 路径不得生成 PNG、不得 rasterize、不得把解答真相写 PostgreSQL/Redis；verify 路径必须先解封 AEAD，再校验 assignment/action/route/subject/client/device/policy/recipe 绑定，最后通过 Redis attempt gate + consume-once 后才允许 orchestrator mint `X-Fsus-Challenge-Proof`。

perception-sealed@v2 的配置名必须与运行时保持一致：AEAD key rotation 只使用 `Security:PerceptionSealedToken:CurrentKeyVersion` 与 `Security:PerceptionSealedToken:Keys:{version}`，本地、测试和生产均不得回退到 `Security:PerceptionV2:SigningKey` 或临时派生 key；固定测试任务只允许通过 `Security:PerceptionV2:TextTask:FixedText`、`Security:PerceptionV2:Localization:FixedX`、`Security:PerceptionV2:Localization:FixedY`、`Security:PerceptionV2:MicroInteraction:FixedSteps` 注入；micro-interaction 子系统开关为 `Security:PerceptionV2:MicroInteraction:Mode`。RiskControl rollout 不新增单独公开 JSON 配置面，只通过 `RiskControlPolicyUpdateRequest(globalMode?, captchaV1Enabled?, poSpaceV1Enabled?, publicReadChallengeEnabled?, commentRiskControlEnabled?, authRiskControlEnabled?, strictRiskMultiplierPercent?, reason?)` 与 `/api/binary/admin/security/risk-control/options|rollback` 调整。

perception-sealed@v2 运行时 metrics 使用 `fsus.security.challenge.v2.*` 前缀：`issued.count`、`verified.count`、`failed.count`、`replayed.count`、`solve.duration`、`payload.bytes`、`verify.duration` 和 `task.kind.count`。所有记录路径必须把 metrics 写入视为 best-effort，collector/listener 失败不得改变 challenge verify 结果。受保护 readiness detail 的 `riskControl` 区块同时暴露 `perceptionAeadKey`、`perceptionMode` 和 `perceptionPerformanceBudget`；预算快照包含 issue p99、verify p99、payload p95、client render p95、对应阈值和 `warnings`，用于 rollout gate 告警而不替代业务 proof 消费。

perception-sealed@v2 的验证矩阵：

| 输入 / 依赖 | 预期行为 |
|-------------|----------|
| `algorithm` 不是 `fsu.challenge/perception-sealed@v2` | AEDS `ApiError`，fail closed |
| `taskKind` / `payloadKind` 不匹配 | AEDS `ApiError`，fail closed |
| sealed token keyVersion 未配置、AAD mismatch、密文篡改或 token 过期 | AEDS `ApiError`，fail closed |
| challengeId、action、routeKey、subjectHash、clientIpHash、deviceFpHash、policyVersion 或 recipeHash 不匹配 | AEDS `ApiError`，fail closed，不进入业务 endpoint |
| Redis `INCR` attempt gate 失败、attempt exceeded、Redis `SETNX` consume-once 失败或 replay | AEDS `ApiError`，fail closed；不得把 Postgres audit 当作消费真相 |
| PostgreSQL audit / aggregation 写入失败 | 不作为 verify 放行依据；应以 structured log、readiness/admin surface 暴露，不能写入 payload 原文或 proof 原文 |
| HumanReadProof proof 用于 `comment.*`、`auth.*`、`admin.*` | required kind mismatch，返回 428，不消费 proof |
| `adminPasskeyStepUpV1` proof 尝试替代 `X-Fsus-Mfa-Proof` | 返回 428 / `MFA_PROOF_REQUIRED`，不执行 admin-sensitive 写入 |

上线顺序固定为 `observe -> text-task enforce -> localization enforce -> micro-interaction optional -> strict/lockdown`。回滚时优先把 `globalMode` 调回 `observe`，或关闭对应 action 的 `publicReadChallengeEnabled`、`commentRiskControlEnabled`、`authRiskControlEnabled`；PoSpace 只能通过 `poSpaceV1Enabled` 与 `Security:PoSpaceV1:Mode` 进入 notification / high-risk 分支；AdminPasskeyStepUp 与 `X-Fsus-Mfa-Proof` 始终保留独立授权边界。

`argon2idPoSpaceV1` provider 使用 `fsu.pospace/argon2id@v1` wire algorithm，默认 `Security:PoSpaceV1:Mode=disabled`，只有策略显式 enable 且 RiskDecision 选择该 kind 时才可签发。issue payload 包含 `algorithm`、`saltHex`、`memoryKib`、`iterations`、`lanes` 和 `targetDurationMs`；服务端约束 `memoryKib=19456..65536`、移动端最大 `8192`、`iterations=2..6`、`lanes=1..4`、`targetDurationMs=100..5000`。verify payload 必须回传 issue payload 字段，并追加 `nonceHex` 和 `proofHex`。服务端通过 `SecurityPoSpaceChallenge` cache 一次性消费 challenge，使用 challengeId/action/routeKey/subject/client/device/policyVersion/nonce 作为 Argon2id material 重新派生 proof；参数越界、payload 错误、proof mismatch 或 replay 均 fail closed 并写 `SecurityChallengeRejected` 风险事件。移动 UA 或 disabled policy 会由 RiskDecision 降级到 `captchaV1`，不得签发 PoSpace。

`humanReadProofV1` provider 使用 `fsu.human-read-proof@v1` wire algorithm，且只允许 `action=public.read`。issue payload 包含 `algorithm`、`token`、`scope`、`routeKey`、`articleId`、`minDwellMs`、`issuedAtUnixMs` 和 `expiresAtUnixMs`；持久化层只保存 payload hash，不保存 token 原文。verify payload 必须提交 `token`、`scope`、`routeKey`、`articleId` 和 `dwellMs`，服务端复用 HumanReadProof submit 绑定校验；成功只签发绑定 public-read action / route / IP / device 的统一 proof token，并额外写 `ReadProofAccepted` 负分风险信号以降低后续 public-read 风险。`comment.*`、`auth.*`、`admin.*` 或任何非 public-read action 使用该 kind 都必须 fail closed；`RequiresRiskControlFilter` 也必须在 required kind 不匹配时返回 428，不得消费 HumanReadProof proof 或进入写操作 handler。

`passkeyStepUpV1` provider 使用 `fsu.passkey-step-up@v1` wire algorithm，只接受普通已认证用户，不接受 `identity_kind=admin_principal`。issue payload 包含 `algorithm`、`challengeToken` 和 `optionsJson`，其中 `optionsJson` 为当前用户 allowCredentials 约束后的 `PasskeyLoginBeginCoreModel` JSON；verify payload 必须包含 `assertionJson`，其内容为 `PasskeyLoginCompleteCoreModel` JSON。verify 成功后 provider 不直接授权业务请求，只由 orchestrator 签发统一 `X-Fsus-Challenge-Proof`。普通账号敏感凭据变更不得用该 RiskControl proof 替代 `X-Fsus-Mfa-Proof`；必须走 `/api/binary/auth/step-up/passkey/begin|complete` 换取 action 绑定的一次性 `MfaChallengeResult.proofToken`。该业务 step-up 通道受 `Auth:PasskeyStepUp:Enabled` 控制，关闭时返回 503 + `PASSKEY_STEP_UP_DISABLED`，且不签发 challenge 或 proof。

`adminPasskeyStepUpV1` provider 使用 `fsu.admin-passkey-step-up@v1` wire algorithm，只接受 admin principal session。issue payload 同样包含 `algorithm`、`challengeToken` 和 `optionsJson`，verify payload 同样使用 `assertionJson`。该 provider 复用 admin Passkey step-up challenge 与 WebAuthn 校验，但只执行 verify-only 路径，不 mint、consume 或返回 `X-Fsus-Mfa-Proof`，也不写 `SecurityMfaProof` cache。admin-sensitive 作者/安全写操作仍必须先通过 `/api/binary/auth/admin/step-up/passkey/begin|complete` 获取 action=`admin-sensitive` 的一次性 `X-Fsus-Mfa-Proof`；`adminPasskeyStepUpV1` 换得的普通 `X-Fsus-Challenge-Proof` 不能替代它。

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
| `providerPayloads` | array | 按 `challengeId` 返回 provider payload JSON；`sha256PowV1` 包含 `salt`、`difficulty`、`timestamp`、Base64Url `signature` |

`SecurityChallengeVerifyRequest` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `challengeId` | string | issue response 中的 assignment id；必填 |
| `kind` | enum | `SecurityChallengeKind`；未知或未支持 kind fail closed |
| `action` | string | 必须与 issue / 后续业务 endpoint 绑定的 action 一致 |
| `routeKey` | string | 必须与 issue / 后续业务 endpoint 绑定的 route key 一致 |
| `payload` | string | provider payload JSON；`sha256PowV1` 必须包含 Base64 FPOW `proof`，`captchaV1` 必须包含 issue payload 字段加 `answerText`、`responseTokenHex`、`nonceHex`、`solveDurationMs`，`passkeyStepUpV1` / `adminPasskeyStepUpV1` 必须包含 `assertionJson` |

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

受 `RequiresRiskControlFilter` 保护的 endpoint 必须具备 `RiskActionEndpointMetadata`，服务端用 action、routeKey、subjectHash、clientIpHash、deviceFpHash 和 policyVersion 消费统一 proof。RiskControl actor context 不能混用身份平面：普通账号 actor 可携带 `UserId/SessionId`，AdminPrincipal actor 只能携带 `AdminPrincipalId/AdminSessionId` 且 `UserId/SessionId` 必须为 null；subject binding 对 AdminPrincipal 只使用 admin id + admin session。客户端提交已签发 proof 时必须同时发送 `X-Fsus-Challenge-Proof`、`X-Fsus-Challenge-Id`、`X-Fsus-Challenge-Kind`；缺 proof、proof 重放 / Redis miss、action 或 route mismatch、IP/device mismatch 均返回 428，block / throttle 类裁决返回 429。`queue` 裁决只允许业务端显式读取 `RiskControlDecisionContext` 后继续执行；评论创建会把 queue 映射为待审队列并记录 `risk_control_queue`，其他未接入 queue 语义的写入口不得默默放行。当前高价值入口使用的 action 为：`POST /api/binary/comment` root create -> `comment.create`，同一路径 reply payload -> `comment.reply`，`POST /api/binary/auth/passkey/login/begin` -> `auth.passkey.begin`，`POST /api/binary/auth/passkey/login/complete` -> `auth.passkey.complete`，`POST /api/binary/auth/recovery-key/verify` -> `recovery-key.verify`，匿名 `GET /api/notifications/stream/preflight` / WebSocket handshake -> `notification.subscribe`。旧 `auth.login` action 仅保留给 legacy migration/test policy，不绑定生产用户侧 password endpoint。旧 `RequiresPowFilter` endpoint 仍使用 `X-Fsus-Pow-Proof`；同时保留 PoW 的 auth/comment endpoint 需要同时提交 legacy PoW proof 与 RiskControl proof，notification stream 继续兼容 legacy `pow` query proof。

| FrameType | 值 | POD | 用途 |
|-----------|----|-----|------|
| `SecurityChallengeAssignment` | 171 | `SecurityChallengeAssignmentPod` | 单个 challenge assignment |
| `SecurityChallengeEnvelope` | 172 | `SecurityChallengeEnvelopePod` + `SecurityChallengeAssignmentPod[]` | 一次裁决返回的 challenge assignment 集合，最多 8 个 |
| `SecurityChallengeIssueRequest` | 173 | `SecurityChallengeIssueRequestPod` + UTF-8 blob | RiskControl challenge 签发请求 |
| `SecurityChallengeVerifyRequest` | 174 | `SecurityChallengeVerifyRequestPod` + UTF-8 blob | RiskControl challenge provider proof 验证请求 |
| `SecurityChallengeIssueResponse` | 175 | `SecurityChallengeIssueResponsePod` + assignment / provider payload records + UTF-8 blob | RiskControl challenge 签发响应 |
| `SecurityChallengeVerifyResponse` | 176 | `SecurityChallengeVerifyResponsePod` + UTF-8 blob | 一次性 proof token 响应 |
| `PerceptionSealedChallengeV2` | 184 | `PerceptionSealedChallengeV2Pod` + UTF-8 blob | perception-sealed@v2 issue payload；三类 task kind 共用 |
| `PerceptionSealedResultV2` | 185 | `PerceptionSealedResultV2Pod` + UTF-8 blob | perception-sealed@v2 verify payload；三类 response payload 共用 |
| `AnonymousCredentialRevocationWitnessRequest` | 186 | `AnonymousCredentialRevocationWitnessRequestPod` + shared blob | 强匿名凭证撤销 non-membership witness 请求；公开 root/issuer/handle metadata |
| `AnonymousCredentialRevocationWitnessResponse` | 187 | `AnonymousCredentialRevocationWitnessResponsePod` + shared blob | circuit-friendly sparse Merkle non-membership witness 响应 |

### 匿名凭证签发契约

`POST /api/binary/anonymous-credential/issue` 是强匿名评论凭证领取入口。该端点要求 `RequireAnonymousAccountPrincipal()`、`identity_kind=anonymous_account` 的普通匿名账号会话、`fixed_ip` 限流、`Content-Type: application/octet-stream`、`Accept: application/octet-stream`，并声明 `RequireNoStoreResponse()`；AdminPrincipal、缺失 `identity_kind`、账号不存在/已删除或 `anonymous_credential_status != active` 一律在读取请求体和调用 issuer 前拒绝并写高价值安全审计。失败统一返回 AEDS `ApiError` frame。该端点只完成“登录态证明领取资格”的最小闭环，不验证 ZK proof、不生成匿名评论 ticket，也不接入评论发布路径。

请求 frame 为 `AnonymousCredentialIssueRequest` (`177`)：`credentialEpoch`、`circuitNumericId`、`publicInputLayoutVersion`、`circuitId`、`credentialLevel`、`credentialRequest`、`clientNonce`。服务端以当前账号的 `anonymous_credential_level/status` 和 `sys_user.Status/deleted_at` 判定资格；被封禁账号是否允许领取必须通过 `AnonymousCredentialIssuer:AllowBannedAccountIssuance` 显式配置，默认配置为 `false`。请求 frame 上限为 16 KiB，`credentialRequest` 默认最大 8192 bytes，`clientNonce` 默认最大 128 bytes。

响应 frame 为 `AnonymousCredentialIssueResponse` (`178`)：返回当前 `credentialEpoch`、`rootExpiresAtUnixMs`、circuit metadata、`issuerPublicKeyId` 与 circuit-native `issuerSignature`。`issuerPublicKeyId` 必须来自显式生产配置，空值、`issuer-key:local` 或仓库占位值均 fail closed。响应不返回 SHA256 commitment 或可逆身份字段；频率限制以 `anonymous_credential_issuance_audit(subject_hash, epoch)` 唯一约束作为真源，`subject_hash` 是服务端 HMAC 盲化账号 subject，不是 raw `user_id`；重复领取返回 `409` + `anonymous_credential_issue_rate_limited`。

`anonymous_credential_issuance_audit` 只保存不可逆审计字段：`subject_hash`、`epoch`、`status`、`created_at_utc`、`trace_id`。`subject_hash` 只能由独立 `AnonymousCredentialIssuer:SubjectHashPepper` HMAC 派生，缺失时 fail closed，不得回退到 `Jwt:SecretKey` 或硬编码开发字面量。该表不得包含 raw `user_id`、`request_hash`、`credential_commitment`、nullifier、proof witness、credential secret、credential request、issuer signature 或 issuer response 原文；每日 retention cleanup 会删除超过 90 天的签发审计行。高价值审计事件 `security.anonymous_credential.issued` 只记录签发 `status`、`epoch`、trace id 和短 subject hash，不记录 raw account id、credential request、issuer response、signature、request hash 或 credential commitment。

`anonymous_credential` 仅作为 account-bound credential metadata 表，字段语义限定为 nullable `account_id`、不可逆 `account_binding_hash`、`credential_type=account_bound`、`credential_level/status/revoked_at_utc`；它不得保存 `zk_commitment`、nullifier、proof witness、credential secret 或可反查强匿名凭据的 commitment。强匿名/ZK material 只通过 `anonymous_credential_root`、`anonymous_credential_epoch`、`anonymous_credential_revocation` 与 ticket/proof 链路处理。

`GET /api/binary/anonymous-credential/root` 与 `GET /api/binary/anonymous-credential/circuit` 是公开 root/circuit metadata 读取端点：匿名访问、`public_read` 限流、只接受 `Accept: application/octet-stream`，成功返回 `AnonymousCredentialRootSnapshot` (`179`)，失败返回 AEDS `ApiError` + `anonymous_root_unavailable`。端点不得读取 Cookie、session、Authorization 或当前账号；服务端通过 `IAnonymousCredentialRootService` 使用短 TTL immutable snapshot cache 和 negative cache 读取 `anonymous_credential_root`，直到显式 invalidation 或 TTL 过期才回源。

`AnonymousCredentialRootSnapshot` (`179`) 返回字段为 `credentialRoot`、`revocationRoot`、`issuerPublicKeyHash`、`credentialEpoch`、`rootExpiresAtUnixMs`、`rootGraceExpiresAtUnixMs`、`circuitNumericId`、`circuitId`、`verifyingKeyHash`、`publicInputLayoutVersion`、`zkAnonymousEnabled`、`verifierConfigured` 和 `circuitMetadata`。`anonymous_credential_root` 只保存公开 root/circuit 元数据：`epoch`、`root_hash`、`revocation_root_hash`、`issuer_public_key_hash`、`circuit_id`、`circuit_numeric_id`、`verifying_key_hash`、`public_input_layout_version`、`circuit_metadata`、`created_at_utc`、`expires_at_utc`、`root_grace_expires_at_utc`、`status`；不得包含 user/session/cookie/account 映射。

`POST /api/binary/anonymous-credential/revocation-witness` 是公开强匿名撤销 non-membership witness 读取端点：匿名访问、`public_read` 限流、`RequireNoStoreResponse()`、`RequireStrongAnonymousRequest()`，要求 `Content-Type` 与 `Accept` 都为 `application/octet-stream`。请求 frame 为 `AnonymousCredentialRevocationWitnessRequest` (`186`)，包含 `credentialEpoch`、`circuitNumericId`、`publicInputLayoutVersion`、`circuitId`、`issuerPublicKeyHash`、`revocationRoot` 与不可逆 `revocationHandleHash`；响应 frame 为 `AnonymousCredentialRevocationWitnessResponse` (`187`)，包含 `algorithmId=circuit-friendly-non-membership.v1`、`pathDepth=128`、`leafKey`、`witnessHash` 与 128 个 32B sibling hashes。端点只读取公开 root snapshot 与当前 epoch 的 revoked handle hash 集合，不读取 Cookie/session/Authorization/current user；metadata 未标记 `productionZkReady=true` 或 root/request 不匹配时 fail closed，不伪造 Groth16 proof 或声明 circuit 已完成。

ZK 评论 proof verifier 的运行时配置位于 `AnonymousIdentity:ZkVerifier:*`：`Enabled`、`CircuitId`、`VerifyingKeyHash`、`PublicInputLayoutVersion`、`MaxProofBytes`、`Backend`，可选 `BackendTimeoutMs` 与 `MaxConcurrentVerifications`。`verifierConfigured=true` 只表示上述配置完整且对应 backend adapter 可用；配置关闭、不完整或 backend 不可用时仍按 `DisabledZkProofVerifier`/`verifier_unavailable` fail closed。生产 verifier 在 backend 调用前校验 `comment.create` action、circuit id、verifying key hash、public input layout version、credential epoch、credential root + revocation root + issuer public key hash 的 active-or-grace snapshot 三元绑定、proof byte 上限以及 nullifier/credential commitment/issuer public key hash/credential root/revocation root 均为固定 64 字符 hex token；所有 reject、timeout、取消或异常对外统一为 AEDS `invalid_proof`，不得把 proof、witness、credential secret 或 backend 细节写入响应或日志。

ZK-Prod feature flag 位于 `AnonymousIdentity:ZkProd:*`，生产 compose 默认 `Enabled=true`，并要求缺真实材料时 fail closed。生产开启态必须显式满足 `RequireNativeVerifier=true`、`RequireCredential=true`、`RequireTrustedSetupVerified=true`、`VerifierBackend=native_groth16`、`TrustedSetupVerified=true`、`CredentialReady=true`、64-hex `verifyingKeyHash` 已配置且运行态 `IZkProofVerifier.IsConfigured=true`、trusted setup manifest 与 verifying-key manifest 均声明 `production_usable=true` 且绑定同一个 verifying key hash、anonymous credential root snapshot ready。root readiness 必须同时具备 credential root、revocation accumulator root 与 issuer public key hash；任一为空或过 grace 窗口都 fail closed。Production 下 `AllowDevVerifier=true` 或 `FallbackToLegacyAnonymous=true` 一律启动失败；`ZkProd:Enabled=true` 时任一 native verifier、trusted setup、circuit-native credential 或 root readiness 缺失也启动失败。当前 `comment.v2` checkout 的 R1CS、phase transcript、proving key、verifying key 和 WASM bundle 是 KB-scale deterministic placeholders，`security/zk/comment-v2-trusted-setup.manifest.json` 与 `config/zk/anonymous-comment-v2-verifying-key.manifest.json` 必须保持 `production_usable=false`，直到 #552 以真实 ceremony artifacts 和 release evidence 替换。没有真实 trusted setup、issuer private/public key、issuer public key root binding、root snapshot 或 release evidence 时，运行态必须保持 fail closed。

### Passkey AEDS frames

Passkey/WebAuthn 载荷不再以文本字符串传输。服务端返回 AEDS POD，前端 adapter 将 POD 还原为浏览器 WebAuthn API 需要的选项对象；浏览器返回的 attestation/assertion 由前端编码为二进制 request POD。

匿名身份模式下，`PasskeyRegisterBegin` 的 WebAuthn `user.id` 使用 `sys_user.passkey_user_handle` 中持久化的 32B 随机 Base64Url 账号句柄；同一账号多次注册与 Recovery Key 重绑必须复用该句柄，不得由数据库 id、username 或 public handle 推导。`PasskeyRegisterBeginPod` 内部字段命名为 `accountHandle`、`accountName`、`accountDisplayName`，前端 adapter 只在交给浏览器 WebAuthn API 时映射成 `user.id`、`user.name`、`user.displayName`。`user.name` 固定为 `fsus-anonymous-account`，不包含内部 id；`user.displayName` 仅在用户显式设置 `public_handle` 时使用公开 handle，否则使用通用 `Anonymous account`。注册与 discoverable login 仍复用同一套 `passkey_credential` 表、challenge cache、sign-count 和 last-used 更新路径，不新增平行 Passkey 栈；`passkey_credential` 的账号外键最终态是 `account_id` + `idx_passkey_account_id`，不得继续暴露或依赖旧 `user_id` / `idx_passkey_user_id` 命名。登录与 step-up assertion 的 user handle owner callback 只按账号存储句柄校验。匿名模式下删除最后一枚 Passkey 需要已启用 Recovery Key / recovery path；否则服务端返回 `409` + AEDS `ApiError`，错误消息为 `CannotRemoveLastCredentialWithoutRecovery`。Passkey login begin/complete 受 RiskControl 保护；assertion 失败写 `PasskeyAssertionFailed` 正分风险信号，assertion 成功写 `PasskeyAssertionAccepted` 负分风险信号并以 `mfaVerified=true` 完成登录，不再额外要求普通 TOTP MFA。

Passkey 删除与凭据友好名称更新是账号安全凭据变更，必须通过统一 user security step-up。生产 binary endpoint 只从 `X-Fsus-Mfa-Proof` 读取一次性 proof，proof 必须绑定对应 action：删除为 `passkey.delete`，友好名称更新为 `passkey.credential-name.update`，且服务端一次性消费。普通账号可先调用 `/api/binary/auth/step-up/passkey/begin` 提交对应 action，再调用 `/api/binary/auth/step-up/passkey/complete` 提交当前账号 Passkey assertion；complete 成功返回同 action 的 `MfaChallengeResult.proofToken`。`Auth:PasskeyStepUp:Enabled=false` 时这两个 step-up 端点必须 fail closed 为 503 + `PASSKEY_STEP_UP_DISABLED`，不允许创建 challenge 或签发 proof。MFA enabled 账号也可继续使用 TOTP challenge 获取对应 action proof；anonymous identity mode 下禁止 legacy password fallback，`DELETE /api/binary/auth/passkey/credentials/{id}` 与 `PUT /name` 都不得提交或解析 `MfaPasswordProofRequest` body。非匿名 legacy password fallback 如仍需保留，必须放在显式隔离的兼容路径，不能进入这些生产匿名敏感操作 endpoint。

| FrameType | POD | 端点 / 用途 |
|-----------|-----|-------------|
| `PasskeyRegisterBegin` (`63`) | `PasskeyRegisterBeginPod` | `POST /api/binary/auth/passkey/register/begin`；admin bootstrap begin 复用该响应 frame |
| `PasskeyLoginBegin` (`64`) | `PasskeyLoginBeginPod` | `POST /api/binary/auth/passkey/login/begin`；admin login begin 复用该响应 frame |
| `PasskeyCredentialList` (`65`) | `PasskeyCredentialSummaryPod[]` | `GET /api/binary/auth/passkey/credentials` |
| `PasskeyRegisterCompleteRequest` (`66`) | `PasskeyRegisterCompleteRequestPod` | 注册完成请求体；admin bootstrap complete 复用该请求 frame |
| `PasskeyLoginCompleteRequest` (`67`) | `PasskeyLoginCompleteRequestPod` | 登录完成请求体；admin login complete 复用该请求 frame |
| `PasskeyCredentialFriendlyNameUpdateRequest` (`68`) | `PasskeyCredentialFriendlyNameUpdateRequestPod` | Passkey 凭据友好名称更新请求体 |

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
| GET | `/api/binary/auth/admin/me` | 响应 `AdminPrincipalSnapshot` | admin principal + `admin.manage` |
| POST | `/api/binary/auth/admin/logout` | 响应 `EmptySuccess` | admin principal + `admin.manage` |
| GET | `/api/binary/auth/admin/sessions` | 响应 `AdminSessionList` | admin principal + `admin.manage` |
| POST | `/api/binary/auth/admin/sessions/{sessionId}/revoke` | 响应 `EmptySuccess` | admin principal + `admin.manage` |
| POST | `/api/binary/auth/admin/sessions/revoke-others` | 响应 `EmptySuccess` | admin principal + `admin.manage` |

admin 登录只接受 Passkey/Security Key assertion。成功会写入独立 `AdminAccessToken` / `AdminSessionId` Cookie；生产读取只接受 `__Host-AdminAccessToken` / `__Host-AdminSessionId`，未前缀 admin Cookie 只在清理路径删除，不作为认证 fallback。JWT 必须包含 `identity_kind=admin_principal`、`admin_id`、`admin_sid` 与多值 `admin_permission` claim，不得签发 `ClaimTypes.Role` / `role=admin` 兼容 claim，也不得把 role claim 作为后台授权来源。请求期认证必须按 `admin_sid` 回查 `admin_session` 并校验 principal active、session 未撤销、idle/absolute 未过期、`AccessTokenHash` 与当前 token 匹配、session principal id 与 `admin_id` 一致；失败返回未认证/未授权并删除 admin session cookies，成功时只通过 row-version、旧 token hash 和旧过期时间谓词更新 `LastSeenAtUtc`，stale 更新按 session conflict 处理。`GET /api/binary/auth/admin/me` 从已验证的 admin principal claims 生成 `AdminPrincipalSnapshot`，用于前端从 HttpOnly Cookie 恢复 independent admin workspace，不得退回 legacy `sys_user.role=admin`。admin-sensitive step-up 只接受 `/api/binary/auth/admin/step-up/passkey/begin|complete` 的管理员 Passkey 再认证，不读取普通 `sys_user` MFA 状态，也不接受普通用户 MFA proof。

前端管理态只来自 `GET /api/binary/auth/admin/me` 返回的 independent principal；`AdminPrincipalSnapshot.permissions` 是导航、route guard 和按钮权限的唯一来源。普通 `IdentityAccountSnapshot` / `/auth/me` 不提供 admin 权限，客户端不得用 `legacy.admin`、`syncLegacyAdminPrincipal` 或 `user role=admin` 作为降级入口。

admin step-up challenge 绑定 `identity_kind=admin_principal`、`admin_id`、当前 `admin_sid`、action=`admin-sensitive`、challenge token 和过期时间。complete 成功后返回 `MfaChallengeResult(verified=true, action=admin-sensitive, proofToken=...)`；proof 存储使用 `CachePolicyId.SecurityMfaProof`，key 形如 `admin:{adminId}:{adminSid}:admin-sensitive:{token}`，只能消费一次，不能跨 admin principal 或 session 使用。敏感写入继续通过 `X-Fsus-Mfa-Proof` 传递该 proof header；缺失、过期、复用或 session 不匹配返回 `428` + `MFA_PROOF_REQUIRED`。

`POST /api/binary/auth/admin/logout` 会把当前 `admin_session.RevokedAtUtc` 置为当前 UTC 时间、`RevokeReason=logout`，并只清理 `AdminAccessToken` / `AdminSessionId` 及 `__Host-*` admin Cookie，不触碰普通用户 Cookie。普通用户认证读取只接受当前传输模式下签发的 Cookie；旧未前缀 `AccessToken` / `RefreshToken` / `SessionId` 不再作为 fallback，但 logout/clear 仍删除 legacy Cookie 以帮助浏览器收敛。`POST /api/binary/auth/admin/sessions/{sessionId}/revoke` 使用 `admin_session` row-version guard；目标不存在返回 `NotFound`，目标已被并发撤销或版本不匹配返回 `Conflict`，成功只写一条 `admin.session.revoked` admin audit。`POST /api/binary/auth/admin/sessions/revoke-others` 必须保留当前 `admin_sid` 对应 session，并逐 session 使用同样的 row-version revoke。

### User MFA / TOTP step-up

匿名身份模式下，TOTP 只作为敏感操作 step-up，不作为账户恢复凭据。`POST /api/binary/auth/mfa/setup/start` 使用 `FsusBlog:account:{accountId}` 作为 TOTP issuer account label，不得暴露 legacy `sys_user.username`；TOTP secret、pending secret、verified time 和 TOTP recovery-code hash 只允许存储在 `user_mfa_profile`，`sys_user` 只保留 `MfaEnabled` 状态投影。已启用 TOTP 的重新绑定 action 为 `mfa_setup_rebind`，初次启用 action 为 `mfa_setup`。`/mfa/setup/start`、`/mfa/disable` 与 `/mfa/recovery/regenerate` 在 anonymous identity mode 下都必须通过 `X-Fsus-Mfa-Proof` 提交对应 action 的一次性 proof，不接收 `MfaPasswordProofRequest` body。普通账号凭据变更 action（`account.delete`、`passkey.delete`、`passkey.credential-name.update`、`recovery-key.create`、`recovery-key.rotate`）可以通过 TOTP challenge 或开启状态下的 `/api/binary/auth/step-up/passkey/begin|complete` 获取同一类 action-bound proof；`/auth/mfa/challenge/start` 在未启用 TOTP 时不得为空签发这些 action 的 proof。缺失、action 不匹配、过期或重放 proof 返回 `428` + AEDS `ApiError`，Passkey step-up 通道关闭返回 `503` + `PASSKEY_STEP_UP_DISABLED`，且不得进入 secret 写入、停用或恢复码重生成。

TOTP recovery code 只允许绕过或完成 TOTP step-up；它不是账户 `Recovery Key`，不得用于匿名账号恢复、Passkey 重绑或 recovery session 签发。服务端只在 `user_mfa_profile.mfa_recovery_codes_hash` 存储 `v3$argon2id$m=65536,t=3,p=4$...` 哈希条目，并用 `user_mfa_profile.hash_version` 标记集合版本；裸 SHA-256 legacy 恢复码只允许在 2026-09-01 00:00:00Z 前消费并触发重生成，deadline 后 fail closed。非匿名 legacy 模式可继续使用 `MfaPasswordProofRequest` 支持旧密码 + 当前 TOTP/恢复码证明，但生产匿名模式必须走 header proof。

MFA challenge ticket 的内部契约使用 `AccountId` 与 `AccountSubjectHash`，不再暴露或序列化 `MfaChallengeTicket.UserId`。`/api/binary/auth/mfa/challenge` 验证失败时，attempt limiter 通过 `SecurityMfaChallenge` cache policy 写入 `fail:ticket:{ticketId}`、`fail:subject:{accountSubjectHash}` 与 `fail:ip:{clientIpHash}` 三类计数；这三类计数必须用统一缓存的单次 Redis Lua primitive 原子递增并返回同一 post-increment 快照，lock 决策不得混用分散递增结果。主体窗口按 stable subject hash 聚合，不按可重排的账号容器 id 聚合。audit context 字段为 `AccountId`、`AccountSubjectHash`、`TicketHash`、`ClientIpHash`、`UserAgentHash` 与失败计数，不得恢复 `UserId`。

### Recovery Key AEDS frames

Recovery Key 是匿名账号的账户恢复凭据，独立于 TOTP MFA recovery code。新明文格式为 `frk_<lookupId>_<secret>`：`lookupId` 是 128-bit hex 随机不可枚举定位符，`secret` 是完整恢复密钥材料；提交值超过 256 字符时必须在 lookup、HMAC 或 PBKDF2 前拒绝为 `RECOVERY_KEY_INVALID`。服务端只存储 `account_recovery_key.account_id`、`lookup_id_hash`、`key_hash`、`key_version`、`created_at`、`used_at`、`revoked_at`；`lookup_id_hash` 与完整 `key_hash` 都使用服务端 `RecoveryKeyPepper` 加固，完整 key hash 使用 PBKDF2-SHA256。`account_recovery_key` 索引最终态为 `idx_account_recovery_key_account`、`idx_account_recovery_key_version(account_id, key_version DESC)`、active unique 和 lookup active unique，历史 `user_id` / `idx_account_recovery_key_user` 只允许在迁移输入中出现。明文 Recovery Key 只在 create/rotate 响应中返回一次，不写数据库、日志、telemetry 或 browser storage。

`POST /api/binary/auth/recovery-key/create` 和 `/rotate` 必须通过统一 user security step-up：`X-Fsus-Mfa-Proof` 绑定 `recovery-key.create` 或 `recovery-key.rotate` 并一次性消费。客户端可通过 TOTP challenge 或普通账号 `/api/binary/auth/step-up/passkey/begin|complete` 获取该 proof；Passkey complete 返回的 `MfaChallengeResult.action` 必须与 create/rotate action 完全一致。生产 binary endpoint 不接收 `MfaPasswordProofRequest` body；anonymous identity mode 下发送旧 body proof 会被忽略或拒绝，并按缺失 / 无效 step-up proof 返回 `428` + AEDS `ApiError`。非匿名 legacy password fallback 如仍需保留，必须放在显式隔离的兼容路径，不能进入这些生产匿名敏感操作 endpoint。

验证请求不携带 account id。服务端从 Recovery Key 中解析 `lookupId`，按 peppered `lookup_id_hash` 定位候选记录，再校验完整 Recovery Key；无 lookup id 的旧格式不会扫描全表兼容，统一返回恢复失败并受同一 attempt limiter 约束，用户需要通过仍可登录设备重新生成新格式 Recovery Key。验证成功会把当前 Recovery Key 标记为 used，返回 10 分钟 recovery session token 与 `expiresAt`，不得返回 account id、user id、internalUserId 或其他身份字段。该 token 只允许调用 recovery passkey begin/complete 端点绑定新 Passkey；如果 verify 请求设置 `revokeSessions`，服务端会撤销该账号现有会话；如果设置 `revokePasskeys`，新 Passkey 绑定完成后删除旧凭据。TOTP MFA recovery code 仍只用于 MFA bypass，不得作为账户恢复。

| FrameType | POD | 端点 / 用途 |
|-----------|-----|-------------|
| `RecoveryKeyCreateResponse` (`159`) | `RecoveryKeyCreateResponsePod` | `POST /api/binary/auth/recovery-key/create` 和 `/rotate` 响应 |
| `RecoveryKeyVerifyRequest` (`160`) | `RecoveryKeyVerifyRequestPod` | `POST /api/binary/auth/recovery-key/verify` 请求体；只携带 Recovery Key、`revokeSessions`、`revokePasskeys`，不携带 account id；匿名、`fixed_ip` 限流、RiskControl challenge、PoW、no-store |
| `RecoveryKeyVerifyResponse` (`161`) | `RecoveryKeyVerifyResponsePod` | verify 成功后只返回短期 recovery session token 与过期时间 |
| `RecoveryKeySessionRequest` (`162`) | `StringMutationRequestPod` | `POST /api/binary/auth/recovery-key/passkey/register/begin` 请求体；complete 复用 `PasskeyRegisterCompleteRequest.MfaProofToken` 传 recovery session token |

### Anonymous identity and comment policy AEDS frames

匿名身份不新增平行 Passkey 协议：注册、登录、credential list、rename、admin bootstrap 和 recovery bind 仍复用上面的 Passkey frame；账户恢复仍复用 `RecoveryKeyCreateResponse` / `RecoveryKeyVerifyRequest` / `RecoveryKeyVerifyResponse` / `RecoveryKeySessionRequest`。已发布运行时 frame 覆盖账户快照、评论策略、CommentCreateV2 和作者展示投影。177-183 是匿名凭证/root/ticket/匿名评论创建的独立 frame family；已注册的 root/circuit/ticket/submit endpoint 必须只使用对应 AEDS frame，未注册 frame 仍只代表跨栈 POD/codec、AEDS 编号、前端 adapter 和 golden fixture。

`POST /api/binary/auth/anonymous/bootstrap` 是匿名身份模式的新账号创建入口：匿名访问、`fixed_ip` 限流、`RequiresPowFilter`、`RequireNoStoreResponse()`，请求 `Content-Type` 必须为 `application/octet-stream`。请求 frame 为 `AuthAnonymousBootstrapRequest` (`189`)，只包含 `acceptedGuidelines` 和可选 `publicHandle`；不得携带 username、password、confirmPassword、Recovery Key 或 Passkey attestation。服务端只创建 `sys_user` 匿名账号容器，写入 `identity_kind=anonymous_account`、可选 `public_handle`、`privacy_initialized_at`、匿名 credential 默认状态和内部 `InternalSubject`；`LegacyPasswordHash` / `LegacyProjectRole` 仅是 legacy tombstone，不由匿名 bootstrap 写入，且不能作为登录凭据或权限来源。成功响应复用 `AuthLoginFlow` (`18`) 并写入当前用户 session cookie，随后客户端继续调用 Recovery Key create 与 Passkey bind 流程。旧 `/api/binary/auth/register` 与 `/api/binary/auth/login` password endpoints 已从生产用户侧 binary API 移除；旧 password-auth request frame 已从 AEDS/OpenAPI/contract fixtures 下线，不能作为 legacy migration/test frame 继续消费。AEDS 数值 `40` 已作为 legacy admin password reset slot 退休，`43`/`44`/`45`/`46` 已作为 legacy username/password auth slots 退休；这些数值不再生成 frame 名、POD、codec 或 OpenAPI 契约。

普通账号自助 `/api/binary/auth/*` 端点只接受 `identity_kind=anonymous_account` 的账号主体，必须使用 `RequireAnonymousAccountPrincipal()` 或等价 `RequireClaim("identity_kind", "anonymous_account")` 策略；这包括 `/auth/me`、`/auth/public-handle`、普通 session 管理、MFA profile/setup/disable/recovery、Recovery Key create/rotate、Passkey credential 管理、自助注销和普通登出。AdminPrincipal JWT 即使 `NameIdentifier` 与 `sys_user.id` 数值碰撞，也不得进入这些 handler；授权层应返回 403，并记录 `security.auth.self_service_principal_rejected` 高价值审计。AdminPrincipal 只能访问 `/api/binary/auth/admin/*` 控制面端点，普通自助 handler 不得使用裸 `.RequireAuthorization()` 或把 `HttpContext.GetUserId()` 作为账号身份判定。

| FrameType | POD | 用途 |
|-----------|-----|------|
| `IdentityAccountSnapshot` (`163`) | `IdentityAccountSnapshotPod` + UTF-8 blob | `GET /api/binary/auth/me` 响应；account id、identity kind、nullable public handle、Passkey/Recovery/TOTP step-up 状态、anonymous credential status/level、status/ban/deletedAt；不暴露 internalUserId 或旧兼容 id |
| `AuthAnonymousBootstrapRequest` (`189`) | `AuthAnonymousBootstrapRequestPod` + UTF-8 blob | `POST /api/binary/auth/anonymous/bootstrap` 请求体；只含使用规范确认和可选 public handle，不含 password/username 注册字段 |
| `AuthUpdatePublicHandleRequest` (`190`) | `StringMutationRequestPod` + UTF-8 blob | `PUT /api/binary/auth/public-handle` 请求体；保存或清空当前匿名账号的 public handle |
| `CommentPolicySnapshot` (`164`) | `CommentPolicySnapshotPod` + UTF-8 blob | `GET /api/binary/comment/policy` 响应；评论 composer 渲染前读取 anonymous/public/ZK 开关、ZK-Prod readiness、默认 author mode、支持语言 `zh-CN` / `en` 与策略 `snapshotHash` |
| `CommentPolicyUpdateRequest` (`165`) | `CommentPolicyUpdateRequestPod` + UTF-8 blob | admin 匿名评论策略 patch；bool 字段用 `Has*` flag 表示未设置 |
| `CommentCreateV2Request` (`166`) | `CommentCreateV2RequestPod` + UTF-8/blob payload | 新评论创建请求，包含 article/reply 上下文、author mode、public opt-in、anonymous scope、语言提示、普通 proof token、ZK proof bytes 和 content；不再把 ProofToken 当作 credential commitment/root 占位 |
| `CommentAuthorView` (`167`) | `CommentAuthorViewPod` + UTF-8 blob | 评论读取侧作者投影：mode、display name、display language、badge/status/scope label、credential level；评论 cursor item blob 必须内嵌该 payload，客户端不得从 legacy identity string 伪造 author |
| `AnonymousCredentialIssueRequest` (`177`) | `AnonymousCredentialIssueRequestPod` + shared blob | 匿名凭证签发请求契约：epoch、`fsus.anonymous.comment.v2` circuit id、credential level、circuit-native credential request、client nonce |
| `AnonymousCredentialIssueResponse` (`178`) | `AnonymousCredentialIssueResponsePod` + shared blob | 匿名凭证签发响应契约：circuit-native issuer signature、issuer public key id、credential epoch、expires_at、credential level；不再返回 SHA256 commitment |
| `AnonymousCredentialRootSnapshot` (`179`) | `AnonymousCredentialRootSnapshotPod` + shared blob | 匿名凭证 root/verifying-key snapshot：epoch、root expiry/grace expiry、ZK/verifier flags、circuit id、verifying key hash、issuer public key hash、credential/revocation root |
| `AnonymousCredentialRevocationWitnessRequest` (`186`) | `AnonymousCredentialRevocationWitnessRequestPod` + shared blob | 匿名凭证撤销 non-membership witness 请求：epoch/circuit/layout/root/issuer/handle hash |
| `AnonymousCredentialRevocationWitnessResponse` (`187`) | `AnonymousCredentialRevocationWitnessResponsePod` + shared blob | 128 层 circuit-friendly sparse Merkle non-membership witness；供浏览器 prover 输入，不代表 Groth16 proof 已生成 |
| `AnonymousCommentTicketRequest` (`180`) | `AnonymousCommentTicketRequestPod` + shared blob | 匿名评论 ticket 申请请求：article/reply 上下文、action context、scope、verifying key hash、nullifier hash、credential commitment/root、revocation root、credential level、reputation bucket、Groth16 proof、canonical public inputs |
| `AnonymousCommentTicketResponse` (`181`) | `AnonymousCommentTicketResponsePod` + shared blob | 匿名评论 ticket 响应：one-time opaque ticket、expires_at、credential level、moderation subject hash；不得包含 user id、username、public handle 或 nullifier 原文 |
| `AnonymousCommentCreateRequest` (`182`) | `AnonymousCommentCreateRequestPod` + shared blob | 匿名评论创建请求：article/reply 上下文、credential epoch、scope、language、ticket、content；不携带用户身份或 Authorization token |
| `AnonymousPrivacyStateSnapshot` (`183`) | `AnonymousPrivacyStateSnapshotPod` + shared blob | 前端隐私状态快照：active credential、issue/submit capability、root/ticket expiry、circuit/verifying-key/status/level |

`CommentPolicySnapshot` 通过 `GET /api/binary/comment/policy` 公开读取，匿名访问、`public_read` 限流，用于让公开文章评论 composer 在渲染前应用当前服务端策略。`DefaultAuthorMode` byte 映射为 `1=anonymous`、`3=public`、`4=zk_anonymous`；`0` 只作为读端兼容值并解释为 `anonymous`，其他值必须作为协议错误拒绝。`SupportedDisplayLanguages` 使用换行分隔文本，当前只允许 `zh-CN` 与 `en`。`snapshotHash` 是服务端规范化匿名评论策略上下文的 64-hex SHA-256，用于 comment.v2 `policy_hash` public input；客户端只能读取并绑定，ticket service 会用当前服务端 policy 重新计算并比对 canonical public inputs。ZK-Prod 字段只暴露 coarse readiness：`zkProdEnabled`、`zkProdNativeVerifierConfigured`、`zkProdTrustedSetupVerified`、`zkProdCredentialRequired`、`zkProdCredentialRootReady` 和枚举式 `zkProdUnavailableReason`，不得返回 proof、circuit、witness、credential secret 或 verifying key 细节。前端 binary adapter 必须能在评论 composer 渲染前解码该 frame，并只依据 policy snapshot 判断是否展示/尝试 ZK-Prod 匿名路径，不得从组件内硬编码策略或每次输入读取 env。

`CommentCreateV2Request` 是 `POST /api/binary/comment` 的唯一登录态评论创建 frame，但生产写入只允许显式公开/可归因发送：`AuthorMode` 必须为 `public`，且 `PublicSendExplicitlySelected` 必须为 `1`。`AnonymousScope`、`ProofToken`、`zkProof` 等字段仅作为既有 wire layout / legacy contract 字段保留，不能作为默认匿名或强匿名提交通道；完整强匿名评论发布必须使用 `AnonymousCommentTicketRequest` / `AnonymousCommentCreateRequest` ticket-submit 流程。`DisplayLanguage` 是展示语言提示。`CommentCreateV2RequestPod` 偏移 4 的旧 `replyToUserId` 兼容槽和偏移 11 的 presence flag 必须固定写入 `0/0`；回复目标只能通过 `replyToCommentId`、端上 nullifier 和作者快照解析。退休的数值 37 frame 不再保留 happy path，必须在预读或 payload decode 阶段作为协议错误拒绝。

匿名凭证与匿名评论 ticket frame 使用固定宽度 POD + shared blob，不走 JSON hot path。所有变长字段都通过 `Utf8SliceRef` 指向 blob slice，包括 circuit-native credential request/issuer signature、issuer public key id/hash、credential commitment、credential root、revocation root、Groth16 proof、public inputs 和 opaque ticket。公共元数据固定字段包括 `credentialEpoch:int64`、`rootExpiresAtUnixMs:int64`、`rootGraceExpiresAtUnixMs:int64`（root snapshot）、`ticketExpiresAtUnixMs:int64`（仅 ticket/state）、`circuitNumericId:uint32`、`circuitId:Utf8SliceRef`、`verifyingKeyHash:Utf8SliceRef`、`publicInputLayoutVersion:uint16`、`zkAnonymousEnabled:bool` 和 `verifierConfigured:bool`（root snapshot）。当前生产匿名隐私 contract 固定为 `circuitId=fsus.anonymous.comment.v2`、`publicInputLayoutVersion=3`、issuer signature 上限 256B、credential request 上限 256B、Groth16 proof 上限 4096B；版本不匹配、malformed slice、尾随字节或超长字段必须 fail closed。

撤销 witness frame 同样使用固定 POD + shared blob：request 只提交公开 root/circuit/issuer 字段和不可逆 `revocationHandleHash`；response 返回 `algorithmId`、`pathDepth`、`leafKey`、`witnessHash` 与连续拼接的 sibling hash bytes。该 witness 仅是浏览器 prover 的 non-membership 输入材料，不能替代 `AnonymousCommentTicketRequest.zkProof`，也不能作为服务端已验证 Groth16 proof 使用。

`AnonymousCredentialIssueRequest.credentialRequest` 当前只接受 comment.v2 circuit-native credential request envelope：domain magic、metadata digest、credential secret commitment、client nonce binding 和 request nonce。服务端只把账号侧可公开消息和 opaque request envelope 绑定进签发材料：`credentialEpoch:int64le`、`circuitNumericId:uint32le`、`publicInputLayoutVersion:uint16le`、`circuitId:utf8`、`credentialLevel:utf8`、`credentialRequest:bytes`。`AnonymousCredentialIssueResponse.issuerSignature` 是 96B BN254 Schnorr issuer signature (`R.x || R.y || s`)，签名 nonce 由 HMAC-DRBG deterministic nonce 从私钥、公钥、canonical issue material 和 attempt 派生，可作为后续 comment.v2 circuit witness；client nonce 只用于客户端防重放/状态绑定，不进入服务端审计。

`AnonymousCommentTicketRequest` 的 public input layout v3 固定包含 `action_context`、`scope`、`circuit_id`、`verifying_key_hash`、`public_input_layout_version`、`credential_epoch`、`nullifier_hash`、`credential_commitment`、`credential_root`、`revocation_root`、`issuer_public_key_hash`、`policy_hash`、`credential_level` 和 `reputation_bucket`。客户端 `publicInputs` 必须是后端 `NativeGroth16PublicInputCodec` 的 canonical binary transcript；ticket service 会用 POD 字段、当前 root snapshot 和当前 policy snapshot hash 重建 transcript 并做 byte-for-byte 比较，mismatch 在调用 native verifier 前 fail closed。`POST /api/binary/comment/anonymous-ticket` 只在 ZK-Prod policy ready 时开放：`zkProdEnabled=true`、native verifier configured、trusted setup verified、circuit-native credential required/ready、credential root ready 且 `zkProdUnavailableReason` 为空；否则在 decode payload 或调用 ticket service 前返回 AEDS `ApiError` + `anonymous_comment_ticket_unavailable`，不降级为 dev verifier。服务端只允许 `action_context=comment.create`，并在昂贵 verifier 调用前校验 scope、credential commitment/root、revocation root、issuer public key hash、policy hash、verifying key hash 和 layout version 与当前 root/policy snapshot 匹配。

`AnonymousCommentCreateRequest` 不包含 `userId`、`replyToUserId`、`username`、`Authorization` token 或 `publicHandle` 字段；`POST /api/binary/comment/anonymous` 只能通过 consume-once ticket、nullifier 和策略上下文解析匿名 actor。所有强匿名 ticket / submit endpoint 必须挂 `RequireStrongAnonymousRequest()`，拒绝 `Cookie`、`Authorization`、session/bearer bridge header 和已认证 principal；拒绝时返回 AEDS `ApiError`，`Details=anonymous_identity_contaminated`。`AnonymousCommentTicketResponse` 同样不得返回可逆用户身份或 nullifier 原文，只能返回 opaque ticket、moderation subject hash 和 credential level。旧 `CommentCreateV2RequestPod` 布局保持不变；需要完整匿名凭证/ticket 流程的客户端必须使用 177-183 对应新 frame，不得把 nullifier/credential/root 新字段塞回 `CommentCreateV2Request` 或从 `ProofToken` 派生。

评论写入不再把 `comment.user_id` 作为作者展示的必填外键。`CommentActor` 会写入 `author_mode`、`public_handle`、`anonymous_handle`、`anonymous_display_name`、`anonymous_display_language`、`anonymous_nullifier_hash`、`anonymous_scope`、`moderation_subject_hash`、`credential_level`、`reputation_bucket` 和 `account_age_bucket`。`CommentActor.UserId` 只有在 `author_mode = public` 且 public send 显式选择成功时允许为当前账号 id；`anonymous` 与 `zk_anonymous` resolve 结果必须为 null，即使请求携带登录账号 id 也不得把它写入评论、审核、通知或审计上下文。新 public send 写入只允许使用当前账号已保存的 `public_handle`，未设置时拒绝 public mode，不得回退内部 `sys_user.username` 或合成 user id；公开评论读取优先使用 `anonymous_display_name` / `public_handle`，旧数据缺少快照字段时只能按 `author_mode` 使用匿名或未署名兜底。`comment.user_id` 与 `comment.reply_to_user_id` 的最终态白名单仅覆盖 public attribution 和旧回复投影兼容；admin 审核记录必须使用 `moderated_by_admin_principal_id`，不得继续写 `moderated_by_user_id`。默认匿名和强匿名路径不得按 `comment.user_id` 查询或授权。账号侧可归因评论读取的最终态索引是 `idx_comment_attributable_public_user_id_desc`，只覆盖 `author_mode = 'public' AND user_id IS NOT NULL`，旧 generic `idx_comment_user_id_desc` 必须被迁移删除。匿名 display name 由服务端按 `zh-CN` / `en` 的内置常见姓名列表生成，并在 scope 内稳定，不暴露 account id、username、public handle、credential id 或 nullifier 原文。

Authoring 和审核 schema 的 fresh DB 最终态不得创建旧用户归因列。`article_draft` 首次建表使用 `owner_admin_principal_id`，`article_revision` 首次建表使用 `created_by_admin_principal_id`，`comment` 首次建表/补列使用 `moderated_by_admin_principal_id`。历史库中的 `owner_user_id`、`created_by_user_id`、`moderated_by_user_id` 仅作为迁移输入被 rename/copy/drop，不能作为运行时 API、导入恢复或后台审核契约字段。

---

## 分页与游标信封

源码：`src/shared/Contracts/Envelopes/PodEnvelopes.cs`

### `PageResponse<T>`（基于页码）

```json
{
  "items": [ /* T[] */ ],
  "total": 100,
  "nextCursor": "1715299200000:42",
  "hasMore": true,
  "page": 1,
  "pageSize": 20
}
```

文章列表页码参数不得静默修正：`page` 必须大于等于 `1`，`pageSize` / binary `size` 必须在 `1..100`。缺省参数仍按 `page=1`、`size=10` 处理；显式非法值返回 HTTP `400` + AEDS `ApiError`，不回退第一页，也不截断到最大页大小。
公共文章列表保留 page URL 兼容层，但 AEDS `ArticleList` 响应会额外携带可选 `nextCursor` / `hasMore`。`nextCursor` 使用 `{createTimeUnixMs}:{id}`，排序仍固定为 `createtime DESC, id DESC`；服务端深页内部用 `(createtime, id)` keyset walk，不允许为公共列表回退 `OFFSET`。

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
| `ArticleListCursorEnvelope` | NextCursorUnixMs | long | 下一页游标时间戳；无更多时为 `0` |
| | HasMore | bool | 是否还有后续文章 |
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
  "accessTokenExpiresAtUtc": "2026-06-29T12:49:56Z",
  "refreshToken": "随机刷新令牌",
  "refreshTokenExpiresAt": "2026-06-29T12:34:56Z"
}
```

- 该结构主要用于服务端内部登录/续签流程，不直接作为公开认证 API 的最终响应体
- `accessTokenExpiresAtUtc` 由 JWT 签发结果直接给出并与 JWT `exp` 对齐；普通/MFA/Passkey 登录、refresh rotation 和 admin session 签发必须把该值原样传给 AccessToken Cookie，Cookie 层不得重新读取配置或解析 token
- `refreshTokenExpiresAt` 对齐 `sys_user_session.IdleExpiresAt`，用于 refresh-token 成功路径直接写 Cookie expiry，避免按新 refresh token 回查 session
- 对外认证接口成功后统一返回 `AuthLoginFlowDto`，认证 Cookie 通过 `Set-Cookie` 下发

### `AccountSnapshotContract`（shared/core 账号快照）

`IUserCoreService.GetByIdAsync` 与 CoreBridge 只传递匿名账号容器快照：

```json
{
  "accountId": 1,
  "identityKind": "anonymous_account",
  "publicHandle": "Public Alice",
  "passkeyEnabled": true,
  "recoveryEnabled": true,
  "totpStepUpEnabled": false,
  "anonymousCredentialStatus": "active",
  "anonymousCredentialLevel": "strong_anonymous",
  "status": 0,
  "deletedAt": null
}
```

- shared/core 边界不再暴露 `UserSnapshotContract` 或 `AuthLoginResultContract.User`。
- 该快照不得包含 `username`、`role`、`lastLoginIp` 或任何管理员权限推断字段；管理审计字段必须放入 admin/security-only read model。

### `AuthLoginFlowDto`（注册 / 登录成功响应）

```json
{
  "accountId": 1,
  "identityKind": "anonymous_account",
  "authPhase": "authenticated",
  "mfaMode": null,
  "challengeToken": null
}
```

- `accountId`：匿名账号容器 id；不等同于可公开展示名，也不能作为 admin 权限来源
- `identityKind`：当前用户侧固定为 `"anonymous_account"`；admin principal 使用独立 `/api/binary/auth/admin/**` 流程
- `authPhase`：`"authenticated"` 或 `"mfa_required"`
- `mfaMode`：`"risk"` / `"standard"` / `null`
- `challengeToken`：仅在 `authPhase = "mfa_required"` 时存在
- `POST /api/binary/auth/anonymous/bootstrap` 与 `POST /api/binary/auth/passkey/login/complete` 成功时返回该结构，并在同一响应内写入登录 Cookie。
- 该结构以及 `MfaChallengeResult.user` 不再输出 legacy `username`、`role` 或 `userId` 字段；MFA 登录完成时的 `user` 只包含 `accountId` 与 `identityKind`。
- 密码、MFA challenge 或 Passkey 断言完成后仍必须经过服务端最终会话签发校验；封禁账号在认证通过后返回 `AuthLoginFlowDto` 并写入受限会话 Cookie，用于读取账号状态、登出、撤销会话、删除本人账号等安全收尾操作。注销账号（`Deleted` / `DeletedAt`）仍不得返回该结构，也不得写入 access / refresh / session Cookie。
- 普通账号 access token 不携带 legacy username 或 role claim；必须携带与 `sys_user.account_subject_hash` 完全一致的 `account_subject_hash`，供 RiskControl subject hash、challenge proof、blacklist 和 notification admission 使用。该字段由迁移或账号创建写入并保持稳定，签发/读取路径不得从账号 id、public handle 或 Passkey handle 动态重建。缺失或格式错误时 token 签发与相关安全边界 fail closed。`ClaimTypes.NameIdentifier` / `nameid` 仅作为账号容器 id 兼容字段，不能作为 RiskControl subject hash 材料。`sys_user.role=admin` 不能作为后台权限、notification admin group、rate-limit admin partition、评论管理员删除、普通账号状态治理保护条件或审计 admin actor 的来源。后台权限只能来自 independent admin principal token 的 `identity_kind=admin_principal`、`admin_id/admin_sid` 与多值 `admin_permission` claim。普通账号状态治理接口只治理 `identity_kind=anonymous_account` 容器；若旧数据出现 `identity_kind=admin_principal` 的 `sys_user` 影子行，接口必须拒绝并交由 independent admin principal plane 处理。
- `POST /api/binary/auth/delete-account` 在匿名身份模式下只接受 `AuthDeleteAccountRequest` 的确认文本，不包含旧 password、TOTP code 或 recovery-code 字段；敏感操作 proof 必须通过一次性 `X-Fsus-Mfa-Proof` 提交，action 固定为 `account.delete`。注销成功后服务端撤销当前账号 session、Passkey、Recovery Key 与匿名凭据状态，并把 `sys_user` 保留为 anonymous account tombstone，不再改写旧 username。
- 封禁状态以 `sys_user.Status/BanReason` 为权威来源；`SecurityBlacklistUser` Redis 缓存只做加速且不设置 L2 过期。缓存值必须是 `v1|rowVersion|status|reason` 版本化状态快照，`rowVersion` 来自 `sys_user.xmin::text`；ban/unban 后发布当前 DB 版本，cache-miss 回填只能通过 Redis Lua 在 key 缺失或版本相同时写入，版本不匹配必须拒绝旧快照。登录、写入过滤器和 notification stream 遇到缓存 miss 时必须回查数据库，不能因 Redis 丢失而恢复封禁用户权限，也不得接受旧 reason-only 缓存值。受限会话的普通业务写入由服务端返回 `423 Locked`，Binary `ApiError.Details = "ACCOUNT_BANNED_WRITE_LOCKED"`；客户端不得只靠前端状态拦截来实现安全边界。

### `IdentityAccountSnapshot`（当前匿名账号容器，`GET /api/binary/auth/me`）

```json
{
  "accountId": 42,
  "identityKind": "anonymous_account",
  "publicHandle": "Public Alice",
  "passkeyEnabled": true,
  "recoveryEnabled": true,
  "totpStepUpEnabled": true,
  "anonymousCredentialStatus": "active",
  "anonymousCredentialLevel": "strong_anonymous",
  "status": 0,
  "banReason": null,
  "deletedAt": null
}
```

- `sys_user` 仍是持久化账号容器，但 `/auth/me` 不输出内部 `username`、`role`、`internalUserId` 或旧兼容 `id`，也不允许客户端把普通账号快照当成权限来源。
- `identityKind` 当前生产值为 `"anonymous_account"`；`publicHandle` 只是公开显示称呼，不是登录名或权限主体。
- admin 权限只能读取 `/api/binary/auth/admin/me` 的 independent admin principal；legacy `CurrentUserSnapshot` frame 只保留给 admin-only accountId 查询、迁移和测试面，字段为 `accountId`、`identityKind`、`status`、`banReason`、`deletedAt`，不再包含 `username` 或 `role`。常规管理 API 不再暴露 `/api/binary/auth/find/{username}` 或按 `sys_user.username` 定位账号。

### `UserSessionSummaryDto`（普通账号会话列表项）

```json
{
  "sessionId": "uuid-v4",
  "deviceFingerprint": "sha256-or-client-fp",
  "deviceLabel": "Chrome on Windows",
  "lastSeenAt": "2026-01-01T01:00:00Z",
  "isCurrent": true,
  "mfaVerified": true
}
```

普通账号同时只保留一个 active `UserSession`；新登录会在事务内撤销同账号旧 active session，因此 session list 正常只返回当前 active session。该列表不返回 `lastIp`、region、raw user agent 或 user id。服务端可继续在 `sys_user_session.last_ip` 内部用于风险判定，但 `AuthSessionList` 的 `UserSessionSummaryPod` 不包含该字段，IdentityCenter 不显示原始 IP。

### `AdminSessionSummaryDto`（管理员会话列表项）

```json
{
  "sessionId": "admin-session-id",
  "deviceFingerprint": "sha256-or-client-fp",
  "userAgent": "Mozilla/5.0 ...",
  "createdAtUtc": "2026-01-01T00:00:00Z",
  "lastSeenAtUtc": "2026-01-01T01:00:00Z",
  "idleExpiresAtUtc": "2026-01-01T09:00:00Z",
  "absoluteExpiresAtUtc": "2026-01-01T12:00:00Z",
  "isCurrent": true,
  "isRevoked": false
}
```

管理员 session list 不返回 `lastIp` 或其他原始客户端 IP。`admin_session.last_ip` 仅可作为服务端风险判定、审计哈希或运维排障输入，不进入 AEDS `AdminSessionSummaryPod`、DTO 序列化或前端 hydration。

### `AdminPrincipalSnapshot`（管理员当前会话快照）

```json
{
  "id": "1",
  "displayName": "local-root",
  "source": "independent",
  "permissions": ["admin.manage", "article.write"],
  "adminSessionStatus": "active",
  "totpStepUpRequired": false
}
```

`permissions` 来自 admin JWT 的多值 `admin_permission` claim；前端只用该快照恢复管理工作区和做本地导航 gating，真实授权仍由后端 endpoint permission policy 决定。

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
  "rights": {
    "snapshotId": 901,
    "articleRevisionId": 801,
    "revisionNo": 7,
    "enabled": true,
    "licenseType": "CC-BY-4.0",
    "copyrightHolder": "Fsus",
    "copyrightYear": 2026,
    "rightsStatement": "Reuse with attribution.",
    "attributionTemplate": "{title} - {holder}",
    "copyPolicy": "append-attribution",
    "maxExcerptChars": 300,
    "allowCodeCopy": true,
    "showPublicBadge": true,
    "proofBindingEnabled": true,
    "canonicalUrl": "https://fsus.example/article/42",
    "policyHash": "sha256:<64 lowercase hex>",
    "contentCanonicalHash": "sha256:<64 lowercase hex>",
    "proofUrl": "urn:fsus:rights-proof:901",
    "proofStatus": "ready"
  },
  "prevArticle": { "id": 0, "title": "..." },
  "nextArticle": { "id": 2, "title": "..." }
}
```

### Binary Article POD

源码：`src/shared/Contracts/Models/ArticlePods.cs`

`ArticleDetail` payload 当前为 V3 envelope，外层仍使用 AEDS v2 frame。payload 以 `ArticleDetailV3HeaderPod` 开头，`Magic = 0x41524433` (`ARD3`)、`Version = 3`、`Flags = 0`，随后按 header offset 指向 `ArticleDetailV3RecordPod`、`ArticleDetailTagV3RecordPod[]`、必备 `ArticleRightsV3RecordPod` 和共享 UTF-8 blob。旧 `ArticleDetailPod + tagCount + cover blob + lifecycle tail` payload 已废弃，解码器必须拒绝 invalid magic/version、缺失 rights block、offset/length 不一致和尾随 payload。

`ArticleDetailV3RecordPod` 记录文章 id/title/content/summary/cover/category/views/status/scheduled/published/isDeleted；tag record 只保存 tag id/name slice。`ArticleRightsV3RecordPod` 记录冻结 snapshot：`snapshotId`、`articleRevisionId`、`revisionNo`、enabled/license/copyright/copy policy/excerpt/code-copy/badge/proof-binding、canonical URL、`policyHash`、`contentCanonicalHash`、proof pointer 和 proof status。所有文本通过 `Utf8SliceRef` 指向同一个 blob。

前端 `mapArticleDetailFromPodPayload` 只接受上述 V3 envelope。旧 detail tail payload、缺失 rights record、record offset/length 与共享 blob 不一致、或 required rights 文本为空时，必须作为协议错误失败；不得 JSON parse 或回退到旧 ArticleDetail 解码。

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

被接受的阅读事件只记录 `viewerKeyHash`、`proofId`、`eventType`、`routeKey`、`articleId`、region 与时间；`sys_visit_log` 最终态不包含 `userid` / `user_id` 账号绑定列，后续去重与统计不得以账号身份作为维度。

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
  "id": "101",
  "content": "评论内容",
  "createTime": "2026-01-01T00:00:00Z",
  "author": { "mode": "public", "displayName": "alice" }
}
```

### `CommentAuthorViewDto`（评论作者展示）

`CommentAuthorViewDto` 是公开评论列表、回复列表和实时推送的必备当前契约。公开读取 DTO 只暴露 `author` 与可空 `replyToAuthor` 快照，不返回旧账号 ID、旧用户名、被回复账号 ID 或被回复旧用户名。

```json
{
  "mode": "public",
  "displayName": "alice",
  "displayLanguage": "zh-CN",
  "badge": null,
  "scopeLabel": null,
  "credentialLevel": null
}
```

### `CommentReplyItemDto`（回复）

```json
{
  "id": "202",
  "content": "回复内容",
  "createTime": "2026-01-01T00:00:00Z",
  "author": { /* CommentAuthorViewDto */ },
  "replyToAuthor": { /* CommentAuthorViewDto */ },
  "parentId": "101",
  "rootId": "101",
  "replyToCommentId": "101",
  "depth": 2,
  "isDeleted": false
}
```

### `CommentThreadItemDto`（线程聚合）

```json
{
  "id": "101",
  "content": "评论内容",
  "createTime": "2026-01-01T00:00:00Z",
  "author": { /* CommentAuthorViewDto */ },
  "rootId": "101",
  "isDeleted": false,
  "replyCount": 3,
  "hasMoreReplies": true,
  "repliesPreview": [
    { /* CommentReplyPreviewItemDto */ }
  ]
}
```

`CommentArticleCursor`、`CommentThreadReplyCursor` 与 `CommentUserCursor` 的二进制 item payload 先保存 content slice，随后追加两个 `int32 length + CommentAuthorView payload` 段：第一个为必备 `author`，第二个为可空 `replyToAuthor`。固定 POD 不再携带 author display string；缺少必备 author 或 payload 尾部残留数据都必须被前端 adapter 视为 `ProtocolFailure`。

公开评论读取会按 viewer IP 解析出的地区过滤 `comment_blocked_region` 规范化 lookup 行，并把 viewer region 纳入 `CommentCursorFrame` cache identity；cache runtime counters 会按 roots/replies 与规范化 region 记录 hit/miss。`CN-MAINLAND` 严格策略只对 `CN-MAINLAND` viewer 隐藏，不会自动套用到 `CN-HK`、`CN-MO`、`CN-TW`；viewer region 解析为 `UNKNOWN` 时，只要 comment 存在任意 blocked region lookup 行就保守隐藏。评论提交同样按 request IP 解析 submit region：submit region 为 `CN-MAINLAND` 且命中大陆严格类别时直接返回 validation error；其他地区可发布但会记录对应 blocked regions；submit region 为 `UNKNOWN` 时记录人工复核和 `hide_until_reviewed=true` 地区原因，但评论初始状态仍为 `Approved`，不会仅因地区未知默认隐藏。`X-Fsus-Region` / `CF-IPCountry` / `X-Geo-Country` 只在 loopback 或 `ReverseProxy:KnownProxies` / `ReverseProxy:KnownNetworks` 命中的可信代理来源上生效，直连请求携带这些头必须按 `connection_ip` 处理。

地区合规结果存储在 `comment_region_compliance`：`comment_id`、`submit_region`、`submit_region_confidence`、`region_provider`、`submit_ip_hash`、`policy_version`、`can_publish`、`requires_manual_review`、`hide_until_reviewed`、`blocked_regions`、`risk_labels`、`decision_reason`、`rule_hits_json`、`created_at_utc`、`updated_at_utc`。其中 `blocked_regions` 继续作为审核展示和 replay diff 的序列化来源；公共读取的可索引过滤写入 `comment_blocked_region(comment_id, region_code)`，主键为 `(comment_id, region_code)`，并有 `(region_code, comment_id)` 索引。IP 只保存由独立 `Moderation:RegionPolicy:IpHashKey` 生成的 HMAC hash；缺失 key 时 fail closed，不使用硬编码或 JWT fallback。轮换该 pepper 后旧 `submit_ip_hash` 不可重算，应通过安全轮换工具清空旧 hash。匿名评论 `moderation_subject_hash` 由 `HMAC-SHA256(Moderation:Pepper, nullifierHash)` 派生，不拼接 scope，不使用裸 SHA-256；缺失 `Moderation:Pepper` 时启动和运行时均 fail closed。策略 replay 通过服务层生成 `RegionPolicyReplayDiff`，用于比较 blocked regions、risk labels、publishability 和公开可见性变化。

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

管理端创建分类和标签均使用 binary mutation path，写入成功响应 `MutationId`，编辑器可用返回的 `id` 立即选中新建分类或关联新建标签，不能只依赖刷新列表后按名称猜测：

| 方法 | 路径 | 请求 frame | 响应 frame |
|------|------|------------|------------|
| POST | `/api/binary/category` | `CategoryWriteRequest` | `MutationId` |
| POST | `/api/binary/tag` | `TagWriteRequest` | `MutationId` |

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
  "conversationId": "123",
  "subject": "系统通知",
  "status": 0,
  "isSystemSource": true,
  "canReply": true,
  "lastMessageAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z",
  "unreadCount": 2
}
```

- `status`：`0=open` / `1=pending` / `2=closed`

管理员系统消息使用 `POST /api/binary/admin/messages/system-send` 的 `SystemMessageRequest` frame。当前契约只支持单账号目标，`targetAccountId` 必须存在且大于 0；`targetAccountId=null` 不表示广播，后端会返回 validation error。前端管理入口位于 `/user/manage/messages`，普通 `/user/messagebox` 只承载账号消息和工单。

普通消息端点 `/api/binary/messages/**` 只接受 `identity_kind=anonymous_account` 的账号主体，并从 `AccountPrincipalContext.AccountId` 解析当前账号；不得使用 legacy `CurrentUser` 参数绑定器或把 AdminPrincipal 的 `NameIdentifier` 当作账号 id。管理消息端点 `/api/binary/admin/messages/**` 继续要求 admin principal + `admin.manage`，并用 `AdminMessageActor` 携带 `admin_id/admin_sid`。

管理员更新对话状态时只接受当前数据库行版本上的状态转换：服务端先读取 `msg_conversation.status + xmin`，再用 `id + expected status + row version` 执行更新。并发 close/pending/open 修改中只有一个写入会生效；后到请求如果命中旧版本，返回 HTTP `409` + AEDS `ApiError`，不得以 last-write-wins 覆盖。

消息表最终 schema 只允许账号 / 管理员主体列：`msg_conversation.initiatoraccountid`、`msg_message.senderaccountid`、`msg_participant_state.accountid` 以及对应 admin-principal 列。`msg_conversation.initiatoruserid`、`msg_message.senderid`、`msg_participant_state.userid` 和 `*_identity_sync` trigger/function 只属于一次性迁移兼容面，finalize 后不得出现在备份、恢复或运行时契约中。

### `ConversationMessageResponse`

```json
{
  "messageId": "456",
  "conversationId": "123",
  "senderType": 0,
  "senderName": "你",
  "body": "消息内容",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

`senderType` 的数值保持 wire 兼容：`0=Account`、`1=Admin`、`2=System`。响应不暴露 sender account id、用户名、公开昵称或头像；显示名只使用“你 / 管理员 / 系统”这类上下文安全文本。

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

`CommentAdded` 的 `payload.comment` 与评论读取 DTO 对齐：必须包含 `author: CommentAuthorViewDto`，回复可包含 `replyToAuthor: CommentAuthorViewDto`，不得包含 legacy identity fields。前端 stream patcher 与 `useArticleCommentStream` 只从这两个作者快照渲染展示名。

### `NotificationHeartbeat`

对应 `AedsFrameType.NotificationHeartbeat = 70`。

载荷布局：

```text
int64 timestampUnixMs
```

### Development/Test drill publish

`POST /_fsus/testing/notification-stream/publish` 只在 Development/Test 环境映射，并要求 `X-Fsus-Notification-Drill-Secret` 匹配 `FSUSBLOG_NOTIFICATION_DRILL_SECRET` / `NotificationStream:DrillSecret`。请求还必须携带 `X-Fsus-Notification-Drill-Timestamp`、`X-Fsus-Notification-Drill-Nonce` 与 `X-Fsus-Notification-Drill-Signature`；signature 为 `HMAC-SHA256(secret, timestamp + "\n" + nonce + "\n" + rawBody)` 的小写 hex，timestamp 允许偏差 60 秒，nonce 在同窗口内只能使用一次。请求体为 JSON tooling payload：

```json
{
  "drillId": "notification-slow-consumer-...",
  "count": 384,
  "payloadBytes": 1024,
  "routeKey": "content-feed"
}
```

服务端通过真实 `INotificationStreamPublisher` 写入 backlog 并触发本机 fanout，响应包含 `status`、`drillId`、`routeKey`、`eventType`、`count` 与 `eventIds`。该入口只供 resilience evidence 使用，生产环境不映射，未配置 secret 时返回 `404`。

### Test-only schema migration qualification

以下两个 JSON tooling routes 仅在 environment 精确为 `Test` 且
`SchemaMigration:QualificationEnabled=true` 时映射；两者均要求 admin
`system.config` 并应用 `fixed_ip` rate limit。Production/Development 中配置为 true
也不会注册。

`POST /api/release-evidence/schema-bridge/write`

请求：

```json
{
  "operationId": "source-migration-run-001",
  "sequence": 1
}
```

`operationId` trim 后必须为 3..96 个 ASCII letters/digits/`-_.`；`sequence` 必须为
1..1,000,000。无效输入返回 `400 {"code":"schema_qualification_write_invalid"}`。
成功执行 qualification control table 的 idempotent upsert，并返回：

```json
{
  "bridgeWrite": true,
  "operationId": "source-migration-run-001",
  "sequence": 1,
  "releaseId": "release-blue-...",
  "slot": "blue"
}
```

`GET /api/release-evidence/schema-qualification/readiness`

- ready：HTTP 200，`{"status":"ready","code":"ok"}`；
- isolated missing Expand：HTTP 503，
  `{"status":"not_ready","code":"schema_incompatible"}`。

两条响应都携带 `X-Fsus-Release-Id`、`X-Fsus-Release-Slot` 与
`Cache-Control: no-store`。这些 header 用于 source/target identity 对账，不是认证
凭据。route 只供 #1031 隔离 migration qualification；真实生产 migration 仍只能由
`tools/deployment/release-rollout.sh` 串联正式 migration runner。

### Development local auth fixture

`GET /__local/auth-fixture/admin` 与 `GET /api/local/auth-fixture/admin` 只在 `Development` 且 `fsus:allowLocalAuthFixture=true` 时映射；调用方还必须来自 loopback 地址，并提供 `X-Fsus-Local-Auth-Fixture-Secret`，其值用固定时间比较匹配 `fsus:localAuthFixtureSecret`。配套的 `/status` 端点使用相同的 loopback + shared-secret 门控。生产启动校验会拒绝 `fsus:allowLocalAuthFixture=true`。该入口只用于本地 Playwright fixture 刷新和 cookie 注入，不能在测试、预发布或生产环境作为匿名 admin 登录 fallback；刷新失败只返回固定失败文案，不回显脚本 stderr/stdout、异常消息或本地 storage-state 绝对路径。

fixture 刷新进程只能通过 `UseShellExecute=false` + `ArgumentList` 调用仓库内固定脚本 `tests/frontend/fixtures/prepare-auth-smoke-users.mjs`。服务端在启动子进程前必须对 repo root、fixtures 目录和脚本路径执行 canonical path 校验，确认目标仍位于预期 fixtures 目录内；executable 与脚本路径都不接受请求参数、配置值、环境派生的相对逃逸或替换文件名。默认 runner 设有 60 秒上限，传播请求取消，非零退出、启动失败和超时均在写 Cookie 前返回固定失败，不向响应或日志转发 stdout/stderr。Production 不映射 fixture endpoint，因而不会从请求链解析或调用 runner；行为测试可通过 DI 注入 fake runner，以真实端点和 storage-state 文件验证成功/失败边界而不启动子进程。

fixture 成功读取 `user.storage-state.json` 的 `AccessToken.expires` 与 `admin.storage-state.json` 的 `AdminAccessToken.expires`，按 Unix 秒转换为绝对 UTC 后原样写入对应 `Set-Cookie Expires`。该路径不得把 access expiry 替换为 fixture 请求时间、refresh/admin idle expiry 或 `Jwt:AccessTokenExpiresMinutes`；runner 失败、storage-state 缺失或 access expiry 非法时不得发出任何新认证 Cookie。

fixture redirect query 最大 2048 字符；`user.storage-state.json` / `admin.storage-state.json` 单文件最大 256 KiB，超过上限视为 fixture 不可用，不解析 JSON。

### `NotificationStreamEventType` 枚举

| 值 | 名称 | 载荷类型 | 说明 |
|----|------|---------|------|
| 1 | `NoticeReceived` | `GlobalNoticePayload` | 用户收到通知 |
| 2 | `GlobalNoticePublished` | `GlobalNoticePayload` | 全站广播（公开） |
| 3 | `UnreadCountUpdated` | `UnreadCountPayload` | 未读数变更 |
| 4 | `AccountStatusChanged` | `AccountStatusPayload` | 账号状态变化（封禁等） |
| 5 | `CommentAdded` | `CommentAddedNotifyDto` | 新评论通知；`comment` 只携带 `author: CommentAuthorViewDto` 与可空 `replyToAuthor: CommentAuthorViewDto` 快照，不携带 legacy identity fields |
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

所有上传端点在 `/api/binary/upload/` 路径下，需要 admin principal + `article.write` 权限。`uploadId` 由服务端生成并返回，wire 格式固定为 32 位 GUID `N` 格式；status、part map、part upload、complete 和 abort 路由只接受该形态并规范化为小写 canonical 值，非法值返回 validation error，不会被当作文件系统路径继续解析。`/part` 和 `/complete` 还必须携带 `X-Fsus-Upload-Token`，其值来自初始化响应的 `uploadToken`。`/part` 必须携带明确 `Content-Length`，chunked transfer-encoding 返回 411；上传总大小上限为 20 MiB，Kestrel request body limit 必须覆盖该上限和协议开销。允许的目标图片格式为 jpg/jpeg/png/gif/webp，品牌图标生成允许额外上传 `ico` favicon 成品；AVIF 与 SVG 在具备像素维度、metadata bomb、decoder 风险防护和 SVG 清洗前不属于 upload allow-list。`.upload-sessions` manifest 和 part 文件只允许 owner read/write，manifest 使用随机 sibling temp path 后原子发布。

### `UploadInitDto`（初始化响应）

```json
{
  "uploadId": "32-char-guid-n",
  "fileName": "image.png",
  "mimeType": "image/png",
  "targetFormat": "png",
  "totalBytes": 15728640,
  "chunkSize": 5242880,
  "totalParts": 3,
  "expiresAt": "2026-01-01T01:00:00Z",
  "uploadToken": "64-char-random-hex"
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

`SeoConfig` 同时用于公开 SEO/head/PWA manifest、admin 统一 SEO 设置页和运行时品牌资产。公开端点为 `GET /api/binary/system/seo`，admin 读取为 `GET /api/binary/system/admin/seo`，保存为 `PUT /api/binary/system/seo` + `SeoConfigUpdateRequest`，写入必须携带 PoW 和 action=`admin-sensitive` 的 `X-Fsus-Mfa-Proof`，并通过可信 `Origin` / `Referer`。保存后必须失效 system SEO cache、Public AOT shell、动态 `manifest.webmanifest` 和公开 shell hydration。动态 `/manifest.webmanifest` 是 SEO 配置派生资源，服务端按 SEO/PWA 字段缓存序列化后的 manifest bytes，使用派生 bytes hash 生成 ETag；`If-None-Match` 命中时返回 `304` 且不重复写完整 manifest body。

```json
{
  "title": "Fsu's Blog",
  "description": "站点描述",
  "keywords": "博客,技术,写作",
  "author": "Fsu",
  "ogImage": "/social/og-image.png",
  "baseUrl": "https://fsus.blog",
  "faviconSvgUrl": "/favicon/favicon.svg",
  "faviconIcoUrl": "/favicon/favicon.ico",
  "faviconPngUrl": "/favicon/favicon-32x32.png",
  "appleTouchIconUrl": "/favicon/apple-touch-icon.png",
  "manifestName": "Fsus Blog",
  "manifestShortName": "Fsus",
  "pwaIcon192Url": "/favicon/pwa-192x192.png",
  "pwaIcon512Url": "/favicon/pwa-512x512.png",
  "pwaMaskableIconUrl": "/favicon/maskable-icon-512x512.png",
  "themeColor": "#0B4F7A",
  "backgroundColor": "#FFFFFF",
  "siteLogoUrl": "/brand/site-logo.svg",
  "siteLogoDarkUrl": "/brand/site-logo-dark.svg",
  "siteWordmarkUrl": "/brand/site-wordmark.svg",
  "adminLogoUrl": "/brand/admin-logo.svg",
  "adminCollapsedIconUrl": "/brand/admin-icon.svg",
  "loginLogoUrl": "/brand/login-logo.svg",
  "loginIconUrl": "/brand/login-icon.svg"
}
```

URL 字段只接受空值、站内绝对路径 `/...` 或 `http/https` 绝对 URL；`javascript:`、`data:`、协议相对 URL 和空字节会被后端归一化为默认值或空值。`themeColor` 与 `backgroundColor` 只接受 `#RGB` / `#RRGGBB`。后台不得新增 `/system/brand` 并行主配置端点，品牌资产必须挂在同一个 SEO 配置模型上。缺省品牌资产来自前端 public 目录中随仓库提交的 `/favicon/*` 与 `/social/*` 文件；根目录旧 favicon / Apple Touch Icon / `/icons/*` 入口不作为品牌资产入口保留。已有后台 SEO 配置中的非默认自定义值继续优先生效；历史内置默认值只在读取投影时折叠为当前缺省值，不做隐式数据迁移。

Admin 设置页的品牌资产上传只是把现有上传结果回填到对应字段，目标语义在客户端区分为 `ogImage`、`brandLogo` 和 `faviconSet`，不改变 SEO 配置 wire model。`brandLogo` 字段上传接受 PNG/JPG/WebP 栅格图并保留手填 URL；SVG 只允许手填已清洗的安全 URL，不做 PNG/JPG/WebP 到 SVG 的自动矢量化。`faviconSet` 生成从一张 PNG/JPG/WebP 源图派生并回填 `faviconIcoUrl`、`faviconPngUrl`、`appleTouchIconUrl`、`pwaIcon192Url`、`pwaIcon512Url` 和 `pwaMaskableIconUrl`；ICO 文件包含 16/32/48 PNG 帧，PNG favicon 为 96px，Apple Touch Icon 为 180px，PWA 图标为 192/512px，maskable 图标为 512px 并保留透明安全边距。生成流程使用透明背景等比填充，不裁切源图。

### `SiteComplianceConfigContract`

`SiteComplianceConfig` 同时用于公开 footer 与 admin 表单。公开端点为 `GET /api/binary/system/compliance`，admin 读取为 `GET /api/binary/system/admin/compliance`，保存为 `PUT /api/binary/system/compliance` + `SiteComplianceConfigUpdateRequest`，写入必须携带 PoW 和 action=`admin-sensitive` 的 `X-Fsus-Mfa-Proof`。

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

静态页面当前是固定页集合，读写范围必须一致：`about`、`privacy`、`guidelines`、`copyright`。匿名读取 `/api/binary/system/page/{slug}`、admin 读取 `/api/binary/system/admin/page/{slug}`、admin 写入 `/api/binary/system/page` 与缓存刷新 `/api/binary/system/page/refresh/{slug}` 都必须拒绝 allowlist 之外的 slug。admin 写入和刷新必须携带 PoW 和 action=`admin-sensitive` 的 `X-Fsus-Mfa-Proof`。页面保存后服务端会刷新相关缓存和对应 Public AOT 静态页；刷新端点是管理端强制刷新入口，前端设置页可手动调用。

---

## 管理端统计契约

### `AdminStatsQueryDto`（`GET /api/binary/stats`，Binary 响应）

对应 `AedsFrameType.AdminStats`，POD 结构包含：

```
SiteStatsPod、共享 UTF-8 blob、popular article records、recent comment records、region records
```

服务端对外 query model 是 `AdminStatsQueryDto`：`Overview` 对应统计摘要与热门文章，`RecentComments` 对应最近评论，`Regions` 对应地区分布。前端 dashboard 从单个 `AdminStats` frame 派生三个视图区块；`/api/binary/stats/recent-comments` 与 `/api/binary/stats/regions` 仅保留为兼容窄读入口。

`RecentComments` 只使用 comment 行内作者快照，不连接 `sys_user`，字段为 `authorDisplayName`、`authorMode`、`authorBadge`、`authorScopeLabel`、`credentialLevel`、`content`、`createTime`；不得恢复账号作者标识或 legacy display 字段。

`Overview.Summary` 的阅读字段为匿名安全口径：

| 字段 | 说明 |
|------|------|
| `totalReads` | `sys_visit_log` 中的总阅读事件数 |
| `humanVerifiedReads` | 带 `proof_id` 的真人 proof 事件数 |
| `uniqueViewerKeyEstimate` | 按 `viewer_key_hash` 去重后的估算 viewer key 数 |
| `articleReads` | `event_type=article_read` 的文章阅读事件数 |
| `siteReads` | `event_type=site_read` 的站点阅读事件数 |

该摘要不暴露注册/匿名账号拆分，也不得恢复 `VisitLog.UserId` 或从历史 `sys_visit_log.userid` / `sys_visit_log.user_id` 派生身份统计。

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
- 过期或 renderer/frontend asset version 不匹配的条目不得作为 stale HTML 返回；运行时必须删除旧
  artifact，返回 SPA index fallback，并排队 backfill。响应头只用
  `X-Fsus-Public-Aot-State: fresh|fallback` 区分 fresh 命中和 SPA fallback。
- AOT HTML 缓存同时校验 `rendererVersion` 与 frontend asset version；前端 `index.html` 或
  `.vite/manifest.json` 变化会自动拒绝旧缓存，并按 frontend asset version 隔离文件 artifact。
- AOT HTML 模板只接受以下 5 个具名 sentinel；sentinel 是字符串相等匹配，不接受通配式标记：
  - `<!--fsus:aot:head-start-->`：SEO/head 注入起点。
  - `<!--fsus:aot:head-end-->`：SEO/head 注入终点。
  - `<!--fsus:aot:app-->`：SPA/AOT shell 挂载点。
  - `<!--fsus:aot:payloads-->`：bootstrap AEDS 注入点与 hydration `.aeds` sidecar marker 注入点。
  - `<!--fsus:aot:spa-boot-->`：deferred SPA boot 注入点。
- 由 Public AOT 管理的 SEO head 节点必须带 `data-fsus-aot-head`。新增 sentinel 必须同步 `src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs`、`docs/api/design.md` 和 `tests/frontend/checks/public/check-public-aot-contracts.mjs`。
- 含 `<head>`、inline `script` 或 inline `style` 的 document 在 publication/decode 阶段编译 CSP nonce UTF-8 segment template。模板绑定 renderer version、frontend asset version、artifact ETag/digest；请求只写预计算 segment/slot，不重新扫描或生成完整 rendered string/byte array。malformed/重复 nonce、预渲染 `csp-nonce` meta、原始 placeholder、重复 head、未闭合或自闭合 script/style 必须 fail closed。
- nonce document 响应固定为 identity、`Cache-Control: private,no-store`、无 `Content-Encoding`、无 `ETag`/`304`；`Accept-Encoding` 明确 `identity;q=0` 时返回 406。无 nonce document 继续使用预生成 identity/br/gzip variant 与各自 strong ETag。HEAD 只返回按实际随机 nonce 长度计算的 Content-Length，不写 body。
- PublicHotRead runtime snapshot 的 `residentBytes` 是 `independent-readonly-arrays-upper-bound-v1` 总上界，包含 binary variants、HTML bytes、nonce template UTF-8 bytes、slot table、构建生成的静态 inline SHA-256 feasibility list、metadata 与 key/index 估算；`htmlTemplateResidentBytes` 单独可观测。分项或 candidate/current overlap 超出动态/显式 budget 时新 snapshot 不得发布，旧 snapshot/version/ETag/invalidation 语义保持不变。

### Public AOT Route Manifest

`GET /internal/public-aot/manifest` 返回后端权威公开 SEO route 清单，供预热脚本和内容变更驱动 backfill 使用。该端点只列出公开可访问 route；文章 route 必须满足 `Published`、未删除、已到 `PublishedAt` / `ScheduledPublishAt` 时间。生产环境 `PublicAot:ManifestToken` 是必填独立 secret；调用方必须携带匹配的 `X-Fsus-Public-Aot-Token`，否则返回 `403`。非生产环境可空 token 以支持本地工具链。

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

`GET /api/public/navigation-snapshot.aeds?path={publicPath}` 返回公开路由的原子接管快照，供 SPA 在路由切换前预取并写入 `PublicRouteSeedStore`。该端点匿名可读，`Accept` 允许空值、`*/*`、`application/octet-stream` 或 `application/vnd.fsus.aeds`；成功响应固定为 `Content-Type: application/vnd.fsus.aeds`，AEDS frame type 复用 `PublicAotBootstrap`。成功帧使用内容 ETag 与 `Cache-Control: no-cache`，缓存可以保存响应但每次使用前必须向源站重验证；`Vary` 固定包含 `Accept, X-Fsus-Test-Session`。内容突变后的 micro-navigation 不允许命中旧 `max-age` / `stale-while-revalidate` 快照。

`path` 必须是同站相对 URL、长度不超过 512 字符，可包含 query；服务端会丢弃 fragment，并通过 Public AOT route registry 校验目标。允许范围与 SEO/AOT 公开页一致：`/`、`/archive`、`/article/{id}`、`/category/{id}`、`/tag/{id|name}`、`/about`、`/privacy`、`/guidelines`、`/copyright`。`/account`、`/search`、`/admin`、空 path、协议相对 URL 和绝对外链必须 fail closed。端点受 `public_read` 限流。

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

hydration payload sidecar 的 URL 只允许解析到 web root 内的静态文件路径。AOT cache 读取持久化 entry、document service 写入 sidecar、Node SSR worker script 启动前都必须使用 canonical full path + relative path 校验确认目标没有逃逸各自 root；越界 sidecar 视为 cache entry 无效或跳过写入，越界 worker script 直接 fail closed，不尝试执行。

`/api/public/navigation-snapshot` 的 `path` query 最大 512 字符，且必须是站内相对公开路径；超长、跨站 URL、反斜杠、CR/LF 或私有路径一律返回固定错误。

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

文章详情 hydration 使用 `bodyContent` 承载原始 Markdown，使用 `bodyHtml` 承载 SSR 渲染后的 HTML。`content` 不再是 AOT 契约字段。`rights` 是 ArticleDetail hydration 与 `detailView.rights` 的必填字段，来自冻结 `article_rights_snapshot`；旧的无 rights hydration 合同已废弃，前端 normalizer 必须拒绝。

```json
{
  "pageKind": "ArticleDetail",
  "routeKey": "article:42",
  "articleId": 42,
  "bodyContent": "# Heading",
  "bodyHtml": "<h1>Heading</h1>",
  "rights": {
    "snapshotId": "901",
    "articleRevisionId": "801",
    "revisionNo": 7,
    "enabled": true,
    "licenseType": "CC-BY-4.0",
    "copyPolicy": "append-attribution",
    "maxExcerptChars": 300,
    "allowCodeCopy": true,
    "showPublicBadge": true,
    "proofBindingEnabled": true,
    "policyHash": "sha256:<64 lowercase hex>",
    "contentCanonicalHash": "sha256:<64 lowercase hex>"
  },
  "detailView": {
    "rights": {
      "snapshotId": "901",
      "articleRevisionId": "801",
      "revisionNo": 7,
      "enabled": true,
      "licenseType": "CC-BY-4.0",
      "copyPolicy": "append-attribution",
      "maxExcerptChars": 300,
      "allowCodeCopy": true,
      "showPublicBadge": true,
      "proofBindingEnabled": true,
      "policyHash": "sha256:<64 lowercase hex>",
      "contentCanonicalHash": "sha256:<64 lowercase hex>"
    }
  },
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

该状态来自 `CrawlerUpdateWorker` 的远程官方 JSON → last-known-good snapshot → 配置项 → empty degraded 加载链，只用于运维诊断，不返回客户端 IP、User-Agent 或用户数据。远程 CIDR URL 必须是 HTTPS，host 只允许 `developers.google.com` 或 `www.bing.com`，且不得使用非默认 HTTPS 端口；生产启动校验、`PUT /api/binary/admin/security/anti-crawler/options` 和 worker 同步前都会拒绝非法 URL，不做兼容回退。

### Site Subscription

订阅表单使用 AEDS，不保存明文 email；服务端只写入由 `Subscription:EmailHashPepper` 派生的 `HMAC-SHA256(normalizedEmail)` keyed lookup identifier、`hash_version` 与归一化 channel。该值仅用于本部署内去重/查找，不是明文 email，也不是跨环境或跨系统稳定身份标识；旧裸 `SHA256(normalizedEmail)` 只允许在迁移期作为一次性匹配来源并在下一次写入时升级到当前 HMAC。公开退订必须额外携带一次性 `X-Fsus-Subscription-Proof`，proof 由服务内部签发并可交给受控外部投递域发送，绑定 keyed email hash 与 channel；当前公开 API 不提供明文 email 查询或无 proof 退订入口。

| 方法 | 路径 | 请求帧 | 响应帧 | 说明 |
|------|------|--------|--------|------|
| POST | `/api/binary/subscriptions` | `SiteSubscriptionRequest` | `SiteSubscriptionResponse` | 启用订阅，响应只包含 `subscribed=true` 与归一化 channel |
| DELETE | `/api/binary/subscriptions` | `SiteSubscriptionRequest` + `X-Fsus-Subscription-Proof` | `SiteSubscriptionResponse` | 退订；缺失、重放、过期或绑定不匹配返回 428 + `ApiError` frame，DB 不更新 |

`SiteSubscriptionRequest` payload 是 `SiteSubscriptionRequestPod`：fixed UTF-8 `Email(256)` + `Channel(32)`。`SiteSubscriptionResponse` payload 是 `SiteSubscriptionResponsePod`：`subscribed:byte`、`unsubscribed:byte`、reserved、fixed UTF-8 `Channel(32)`。非法 email 返回 HTTP 400 + `ApiError` frame，响应不得回显明文 email。退订 proof 不进入 AEDS payload，cache key 只使用 proof token hash，不包含原始 email；DELETE 先按绑定的 `email_hash` + `channel` 非消费校验 proof，只有 `site_subscription` 更新成功后才提交一次性消费，DB 失败或请求取消时 proof 保持可重试。

服务端在 normalization、lowercase、HMAC/SHA-256 前拒绝超过 254 字符的 email，避免匿名订阅接口对超大输入执行无意义分配或 hash。

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

`CreateArticleRequest` 与 `UpdateArticleRequest` 支持 `status`、`scheduledPublishAt`、`rights`。公开读路径必须同时检查 `IsDeleted=false`、`Status=Published`、`PublishedAt<=now`、`ScheduledPublishAt<=now`。

Binary 写入帧 **ArticleWriteRequest V3**（`ArticleWriteRequest` 当前版本）使用旧 `ArticleWriteRequestPod` + `tagIds:int32[]` + article blob 作为主体，随后按顺序追加 `status:int32`、`scheduledPublishAtUnixMs:int64`、`version:int32=3`、`rightsFlags:int32`、`copyrightYear:int32`、`maxExcerptChars:int32`、`ArticleRightsWriteRequestPod`、rights blob。`rightsFlags` bit 定义为：`1 enabled`、`2 allowCodeCopy`、`4 showPublicBadge`、`8 proofBindingEnabled`、`16 hasCopyrightYear`。`ArticleRightsWriteRequestPod` 只包含 UTF-8 slice：`licenseType`、`copyrightHolder`、`rightsStatement`、`attributionTemplate`、`copyPolicy`。缺少 V3 rights 段的 legacy 写入 payload 必须拒绝，不得再按 `Published` / 无定时发布静默补齐。

Binary 读取帧 **ArticleDetail AEDS V3**（`ArticleDetail` 当前 payload 版本）使用 V3 envelope：`ArticleDetailV3HeaderPod` (`magic=ARD3`, `version=3`) + `ArticleDetailV3RecordPod` + `ArticleDetailTagV3RecordPod[]` + 必备 `ArticleRightsV3RecordPod` + 共享 blob。后端 public artifact、admin detail 和 server cache 都必须从 `article_rights_snapshot` 的冻结读模型投影 rights 字段；legacy ArticleDetail payloads 和旧 ArticleDetail tail 必须拒绝，不得新增独立 `/rights.aeds` fallback。

Public Rights V3 presentation 只读取已解码的 `ArticleDetail.rights` / `detailView.rights`，does not request a separate rights endpoint，也不新增 `/rights`、`rights.aeds` 或其它 side channel。公开文章页和 PublicAOT ArticleDetail 由同一个 `PublicArticleDetailPageContent` 渲染可见版权提示与 metadata，PublicAOT ArticleDetail output includes rights metadata：`license`、`copyrightHolder`、`copyrightYear`、rights snapshot id、policy hash、content canonical hash、copy policy。代码块复制增强必须读取 `allowCodeCopy`；当 decoded rights 关闭代码复制时，运行时不得插入复制按钮，并清理已经注入的 code-copy DOM。

`GET /api/binary/admin/article` 的 `status` 查询参数仅 admin 可用。公开 `/api/binary/article/**.aeds` 不接受 query string、请求体或 credentials；admin 不带 `status` 时读取所有非删除状态，带 `status=0/1/2/3/4` 时读取对应 draft/scheduled/published/archived/deleted 集合。admin article list 的 `page` / `size` 缺省为 `1` / `10`，显式传入 `page<1`、`size<1` 或 `size>100` 返回 `400`。

文章更新请求不得把 `status` 设为 `Deleted`；删除必须走专用 delete endpoint，以便写入回收站状态、失效缓存、搜索、PublicAOT、notification stream 和 outbox。对已删除文章重复删除必须是 no-op，不得重复触发派生副作用。restore 只允许从 `IsDeleted=true` 恢复，并恢复为 `Draft`、清空 `PublishedAt`；发布必须由后续显式发布/更新动作完成，避免把删除前的草稿、归档或定时文章意外公开。`DELETE /api/binary/admin/article/trash` 是批量破坏性操作，要求 admin principal、`article.write`、`fixed_ip`、PoW 和一次性 `X-Fsus-Mfa-Proof`，缺失或复用 proof 返回 `428`，不可信 `Origin` / `Referer` 返回 `403`，并写入包含销毁数量与 outcome 的高价值审计。

delete、restore、permanent-delete 必须先读取 article `xmin`，写入时带 `xmin::text = @RowVersion` 和对应 trash 状态条件。permanent-delete 只允许处理 `IsDeleted=true` 的文章，并在事务内先 `FOR UPDATE` 锁定同一 row-version，再删除评论、标签、正文和文章主行；若 row-version 或 trash 状态已变化，返回 no-op，不得删除子表或发出新 outbox 事件。clear-trash 只能批量处理仍处于 `IsDeleted=true` 的文章，并按实际销毁数量返回 `TrashClearResponse`。

公开与管理端文章响应矩阵：

| 路径族 | 身份 | 状态范围 | 失败语义 |
|--------|------|----------|----------|
| `/api/binary/article/**.aeds` | 匿名公开，客户端 `credentials: omit` | 仅 `Published` 且发布时间已到、`IsDeleted=false`；帧内管理尾字段只允许公开安全值 | L0 miss/not-ready/协议错误只返回 HTTP 状态；前端按 `404`/`503`/`400`/`406` 分别处理 |
| `/api/binary/admin/article/**` | admin | draft/scheduled/published/archived/deleted 按 `status` 查询参数精确读取 | AEDS `ApiError` frame，错误码与 JSON 语义保持一致 |

旧公开 query 路径（如 `/api/binary/article?page=1`、`/api/binary/article/hot?size=10`）不再 fallback；fast path 返回 `400 no-store`，并通过 `X-Fsus-Required-Route` 提示新的 segment artifact 路径。

### Admin 作者工作台

生产前端使用 `/api/binary/author/**`，外层为 AEDS v2 frame。写入请求使用 route-specific request frame（如 `AuthorDraftSaveRequest`、`ModerationRuntimeGlobalStateRequest`、`ContentImportRequest`），响应使用 route-specific response frame（如 `AuthorDraftResponse`、`ModerationRuntimeStatus`、`AuditLogList`）；payload 当前承载类型化 JSON DTO bytes，浏览器不可访问 `JsonApiResponse<T>` envelope，错误统一为 `ApiError` frame。授权、MFA、fixed_ip rate limit、审计和缓存失效边界均由原生 authoring binary endpoint 直接执行；外部 `/api/author/**` JSON endpoint 已移除，且不保留 internal bridge 兼容层：

Authoring binary 写入请求 body 最大 1 MiB。`ServerDraftSaveRequest` 字段上限为：`DraftKey` 96、`Title` 200、`Content` 262144、`Summary` 500、`CoverImageUrl` 2048、`ClientRevision` 128、`WarningOverrideReason` 500；超限请求在 Markdown、内容过滤、快照构建或持久化前按 validation fail closed。

Admin Rights V3 editor panel 是文章编辑器内的 `rights` 写入面板，字段与 `ArticleWriteRequest.rights` 一一对应：`enabled`、`licenseType`、`copyrightHolder`、`copyrightYear`、`rightsStatement`、`attributionTemplate`、`copyPolicy`、`maxExcerptChars`、`allowCodeCopy`、`showPublicBadge`、`proofBindingEnabled`。新文章默认选择“继承站点设置”，管理端会读取站点合规版权配置生成当前生效的文章版权值，并在提交时写入完整 `ArticleWriteRequest.rights` 快照；这不是发布后继续动态跟随站点配置。用户切换为“自定义本文版权”后才允许修改单篇文章字段；编辑既有文章时从冻结 `ArticleDetail.rights` 载入当前策略并进入自定义模式。浏览器 localStorage 只保存不可恢复正文的草稿 metadata，不保存 `rights`、标题、摘要、正文或其他未发布内容；完整 `rights` 只写入 `ServerDraftSaveRequest`，私有预览、发布前检查和最终提交共享同一份当前表单构造。客户端会提前校验 enum values、`copyrightYear`、`maxExcerptChars` 和必填文本字段，但 server-side validation remains authoritative，服务端仍按 Article write path 规范化并拒绝非法或缺失的 V3 rights payload。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/binary/author/drafts` | 保存服务端草稿，按 `ownerAdminPrincipalId + draftKey` 幂等覆盖；owner 来自 admin principal `admin_id`，payload 包含 `status`、`scheduledPublishAt` 与完整 `rights` |
| GET | `/api/binary/author/drafts/{draftKey}` | 读取服务端草稿；不存在时返回 `success=true,data=null`，存在时返回 `updatedAt`、`clientRevision`、发布状态、定时发布时间与 `rights` |
| DELETE | `/api/binary/author/drafts/{draftKey}` | 丢弃服务端草稿；编辑器同步清除浏览器中的草稿 metadata |
| POST | `/api/binary/author/preview` | admin-only 私有预览，输出经过转义的 Markdown/AOT-like HTML，根节点带 `data-preview-only=true`、`data-markdown-renderer=server-preview`，不写 PublicAOT cache |
| POST | `/api/binary/author/prepublish-check` | 发布前检查标题、SEO 描述、封面 URL、Markdown 结构、链接、图片 alt 与危险 HTML |
| GET | `/api/binary/author/articles/{articleId}/revisions` | 最近 50 条修订摘要；actor 字段为 `createdByAdminPrincipalId` |
| GET | `/api/binary/author/articles/{articleId}/revisions/{revisionId}` | 单个修订详情，包含标题、摘要、正文、分类、标签、`createdByAdminPrincipalId` 和审计时间，用于编辑器内比较 |
| POST | `/api/binary/author/articles/{articleId}/revisions/{revisionId}/rollback` | 回滚到指定修订并触发文章更新链；必须携带 `X-Fsus-Mfa-Proof` |
| POST | `/api/binary/author/articles/{articleId}/assets/reindex` | 从正文和封面重建资产引用 |
| GET | `/api/binary/author/assets` | 资产库列表 |
| DELETE | `/api/binary/author/assets/orphans` | 删除引用计数为 0 的孤儿资产库记录 |
| GET | `/api/binary/author/taxonomy/categories` | 管理端分类真实引用计数和删除锁定状态 |
| GET | `/api/binary/author/taxonomy/tags` | 管理端标签真实引用计数和删除锁定状态 |
| GET | `/api/binary/author/analytics` | 单作者公开内容与真实阅读事件概览 |
| GET | `/api/binary/author/comments/moderation?status={0..3}&limit={1..100}` | 评论审核队列，默认读取待审项和模型边界风险自动隐藏项；要求 `comment.moderate` |
| POST | `/api/binary/author/comments/moderation/bulk` | 批量通过、拒绝或隐藏评论，可联动封禁用户；要求 `comment.moderate`，必须携带 `X-Fsus-Mfa-Proof` |
| POST | `/api/binary/author/comments/{commentId}/moderation` | 评论审核状态更新；要求 `comment.moderate`，必须携带 `X-Fsus-Mfa-Proof` |
| GET | `/api/binary/author/moderation/overview` | 审核系统总览，返回队列计数、词库/地区策略数量、`CN-MAINLAND` strict policy 状态和模型配置摘要 |
| GET | `/api/binary/author/moderation/anonymous-comment-policy` | 读取匿名评论策略 snapshot；要求 `anonymous.comment.configure` |
| PUT | `/api/binary/author/moderation/anonymous-comment-policy` | 更新匿名评论 enable/disable、public/ZK 开关、默认 author mode 和评论长度策略；必须携带 `X-Fsus-Mfa-Proof` 并写高价值审计 |
| POST | `/api/binary/author/comments/moderation/nullifiers/block` | 审核队列快捷封禁匿名评论 nullifier；必须携带 `X-Fsus-Mfa-Proof`、要求 `anonymous.nullifier.block` |
| POST | `/api/binary/author/comments/moderation/anonymous-credentials/{credentialId}/revoke` | 审核队列快捷撤销匿名凭证；必须携带 `X-Fsus-Mfa-Proof`、要求 `anonymous.credential.revoke` |
| GET | `/api/binary/admin/anonymous-governance/status` | 匿名治理后台状态，返回 root/verifier/revocation/comment 聚合；要求 `anonymous.comment.configure` 与 `X-Fsus-Mfa-Proof` |
| GET | `/api/binary/admin/anonymous-governance/nullifiers` | 匿名 nullifier 治理列表，只返回 masked hash、scope、状态和封禁历史；要求 `anonymous.nullifier.block` 与 `X-Fsus-Mfa-Proof` |
| POST | `/api/binary/admin/anonymous-governance/nullifiers/block` | 匿名治理后台封禁 nullifier，request 使用 hash + scope + reason；要求 `anonymous.nullifier.block` 与 `X-Fsus-Mfa-Proof`，高价值审计只记录 hash 摘要 |
| POST | `/api/binary/admin/anonymous-governance/credentials/revoke` | 按 epoch/root/revocation handle/revocation root 撤销匿名凭证；要求 `anonymous.credential.revoke` 与 `X-Fsus-Mfa-Proof`，高价值审计只记录不可逆 target 摘要 |
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
| POST | `/api/binary/author/articles/import` | Markdown + frontmatter 导入；必须携带 `X-Fsus-Mfa-Proof` |
| GET | `/api/binary/author/audit` | 结构化审计日志列表，支持 actor/action/target/outcome/severity/time 过滤；默认 `piiMode=pii-redacted`，完整 `IpHash`/`UserAgentHash`/`SessionIdHash`/`DeviceFingerprintHash` 仅限具备 `audit.investigate` 且显式传 `piiMode=investigation` 的 admin，并写高价值审计 |
| GET | `/api/binary/author/audit/summary` | 当前过滤条件下的审计 facet 与写入 runtime |
| GET | `/api/binary/author/audit/{id}` | 审计详情、context JSON 与防篡改校验结果；敏感 hash 字段与列表相同，默认 redacted，investigation 读取要求 `audit.investigate` |
| GET | `/api/binary/author/audit/{id}/verify` | 单条审计 `record_hash` / `record_mac` 与同链 `prev_hash` 前驱校验 |
| GET | `/api/binary/author/ops/health` | 运维健康面板数据：PostgreSQL、Redis、audit、Crawler CIDR、备份、PublicHotRead、search、worker、队列和结构化最近错误 |
| GET | `/api/ops/health/ready-detail` | 受保护详细 readiness JSON：配置、PostgreSQL、Redis、资源、runtime、observability、RiskControl/perception-sealed@v2 gate；要求 admin principal `audit.read` |
| GET | `/api/ops/deployment/status` | 受保护发布状态 JSON；要求 admin principal `system.config`、fixed-IP limit 与 loopback source |
| POST | `/api/ops/deployment/activate` | 受保护激活 CAS；body 为 `releaseId/slot/generation`，仅 Ready Candidate 接受；正确重复请求幂等 |
| POST | `/api/ops/deployment/drain` | 受保护排空 CAS；body 为 `releaseId/slot/generation/timeoutSeconds?`，超时仅限 5..300 秒；正确重复请求幂等 |
| GET/POST | `/api/ops/deployment/fence/status|acquire|revoke` | 受保护 active-release fence 查询/CAS/撤销；要求 admin principal `system.config`、fixed-IP limit 与 loopback source |
| GET/POST | `/api/ops/deployment/notification-stream/restart/status|restart` | 受保护 notification stream 1012 restart 协议；请求必须绑定精确 release/slot/generation |
| POST | `/api/ops/deployment/notification-stream/drill/publish` | 零停机演练专用事件发布；`Deployment:NotificationStreamDrillEnabled=false` 时固定 404，启用后仍要求 admin `system.config`、loopback、active runtime 与 active fence |

匿名 `/health/ready` 只返回最小 readiness 结果，配置错误和依赖异常必须被归一为 `configuration_invalid`、`dependency_unavailable` 等固定类别，不暴露配置键、validation error 列表、连接串、URL、CIDR、exception type 或 provider/backend 细节。完整失败明细只允许在受保护的 `/api/ops/health/ready-detail` 和后台运维视图中按权限查看。

`DeploymentRuntimeSnapshot` 字段为 `releaseId`、`slot`、`mode`、`state`、`generation`、`startedAtUtc`、`activatedAtUtc?`、`drainStartedAtUtc?`、`inFlightHttpRequests`、`notificationStreamConnections`、`activeBackgroundClaims`、`drain`、`canReceiveTraffic`、`canClaimBackgroundWork`、`canAcceptNotificationStream`、`lastFailureStage?`、`lastErrorCode?`。`drain` 固定包含 `requested/drained/timedOut/deadlineUtc?/blockers/components`；每个 component 只有 bounded `name/pendingCount/blocking/status/error?`，不得包含 URL、用户、token 或队列 payload。activate/drain 返回 `accepted/idempotent/status/errorCode?/snapshot`；identity 或状态冲突为 409，非 loopback 为 403，认证/权限仍走现有 401/403。错误码固定为 `trusted_host_required`、`deployment_release_mismatch`、`deployment_slot_mismatch`、`deployment_generation_mismatch`、`candidate_not_ready`、`deployment_is_draining`、`deployment_still_starting`。Draining 时普通新请求返回 JSON `503`、`Retry-After: 5`、`Cache-Control: no-store`；notification preflight/握手返回既有 AEDS/notification 错误通道中的 `deployment_draining`（Candidate 为 `deployment_not_active`）和 `Retry-After: 5`，不新增旧文本业务 fallback。

Notification deployment drill 请求固定为 `{releaseId,slot,generation,drillId,count,dryRun}`；`drillId` 只允许 8..96 个 ASCII 字母数字、`.`、`_`、`-`，`count` 为 1..32。成功响应包含精确 release/slot/generation、drillId 与单调 event ID 数组；dry-run 不发布事件。错误固定为 `notification_drill_release_mismatch`、`notification_drill_slot_mismatch`、`notification_drill_generation_mismatch`、`notification_drill_release_not_active`、`notification_drill_active_fence_not_owned`、`notification_drill_id_invalid`、`notification_drill_count_invalid`、`notification_drill_publish_failed`。该 JSON ops 协议不是公开业务 API、AEDS fallback 或测试密钥旁路。

| GET | `/api/binary/author/ops/backup` | 最近站点备份状态，扫描 database/uploads/DataProtection keyring/config/site-package/restore-drill artifacts |
| GET | `/api/binary/author/ops/dangerous-operations/policy` | 管理端危险操作等级、admin passkey step-up、强确认和 diff 策略 |
| GET | `/api/binary/author/cache/diagnostics?articleId={id}` | AOT/PublicHotRead/search/sitemap/feed/comment cache/output cache 诊断，可选单文章定位 |
| POST | `/api/binary/author/cache/actions` | 手动维护动作：`search-rebuild`、`aot-rebuild`、`public-hot-rebuild`、`output-cache-clear`、`recompute-article-rights`、`rebuild-article-detail-aeds-v3`、`sitemap-feed-refresh` |
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

匿名治理后台使用 `/api/binary/admin/anonymous-governance/**` 的 AEDS v2 端点接入，不再由前端 mock 数据驱动。所有端点都要求 admin principal、对应 `AdminPermissions.AnonymousCommentConfigure` / `AnonymousNullifierBlock` / `AnonymousCredentialRevoke`、`fixed_ip` 限流、device fingerprint 和 action=`admin-sensitive` 的一次性 `X-Fsus-Mfa-Proof`。响应 payload 复用 `AnonymousGovernanceActionResponse` frame 承载 JSON DTO；写操作 request 复用 `AnonymousGovernanceActionRequest` frame。DTO 不得包含真实 `userId`、`username`、`publicHandle`、credential commitment、proof、witness、secret 或 nullifier 到账号映射；UI 列表只能展示 `maskedHash`，action payload 可携带 raw nullifier hash 但不得渲染。

`ModerationRuntimeStatusResponse` 返回 `snapshotId/globalState/regionStates/disabledDictionaryIds/model/changedAtUtc/changedBy/reason/expiresAtUtc/lastError`。`model` 是 `ModerationModelRuntimeResponse`，包含 `snapshotId/enabled/provider/modelProfile/thresholdProfile/contractVersion/configChecksum/loadedAtUtc/loadedBy/status/timeoutMs/failOpen/externalProviderAllowed/externalProviderReviewed/lastError`。全局状态支持 `enabled/read_only/disabled_to_pending/emergency_lockdown`，服务层仍能表达 `disabled_pass_through`，但 production 默认拒绝该状态；地区状态支持 `enabled/manual_review_only/no_public_display/read_only/disabled`。请求体包括：`ModerationRuntimeGlobalStateRequest(state, reason?, expiresAtUtc?)`、`ModerationRuntimeRegionStateRequest(region, state, reason?, expiresAtUtc?, confirmPhrase?)`、`ModerationDictionaryStateRequest(reason?, confirmPhrase?)`、`ModerationModelRuntimeRequest(enabled?, provider?, modelProfile?, thresholdProfile?, reason?)`。`CN-MAINLAND` 地区非 `enabled` 变更和强制词库禁用必须传 `confirmPhrase="CONFIRM CN-MAINLAND MODERATION CHANGE"`；`CN-MAINLAND` 地区状态不得设为 `disabled`。

### Admin 安全系统

生产前端使用 `/api/binary/admin/security/**`，外层为 AEDS v2 frame。写入请求使用 route-specific request frame（如 `AntiCrawlerOptionsUpdateRequest`、`SecurityRiskResetRequest`、`AntiCrawlerRuleRequest`、`PowOptionsUpdateRequest`），控制面 dry-run 可使用 `SecurityOverview` JSON frame 承载 route-specific request/response DTO；响应使用 route-specific response frame（如 `SecurityOverview`、`AntiCrawlerPolicySnapshot`、`SecurityRiskEventList`、`PowPolicySnapshot`）；payload 当前承载类型化 JSON DTO bytes，浏览器不可访问 `JsonApiResponse<T>` envelope，错误统一为 `ApiError` frame。admin principal + `system.config` permission、MFA、fixed_ip rate limit、device fingerprint、审计和运行时策略更新边界均由原生 security binary endpoint 直接执行；外部 `/api/admin/security/**` JSON endpoint 已移除，且不保留 internal bridge 兼容层。

`/api/binary/admin/security/**` 全部要求 admin principal + `system.config` 权限。写入型和高价值操作必须携带 admin passkey step-up 产生的 action=`admin-sensitive` 一次性 `X-Fsus-Mfa-Proof`，并写入高价值安全审计。`X-Fsus-Mfa-Proof` 与 PoW replay proof 共用 consume-once cache primitive：L1 先失效，Redis 删除成功后同一进程内也不能再次读取该 proof。安全控制面 actor 只允许从 independent admin principal claims 解析，wire/内部归因格式为 `admin:{admin_id}`；缺失 `identity_kind=admin_principal` 或 `admin_id` 时拒绝请求，不得使用普通账号 `NameIdentifier`、legacy user id 或 `sys_user.role=admin` 作为 fallback。

安全系统 IA 与 API 边界：

- `GET /api/binary/admin/security/overview` 返回 `SecurityOverviewResponse(status, checkedAtUtc, antiCrawler, pow, risk)`。
- `GET /api/binary/admin/security/risk-control/overview` 返回 `RiskControlConsoleResponse(activePolicy, risk, riskEventAggregate, challengeMetrics, recentEvents, topRiskSnapshots)`；`activePolicy` 为 `SecurityRiskPolicySnapshotV2`，`riskEventAggregate` 按 `source/reason` 聚合最近风险事件，`challengeMetrics` 复用最近 24 小时 challenge attempt 成功 / 失败率。
- `GET|PUT /api/binary/admin/security/risk-control/options` 读取或热更新 `SecurityRiskPolicySnapshotV2`。PUT 使用 `RiskControlPolicyUpdateRequest(globalMode?, captchaV1Enabled?, poSpaceV1Enabled?, publicReadChallengeEnabled?, commentRiskControlEnabled?, authRiskControlEnabled?, strictRiskMultiplierPercent?, reason?)`，要求 `X-Fsus-Mfa-Proof`，写入 `security_policy_snapshot(policy_id=risk-control)` 和高价值审计。`globalMode` 只接受 `disabled | observe | enforce | strict | lockdown` 语义；关闭 `captchaV1Enabled` 时不得签发 captcha challenge，关闭 `poSpaceV1Enabled` 时不得签发 Argon2id PoSpace challenge；关闭 public-read/comment/auth 开关会投影到对应 RiskControl action override。
- `POST /api/binary/admin/security/risk-control/options/rollback` 回滚上一份 RiskControl last-known-good policy；优先从 `security_policy_snapshot` 读取 LKG，失败时回退内存上一版本，并写高价值审计。
- `POST /api/binary/admin/security/risk-control/simulate` 使用 `SecurityOverview` request/response frame 承载 `RiskControlSimulationRequest(action?, routeKey?, subject?, riskScore?, clientIp?, userAgent?, deviceFingerprint?, region?, actorStatus?, identityKind?, verifiedCrawler?, socialPreviewBot?)`，返回 `RiskControlSimulationResponse(riskScore, effectiveRiskScore, decision, decisionKind, reasons, requiredChallenges, policyVersion, action, routeKey, subject, clientIp, actorStatus, identityKind, escalationLevel, simulated)`。该端点调用生产 `RiskDecisionService` 与当前 `SecurityRiskPolicySnapshotV2`，不签发 `security_challenge`，不修改策略或风险分；每次调用写入 admin security audit。
- `GET /api/binary/admin/security/challenges/overview?kind={kind}` 返回 `SecurityChallengeMetricsResponse(kind, windowStartedAtUtc, totalIssued, totalAttempts, verified, failed, replayed, expired, revoked, successRate, failureRate, kindBreakdown, recentAttempts)`；`kind` 可传 `captchaV1` 或 `argon2idPoSpaceV1` 等 provider wire kind，不传则返回全部 challenge。
- `GET /api/binary/admin/security/policies/overview` 返回 `SecurityPolicyConsoleResponse(activePolicy, antiCrawler, pow, policyVersions)`；`policyVersions` 来自 `security_policy_snapshot` 持久化表，并额外暴露当前派生 RiskControl policy version。
- `GET /api/binary/admin/security/anti-crawler/overview` 返回 `AntiCrawlerOverviewResponse(policy, summary, crawlerRanges, recentEvents, rules, allowlist, blocklist)`。
- `GET|PUT /api/binary/admin/security/anti-crawler/options` 读取或更新 `AntiCrawlerPolicySnapshot`。
- `POST /api/binary/admin/security/anti-crawler/options/rollback` 回滚上一份反爬虫策略快照。
- `GET|POST /api/binary/admin/security/anti-crawler/crawler-ranges/status|sync` 查看 CIDR worker 状态或手动同步。
- `GET /api/binary/admin/security/anti-crawler/risk-events`、`GET /api/binary/admin/security/risk/events`、`GET /api/binary/admin/security/risk/snapshots` 分别读取反爬虫事件、统一风险事件和风险主体快照。事件/快照列表的 `limit` 缺省为 `100`，服务端强制 clamp 到 `1..1000`，并挂 `fixed_ip` rate limit，避免 admin 可控大 limit 放大为内存或慢查询 DoS。
- `GET|POST|PUT|DELETE /api/binary/admin/security/anti-crawler/rules` 管理运行时反爬虫规则。
- `GET|POST|DELETE /api/binary/admin/security/anti-crawler/allowlist|blocklist` 管理运行时 allow/blocklist。
- `POST /api/binary/admin/security/anti-crawler/simulate` 只返回 dry-run 结果，不修改策略或风险分。
- `GET|PUT /api/binary/admin/security/pow/options` 和 `GET /api/binary/admin/security/pow/overview` 管理 PoW 独立策略。
- `POST /api/binary/admin/security/risk/ip/reset` 重置指定 IP 的统一风险分。

`AntiCrawlerPolicyOptions` 包含 `mode`（`disabled|observe|enforce|strict`）、局部开关 `publicReadChallengeEnabled/searchCrawlerVerificationEnabled/socialPreviewGuardEnabled/riskScoringEnabled/eventPersistenceEnabled/dashboardAggregationEnabled/cidrAutoUpdateEnabled/illegalPathHardAbortEnabled`、阈值 `requireChallengeScore/blockScore/maxRiskScore`、TTL、crawler-aware rate limiter 额度、CIDR 更新时间和 Google/Bing URL。`disabled` 只关闭 crawler 类处置，不关闭 PoW、认证、授权、CORS、Fetch Metadata 或基础路径安全；`observe` 记录事件但不拦截、不触发 public read challenge 升级；`strict` 提高 crawler 类风险分。更新时间运行时热更新，最小间隔默认 30 分钟。

`PowPolicyOptions` 独立包含 `mode/defaultDifficulty/adaptiveDifficultyEnabled/proofTtlSeconds/replayProtectionEnabled/riskScoreLinkEnabled/challengeEndpoint/verificationStrategy`。PoW 是安全系统下与 AntiCrawler 并列的 challenge 能力；反爬虫页面只展示 `securityChallengeReference`，不得把 PoW 作为反爬虫子配置。

`RiskControlConsoleResponse`、`RiskControlPolicyUpdateRequest`、`RiskControlSimulationResponse`、`SecurityChallengeMetricsResponse` 与 `SecurityPolicyConsoleResponse` 均为控制面 DTO，使用 `SecurityOverview` frame 承载 JSON payload，仍要求 admin principal + `system.config`，且不得提供公开 JSON fallback。`risk-control/simulate` 是 dry-run，只能读当前风险分或使用请求给定 riskScore，不调用 challenge orchestrator、不写 `security_challenge`、不调用 `ResetRiskAsync`。策略写入只通过 `risk-control/options`、`risk-control/options/rollback`、`anti-crawler/options`、`anti-crawler/options/rollback`、`pow/options`、`pow/options/rollback` 等登记写入口执行；这些写入口必须校验 `X-Fsus-Mfa-Proof`。策略快照的 `createdByAdminId`、运行时策略响应中的 `changedBy` / `updatedBy` 和高价值 audit `ActorId` 必须来自同一个 `admin_id`，其中响应中的文本 actor 使用 `admin:{admin_id}`。

统一风险抽象为 `SecurityRisk`：`ISecurityRiskSignalSink` 写入 `anti-crawler/rate-limiter/pow/human-read-proof/public-read/captcha/pospace/auth/passkey/risk-control` 来源事件，`ISecurityRiskScoreReader` 读取和重置主体风险分，`ISecurityRiskPolicyProvider` 提供 `SecurityRiskPolicySnapshot`。旧 `CrawlerRiskService` 作为 Redis 热路径兼容实现保留，但 API 与前端不再把 PoW、ReadProof、RateLimiter 归入 AntiCrawler。生产事件同时落到 PostgreSQL `security_risk_event`，可按 `source`、`reason`、`action`、`subjectHash`、`routeKey`、`clientIpHash` 和 `deviceFpHash` 聚合 / 查询；风险分在 Redis miss 时按未过期事件的剩余 TTL 线性衰减重算并回填热缓存。持久化失败只写 structured fallback log，不改变原业务判定。

`AiAssistResponse` 返回 `providerEnabled`、`providerMode`、`externalProviderAllowed`、`auditEvent`、`suggestedSummary`、`suggestedTags`、`titleCandidates`、`translationDraft`、`structureIssues`。前端编辑器只能在 admin 作者工作台内调用该接口；调用结果可用于使用摘要草稿、匹配已有标签、使用标题备选、使用翻译草稿或查看结构检查。外部 provider 必须同时满足 `Authoring:AiAssist:Enabled=true`、非 `local` provider、`AllowExternalProvider=true`、`ExternalProviderReviewed=true`，否则 `externalProviderAllowed=false` 且服务端只返回本地建议。

`ArticlePreviewResponse` 只用于作者工作台内嵌预览：`html` 是服务端按公开阅读页常用 Markdown block/inline 语义生成的安全片段，前端仍必须经过本地 allowlist sanitizer 后放入 `sandbox=""` iframe，不允许 `allow-scripts`，也不允许用户 HTML 中的 `srcdoc`、事件属性、SVG/MathML/iframe/object/embed 或 `javascript:` URL 进入预览文档；`plainText` 用于字数和摘要提示；`issues` 复用发布前检查结果。该响应不得被缓存为公开 AOT、不得进入 feed/sitemap/search/related-reading，也不得被匿名接口返回。

编辑器侧栏必须基于当前表单和 `SeoConfigContract.baseUrl` 实时给出搜索/分享预览：标题、description、canonical URL、OG image 与当前公开路由 slug。提交 `Published` 或 `Scheduled` 前必须调用 `/api/binary/author/prepublish-check`；`severity=error` 阻断提交，`severity=warning` 必须在确认发布弹窗中要求作者填写 `warningOverrideReason` 后才能跳过，服务端写入 `prepublish-warning-override` 审计事件。检查项覆盖标题/摘要/封面、危险 HTML 标签和事件属性、Markdown 未闭合代码块、超大/密集 Markdown 结构、正文图片 alt text、空链接、不安全协议、私有站内路径以及 `/article|category|tag/{id}` 格式错误。当前真实公开文章路由仍以 `/article/{id}` 为准，新文章在落库前只显示 draft-preview slug，不新增持久化 slug 字段。

`AssetLibraryItemResponse` 暴露 `id`、`url`、`altText`、`sourceArticleId`、`referenceCount`、`sha256`、`updatedAt`。重建资产索引会扫描所有文章正文中的 Markdown 图片和文章封面，只接受 `/uploads/illustration/*` 图片 URL；正文图片的 alt text 写入资产库，封面作为可复用资产参与引用计数。仍被正文或封面引用的资产 `referenceCount > 0`，失去引用的资产先保留为 `referenceCount=0` 供作者审计，只有 `DELETE /api/binary/author/assets/orphans` 会删除这些孤儿资产库行；该清理不删除上传文件本体。物理删除文件必须走 `/api/binary/file/delete`，并由管理 UI 通过二次确认区分“仅移除配置/索引”和“删除服务器文件”。

`AuditLogListResponse` 返回 `items`、`total`、`page`、`pageSize`、`nextCursor` 和 `runtime`。列表查询参数包括 `source`、`type`、`actor`、`action`、`targetType`、`targetId`、`outcome`、`severity`、`fromUtc`、`toUtc`、`cursor`；`actor` 会匹配 actor id/type/role，target 可按 type 和 id 分别过滤。`page/pageSize/total` 保留给旧 UI 兼容和显示估算，真实翻页使用 `occurredAtUtc + id` keyset cursor：首屏不传 `cursor`，下一页传上次响应的 `nextCursor`，服务端按 `occurred_at_utc DESC, id DESC` 查询。`/audit/summary` 对归一化过滤条件使用短 TTL cache，避免每次刷新都重新执行 total/source/action/outcome/severity 多路聚合。`AuditLogItemResponse` 暴露 `source/type/action/outcome/severity/isHighValue`、`actorType/actorId/actorRole`、`targetType/targetId`、`reasonCode`、`eventInfo`、trace/path/method、`ipHash/userAgentHash/sessionIdHash/deviceFingerprintHash` 和 `chainId/prevHash/recordHash/recordMac`。`AuditLogDetailResponse` 额外返回 `contextJson` 与 `tamperEvidenceValid`；`AuditTamperVerifyResponse` 校验当前记录 hash/mac，并按 `chainId` 查询前一条记录，要求当前 `prevHash` 等于前驱 `recordHash`，首条记录则要求不存在前驱。所有审计查询端点位于 admin-only `/api/binary/author/audit/**`，并会写入 `admin.audit.queried` 审计事件。

`OpsHealthResponse` 的 `services` 至少包含 `postgres`、`redis`、`audit`、`crawler-cidr`、`backup`、`public-hot-read`、`search-index`；`workers` 包含 `scheduled-publish` 和启动任务快照；`queueBacklog` 包含 `articleMutationPending`、`articleMutationFailed`、`auditQueued`、`auditDropped`；`backup` 内嵌 `BackupStatusResponse`，用于 `/user/manage/ops` 的后台状态展示。`recentErrors` 返回 `RecentOpsErrorResponse[]`，每项包含 `occurredAt`、`severity`、`action`、`message`、`detail` 和 `count`；服务端只查询审计行的原始字段，物化后清理 `CAST(...)` 等 SQL 投影残片、提取短摘要、保留可展开详情，并按 `action + normalized message` 合并重复错误。`BackupStatusResponse` 只暴露 artifact 路径、mtime、size 和状态，不返回 secret 内容。

`CacheDiagnosticsResponse` 返回 `aot`、`search`、`distribution`、`commentCache`、`hotStatsInvalidation`、`outputCache`、`articlePolicies`、`publicHotReadCounters` 和可选 `article`。`aot` 来自 `PublicHotReadStore` 和 `PublicAotInvalidationTracker`；`search` 读取 `/search/index.manifest.aeds` 的 schema/version/shard count；`distribution` 通过实际生成 sitemap/rss 统计 URL/item 数；`commentCache` 来自 `CacheInvalidationRuntimeState`。`hotStatsInvalidation` 来自 `IHotStatsInvalidationCoalescer`，暴露当前 HotArticles version、dirty/flush 次数、coalesced dirty 数、pending 状态和最近 dirty/flush reason，用于 VisitLog 驱动失效压力 evidence。`articlePolicies` 按 Article cache policy 返回 `policyId/policy/owner/consumers/writes/invalidation/retention/keyCount/bytes/hitCount/missCount`，用于定位 DTO/Core/AEDS frame 缓存 ownership、当前 Redis registry key 数和可读运行时命中/未命中计数。`POST /api/binary/author/cache/actions` 会写入 `admin.cache.action_executed` 高价值审计。

`IntegrityReportResponse` 返回 `checks`，每项包含 `code/title/status/severity/count/autoFixAvailable/detail/sampleKeys/previewDiffs`。巡检覆盖 `article_missing_body`、`article_body_without_revision`、`article_missing_category`、`article_tag_missing_tag`、`article_tag_missing_article`、`comment_missing_article`、`comment_chain_invalid`、`session_deleted_user`、`upload_untracked`、`asset_missing_file`、`sitemap_visibility`、`search_visibility`、`taxonomy_count_runtime`。`IntegrityFixPreviewResponse` 和 `IntegrityFixResponse` 使用 `AdminDiffResponse(field,before,after)` 表示变更摘要；实际修复端点只应用 safe fixes，并写入 `admin.integrity.safe_fix_applied` 高价值审计。

`AuthorAnalyticsResponse` 聚合单作者运营数据：文章状态计数、`totalHumanReadEvents`、`totalSearchableArticles`、`aotHitRate`、`averageDwellMs`、`readingCompletionRate`，以及 `topSearchKeywords`、`topSourceRoutes`、`notFoundHotspots`、`rumMetrics`、`rumPageTypes`、`rumAotSources`。阅读列表来自 `VisitLog.routeKey` 的匿名化公开路由读证明，不包含账号、email、token、cookie 或正文输入；AOT 命中率由真实阅读事件与 `Public AOT cache miss` 审计日志估算。RUM 列表来自匿名 `POST /api/binary/telemetry/rum` 写入的 `frontend_rum_metric`，只接受 `web_vital_lcp`、`web_vital_cls`、`navigation_timing`、`hydration_time`、`wasm_decode_timing`、`markdown_render_timing` 和低基数 `pageType/aotSource/value/duration` 字段。`accepted=false` 或 `rejectedCount>0` 表示部分/全部样本被丢弃但不向公开读链泄露校验细节；服务端只保存净化后的 `frontend_rum_metric` 行，不写入 `sys_audit_log`。

评论通过长度、受限 Markdown 和地区硬拒绝校验后默认写入 `CommentModerationStatus.Approved`；公开评论线程、回复预览和回复游标只返回 `Approved`。模型审核在写入后执行，模型风险命中会把评论自动改为 `Hidden` 并清理公开评论缓存；风险命中且低于边界置信阈值时进入人工审核队列。账号侧 `GET /api/binary/comment/me` 只返回当前账号显式 public/可归因发送的评论，强匿名评论不进入该记录，也不能通过账号 ID 找回。该路径允许使用 `comment.user_id` 的唯一条件是同时约束 `author_mode = public`，并由 `idx_comment_attributable_public_user_id_desc` 服务，不得恢复默认匿名 `user_id` 绑定。匿名评论通过 actor projection 展示而不是强制绑定 `user_id`。公开评论读取的展示名只能来自评论快照字段：匿名/强匿名按 `anonymous_display_name` 后接匿名兜底，public send 按 `public_handle` 后接未署名兜底，不得 join `sys_user` 或回退 `sys_user.username`。公开评论 composer 必须先读取 `GET /api/binary/comment/policy` 的 `CommentPolicySnapshot`，其中 `commentMaxChars` / `commentMaxUtf8Bytes` 表示当前评论内容上限；读取失败时前端回退默认 `1000` 字 / `4096` UTF-8 bytes，后端仍以 `IAnonymousCommentPolicyService` 为准。admin 关闭匿名评论时前端隐藏匿名/强匿名入口，后端仍 fail closed 拒绝匿名写入。

`POST /api/binary/comment/anonymous-ticket` 是强匿名评论写入前置 ticket 端点：请求为 `AnonymousCommentTicketRequest` frame，包含 article/reply context、action context、credential epoch、circuit id、verifying key hash、public input layout、anonymous scope、nullifier hash、credential commitment/root、revocation root、credential level、reputation bucket、proof 与 canonical public inputs；服务端必须拒绝登录态污染，只使用当前 root snapshot 校验 verifying key/root/issuer 绑定，不在请求线程查询 DB root。root snapshot 只接受 root lifecycle 用独立 `AnonymousCredentialRoot:AttestationKey` 签过的 active root 或 freshness 窗口内 Grace root，attestation 绑定 epoch、credential root、revocation root、issuer public key hash、circuit/verifying key、layout version 和 circuit metadata；revocation accumulator profile 的 hash/tree/pathDepth 必须与 production circuit metadata 匹配。成功响应为 `AnonymousCommentTicketResponse` frame，返回 opaque ticket、expiresAt、credentialLevel、moderationSubjectHash 和 anonymousNullifierHash；Redis/统一缓存只保存 `SHA256(ticket)` 下的 compact binary payload，绑定 articleId、scope、parentId/rootId/replyToCommentId、nullifierHash、credentialEpoch、credentialLevel、reputationBucket 和 expiresAt，TTL 默认 120 秒且只能被后续匿名 submit consume-once。proof、publicInputs mismatch、root 过期、nullifier blocked、scope limit 或并发抢占失败统一对外返回 `ApiError` message=`anonymous_comment_ticket_denied`，不得泄露 verifier 细节。

`POST /api/binary/comment/anonymous` 是强匿名最终提交端点：请求为 `AnonymousCommentCreateRequest` frame，只携带 article/reply context、credential epoch、scope、display language、content 和 opaque ticket；端点必须 `AllowAnonymous`、`public_read` 限流并通过 `RequireStrongAnonymousRequest()` 拒绝 Cookie、Authorization、bridge session header 或已认证 principal。服务端先 trim content 并在内容过滤前按当前匿名评论策略校验长度，默认上限为 `1000` 字符 / UTF-8 `4096` bytes，后台可提升到硬上限 `3000` 字符 / UTF-8 `12288` bytes，且创建 frame 仍受 16 KiB payload 上限保护；随后校验受限 Markdown 安全策略，再 consume-once 读取 ticket，校验 ticket 绑定的 articleId、scope、credentialEpoch 和 reply context，执行地区合规，写入 `comment.user_id = null`、`reply_to_user_id = null`、`author_mode = zk_anonymous`、匿名 nullifier/scope/credential/reputation/account-age 字段、region compliance 和 `Approved` 初始状态，并触发 scoped comment cache invalidation。模型风险自动隐藏强匿名评论时无账号站内信收件人，只写审核和审计信号。回复展示必须从 `reply_to_comment_id` 指向的评论作者快照生成，不能把 `reply_to_user_id` 作为强匿名回复作者来源。ticket、proof、credential commitment/root 和任何可逆用户身份不得写入 comment。`POST /api/binary/comment` 的 `CommentCreateV2Request` 不再是 ZK proof 提交通道；`authorMode=zk_anonymous` 必须拒绝为 `anonymous_ticket_required`，避免复用旧 proof 绕过 ticket nonce/consume-once 语义。

登录态创建 `POST /api/binary/comment` 只接受 `CommentCreateV2Request`，AEDS frame 上限为 16 KiB；该端点仅用于显式公开/可归因发送，服务端要求 `authorMode=public` 且 `publicSendExplicitlySelected=true`，否则拒绝写入。`CommentCreateV2Dto.content` 与 `AnonymousCommentSubmitDto.content` 均表示受限 Markdown 源文，不存 HTML，长度由当前匿名评论策略统一控制。退休的数值 37 frame 不得执行评论写入。目标文章必须是未删除、已发布且发布时间/定时发布时间已到达的公开文章。回复必须引用同文章、未删除、已通过的父评论和根评论，回复展示使用 `reply_to_comment_id` 对应的作者投影，不要求父评论存在非空 `reply_to_user_id`。普通用户删除只允许删除自身可归因 public 评论；强匿名评论暂不支持账号侧自删，需后续 receipt/capability/nullifier proof 方案或由管理员处理。管理员删除匿名评论时，通知和用户评论缓存失效不得假设存在可通知的 `user_id`。`POST /api/binary/comment` 先通过 `CommentRiskActionFilter` 预读 AEDS frame 判定 root create / reply 并写 RiskControl action metadata；低风险继续要求 legacy `X-Fsus-Pow-Proof`，中风险要求 `captchaV1` proof 后再校验 PoW，高风险 `queue` 允许写入但把初始原因标记为 `published_risk_control_queue`，极高风险 `block` 返回 429。内容过滤、地区合规和匿名 nullifier 重复/封禁会写入 comment 风险信号，但不得反查匿名 nullifier 到真实账号，也不得改写匿名 display name 生成规则。

`CommentModerationItemResponse.id` 使用字符串承载 Snowflake ID，避免前端整数精度损失；响应同时包含文章、内容、状态、审核原因、审核人、审核时间、`hitReasons`、`submitRegion`、`submitRegionConfidence`、`blockedRegions`、`regionPolicyVersion`、`regionDecisionReason`、`regionCanPublish`、`regionRequiresManualReview`、`regionHideUntilReviewed`。审核队列响应契约不包含真实 `userId` 或 `userName`；管理端只读取 `authorDisplayName` 和作者安全快照字段生成展示与过滤。匿名作者投影字段包括 `authorMode`、`anonymousDisplayLanguage`、`moderationSubjectHash`、`anonymousNullifierHash`、`anonymousScope`、`credentialLevel`、`reputationBucket` 和 `accountAgeBucket`；这些字段用于审核解释、nullifier 封禁和本地队列过滤，不暴露 account id、username、credential commitment 或 nullifier 原文。作者展示名统一由评论行快照投影生成：public 使用 `public_handle` 后接 `未署名用户` 兜底，anonymous/zk anonymous 使用 `anonymous_display_name` 后接匿名兜底；审核读取、审核通过实时推送和回复站内通知均不得 join `sys_user` 或回退 `sys_user.username` / 账号 `public_handle`。启用可选反垃圾模型后，响应追加最新 `modelSignals` 及摘要字段 `modelLabel/modelConfidence/modelPrimaryReason/modelProvider/modelUnavailable`；这些字段只表示风险信号，不包含或代表最终审核动作。`hitReasons` 来自内容过滤器、HTML 风险、密集链接、重复刷屏、人工原因、地区风险标签和 `model:{category}`，用于解释敏感词/垃圾评论/地区策略/模型命中；管理端可按命中原因、blocked region、模型标签、provider 和匿名作者投影做本地队列过滤。审核读取和写入受 `fixed_ip` 限流，并显式要求 `comment.moderate`；该权限只覆盖普通评论审核，不覆盖匿名评论策略、nullifier 封禁或匿名凭证撤销。单条与批量审核需要先完成 `/api/binary/auth/admin/step-up/passkey/begin` / `/api/binary/auth/admin/step-up/passkey/complete`，再把返回的 action=`admin-sensitive` 一次性 proof 放入 `X-Fsus-Mfa-Proof`。proof 缺失、过期、跨 session 或已被消费时返回 `428` + `MFA_PROOF_REQUIRED`；普通用户 MFA proof 不能用于 admin-sensitive 操作。

单条与批量审核都会写入 `comment-moderation` / `comment-moderation-bulk` 审计，服务层用旧 `ModerationStatus` 做 CAS 条件更新并限制状态机转换。`Pending/Rejected/Hidden -> Approved` 会通过 notification stream 推送 `CommentAdded`，但推送内容只能携带同一个安全 `authorDisplayName` 投影，不能读取账号表；合规记录 `can_publish=false` 的发布地违法评论不能被批准。审核通过的回复站内通知同样用当前评论和父评论的快照投影拼接正文，父评论缺少快照时回退为“您”，不得通过 `reply_to_user_id` 查账号名。`Approved -> Rejected/Hidden` 和删除会推送 `CommentRemoved`。评论游标缓存按 article/root/user scope 清理，公开读取的 frame identity 额外包含 viewer region，不再全局清 `CacheTag.Comment`；当 `status=Rejected|Hidden` 且 `banUser(s)=true` 时，服务端会把非 admin、非注销用户更新为封禁状态并同步黑名单缓存。误判恢复使用 `status=Approved`，不会触发封禁联动。

第三方审核模型 Provider 契约由 FsusBlog 定义，Provider 只返回风险类别、置信度、严重度、证据策略和模型元数据，不得返回 `reject_submit`、`geo_block`、`blocked_regions`、发布、隐藏或地区合法性字段。`comment_moderation_signal` 存储 `provider/model/contract_version/label/severity/confidence/primary_reason/needs_second_round/risk_categories/evidence_json/raw_reason/latency_ms/status/error_code/threshold_profile/created_at_utc`；`metadata_json` 保留匿名安全元数据，包括 `author_mode`、`anonymous_display_language`、`moderation_subject_hash`、`anonymous_nullifier_hash`、`anonymous_scope`、`credential_level`、`reputation_bucket`、`account_age_bucket`、`anonymous_comments_enabled` 和 `zk_anonymous_enabled`。外部 provider 不接收真实账号 identity；匿名评论的 `user_id` 可为空，审核 context 仍携带内容、地区、策略和 actor projection。`timeout|unavailable|contract_invalid|error` 均 fail-open，不阻断已发布评论；`status=ok` 且模型风险命中时由 FsusBlog disposition policy 自动隐藏评论，有账号归属时发送“评论审核提醒”站内信，警告不造成实质性处罚。风险命中且 `confidence < Moderation:AntiSpamModel:BorderlineRiskConfidenceThreshold`（默认 `0.90`）时，隐藏后进入人工审核队列。模型 runtime reload 会校验 provider/schema/checksum；失败时保留旧模型快照，rollback 只恢复上一份成功模型快照。模型 runtime 禁用只停止模型风险信号，不禁用硬词库、地区策略或人工审核。HTTP/CLI JSON schema、错误响应和 conformance 工具见 [../moderation/third-party-model-development.md](../moderation/third-party-model-development.md)，运行时配置见 [../moderation.md](../moderation.md)。

硬词库和地区策略由 `configs/moderation/**` 加载为 immutable snapshot。词库只输出 `category/severity/reason/evidence_policy`，地区策略负责把 category 映射为 `submit_action/display_action`；reload 构建失败时保留旧 snapshot 并记录 `lastError`，rollback 只回到上一份成功 snapshot。运行时禁用某个词库只从匹配集合移除该词库，不禁用模型或地区策略；运行时禁用某个地区策略时必须回落到 `GLOBAL` baseline，不进入无审核状态。`GET /api/binary/author/moderation/dictionaries` 返回 `snapshotId/version/checksum/createdAtUtc/lastError`、词库 metadata（id/version/scope/region/category/source/reviewedBy/checksum/termCount）和地区策略 metadata（region/version/inherits/dictionaryIds/checksum/ruleCount）。详见 [../moderation/dictionary-architecture.md](../moderation/dictionary-architecture.md)。

内容导出使用 `ContentExportResponse`：`fileName`、`markdownWithFrontmatter`、`metadata`。frontmatter 固定写入 `fsusFormat: content-export-v1`、`sourceArticleId`、`title`、`summary`、`cover`、`categoryId`、`status`、`scheduledPublishAt`、`tagIds`、`revisionCount` 与 `fsusMetadataJson`；`fsusMetadataJson` 是 base64url 编码的 `ContentExportMetadataResponse`，用于无损恢复分类、标签、封面、文章状态和修订元数据，但不得携带 `createdByUserId` 或 `createdByAdminPrincipalId` 这类可导入 numeric actor id。`GET /api/binary/author/content/export` 返回 `ContentBackupExportResponse`，以 JSON 包含所有文章的导出结果。导入时 `publish=true` 会强制导入为 `Published`，否则按 metadata 的 `status` 恢复；`preserveRevisions=true` 会用导出包中的 revisions 替换导入时生成的初始 revision，恢复出的修订不得把外部环境 actor id 写入本地账号或 admin principal 字段。

### 公共 ArticleDetail DB projection

公开 `GET /api/binary/article/{id}.aeds` 的 wire contract 仍是 `AedsFrameType.ArticleDetail` + `ARD3` V3 payload，没有新增 JSON/text fallback，也没有新增响应字段。文件 artifact miss 时，内部 `public_article_projection` 只返回 `version/aeds_payload/etag/updated_at_utc`；`aeds_payload` 是 projector 生成的完整 immutable AEDS v2 frame。直接 Npgsql reader 使用 `$1` positional parameter、prepared statement、固定 ordinal 和 `SequentialAccess | SingleRow`，每个请求至多执行一次 projection query。CRC、frame type、V3 payload 与 `SHA-256` ETag 任一不符均视为 corrupt，记录 repair evidence 后走既有动态兜底，不能把损坏 bytes 写入缓存或响应。

投影 row 的 `visible=false` 表示 negative/不可公开状态，payload、etag、content hash 必须为空；publish/restore/update 会通过 outbox 重建为 visible row，archive/delete/permanent-delete 会写回不可用状态。backfill durable watermark 保存 `paused|running|completed`、last article id、rate 和成功/失败计数；author cache action 支持 `public-article-projection-backfill-status`、`public-article-projection-backfill-pause`、`public-article-projection-backfill-resume`。这些动作只控制内部 read model，不改变公开 endpoint、admin permission 或 notification stream 契约。

受保护 readiness 的 `runtime.dbGateClasses` 暴露 public-short-read、admin-heavy-read、foreground-write、background-projection-rebuild 的 limit/queue/active/waiting/timeouts/p99；`runtime.publicArticleProjection` 暴露独立 pool capacity、active/waiting、hit/miss/invalid/timeout/broken connection、pool wait p99 与 query p99。公开 `/health/ready` 仍只返回 `status/checkedAt`。

### 订阅

`POST /api/binary/subscriptions` 与 `DELETE /api/binary/subscriptions` 使用 `SiteSubscriptionRequest` / `SiteSubscriptionResponse` AEDS frame，只保存 `HMAC-SHA256(Subscription:EmailHashPepper, normalizedEmail)` keyed lookup identifier、`hash_version`、`channel`、启用状态和退订时间，不保存明文 email。`DELETE` 还必须携带 `X-Fsus-Subscription-Proof`；proof 与 keyed email hash/channel 绑定、TTL 生效，端点先非消费校验，DB 退订成功后再一次性消费，旧 email-only 退订返回 428 且不得更新 DB。旧裸 SHA-256 值仅用于迁移期双读匹配，订阅写入会升级为当前 HMAC，不得作为跨系统身份标识使用。订阅能力是 RSS/Atom 的增强，不构成关注、点赞、收藏或社交关系链。默认实现不发送邮件或 Web Push；`channel=email` 只记录读者显式偏好，外发增强必须以后续配置开关和退订 smoke 为准。

---

## 参见

- [design.md](design.md) — API 设计哲学与格式约定
- [quick-reference.md](quick-reference.md) — 端点路由速查表
- [schemas-and-errors.md](schemas-and-errors.md) — 错误码枚举与 Binary 帧格式
- `src/shared/Contracts/Outputs/ServerResponseContracts.cs` — 所有 DTO 权威源码
- `src/shared/Contracts/NotificationStream/NotificationStreamContracts.cs` — notification stream 信封权威源码

# API Contract Reference

This document is the **complete reference** for FsusBlog request/response DTOs,
notification WebSocket envelopes, and AOT contracts. Authoritative definitions live
under `src/shared/Contracts/`; cross-language security JSON sources live under
`src/shared/Contracts/Validation/Security/` and are consumed by
`tools/contracts/` to generate the Shared backend and frontend consumers.

> Updated 2026-07-19 — RiskControl verify now uses UUIDv7 envelope identity and
> member progress, and returns an aggregate proof only after every member completes.

## v5/layout 6 strong-anonymity eligibility contract

`AnonymousCommentTicketRequest` frame `198` 的 canonical public inputs 固定为 `action_context`、`scope`、`circuit_id`、`verifying_key_hash`、`public_input_layout_version`、`nullifier_hash`、`credential_root`、`revocation_root`、`issuer_public_key_hash`、`policy_hash`、`is_eligible`、`may_comment`、`rate_class`、`requires_moderation`。frame `199` 只返回 expiry、`rate_class`、`requires_moderation`、opaque ticket 与 moderation subject；最终 `AnonymousCommentCreateRequest` 不再携带 credential epoch。数值 `180/181` 和 ticket codec v1/v2 均退休并 fail closed。

精确 credential epoch/level、reputation bucket、account age 只存在于浏览器 credential vault 与 circuit 私有 witness，由 finalized blind signature、credential root membership 和 policy constraint 绑定。评论公开作者、notification stream、审核队列、anti-spam metadata、stats 与 admin user list 均不得序列化这些字段。root attestation 的 `anonymity_sets` 只记录最小谓词组合和 aggregate size；Production `k >= 20`，`k-1` 只能要求客户端合并为 `common|unknown` 后重证，无法满足即拒绝。release evidence 只允许 set count、minimum、median，不包含成员标识。

---

## Reader paths

Use the document according to the reader's responsibility:

- **Maintainers and implementers:** start with [API design principles](design.md),
  then use this file for DTO, envelope, and payload obligations. Verify wire facts
  against the [AEDS protocol manifest](../../src/shared/Contracts/Validation/aeds-protocol.json)
  and the [shared response contracts](../../src/shared/Contracts/Outputs/ServerResponseContracts.cs).
- **Clients and integrators:** use the [route quick reference](quick-reference.md)
  for method/path/security selection, then use the relevant contract section below.
  Use [schemas and errors](schemas-and-errors.md) for frame validation, error mapping,
  and POD sizes; do not infer a fallback from a prose example.
- **Operators, reviewers, and test authors:** use the machine-readable sources and
  the linked implementation/test authorities named in each section. Treat failure,
  rollback, retention, and provenance statements below as normative; current status
  comes from the lifecycle index and the repository's executable checks.

Repeated route, frame-format, error, and POD prose is intentionally owned by the
canonical documents above. This file retains the contract-specific fields and
invariants and links back to those authorities rather than restating them.

## Contents

- [Base response and transport contract](#base-response-and-transport-contract)
- [Pagination and cursor envelopes](#pagination-and-cursor-envelopes)
- [Authentication contracts](#authentication-contracts)
- [Article contracts](#article-contracts)
- [Human-read proof contracts](#human-read-proof-contracts)
- [Comment contracts](#comment-contracts)
- [Category and tag contracts](#category-and-tag-contracts)
- [Message contracts](#message-contracts)
- [Notification WebSocket contracts](#notification-websocket-contracts)
- [File-upload contracts](#file-upload-contracts)
- [System-configuration contracts](#system-configuration-contracts)
- [Admin-statistics contracts](#admin-statistics-contracts)
- [Public AOT-page contracts](#public-aot-page-contracts)
- [PoW contracts](#pow-contracts)
- [Security-challenge contracts](#security-challenge-contracts)
- [Anonymous-credential issuance contracts](#anonymous-credential-issuance-contracts)

---

## Base response and transport contract

运行时主 API 已收敛到 AEDS Binary：`/api/binary/**` 响应使用 AEDS v2 frame，错误也通过 `ApiError` frame 表达，不再通过旧文本响应包装。所有内部应用 API 按 [aeds-only-policy.md](aeds-only-policy.md) 治理；`JsonApiResponse<T>` 只允许出现在 public AOT tooling 等已登记工具边界中，不能作为浏览器运行时 API 暴露。

HTTP 层契约源是 `src/shared/Contracts/Validation/fsusblog.openapi.json`。该 OpenAPI snapshot 描述 method/path/status/content-type/security 与 `x-fsus-*` AEDS metadata；AEDS frame 名称、header magic/version/size 仍以 `src/shared/Contracts/Validation/aeds-protocol.json` 为唯一权威来源。`tools/frontend/generate-aeds-protocol.mjs` 从该 manifest 同时生成 Core `AedsFrameType`、Shared `AedsFrameHeader`/`AedsFrameType`、TypeScript frame constants 和 C++ `aeds_frame.hpp`；这些生成文件不得手写修改。Core 不再维护第二份 `AedsFrameHeader`，编码器、后端和测试统一引用 Shared 的 packed header。cross-stack matrix、前端 route constants、runtime contract smoke 与 release evidence 通过 `tools/contracts/*` 从这两个源校验或生成。

Compiled request 治理观察使用 closed `fsusblog.api-aeds-observation.v5`：容器的 `item` 递归保留元素/字典值的 nullable、primitive format/enum/bounds 和 CLR schema ref，与容器自身 nullable 分开；原 `itemType`/`itemSchemaRef` 必须与该元素一致。唯一 compiled observer 从实际声明的 `NullabilityInfo` tree 和原类型边界规则取值，未知 reference annotation 或不可精确解析的元素 annotation 拒绝，不推定 nullable。消费者拒绝缺少元素信息的旧 v4；观察及 build receipt、OpenAPI 和 fact projection 须由原 producer 重新生成，不能通过重密封旧输出代替。这只升级治理元数据，不改变 endpoint、AEDS v2 wire、runtime request reader 或 public error 合同。

同一协议生成器也拥有 `tests/backend/Fixtures/aeds-golden-catalog.json`。编号和退休值只来自协议 manifest；`goldenCatalog.defaultEvidence` 与每个 frame 的 `goldenFamily`、`goldenOrder` 显式保存原测试元数据和排列顺序，不能从名称猜测 payload、POD 或 ABI。所有注册 frame 必须具有完整、唯一的 golden 元数据；生成与 `--check` 都覆盖五个输出，不从旧 catalog 反推源。catalog 的生成一致性不替代真实 codec、跨栈探针或完整 matrix 验收。

原 TestOwner `BackendGoldenCatalogTests` 继续持有独立 numeric oracle：旧 236 条 name/value/family 的固定 UTF-8 JSON 投影 SHA-256 包含原顺序，新 Font/Theme 八条使用独立 literal 编号与分类断言。其值不能随 manifest 或生成文件自动更新。原 `backend-golden` 入口在原 `Category=GoldenContract` SDK 测试前执行同一生成器的 Node 控制；这些控制与原 SDK 过滤、覆盖率和阈值共同保留，不能用 renderer 自洽替代 TestOwner 或 ABI 验收。

Font/Theme 管理的八个 GET 均为 typed AEDS v2：`/api/binary/author/ops/fonts/registry`、`/registry/{fontId}`、`/activations` 分别使用 `FontRegistryList`、`FontRegistryDetail`、`FontActivationList`；`/api/binary/author/ops/themes/registry`、`/registry/{themeId}`、`/activations`、`/activations/{scope}`、`/activations/{scope}/history` 分别使用 `ThemeRegistryList`、`ThemeRegistryDetail`、`ThemeActivationList`、`ThemeActivation`、`ThemeActivationHistory`。缩写路径均相对于其 fonts/themes group。各路由继续要求 admin principal 的 `SystemConfig` 权限及 `fixed_ip` 限流，错误仍使用 `ApiError`；没有裸 JSON、`TextDecoder + JSON.parse` 或旧 helper fallback。前端经原生成 OperationID 路由入口消费，生成 OpenAPI/matrix/route 产品必须从当前 compiled endpoint observation 产生，不可用候选源码描述或旧分支产物替代。

这些 payload 使用 Shared `FontThemeAdminPods` 和 `FontThemeAdminContractLimits` 的封闭、packed、bounded schema；C#、C++ 与 TypeScript 同步拒绝未知枚举、非法 presence/reserved、越界或非规范 UTF-8 slice、超限 count、截断和尾随 bytes。64-bit 非负 size/configuration/budget 在 TypeScript 为十进制字符串以保留完整 Int64 精度；时间仍是 UTC Unix 毫秒，nullable 用显式 presence 而非空字符串猜测。它们不改变路由、权限、AEDS header 或既有 Font/Theme 业务安装与激活语义。

公开 HTML、hydration sidecar、PublicHotRead AEDS/HTML、cache/file runtime entry 与浏览器 hydration state 使用统一的 `PublicRepresentationCoordinate` 投影合同。唯一 machine-readable 定义是 `src/shared/Contracts/Validation/public-representation-coordinate.json`；C#、TypeScript 与 Wasm C++ 表面由 `tools/contracts/generate-public-representation-coordinate.mjs` 生成。它引用而不复制 release ID 与 AEDS wire authority，坐标包含 canonical route、source/revision/publication/visibility、renderer/release/assets、AEDS protocol/schema、document/sidecar digest、SEO identity 与 hydration page kind。坐标只在 build/project/publish 阶段密封，请求热路径不得查询数据库或 Redis 补齐坐标。

transport validation 对 manifest 中每条转换只比较固定 `preserves` 字段。任一 renderer/assets/source/document/sidecar digest 不匹配，cache/file materialization 必须 evict-and-rebuild，HotRead 必须保留上一份合格 snapshot或回常规 endpoint，浏览器 hydration 与旧 Service Worker shell 必须走 network canonical route/navigation；不得继续消费部分兼容 payload。结构化 evidence 只使用固定 mismatch layer、transition 与 counter，不记录 route/digest/release 等高基数值。该合同不新增 frame 字段、不调整 AEDS v2 header 或 middleware 顺序，也不声明 #428 范围内的多节点强一致。

AEDS payload 的消费投影由 `src/shared/Contracts/Validation/aeds-access-profiles.json` 单独治理；它不得覆盖上述 wire authority。生成器 `tools/frontend/generate-aeds-access-profiles.mjs` 同时产出 C#、TypeScript 与 C++ offset/profile surface。当前默认 `publicArticleListCard` 只在合法 76/100-byte `ArticleList` layout 上选择性物化公开卡片字段；合法 56-byte layout 确定性回退 canonical decoder，未知 layout、越界 slice、非法 UTF-8、reserved byte、tag range 或 trailing bytes 全部 fail closed。完整边界、生成流程、门禁与回退见 [AEDS v2 access projections](../architecture/aeds-access-projections.md)。

公开 binary 读模型使用预编码 artifact：匿名 `GET /api/binary/article/{id}.aeds`、公开文章列表的 `page=1` 且无 `cursor` 请求、`GET /api/binary/article/hot/{size}.aeds`、`GET /api/binary/category.aeds`、`GET /api/binary/tag.aeds` 可读取进程内 `PublicHotReadSnapshot` 的完整 AEDS v2 frame。文章列表 `page>1&cursor=...` 固定绕过 L0 并进入动态 endpoint；PublicHotRead 与 Public AOT 只预生成第一页，其响应中的 `nextCursor` 是下一页的唯一输入，不生成或读取 cursor-less 深页 artifact。artifact build 阶段同时生成 raw/br/gzip variant；命中时服务端按 `Accept-Encoding` 选择最优 variant，写出 variant-aware `ETag`、`Vary: Accept-Encoding`、可选 `Content-Encoding` 和 `X-Fsus-Frame-Encoding`。`If-None-Match` 匹配当前 variant 时返回 `304 Not Modified`，不发送 frame body。miss/not-ready 返回状态码，不会在请求线程同步查询 PostgreSQL、Redis、IMemoryCache、OutputCache 或文件系统。`GET /api/binary/article/{articleId}/related.aeds` 是动态 AEDS public-read endpoint；它缓存并直接租借唯一的最终 `ArticleRelatedReading` frame，不缓存 DTO/JSON，也不属于 PublicHotRead L0 或 Public AOT snapshot。不存在的公开文章使用同 policy 负缓存，存在但无推荐的文章返回合法空推荐 frame。admin/private 读取走 `/api/binary/admin/article/**` 和非 `.aeds` taxonomy mutation path，以便草稿、定时、归档、删除状态和分类标签管理。

公开 artifact 撤回是无 body HTTP 契约，不是 AEDS `ApiError`：active tombstone 命中时返回 `410 Gone`，`Content-Length: 0`，`Cache-Control: no-store, no-cache, must-revalidate`，并带十进制单调 `X-Fsus-Generation` 与 opaque `X-Fsus-Revoked: g{generation}`。响应不得带 `ETag`、`Last-Modified` 或 `Content-Encoding`。同一 generation 同时作为 Redis edge notification 和 CDN purge 的幂等键；只有包含撤回内容的新 snapshot 发布成功后才清除 marker。auth、admin、author、notification stream 与未登记动态 API 不进入此契约。

常规 endpoint response compression 与 artifact variant 是两套边界。通用中间件只压缩显式登记的匿名公开 feed/sitemap/robots 与成功公开 integrity manifest，并要求 HTTPS GET/HEAD、`200`、`Cache-Control: public`、无 Cookie/Authorization/CSRF 输入、无已认证 principal、无 `Set-Cookie`、无敏感 `Vary`。允许媒体类型固定为公开 JSON/feed/XML/plain text；`text/html`、`application/octet-stream`、`application/vnd.fsus.aeds` 不进入通用压缩。auth/admin/account/cookie/antiforgery/notification、所有动态/private binary、错误/no-store/private response 固定 identity。带 CSP nonce 的 SPA fallback 也固定 identity，`identity;q=0` 返回 `406`；只有无请求反射的 immutable PublicHotRead/AOT artifact 可以按自身 variant/ETag 契约返回 br/gzip。

PublicHotRead early classifier 不扩展上述路由集合：`/api` 与 `/api/binary` 下 `auth`、`admin`、`author`、`manage`、`internal`、`billing`、`audit` namespace（大小写不敏感且按完整 path segment 匹配）显式绕过 L0；登录 principal、Authorization/Cookie/CSRF header、anonymous gateway guard 会拒绝的 `X-Fsus-*` header、`Origin`、非 `GET`/`HEAD`、notification stream、dynamic/private binary 与相似但未登记的 prefix 同样回到常规 CORS/authentication/authorization/audit 管线。敏感请求不增加 L0 hit/miss/bytes/rejected 计数；独立 `fsus.hotread.classifier.sensitive_bypass` 是低基数安全告警计数，不改变任何 HTTP/AEDS wire 响应。

常规 L1/L2 binary frame cache 同样保存完整预编码 AEDS frame，并通过 `TryGetRawReadonlyAsync` 以 cache-owned `ReadOnlyMemory<byte>` 同步直出；public list/hot/comment/taxonomy 与 admin stats 命中时不得先解码 read model 再重新编码。`SetRawAsync` 仍保存防御性副本，caller 不得保留或写入 cache backing storage；ETag/version identity 和 `ICacheInvalidationDispatcher` 失效语义不变。动态 frame、payload frame 和预编码 frame 的 HTTP body 均只执行一次有效 PipeWriter write/flush；取消、response abort 与 backpressure 继续按 ASP.NET Core transport 语义传播，不新增文本 fallback 或 wire 字段。

L0 `Accept` 语义固定为：空值、`*/*`、`application/octet-stream` 可读取 binary artifact；HTML artifact 只接受空值、`*/*`、`text/html`；其他类型返回 `406`。L0 不承担跨域公开接口；带 `Origin` 的请求和 `OPTIONS` 不创建 L0 feature，CORS/405 由常规管线治理。快照状态通过 `/api/ops/health/ready-detail` 的 `runtime.publicHotRead` 暴露 `NotStarted` / `Building` / `Ready` / `Failed`、版本、artifact 计数、最后构建原因和错误；同一对象的 `residency` 暴露 `totalBytes/rawAedsBytes/brotliBytes/gzipBytes/htmlBytes/htmlTemplateBytes/keyIndexBytes/articleBytes/listBytes/taxonomyBytes/htmlResidentBytes/baseBytes/overlayBytes/removedSetBytes/artifactCount/objectCount/arrayCount/lohEligibleArrayCount/lohEligibleArrayBytes`，并携带 `budgets`、`snapshotOverlapBytes`、`retiringSnapshotBytes`、`budgetViolations`、`lifecycleStage`、overlay/removed count、storage/compression policy。author ops response 的 `publicHotReadCounters` 额外暴露 `identityVariant/brotliVariant/gzipVariant` 实际 negotiation 计数，作为下一次 release 调整压缩常驻份额的输入。同一受保护详情的 `release` check 暴露非敏感 `releaseId`、`releaseSlot`、完整 commit SHA、不可变 image ref/digest，且生产环境缺失或不一致时整体 readiness fail closed。所有应用响应统一带非敏感 `X-Fsus-Release-Id` 与 `X-Fsus-Release-Slot`，供 Blue/Green 网关在 loopback 和公网路径核对实际命中的 release；不得在这些 header 中加入 token、密钥、完整配置或用户身份。公开 `/health/ready` body 仍只返回 `status` 与 `checkedAt`。未 Ready 时 fast path 返回 `503` + `Retry-After: 1`。list/category/tag（以及诊断 HTML）Serving miss 不得与权威 404 混用：last-good 或 fresh 命中仍为 `200`；未常驻/重建中为 `503` + `Retry-After: 1`；未发布、已删除或在该快照公开可见性下从不存在才是无 `Retry-After` 的 `404`。详见 [PublicHotRead serving miss outcomes](../operations/public-hot-read-serving-outcomes.md)。L0 负响应固定 `Cache-Control: no-store`，并带与公开 HTML artifact 相同的静态浏览器安全头：`Content-Security-Policy`、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、`Cross-Origin-Embedder-Policy`、`Cross-Origin-Opener-Policy` 与 `Cross-Origin-Resource-Policy`；`Range` 不支持并返回 `416` + `Accept-Ranges: none`；命中的 `.aeds` artifact 只使用 artifact-level HTTP 预压缩，浏览器 fetch 解压后仍得到原始 AEDS frame，payload 语义与 CRC 不变。

HTML L0 只暴露 `/api/binary/article/html/{pathKey}.html` 诊断/预览路径，真实公开 URL 仍是 `/`、`/article/{id}`、`/category/{id}`、`/tag/{id}` 等 public route。`pathKey` 必须 URL-safe：`article:42` -> `article-42`，`category:7` -> `category-7`，`tag:9` -> `tag-9`；`tag-name:*` 与包含空白、斜杠、非 ASCII 的 routeKey 使用稳定 hash。`PublicHotRead:EnableDiagnosticHeaders` 默认关闭；打开后成功响应才带 `X-Fsus-HotRead-Version`、`X-Fsus-HotRead-Artifact`、`X-Fsus-HotRead-Key`。

所有 HTTP 响应都会带 `X-Fsus-Trace-Id`，值与当前 OpenTelemetry `Activity.TraceId`、`HttpContext.TraceIdentifier`、Serilog/audit `TraceId` 对齐。客户端可用该值报告问题；它不是认证凭据，也不得包含用户身份或请求正文。

`POST /api/security/csp-report` 是浏览器标准 CSP 上报入口，不属于 `/api/binary/**`。请求 media type 允许 `application/csp-report`、`application/reports+json` 或 `application/json`，body 上限 16 KiB；合法 legacy `csp-report` object 或 Reporting API array 返回 `204` 空 body，media type 不支持返回 `415`，超限返回 `413`，格式错误返回 `400`，所有响应 `no-store`。collector 只把 effective/violated directive、disposition 和 blocked URI 类别写入结构化日志，不保留原始 payload 或完整 URL。

未被业务显式捕获的异常只能返回固定、客户端安全的错误消息。`ArgumentException` / malformed request / auth / not-found 等 4xx 映射不得把 `exception.Message`、SQL、配置键、文件路径、后端类型名或 token 片段写入 `ApiError.Message` / `Details`；Development 500 诊断输出仅限本地开发，不构成运行时 API 契约。生产和共享环境的 binary/json 错误响应只暴露稳定错误码、HTTP 状态、固定文案和 trace id。

### Public integrity verification manifests

Integrity verification endpoints are public JSON sidecars, not `/api/binary/**` runtime endpoints. They exist so external verifiers can read public keys, publish proofs, local transparency log heads, and Merkle checkpoints without depending on internal AEDS frames.

Article responsibility sidecars extend this public verification boundary with revision-scoped authors, optional reviewer, structured public sources, substantial-update disclosure and optional methodology/applicability/limitations. The current and historical endpoints resolve the snapshot explicitly referenced by the corresponding immutable publication. A public article that predates persisted revisions returns a deterministic site-author fallback with `revisionNo=0`, `legacyFallback=true`, and `verification.proofStatus=unavailable`; a missing or unpublished requested historical revision remains `404`. Responses expose responsibility snapshot/version coordinates and only safe public HTTP(S) links plus `ready|failed|unavailable` proof state; they never include admin actor ids, draft content, private sources, failure details or audit payloads. See [Article responsibility and sources](../integrity/article-responsibility.md).

The complete integrity route matrix (method, path, media type, cache policy, and
permission) is maintained once in the [integrity section of the route quick
reference](quick-reference.md#integrity-verification-sidecars--integrity). This
section retains the manifest payload and privacy obligations below.

| Method | Path | Content-Type | Cache | Description |
| -------- | ------ | -------------- | ------- | ------ |
| GET | `/integrity/keys.json` | `application/json; charset=utf-8` | short public manifest cache | Public signing key registry; never exposes private keys. |
| GET | `/integrity/article/{articleId}` | `application/json; charset=utf-8` | immutable for ready/superseded proof; `no-store` otherwise | Current public publish proof for an article. |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}` | `application/json; charset=utf-8` | same as proof | Publish proof for one public article revision number. |
| GET | `/integrity/article/{articleId}/rights` | `application/json; charset=utf-8` | immutable for ready/superseded proof; `no-store` otherwise | Current public Rights V3 proof for an article. |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}/rights` | `application/json; charset=utf-8` | same as proof | Rights V3 proof for one public article revision number. |
| GET | `/integrity/article/{articleId}/responsibility` | `application/json; charset=utf-8` | short public manifest cache | Current responsibility manifest; pre-revision public articles return deterministic legacy fallback. |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}/responsibility` | `application/json; charset=utf-8` | short public manifest cache | Responsibility manifest for one persisted revision; missing revision returns `404`. |
| GET | `/integrity/revisions/{articleRevisionId}` | `application/json; charset=utf-8` | same as proof | Publish proof by persisted `ArticleRevision.Id`. |
| GET | `/integrity/checkpoints/latest` | `application/json; charset=utf-8` | short public manifest cache | Latest signed Merkle checkpoint. |
| GET | `/integrity/checkpoints/{date}` | `application/json; charset=utf-8` | short public manifest cache | Daily checkpoint using `yyyy-MM-dd`. |
| GET | `/integrity/log/head` | `application/json; charset=utf-8` | short public manifest cache | Current transparency log head. |

Ready and superseded publish proof manifests contain `articleId`, `articleRevisionId`, `revisionNo`, canonical hash, artifact digests, signing key id, signature, and transparency log pointer. Ready and superseded Rights V3 proof manifests contain `articleId`, `articleRevisionId`, `revisionNo`, `articleRightsSnapshotId`, `publishProofId`, `rightsPolicyHash`, `contentCanonicalHash`, signing key id, signature, and transparency log pointer. Pending, failed, retrying, not-public, missing, private, hidden, or deleted cases expose only stable low-sensitive status or an error manifest; they must not expose stack traces, failure details, admin principal context, draft content, user data, IP, user agent, device, session, token, private key material, comments, private messages, or secret material. See [Public Verification API](../integrity/public-verification-api.md) for schema and manual verification.

### Common AEDS response PODs

The common `EmptySuccess` (`240`), `MutationId` (`241`), and `ApiError` (`251`)
frames, their POD fields and byte sizes are owned by
[schemas and errors](schemas-and-errors.md#aeds-v2-frame-format) and
`src/shared/Contracts/Models/CommonPods.cs`. This document only records
endpoint-specific response semantics below; do not create a second common POD table.

| FrameType | POD | Description |
| ----------- | ----- | ------ |
| `EmptySuccess` (`240`) | `EmptySuccessPod` | Empty successful response with `Ok = 1`. |
| `MutationId` (`241`) | `MutationIdPod` / `ArticleMutationResultPod` | Generic writes return an 8-byte `int64 Id`; article create/update/rollback return a 48-byte typed mutation coordinate. |
| `ApiError` (`251`) | `ApiErrorPod` | Binary error response containing `Code`, `Category`, `HttpStatus`, `Message`, `Details`, and `TraceId`; non-business errors must not echo internal exceptions/messages. |

### Locale-preference binary contract

`GET /api/binary/locale-preference` 返回 `UserLocalePreference` (`239`)；`PUT /api/binary/locale-preference` 只接受 `UserLocalePreferenceUpdateRequest` (`242`) 并返回提交后的 `UserLocalePreference`。两条路径均允许匿名访问、使用 `fixed_ip` 限流并返回 `no-store`；登录主体仅允许普通匿名账户，admin principal 或其它主体返回 `403 locale_preference_unavailable`。

`UserLocalePreferencePod` 固定为 24B：`revision:int64`、`updatedAtUnixMs:int64`、`mode:uint8`、`hasFixedLocale:uint8`、`fixedLocale:uint8`、一个保留零字节和四个保留零字节。`UserLocalePreferenceUpdateRequestPod` 固定为 16B，以 `expectedRevision:int64` 替代前两个时间/版本字段，其余 mode/locale/reserved 布局一致。`mode=1` 表示 `auto`，必须携带 `hasFixedLocale=0/fixedLocale=0`；`mode=2` 表示 `fixed`，必须携带 `hasFixedLocale=1` 和 locale catalog 中启用的 canonical locale id。未知 mode、alias、禁用 locale、字段组合错误、非零保留位、截断或尾随字节均 fail closed。

匿名设备偏好只写规范 `fsusblog.locale` cookie，`expectedRevision` 必须为零，响应 revision 也为零；`auto` 清除 cookie。普通账户偏好以数据库 revision 做 optimistic CAS，成功后同步 cookie；revision conflict 不得覆盖已提交偏好。该 contract 不使用 `localStorage` 作为事实源，也不新增 JSON fallback。

### AEDS v2 payload layout

The canonical AEDS v2 header layout, CRC/flag rules, decode rejection rules, and
POD-size limits are maintained in [schemas and errors](schemas-and-errors.md#aeds-v2-frame-format)
and [`AEDS_V2_PROTOCOL.md`](../../src/core/Algorithms/AEDS_V2_PROTOCOL.md). The
cross-stack gate remains contract-specific: `check:aeds-protocol` must fail closed
on drift for every generated target; the frame-schema check compiles the real C++
decoder, confirms that every active manifest frame type is recognized, and gives
C# golden frames to that decoder for type/payload validation. Any header-layout,
frame-name, or numeric drift fails CI.

服务端 request payload 的内存契约是请求级 pooled lease，而不是由 response completion 拥有。header 通过后发生的 payload short read、CRC mismatch、取消或异常由 binder `finally` 归还；成功绑定后由 `/api/binary/**` middleware `finally` 在 handler/result 完成、抛错或客户端断连时归还。`HttpResponse.OnCompleted` 未触发不影响正确性，它只保留为幂等兜底；同步解码调用方可以 `Dispose` 提前归还，同一 lease 无论经过 consumer、pipeline 和 completion 多少个入口都只能归还一次并清零。lease 归还后继续访问 payload 是生命周期错误。该规则只改变服务端内存 ownership，不改变 frame、HTTP status、`X-Fsus-*`、PoW、RiskControl、Cookie 或 notification stream 契约。租借平衡通过 `FsusBlog.Server` meter 的 `fsus.binary_request.pool.rent_count`、`return_count`、`rented_bytes`、`returned_bytes` 与 `outstanding` 暴露。

浏览器 AEDS decoder 发布为 ABI `fsusblog.aeds.v4` 的 `aeds_decoder_basic.*` 与 `aeds_decoder_speed.*` 两套 artifact。两者只改变执行实现，不改变本节 wire：basic 为 scalar `-Oz` fallback；speed 为 `-O3/-flto/-msimd128`、严格 Binaryen `wasm-opt` 校验和固定 64 MiB memory。`aeds-runtime-manifest.json` 必须绑定两套 JS/Wasm hash、ABI、memory profile 与 compiler/emsdk/Binaryen/CMake/vcpkg identity，release asset URL 按 immutable build id 隔离。客户端以 `WebAssembly.validate` 探测 SIMD，speed 初始化失败后才顺序加载 basic；同一 frame 不允许 basic/speed 双解码，也不允许回退旧文本协议。

ABI v4 的 arena 与 payload export 使用单调 `uint64` handle token。`reserve`、任意 decode 尝试和 `clear` 都先推进 epoch，使之前取得的 input/payload handle 立即失效；`get_io_buffer_ptr`、`decode_io_buffer`、`get_last_payload_ptr/len/frame_type` 必须携带当前 token，stale token 固定返回空地址/零值或 decode failure。地址使用 `uintptr_t`，Emscripten 通过 BigInt 承载 64-bit token，memory64 build 不允许把地址截断为 `uint32`。JS 只在同一个同步调用段内以 token 取址并复制为 owned bytes，不得缓存 raw pointer 跨越 reserve/decode/clear。该边界由实际 exports 的 ASAN/UBSAN 合约、stale-epoch negative case 和 libFuzzer harness fail closed 验证。

网络 frame 进入 `wasmDecode.worker.ts` 时必须 transfer `ArrayBuffer` ownership；Worker 到 Wasm 使用一个可复用 I/O arena，禁止逐 frame `malloc/free`。payload result 直接引用 arena 内原 frame slice，复制一次到 JS owned bytes 后再交给 adapter；非公开 auth/admin/private frame 必须立即清零 arena，其他不可信 frame 最迟在下一次 reserve 前清零旧 active bytes。最大浏览器 frame 与服务端 binary request cap 对齐为 8 MiB；speed decode 不允许 memory growth，basic growth 必须受 256 MiB 上限约束并记录 pages/grow。完整实现、诊断、性能预算与无需重启回退见 [../wasm.md](../wasm.md)。

The high-frequency reading frame is changed to compact POD:

| FrameType | Payload layout |
| ----------- | ---------------- |
| `ArticleList` | `total:int32` + `count:int32` + `tagRecordCount:int32` + shared UTF-8 blob + current 100B article records + 12B tag records；只读兼容 56B/76B |
| `ArticleSearch` | `total:int32` + `count:int32` + `tagRecordCount:int32` + shared UTF-8 blob + 52B search records + 12B tag records |
| `ArticleHot` | `count:int32` + shared UTF-8 blob + 16B article records |
| `CategoryList` / `TagList` | `count:int32` + shared UTF-8 blob + 16B taxonomy records |
| `AdminStats` | `SiteStatsPod` + shared UTF-8 blob + 16B popular records + 32B recent-comment records + 12B region records |
| `SiteComplianceConfig` | `SiteComplianceConfigPod`，固定宽度 UTF-8 字段；空配置不写占位备案号 |

compact record 内所有文本字段均为 `Utf8SliceRef`，指向当前 payload 的共享 blob。`ArticleList` 当前 100B record 在旧 76B 生命周期字段后追加 revision/publication 四项坐标；`status` 值固定为 `Draft=0`、`Scheduled=1`、`Published=2`、`Archived=3`、`Deleted=4`，公开可见性以 [design.md#文章状态枚举](design.md#文章状态枚举) 为准。写请求、Passkey、上传和复杂评论游标仍使用 v2 header 包裹的 POD + blob 结构；`ArticleDetail` 外层仍是 AEDS v2 frame，新写 payload 使用 `ARD5` V5 envelope，解码器只读兼容 `ARD4` V4 与 `ARD3` V3，不再允许旧 detail tail payload。

所有 `*UnixMs` 字段均为 UTC Unix epoch 毫秒。服务端从数据库读取 `DateTimeKind.Unspecified` 时间时，必须把该 wall-clock 值视为已归一化的 UTC，不得再按宿主机本地时区偏移；`DateTimeKind.Local` 才按其实际时刻转换为 UTC。该规则只约束时间语义，不改变 `int64` wire layout、frame size 或 TypeScript/Worker/Wasm decoder ABI。

payload 字典化的第一阶段采用兼容 layout：ArticleList/ArticleSearch/Conversation 等重复文本均落到单个 shared UTF-8 blob，records 只保存 `Utf8SliceRef`；前端 ArticlePage decode 不再创建 object records 数组，也不使用 `tagRecords.slice(...)` 复制 tag range。后续若引入 `ArticleListV4` category/tag dictionary，必须保持现有 frame type 的 downgrade 路径和 golden fixture。

Search runtime rejects keywords longer than 128 characters to avoid processing very large inputs before DB fallback, runtime token hashing, and snippet builds. Search index construction only processes the first 256 KiB of text tokenization, and CJK returns bounded unigram fallback when the continuous segment exceeds 4096 runes.

### Read-proof AEDS frames

`/api/binary/read-proof/**` 使用 request/response AEDS frame；错误语义统一为 `ApiError`。旧 `/api/read-proof/**` JSON endpoint 已移除，前端运行时不得调用或回退。

The frame/number/POD matrix is maintained in
[schemas and errors](schemas-and-errors.md#aeds-frametype-enum) and the
[route quick reference](quick-reference.md#read-proof). The endpoint-specific
failure and privacy rules remain above.

| FrameType | Value | POD | Purpose |
| ----------- | ---- | ----- | ------ |
| `HumanReadChallengeResponse` | 28 | `HumanReadChallengeResponsePod` + UTF-8 blob | Challenge response. |
| `HumanReadSubmitResponse` | 29 | `HumanReadSubmitResponsePod` + UTF-8 blob | Submit response. |
| `HumanReadChallengeRequest` | 73 | `HumanReadChallengeRequestPod` + UTF-8 blob | Challenge request body. |
| `HumanReadSubmitRequest` | 74 | `HumanReadSubmitRequestPod` + UTF-8 blob | Submit request body. |

### RUM telemetry AEDS frames

生产前端只向 `/api/binary/telemetry/rum` 发送 RUM，使用 `credentials: omit`、`Content-Type: application/octet-stream` 和 `Accept: application/octet-stream`。旧 `/api/telemetry/rum` JSON endpoint 已移除，不允许生产前端回退。

The frame/number/POD matrix is maintained in
[schemas and errors](schemas-and-errors.md#aeds-frametype-enum) and the
[route quick reference](quick-reference.md#rum-telemetry). The request limits
and accepted metric vocabulary remain here.

| Frame | Value | Payload | Purpose |
| ------- | ------- | --------- | ------ |
| `RumMetricBatchRequest` | 75 | `RumMetricBatchRequestPod` + `RumMetricItemPod[]` + `RumMetricValuePod[]` + `RumMetricDimensionPod[]` + UTF-8 blob | Batch RUM request body. |
| `RumMetricIngestResponse` | 76 | `RumMetricIngestResponsePod` | accepted / acceptedCount / rejectedCount. |

请求限制：单帧最大 8192 bytes，单批最多 16 条 metric，metric name 最多 64 bytes，单条最多 4 个数值字段和 4 个低基数字符串 dimension。服务端只接受 `web_vital_lcp`、`web_vital_cls`、`navigation_timing`、`hydration_time`、`wasm_decode_timing`、`markdown_render_timing`，数值字段只允许 `value/domInteractive/responseStart/durationMs`，dimension key/value 只能进入白名单低基数集合；不接受任意 JSON blob。

### Security Challenge Contract

业务 RiskControl 决策只由服务端生成。受保护命令第一跳不携带 challenge proof；当服务端返回 428 时，响应必须同时带 `X-Fsus-Risk-Decision: challenge|stepUp`、`X-Fsus-Challenge-Action`、`X-Fsus-Challenge-Route-Key` 与 `X-Fsus-Challenge-Policy-Version`。action/routeKey 是本次业务请求的不可变 identity，客户端只允许严格相等校验后发起 challenge；policyVersion 绑定当前裁决，不能从旧页面状态或本地缓存恢复。block/throttle/reject 使用 429 和对应 `X-Fsus-Risk-Decision`，queue/allow 进入各自稳定业务结果，不先向客户端暴露 kind 策略。缺失、超长、未知 decision 或 identity mismatch 均 fail closed，不得根据错误文案或 action 名猜 kind。

`SecurityChallengeKind` 的 wire/decoder 枚举只表达 `kind_known`，不承诺端到端可执行。仓库随构建发布版本化 capability manifest；每个 enum 值显式记录 provider、executor factory、UI/headless host、取消能力和业务 surface。当前 Perception V2/V3 具备 UI executor；`sha256PowV1` 只在 `notification.subscribe` 具备 headless executor/host；`argon2idPoSpaceV1` 通过同一可取消 executor 同时注册 UI host 与 `notification.subscribe` headless host。HumanReadProof 与 Passkey 占位宿主仍不进入可启用 manifest。服务端策略和签发必须同时满足 provider、manifest version、executor 与 action host；未知能力一律 fail closed。该规则不增加 AEDS 字段，不改变 `SecurityChallengeAssignment` / `SecurityChallengeEnvelope` 布局。

RiskControl challenge assignment 使用统一 AEDS 契约，不在 PoW、感知挑战、PoSpace、HumanReadProof、Passkey step-up 或匿名 proof provider 中各自定义不同字段。每次 `challenge|stepUp` issue 生成一个 UUIDv7 `SecurityChallengeEnvelope.envelopeId`；envelope 的 assignment 数组是服务端权威的 ordered required member 集合，顺序必须与 `RiskDecision.RequiredChallenges` 一致且不能由客户端重排。每个 `SecurityChallengeAssignment` 通过其所在 envelope 绑定同一 `envelopeId`，并包含 `challengeId`、`traceparent`、`tenantId`、`kind`、`escalationLevel`、`action`、`routeKey`、`subjectHash`、`clientIpHash`、`deviceFpHash`、`issuedAtUnixMs` 和 `expiresAtUnixMs`；同一 envelope 的 action、routeKey、subject/client/device hash 与 policyVersion 必须一致，`expiresAtUnixMs` 必须大于 `issuedAtUnixMs`。`envelopeId` 与 `challengeId` 都只接受 UUID v7。`subjectHash`、`clientIpHash`、`deviceFpHash` 均为 64 字符 SHA-256 hex，不携带原文。

支持的 `SecurityChallengeKind` wire name 为：`sha256PowV1`、`argon2idPoSpaceV1`、`humanReadProofV1`、`passkeyStepUpV1`、`adminPasskeyStepUpV1`、`recoveryKeyProofV1`、`anonymousCredentialProofV1`、`zkAnonymousCommentProofV1`、`perceptionLocalizationV2`、`perceptionMicroInteractionV2`、`perceptionCharacterV3`。未列出的名称和数值一律 fail closed，不存在 alias 或数值兼容映射。

`PerceptionCharacterV3` 的规范身份为 wire name `perceptionCharacterV3` 与 algorithm `fsu.challenge/perception-character-artifact@v3`，数学、密码学、final-media、状态和 coarse error 契约见 [PerceptionCharacterV3 protocol](../security/perception-character-v3-protocol.md)。运行时 enum、typed AEDS frame/codec、provider 和 capability 均以该身份登记；V3 禁止把任何 V1/V2 kind、frame、旧 V3 raster payload 或 dictionary payload 解析为 alias/fallback。客户端 solve duration、seed、recipe、glyph/warp/noise 参数和 answer-derived material 也不属于 V3 wire。

RiskControl 风险事件使用稳定 source wire value 与 reason enum 名称做跨端归因。旧 reason `VerifiedCrawler` 到 `CommentNullifierAbuse` 的既有枚举数值保持不变；当前 challenge reason 包括 `DeviceFingerprintMissing`、`DeviceFingerprintChanged`、`RegionPolicyHit`、`CommentSpamPatternHit`、`AnonymousNullifierAbuse`、`AuthFailureBurst`、`PasskeyAssertionFailure`、`AdminStepUpRequired`、`AdminStepUpFailed`、`ChallengeExpired`、`ChallengeKindMismatch` 与 `ChallengeSignatureInvalid`。稳定 source wire value 包括 `anti-crawler`、`auth`、`rate-limiter`、`pow`、`human-read-proof`、`passkey`、`public-read`、`pospace`、`risk-control`、`device-fingerprint`、`region-policy`、`comment-governance` 和 `admin-step-up`。未知 reason 枚举值进入日志/事件时保留原始数值字符串。

challenge 签发与验证审计由 `security_challenge` 和 `security_challenge_attempt` 持久化，Redis 保存短 TTL envelope/member 热状态与最终一次性 proof。PostgreSQL 仍按各 member 的 challengeId 保存 assignment 字段和策略上下文：kind、algorithm、action、routeKey、subjectHash、clientIpHash、deviceFpHash、policyVersion、payloadHash、traceId、traceparent、issued/expires 时间，以及 attempt outcome；payload / proof 原文不得进入持久化表。member 仍使用 `issued | verified | expired | replayed | failed | revoked`。Redis envelope 保存 ordered challengeIds、requiredKinds、verifiedMembers、version 与 `active | completed | failed | expired | revoked` 状态；重放是拒绝 reason，不会把 completed envelope 改写为另一成功状态。单 member envelope 也走相同转换。

Redis envelope state 必须带不超过最短 required member expiry 的 TTL，并以 versioned compare-and-set 原子检查 `envelopeId + next ordinal + member state + binding hashes + policyVersion` 后推进 progress，不能由进程内 read-modify-write 决定 completed。重复 verify 已成功的 member 按 replay fail closed，不得重复推进计数或提前 mint；任一 required member 失败、过期、撤销、重放、顺序错乱，或 CAS 发现 envelope replacement / identity drift 时，整个 envelope fail closed 且不得进入 completed。PostgreSQL audit 不能代替 Redis CAS 放行；Redis miss/断连也不能从客户端自报 progress 重建成功。

单个 challenge provider 校验成功只把对应 member 标为 verified 并返回 progress，不得签发业务 proof。只有 CAS 确认 ordered required members 全部 verified 后，orchestrator 才能 mint 一个 aggregate proof token，并通过 `X-Fsus-Challenge-Proof` header 传递。该 token 是 opaque 值；Redis `SecurityChallengeProof` cache 保存一次性 claims，并绑定 `envelopeId`、ordered `requiredKinds`、最后一个 ordered member 的 `challengeId` / `kind`、`action`、`routeKey`、`subjectHash`、`clientIpHash`、`deviceFpHash`、`issuedAt`、`expiresAt`、`nonce` 和 `policyVersion`。最终业务请求为兼容既有三项 header，`X-Fsus-Challenge-Id` 与 `X-Fsus-Challenge-Kind` 仍发送最后一个 ordered member 的值；服务端必须从 proof claims 校验 envelopeId 与完整 ordered requiredKinds，不能把 header 中最后一个 member 当作“全部完成”的声明。服务端消费时必须先执行 consume-once，再校验全部绑定字段；replay / Redis miss、action 或 route mismatch、IP/device mismatch、过期 proof、requiredKinds 重排或 envelope replacement 都不得进入业务写入，并必须写 challenge attempt。该 header 不替代 `X-Fsus-Mfa-Proof`、legacy `X-Fsus-Pow-Proof` 或 HumanReadProof 阅读计数 proof。

challenge provider 统一通过 `ISecurityChallengeProvider` 接入，wire kind 与上表 `SecurityChallengeKind` 一致。provider 必须先持久化 challenge，再返回可下发 assignment；`SecurityChallengeOrchestrator` 根据 `RiskDecision.RequiredChallenges` 建立 UUIDv7 envelope，按 server-owned cost class 稳定排序完整计划，但每次只调用并返回一个 actionable provider。其 assignment/payload 由 `challengeId` 一一对应，下一项只能由前一项完成后的 version CAS winner 签发。provider missing、provider failure、assignment/payload 对应无效、member state CAS 失败或 aggregate proof mint failure 必须返回可观测错误并 fail closed，不得落入具体业务 endpoint 的 fallback 分支。policy validation/readiness 必须在启用组合 band 前确认每个 required kind 同时具备后端 provider、前端 executor 与对应 UI/headless host；尚不满足时拒绝策略启用，而不是让运行时永久返回 `RISK_CHALLENGE_SET_INCOMPLETE`。

`sha256PowV1` provider 的 issue payload 只包含 legacy PoW challenge 必需字段：`salt`、`difficulty`、`timestamp`、`signature`。`signature` 是无 padding Base64Url HMAC，不能使用旧标准 Base64 `+`、`/`、`=` 兼容格式。verify payload 必须包含 `proof`，其值为旧 `X-Fsus-Pow-Proof` 使用的 Base64 FPOW binary proof；服务端复用同一解析器、`IPowService.VerifyAsync` 和 `AdaptivePowGovernor` difficulty 裁决。该 provider 不引入公开 JSON fallback，不改变现有 FPOW wire format，也不删除 `GET /api/binary/auth/pow-challenge` 或 `X-Fsus-Pow-Proof` legacy 路径。

`perceptionLocalizationV2` and `perceptionMicroInteractionV2` providers use the fixed wire algorithm `fsu.challenge/perception-sealed@v2` and a dedicated AEDS frame. The issue payload is `PerceptionSealedChallengeV2` (`184`): `assignment`, `algorithm`, `taskKind`, `renderRecipeBase64`, `recipeHashHex`, `sealedTokenBase64`, `signatureHex`, `gridWidth`, `gridHeight`, `family`, `variant`, `issuedAtUnixMs`, and `expiresAtUnixMs`. `taskKind` accepts only `localization` or `microInteraction`; the sealed token binds task/action/route/subject/client/device/policy/recipe. `renderRecipeBase64` carries only the render recipe, `recipeHashHex` binds the canonical recipe bytes, and `sealedTokenBase64` plus `signatureHex` carry only server-side sealed/binding material.

`perceptionCharacterV3` 是字符感知挑战的唯一当前契约，使用 V3 frame、provider 与 renderer。V2 frame 或 dictionary payload 不能重解释为 V3；V3 不接受任何旧 identity、alias 或 fallback。V3 与 V2 共享 envelope、assignment、proof、action/route/identity binding 和一次性消费边界。

perception verify payload 为 `PerceptionSealedResultV2` (`185`)：`assignment`、`algorithm`、`taskKind`、`payloadKind`、`responsePayloadBase64`、`recipeHashHex`、`sealedTokenBase64`、`signatureHex`、`issuedAtUnixMs` 和 `expiresAtUnixMs`。`payloadKind` 只允许 `coordinates` 或 `steps`，并分别对应 Localization、MicroInteraction task；响应内容统一放入 `responsePayloadBase64`。该契约不新增公开 JSON fallback。

`perception-sealed@v2` issue payload prohibits expected answers, expected coordinates, expected steps, semantic labels, raw client/device/user information, raw UA, proof, admin session, or any field that directly derives the solution; verify payload may carry only public binding fields, sealed token/signature, recipe hash, `solveDurationMs`, and the coordinate or step response encoded for the task kind. The server issue path must not generate PNGs, rasterize, or write answer truth to PostgreSQL/Redis; the verify path must first decrypt the AEAD token, then validate assignment/action/route/subject/client/device/policy/recipe bindings, and finally allow the orchestrator to mint `X-Fsus-Challenge-Proof` only after the Redis attempt gate + consume-once succeeds.

perception-sealed@v2 的配置名必须与运行时保持一致：AEAD key rotation 只使用 `Security:PerceptionSealedToken:CurrentKeyVersion` 与 `Security:PerceptionSealedToken:Keys:{version}`，本地、测试和生产均不得回退到临时派生 key；固定测试任务只允许通过 Localization 坐标与 MicroInteraction 步骤 fixture 注入；micro-interaction 子系统开关为 `Security:PerceptionV2:MicroInteraction:Mode`。RiskControl rollout 不新增公开 JSON 配置面，只通过 admin binary options/rollback 更新策略。

perception-sealed@v2 运行时 metrics 使用 `fsus.security.challenge.v2.*` 前缀：`issued.count`、`verified.count`、`failed.count`、`replayed.count`、`solve.duration`、`payload.bytes`、`verify.duration` 和 `task.kind.count`。所有记录路径必须把 metrics 写入视为 best-effort，collector/listener 失败不得改变 challenge verify 结果。受保护 readiness detail 的 `riskControl` 区块同时暴露 `perceptionAeadKey`、`perceptionMode` 和 `perceptionPerformanceBudget`；预算快照包含 issue p99、verify p99、payload p95、client render p95、对应阈值和 `warnings`，用于 rollout gate 告警而不替代业务 proof 消费。

Verification matrix for perception-sealed@v2:

| Input/Dependencies | Expected Behavior |
| ------------- | ---------- |
| `algorithm` 不是 `fsu.challenge/perception-sealed@v2` | AEDS `ApiError`，fail closed |
| `taskKind` / `payloadKind` 不匹配 | AEDS `ApiError`，fail closed |
| sealed token keyVersion 未配置、AAD mismatch、密文篡改或 token 过期 | AEDS `ApiError`，fail closed |
| challengeId、action、routeKey、subjectHash、clientIpHash、deviceFpHash、policyVersion 或 recipeHash 不匹配 | AEDS `ApiError`，fail closed，不进入业务 endpoint |
| Redis `INCR` attempt gate failed, attempt exceeded, Redis `SETNX` consume-once failed, or replay | AEDS `ApiError`, fail closed; Postgres audit must not become the consumption authority |
| PostgreSQL audit / aggregation write failure | Not a basis for verify approval; expose it through structured log and readiness/admin surfaces, without writing raw payload or proof text |
| HumanReadProof proof is used for `comment.*`, `auth.*`, `admin.*` | Required-kind mismatch; return 428 without consuming the proof |
| `adminPasskeyStepUpV1` proof attempts to replace `X-Fsus-Mfa-Proof` | Return 428 / `MFA_PROOF_REQUIRED`; do not execute the admin-sensitive write |

The rollout order is fixed to `observe -> V3/localization enforce -> micro-interaction optional -> strict/lockdown`. On rollback, first set `globalMode` back to `observe` or disable public-read/comment/auth enforcement for the affected action; PoSpace may enter notification/high-risk branches only through its subsystem mode; AdminPasskeyStepUp and `X-Fsus-Mfa-Proof` always retain separate authorization boundaries.

`argon2idPoSpaceV1` provider 使用 `fsu.pospace/argon2id@v1` wire algorithm，默认 `Security:PoSpaceV1:Mode=disabled`，只有策略显式 enable 且 RiskDecision 选择该 kind 时才可签发。`src/shared/Contracts/Validation/Security/pospace-v1-contract.json` 是前后端唯一参数源，`tools/contracts/generate-pospace-v1-contract.mjs` 从中生成 C#/TypeScript 常量：`memoryKib=19456..65536`、`iterations=2..6`、`lanes=1..4`、`targetDurationMs=100..5000`。配置、issue、verify 和 derive 都只接受无符号规范十进制；空白、正负号、前导零、小数、NaN、溢出或越界值直接拒绝，禁止 clamp。issue payload 包含 `algorithm`、`saltHex`、`memoryKib`、`iterations`、`lanes` 和 `targetDurationMs`；verify payload 必须按同一规范回传并追加 `nonceHex` 和 `proofHex`。服务端通过 `SecurityPoSpaceChallenge` cache 一次性消费 challenge，按生成契约规定的 material 字段顺序重新派生 proof；共享固定向量同时约束 C# 与 TypeScript 实现。

移动端或低内存客户端不得执行 PoSpace。客户端只上报低基数原因 `worker_unavailable | slow_device | mobile_memory_cap | memory_tier_cap`，通过现有 `SecurityChallengeIssueRequest.attributesJson.unsupportedAssignment` 绑定原 `challengeId/kind/action/routeKey` 和从 1 开始的有限重签计数；该扩展仍只走 AEDS binary endpoint，不增加 JSON fallback。服务端核验原 assignment 存在、未过期、仍为 issued 且 subject/IP/device/action/route 全绑定后，先撤销原 assignment 与一次性 cache，再依据当前策略删除 PoSpace、改发仍启用的当前 challenge 或 fail closed；最多两次，不接受客户端指定 fallback，也不回传内部判定细节。

PoSpace UI 与 notification headless 路径都必须调用共享 executor 完成 `capability -> worker solve -> verify -> proof store`，不得复制 Argon2、payload 解析或超时实现。UI refresh/cancel/unmount、notification stop/账号切换/dispose 都递增 generation 并终止旧 worker；迟到结果不得覆盖新 assignment。headless unsupported 只按上述 bounded attributes 请求服务端重签，最多两次且不在客户端选择 fallback；原有 `sha256PowV1` 与 guest legacy PoW 路径保持独立兼容。

`humanReadProofV1` provider 使用 `fsu.human-read-proof@v1` wire algorithm，且只允许 `action=public.read`。issue payload 包含 `algorithm`、`token`、`scope`、`routeKey`、`articleId`、`minDwellMs`、`issuedAtUnixMs` 和 `expiresAtUnixMs`；持久化层只保存 payload hash，不保存 token 原文。verify payload 必须提交 `token`、`scope`、`routeKey`、`articleId` 和 `dwellMs`，服务端复用 HumanReadProof submit 绑定校验；成功只签发绑定 public-read action / route / IP / device 的统一 proof token，并额外写 `ReadProofAccepted` 负分风险信号以降低后续 public-read 风险。`comment.*`、`auth.*`、`admin.*` 或任何非 public-read action 使用该 kind 都必须 fail closed；`RequiresRiskControlFilter` 也必须在 required kind 不匹配时返回 428，不得消费 HumanReadProof proof 或进入写操作 handler。

`passkeyStepUpV1` provider 使用 `fsu.passkey-step-up@v1` wire algorithm，只接受普通已认证用户，不接受 `identity_kind=admin_principal`。issue payload 包含 `algorithm`、`challengeToken` 和 `optionsJson`，其中 `optionsJson` 为当前用户 allowCredentials 约束后的 `PasskeyLoginBeginCoreModel` JSON；verify payload 必须包含 `assertionJson`，其内容为 `PasskeyLoginCompleteCoreModel` JSON。verify 成功后 provider 不直接授权业务请求，只由 orchestrator 签发统一 `X-Fsus-Challenge-Proof`。普通账号敏感凭据变更不得用该 RiskControl proof 替代 `X-Fsus-Mfa-Proof`；必须走 `/api/binary/auth/step-up/passkey/begin|complete` 换取 action 绑定的一次性 `MfaChallengeResult.proofToken`。该业务 step-up 通道受 `Auth:PasskeyStepUp:Enabled` 控制，关闭时返回 503 + `PASSKEY_STEP_UP_DISABLED`，且不签发 challenge 或 proof。

`adminPasskeyStepUpV1` provider 使用 `fsu.admin-passkey-step-up@v1` wire algorithm，只接受 admin principal session。issue payload 同样包含 `algorithm`、`challengeToken` 和 `optionsJson`，verify payload 同样使用 `assertionJson`。该 provider 复用 admin Passkey step-up challenge 与 WebAuthn 校验，但只执行 verify-only 路径，不 mint、consume 或返回 `X-Fsus-Mfa-Proof`，也不写 `SecurityMfaProof` cache。admin-sensitive 作者/安全写操作仍必须先通过 `/api/binary/auth/admin/step-up/passkey/begin|complete` 获取 action=`admin-sensitive` 的一次性 `X-Fsus-Mfa-Proof`；`adminPasskeyStepUpV1` 换得的普通 `X-Fsus-Challenge-Proof` 不能替代它。

统一 challenge 签发、验证与撤销只通过 binary endpoint 暴露，不提供公开 JSON fallback。`POST /api/binary/security/challenge` 接收 `SecurityChallengeIssueRequest` (`173`) 并返回 `SecurityChallengeIssueResponse` (`175`)；`POST /api/binary/security/challenge/verify` 接收 `SecurityChallengeVerifyRequest` (`174`) 并返回 `SecurityChallengeVerifyResponse` (`176`)；`POST /api/binary/security/challenge/cancel` 接收 `SecurityChallengeCancelRequest` (`200`) 并返回 `EmptySuccess` (`240`)。三个端点均为匿名、`fixed_ip` 限流、`no-store` 响应，request `Content-Type` 必须是 `application/octet-stream`，response `Accept` 只接受空值、`*/*` 或 `application/octet-stream`；不匹配时返回 AEDS `ApiError`，`Accept` 不匹配使用 HTTP 406。请求 frame 上限为 64 KiB，所有业务失败、unsupported kind、provider missing、provider failure、proof replay / mismatch 均 fail closed 返回 `ApiError` frame；cancel 对 missing/repeated/binding-mismatch envelope 返回相同 opaque success，避免形成枚举 oracle。

`PerceptionCharacterV3` 是上述 frame 内由 `kind=14` 封闭判别的 typed AEDS union member；它不经过 `ProviderPayloadJson`。issue member 只编码 `algorithm/challengeId/envelopeId/representation/mediaType/mediaBytes/physicalWidth/physicalHeight/displayWidth/displayHeight/attemptBudget/policyVersion/issuedAtUnixMs/expiresAtUnixMs/stateToken`。visual 只接受不超过 32 KiB 的最终 `image/png`：物理尺寸 `384×144`、显示尺寸 `320×120`、IHDR bit depth 4、color type 0 grayscale、无 alpha，并使用 deterministic zlib DEFLATE level 9；release corpus 还必须满足 P50 ≤ 20 KiB、P95 ≤ 28 KiB。audio 只接受不超过 48 KiB 的最终 mono `audio/ogg; codecs=opus`，固定 48 kHz、pre-skip 312、mapping family 0、20 ms frame、16 kbps CBR/VOIP/complexity 5，release corpus 必须满足 P95 ≤ 40 KiB。`artifactHash` 是 exact transported `mediaBytes` 的 SHA-256，并进入 answer HMAC、AEAD AAD/plaintext、Redis state 和 verify binding。verify member 只编码 `algorithm/challengeId/envelopeId/representation/answer/stateToken`，不接受 issue media、seed、recipe、signature、key 或 client solve duration。unknown union kind、truncated slice、旧 algorithm/media/dimensions/state layout、越界/超限或 malformed PNG/Ogg 均在 provider 调用前拒绝。

artifact pool manifest v1 的 additive `artifactBytes` 是 server-only index metadata，不进入 AEDS payload；旧 runtime 可忽略该字段，新 runtime startup 必须把它与解密后 exact `mediaBytes.Length` 和现有 hard limit 复验。lease、minute/rolling-hour egress accounting、IP-prefix/device/subject/action quota 与 operation retry fence 在同一 Redis Lua commit；compression estimate、HTTP envelope 大小和 ciphertext record length 均不得代替 exact transported artifact bytes。预算或 inventory 竞争失败不改变 frame schema，不触发 runtime rendering，也不返回旧 V1/V2/parser fallback。

前端 response adapter 必须先用 assignment `kind=14` 判别 provider slice，再执行 typed POD 解码；
JSON parse must not be attempted. The front-end typed adapter executes the same set of bounded before creating any browser media resources
PNG/Ogg Opus 结构、CRC、尺寸和 hard-limit 校验；通过校验的 final PNG 直接创建
`image/png` Blob object URL 并作为 FsusUI `image-url` media 消费，不做客户端栅格重建或 canvas 解码。
audio 只创建 `audio/ogg; codecs=opus` Blob，并由现有 accessible audio control 播放。
Replace, complete, cancel, expire and unmount all first stop /断开当前 audio and revoke object URL.
challenge proof, opaque state token and media are only saved in the current memory state machine and are not written to
localStorage, sessionStorage or IndexedDB.

deferred envelope 只渲染 `completedCount` 对应的当前 member。客户端在首次 issue 前固定选择一个
representation (default visual), after completing the prerequisite, only consume the single returned by the server
`nextAssignment/nextProviderPayload`，不得并行预取 visual/audio。ambiguous verify send 保留当前
member 并等待服务端 outcome；不会自动 refresh/reissue 或租用另一 artifact。
Both representation switch and refresh call issue again: ordinary refresh calls cancel first to cancel the old envelope.
switch triggers server-side atomic undo and replacement by replacement headers; new
identity 进入 `ready` 前不得复用旧 answer、state token、attempt state 或媒体资源。公开 UI 只映射
`retryable | reissueRequired | unavailable | rejected` 为本地化任务状态，不渲染 backend reason code。

当前 production 客户端接入 shared RiskControl proof 的业务清单仅为 Passkey login begin/complete、
Recovery Key verify 与 comment/reply。account self-service 与 admin command 尚无 shared RiskControl
proof endpoint/flow；admin-sensitive endpoint 的 `X-Fsus-Mfa-Proof` 是独立 MFA 契约，不能视为或转换成
`X-Fsus-Challenge-Proof`。未来 account/admin endpoint 接入本节的 shared proof 契约时，客户端必须经
shared coordinator 提交并复用唯一 App-level dialog host，不得增加局部 challenge transport/host。

V3 issue response 将公开 `riskScore/effectiveRiskScore` 归零，失败只公开 `retryable`、`reissueRequired`、`unavailable` 或 `rejected`；crypto、Redis、binding、rate-limit dimension 和 parser 原因只进入内部 audit。token/AAD/answer MAC 的字段顺序、编码和测试向量以 `docs/security/perception-character-v3-protocol.md` 与 canonical JSON 为唯一权威源。

同表示 refresh 与 visual/audio representation replacement 都在 issue 请求同时携带 `X-Fsus-Replaces-Challenge`、`X-Fsus-Replaces-Envelope` 与 `X-Fsus-Replaces-State-Token`；V3 客户端不得使用 fire-and-forget cancel 加普通 issue 模拟 refresh。服务端先完整准备并校验 replacement candidate，再由一个 Redis 原子操作校验三项旧 identity、全部 server-authoritative binding 与 active-index，执行旧 `active -> revoked`、新 state NX+TTL 和 active-index swap。active-index 的 server-device 摘要跨 answer/token key rotation 稳定；旧 challenge binding 必须按它记录的旧 answer-key version 校验，新 challenge 才绑定 current version。任一 header 缺失、替换或并发 loser 均返回 coarse `rejected`；Redis 结果不确定返回 `unavailable` 且禁止重放 mutation。commit 前的 renderer/crypto/payload 失败不改变旧 identity，commit 后旧 identity 不恢复。这些 header 只携带 opaque identity/state，不得进入 access log、telemetry 或 cache key。

`SecurityChallengeIssueRequest` 字段：

| Field | Type | Description |
| ------ | ------ | ------ |
| `action` | string | RiskControl action，例如 `public.read`、`comment.create`；必填 |
| `routeKey` | string | 业务 route key，例如 `article:42`；必填 |
| `deviceFp` | string | 可选设备指纹；服务端只使用规范化状态和 SHA-256 hash |
| `attributes` | string | 可选 JSON 字符串，当前仅作为 wire 契约预留，不进入持久化 payload 原文 |
| `capabilityManifestVersion` | string | 必须等于 `2026.07.22.1`；旧的 eager-envelope 客户端收到 409 并整页刷新，不解析新 verify POD |

`SecurityChallengeIssueResponse` 字段：

| Field | Type | Description |
| ------ | ------ | ------ |
| `decision` | enum | `allow`、`challenge`、`stepUp`、`queueForModeration`、`throttle`、`block` 或 `unknown` |
| `riskScore` / `effectiveRiskScore` | int | 原始风险分与策略模式调整后的风险分 |
| `escalationLevel` | int | 策略要求的升级等级 |
| `policyVersion` | string | 产生该裁决的 RiskControl policy version |
| `retryAfterMs` | int | 限流 / 排队建议等待时间；当前 endpoint 返回 0 |
| `envelope` | `SecurityChallengeEnvelope?` | `challenge` / `stepUp` 时返回 UUIDv7 `envelopeId`、policyVersion 与当前唯一 actionable assignment；完整 ordered plan 只保存在服务端；非 challenge 裁决为空 |
| `providerPayloads` | array | 只与当前 actionable assignment 按 `challengeId` 关联；`sha256PowV1` 包含 `salt`、`difficulty`、`timestamp`、Base64Url `signature` |

`SecurityChallengeVerifyRequest` 字段：

| Field | Type | Description |
| ------ | ------ | ------ |
| `envelopeId` | string | issue response 的 UUIDv7 envelope id；必填，非 v7 或与 member 不匹配时 fail closed |
| `challengeId` | string | issue response 中的 assignment id；必填 |
| `kind` | enum | `SecurityChallengeKind`；未知或未支持 kind fail closed |
| `action` | string | 必须与 issue / 后续业务 endpoint 绑定的 action 一致 |
| `routeKey` | string | 必须与 issue / 后续业务 endpoint 绑定的 route key 一致 |
| `payload` | string | provider payload JSON；`sha256PowV1` 必须包含 Base64 FPOW `proof`；V3 或 sealed V2 必须包含对应 response、recipe/sealed binding 与 `solveDurationMs`；`passkeyStepUpV1` / `adminPasskeyStepUpV1` 必须包含 `assertionJson` |

`SecurityChallengeVerifyResponse` 字段：

| Field | Type | Description |
| ------ | ------ | ------ |
| `verified` | bool | 本次 member provider 校验是否通过；成功响应固定为 `true`，不代表 envelope 已完成 |
| `envelopeId` | string | 服务端权威 UUIDv7 envelope id |
| `challengeId` | string | 被验证的 challenge id |
| `kind` | enum | 被验证的 provider kind |
| `policyVersion` | string | proof 绑定的 policy version |
| `completedCount` | int | 已 verified 的 required member 数量；范围 `0..memberCount`，不能由客户端累加推断 |
| `memberCount` | int | envelope required member 总数；范围 `1..8`，单 challenge 固定为 `1` |
| `envelopeCompleted` | bool | 仅当本次 member verified 且 `completedCount == memberCount` 时为 `true` |
| `proofToken` | string | 仅 `envelopeCompleted=true` 时返回 aggregate opaque proof；in-progress 响应必须为空 |
| `expiresAtUnixMs` | int64 | completed 时来自 aggregate mint claims 的服务端权威绝对到期时间；客户端只可应用保守时钟偏差，不得固定推算 TTL |
| `reason` | string | 成功为 `ok`；失败走 `ApiError` frame |
| `retryAfterMs` | int | 当前成功响应为 0 |
| `nextAssignment` | assignment? | 未完成时由原子推进签发的唯一下一 member；完成或失败时为空 |
| `nextProviderPayload` | payload? | 与 `nextAssignment.challengeId` 严格一致；V3 使用 typed union，其他 kind 使用 provider JSON |

`SecurityChallengeCancelRequest` 字段固定为 `envelopeId`、`action`、`routeKey`、`deviceFingerprint` 与 `policyVersion`。服务端重新派生 subject/client IP/device hash 并对完整 binding 执行 CAS revoke；撤销后全部 member 状态变为 `revoked`，未消费 aggregate proof 立即失效。客户端先推进 generation/abort，再异步发送可重试的 keepalive cancel；cancel response 迟到或丢失不能恢复 envelope。

受 `RequiresRiskControlFilter` 保护的 endpoint 必须具备 `RiskActionEndpointMetadata`，服务端用 aggregate claims 中的 envelopeId、ordered requiredKinds、action、routeKey、subjectHash、clientIpHash、deviceFpHash 和 policyVersion 消费统一 proof。RiskControl actor context 不能混用身份平面：普通账号 actor 可携带 `UserId/SessionId`，AdminPrincipal actor 只能携带 `AdminPrincipalId/AdminSessionId` 且 `UserId/SessionId` 必须为 null；subject binding 对 AdminPrincipal 只使用 admin id + admin session。客户端提交已签发 proof 时必须同时发送 `X-Fsus-Challenge-Proof`、`X-Fsus-Challenge-Id`、`X-Fsus-Challenge-Kind`；后两项固定取最后一个 ordered member，仅作为 transport compatibility binding，不能替代 aggregate claims 校验。缺 proof 返回 proof required，重放 / Redis miss、过期、绑定不匹配、requiredKinds 重排、incomplete envelope 和撤销分别映射为安全公开分类，并通过 `X-Fsus-Challenge-Proof-Outcome` 返回；该分类不得包含内部 cache 或身份细节。proof 已通过后出现的普通业务校验拒绝不带该 header，transport 仍把 token 视为已消费而不能恢复。block / throttle 类裁决返回 429。`queue` 裁决只允许业务端显式读取 `RiskControlDecisionContext` 后继续执行；评论创建会把 queue 映射为待审队列并记录 `risk_control_queue`，其他未接入 queue 语义的写入口不得默默放行。当前高价值入口使用的 action 为：`POST /api/binary/comment` root create -> `comment.create`，同一路径 reply payload -> `comment.reply`，`POST /api/binary/auth/passkey/login/begin` -> `auth.passkey.begin`，`POST /api/binary/auth/passkey/login/complete` -> `auth.passkey.complete`，`POST /api/binary/auth/recovery-key/verify` -> `recovery-key.verify`，匿名 `GET /api/notifications/stream/preflight` / WebSocket handshake -> `notification.subscribe`。notification preflight 通过 headers 消费 aggregate proof 并签发最长 30 秒、受 proof expiry 上限约束的一次性 HttpOnly grant；WebSocket 只消费 grant，原 proof 不进入 query。旧 `auth.login` action 仅保留给 legacy migration/test policy，不绑定生产用户侧 password endpoint。旧 `RequiresPowFilter` endpoint 仍使用 `X-Fsus-Pow-Proof`；同时保留 PoW 的 auth/comment endpoint 需要同时提交 legacy PoW proof 与 RiskControl aggregate proof，notification stream 继续兼容 legacy `pow` query proof。

notification preflight 的当前所有权语义是 proof 到 grant 的单条 Redis Lua 原子交换，不是先 GETDEL 再独立 mint。grant token 从 proof token 确定性派生；HTTP 响应丢失时只恢复同一未消费 grant，WebSocket 消费后不能再次恢复或重新 mint。grant 只保存 proof token hash 与 envelopeId；恢复和 WebSocket 消费都必须重新确认 envelope 仍为 completed、prepared proof token hash 与全部 binding 一致，因此 cancel/revoke 会立即拒绝已经交换但尚未消费的 grant。

前端 `BinaryRequestOptions.riskChallengeProof` 只接受 proof store reservation 产生的 typed aggregate lease，不接受 header map。UI host 与 notification headless host 共用一个 envelope runner：runner 只持当前页内存中的已签发 prefix；每次 verify 校验并追加服务端返回的 `nextAssignment/nextProviderPayload`，不把 proof、计划或 provider state 写入 local/session storage。只有 `envelopeCompleted=true` 后才能向业务层暴露 proof。refresh、cancel、身份变化、route generation 变化、组件 unmount 或 notification dispose 会取消整个 envelope；旧 generation 的迟到 worker/verify 结果不得提交或覆盖新 envelope。

transport 校验 action、routeKey、最后 member challengeId/kind、proofToken、policyVersion 与服务端权威 expiry 后统一写 header；旧 `requiresPow/powScope` 始终只生成 legacy `X-Fsus-Pow-Proof`，两者不互转。fetch 前取消恢复 reservation；进入 fetch 后的成功、业务拒绝、明确 expired/replayed/binding mismatch/revoked/rejected 或未知网络结果都进入终态。`BinaryTransportError.riskChallengeFailure` 是 428 的唯一业务可见结构化分类。challenge-aware command 只可重放 `idempotent` 或带固定 `mutationIdentity` 的原始命令，proof 已可能到达服务端时不自动重放。旧客户端缺少 `envelopeId` verify wire 时在 decode/validation 阶段返回 `security_challenge_verify_request_invalid`；有效 envelope/member 但 binding 不符时内部 reason 为 `challenge_envelope_binding_mismatch`，对 binary caller 统一收敛为 428 `challenge_failed`，不得泄露哪项绑定失败。manifest 不支持组合 capability 时沿用 catalog 的 `capability_unavailable` / `executor_unavailable` 等内部 reason，不承诺新增 public 版本码，也不得执行第一项后继续业务。

无需重启的回退只允许通过 reload-capable RiskControl policy 禁止产生 `RequiredChallenges.Count > 1`、把受影响 action 切到 `observe|disabled`，或回滚 last-known-good policy；已签发的多 member envelope 继续按原 expiry fail closed，不转换为单 member proof。回退不得恢复 `assignments[0]`、多个独立 header token、客户端自报 completed 或公开 JSON fallback。重新启用前，policy validation/readiness 必须确认组合中每个 kind 的 provider、executor、UI/headless host 和 manifest version 全部可执行。

| FrameType | 值 | POD | 用途 |
| ----------- | ---- | ----- | ------ |
| `SecurityChallengeAssignment` | 171 | `SecurityChallengeAssignmentPod` | 单个 challenge assignment |
| `SecurityChallengeEnvelope` | 172 | `SecurityChallengeEnvelopePod` + `SecurityChallengeAssignmentPod[]` | UUIDv7 envelope 与 ordered required assignment 集合，最多 8 个；单 challenge 同样使用 |
| `SecurityChallengeIssueRequest` | 173 | `SecurityChallengeIssueRequestPod` + UTF-8 blob | RiskControl challenge 签发请求 |
| `SecurityChallengeVerifyRequest` | 174 | `SecurityChallengeVerifyRequestPod` + UTF-8 blob | 携带 envelopeId/member identity 的 provider proof 验证请求 |
| `SecurityChallengeIssueResponse` | 175 | `SecurityChallengeIssueResponsePod` + assignment / provider payload records + UTF-8 blob | RiskControl challenge 签发响应 |
| `SecurityChallengeVerifyResponse` | 176 | `SecurityChallengeVerifyResponsePod` + UTF-8 blob | member progress；未完成时携带 next assignment/payload，全部完成时只携带 aggregate proof token |
| `SecurityChallengeCancelRequest` | 200 | `SecurityChallengeCancelRequestPod` + UTF-8 blob | 绑定 action/route/device/policy 的 envelope revoke；响应使用 `EmptySuccess` |
| `PerceptionSealedChallengeV2` | 184 | `PerceptionSealedChallengeV2Pod` + UTF-8 blob | perception-sealed@v2 issue payload；Localization/MicroInteraction 共用 |
| `PerceptionSealedResultV2` | 185 | `PerceptionSealedResultV2Pod` + UTF-8 blob | perception-sealed@v2 verify payload；coordinates/steps 共用 |
| `RetiredCredentialSpecificRevocationRequest` | 186 | 无有效 payload | 永久 retired；服务端不得读取或恢复 credential-specific handle body |
| `RetiredCredentialSpecificRevocationResponse` | 187 | 不再发送 | 永久保留编号，禁止复用 |
| `AnonymousCredentialRevocationSnapshot` | 196 | `AnonymousCredentialRevocationArtifactPod` + shared blob | epoch/version 的公共 full revoked-set snapshot |
| `AnonymousCredentialRevocationDelta` | 197 | `AnonymousCredentialRevocationArtifactPod` + shared blob | 从 `baseVersion` 到 `version` 的公共 append-only delta |

### Anonymous certificate issuance contract

frame `177/178` 作为未分配的保留协议号，不注册 route、handler 或 codec。凭证领取流程由两个 AEDS-only、`no-store` 端点组成：

- `GET /api/binary/anonymous-credential/blind-issuer` 匿名公开读取 `BlindCredentialIssuerMetadata` (`193`)。metadata 包含 epoch、expiry、circuit id/numeric id、layout、`rfc9474-rsabssa-sha384-pss-randomized-3072` scheme id、issuer key id、SPKI SHA-256、`modulusBytes=384` 与 DER SPKI；只有 runtime gate 开启、签名器配置完整且 active root 的 issuer key hash/circuit/layout 一致时返回。精确 credential 属性不属于公开 metadata。
- `POST /api/binary/anonymous-credential/blind-issue` 要求 `RequireAnonymousAccountPrincipal()`、`identity_kind=anonymous_account`、`fixed_ip` 限流、二进制 Content-Type/Accept 与 `RequireNoStoreResponse()`。请求 `BlindCredentialIssueRequest` (`194`) 只包含 root/circuit/profile metadata、issuer key id 和 384-byte blinded representative；响应 `BlindCredentialIssueResponse` (`195`) 只包含匹配 metadata 与 384-byte blind signature。AdminPrincipal、普通登录主体、缺失 identity kind、账号不可用、credential disabled、配额冲突、malformed frame、key rotation、runtime disable 和签名失败均返回相同 `403` + `anonymous_credential_blind_issue_denied`，并归一到至少 `max(MinimumResponseMilliseconds, TimeoutMs+100)` 的延迟桶。

浏览器必须实现 RFC 9474 randomized preparation：把 credential secret、client nonce、epoch/circuit/layout/level 和 issuer key hash 编入域分离 message，在本地生成 32-byte randomizer、SHA-384 PSS salt 与可逆随机 blind factor；服务端仅执行固定宽度 RSA private operation，并用 public operation 做 fault check。浏览器 Finalize 后必须再次校验 SPKI SHA-256、3072-bit modulus、`e=65537`，unblind 并用 WebCrypto RSA-PSS/SHA-384 验证最终 signature；任何 malformed opening、signature tamper、SPKI/hash/key rotation 或非安全整数 metadata 都 fail closed。最终 signature、opening、credential commitment、revocation handle 与 nullifier从不发送给 issuer。

`anonymous_credential_issuance_audit` 仅作为 epoch 配额真源，保存 `subject_hash`、`epoch`、`status` 与按 UTC 小时截断的 `created_at_utc`。`subject_hash=HMAC-SHA256(SubjectHashPepper, epoch || accountId)` 只允许在签发域内做单 epoch 去重，不进入 credential message、响应、root、proof 或 ticket；表中旧 `trace_id` 值由迁移清空，应用实体与新写入不映射该列。blind flow 不调用 `IAuditEventService`，不写 raw account id、trace id、path、identity kind、request/signature/response、commitment、nullifier、proof witness、secret 或可跨 epoch稳定的 subject。每日 retention cleanup 继续删除超过 90 天的行。

签名私钥必须是本机 PKCS#8 DER 文件，路径不得位于 `wwwroot`、`uploads` 或 `backups`，Unix mode 不宽于 `0600`；读取 buffer、导出的 RSA private parameters 与每次 private operation 临时 buffer 都在 `finally` 清零。`BlindRsa:Enabled` 通过 `IOptionsMonitor` 热加载：改为 `false` 后 metadata 与新请求在不重建 signer、不重启进程的情况下立即拒绝；只支持热关闭，不承诺在未加载密钥的进程中热启用。仓库默认和生产模板均为 `false`。

`anonymous_credential` 仅作为 account-bound credential metadata 表，字段语义限定为 nullable `account_id`、不可逆 `account_binding_hash`、`credential_type=account_bound`、`credential_level/status/revoked_at_utc`；它不得保存 `zk_commitment`、nullifier、proof witness、credential secret 或可反查强匿名凭据的 commitment。强匿名/ZK material 只通过 `anonymous_credential_root`、`anonymous_credential_epoch`、`anonymous_credential_revocation` 与 ticket/proof 链路处理。

`GET /api/binary/anonymous-credential/root` 与 `GET /api/binary/anonymous-credential/circuit` 是公开 root/circuit metadata 读取端点：匿名访问、`public_read` 限流、只接受 `Accept: application/octet-stream`，成功返回 `AnonymousCredentialRootSnapshot` (`179`)，失败返回 AEDS `ApiError` + `anonymous_root_unavailable`。端点不得读取 Cookie、session、Authorization 或当前账号；服务端通过 `IAnonymousCredentialRootService` 使用短 TTL immutable snapshot cache 和 negative cache 读取 `anonymous_credential_root`，直到显式 invalidation 或 TTL 过期才回源。

`AnonymousCredentialRootSnapshot` (`179`) 返回字段为 `credentialRoot`、`revocationRoot`、`issuerPublicKeyHash`、`credentialEpoch`、`rootExpiresAtUnixMs`、`rootGraceExpiresAtUnixMs`、`circuitNumericId`、`circuitId`、`verifyingKeyHash`、`publicInputLayoutVersion`、`zkAnonymousEnabled`、`verifierConfigured` 和 `circuitMetadata`。`anonymous_credential_root` 只保存公开 root/circuit 元数据：`epoch`、`root_hash`、`revocation_root_hash`、`issuer_public_key_hash`、`circuit_id`、`circuit_numeric_id`、`verifying_key_hash`、`public_input_layout_version`、`circuit_metadata`、`created_at_utc`、`expires_at_utc`、`root_grace_expires_at_utc`、`status`；不得包含 user/session/cookie/account 映射。

`GET /api/binary/anonymous-credential/revocation/{epoch}/{version}/{revocationRoot}/full.aeds` 返回 frame `196`；`GET .../delta/{baseVersion}.aeds` 返回 frame `197`。两者不接收 credential 参数或 request body，只返回所有客户端相同的公共 artifact：`credentialEpoch/version/baseVersion/expiresAt/kind/pathDepth/algorithmId/issuerPublicKeyHash/revocationRoot/contentHash/signature/entryHashes`。`contentHash` 绑定 canonical header、root 与 entries，`signature` 字段当前是公共 hash-binding；客户端必须同时重算 content hash、binding 和 sparse-Merkle root。full 要求 `baseVersion=0`；delta 只允许从 metadata 声明的精确上一 version 更新，rollback、跳版本、过期、root/issuer/epoch 不匹配、tamper 全部 fail closed。请求坐标中的 epoch/version/root/baseVersion 与当前可解析 artifact 冲突时返回 `409`，请求的 immutable artifact 尚不存在时返回 `404`，root/provider 暂不可用时返回 `503`；这些分支都返回 AEDS `ApiError`，不得伪造空成功帧。旧 `POST /revocation-witness` 固定 `410` 且不读取 body，不能通过 query、header 或 retired frame 复活。

ZK 评论 proof verifier 的运行时配置位于 `AnonymousIdentity:ZkVerifier:*`：`Enabled`、`CircuitId`、`VerifyingKeyHash`、`PublicInputLayoutVersion`、`MaxProofBytes`、`Backend`，可选 `BackendTimeoutMs` 与 `MaxConcurrentVerifications`。`verifierConfigured=true` 只表示上述配置完整且对应 backend adapter 可用；配置关闭、不完整或 backend 不可用时仍按 `DisabledZkProofVerifier`/`verifier_unavailable` fail closed。生产 verifier 在 backend 调用前校验 `comment.create` action、circuit id、verifying key hash、public input layout version、credential epoch、credential root + revocation root + issuer public key hash 的 active-or-grace snapshot 三元绑定、proof byte 上限以及 nullifier/issuer public key hash/credential root/revocation root 均为固定 64 字符 hex token；credential commitment 不属于 public verifier request。所有 reject、timeout、取消或异常对外统一为 AEDS `invalid_proof`，不得把 proof、witness、credential secret 或 backend 细节写入响应或日志。

ZK-Prod feature flag 位于 `AnonymousIdentity:ZkProd:*`，当前生产模板默认 `Enabled=false`。未来开启必须显式满足 native verifier、v5/layout 6 trusted setup + verifying key、reload gate 开启且配置完整的 RFC 9474 blind issuer、匹配 issuer SPKI hash 的 root snapshot 与真实 browser prover cross-stack evidence。Production 下 `AllowDevVerifier=true` 或 `FallbackToLegacyAnonymous=true` 一律启动失败。仓库不保存任何非当前 circuit 的 R1CS/key/Wasm artifact；没有真实 v5 circuit/ceremony/root/release evidence 时运行态必须 fail closed。

### Passkey AEDS frames

Passkey/WebAuthn 载荷不再以文本字符串传输。服务端返回 AEDS POD，前端 adapter 将 POD 还原为浏览器 WebAuthn API 需要的选项对象；浏览器返回的 attestation/assertion 由前端编码为二进制 request POD。

匿名身份模式下，`PasskeyRegisterBegin` 的 WebAuthn `user.id` 使用 `sys_user.passkey_user_handle` 中持久化的 32B 随机 Base64Url 账号句柄；同一账号多次注册与 Recovery Key 重绑必须复用该句柄，不得由数据库 id、username 或 public handle 推导。`PasskeyRegisterBeginPod` 内部字段命名为 `accountHandle`、`accountName`、`accountDisplayName`，前端 adapter 只在交给浏览器 WebAuthn API 时映射成 `user.id`、`user.name`、`user.displayName`。`user.name` 固定为 `fsus-anonymous-account`，不包含内部 id；`user.displayName` 仅在用户显式设置 `public_handle` 时使用公开 handle，否则使用通用 `Anonymous account`。注册与 discoverable login 仍复用同一套 `passkey_credential` 表、challenge cache、sign-count 和 last-used 更新路径，不新增平行 Passkey 栈；`passkey_credential` 的账号外键最终态是 `account_id` + `idx_passkey_account_id`，不得继续暴露或依赖旧 `user_id` / `idx_passkey_user_id` 命名。登录与 step-up assertion 的 user handle owner callback 只按账号存储句柄校验。匿名模式下删除最后一枚 Passkey 需要已启用 Recovery Key / recovery path；否则服务端返回 `409` + AEDS `ApiError`，错误消息为 `CannotRemoveLastCredentialWithoutRecovery`。Passkey login begin/complete 受 RiskControl 保护；assertion 失败写 `PasskeyAssertionFailed` 正分风险信号，assertion 成功写 `PasskeyAssertionAccepted` 负分风险信号并以 `mfaVerified=true` 完成登录，不再额外要求普通 TOTP MFA。

Passkey 删除与凭据友好名称更新是账号安全凭据变更，必须通过统一 user security step-up。生产 binary endpoint 只从 `X-Fsus-Mfa-Proof` 读取一次性 proof，proof 必须绑定对应 action：删除为 `passkey.delete`，友好名称更新为 `passkey.credential-name.update`，且服务端一次性消费。普通账号可先调用 `/api/binary/auth/step-up/passkey/begin` 提交对应 action，再调用 `/api/binary/auth/step-up/passkey/complete` 提交当前账号 Passkey assertion；complete 成功返回同 action 的 `MfaChallengeResult.proofToken`。`Auth:PasskeyStepUp:Enabled=false` 时这两个 step-up 端点必须 fail closed 为 503 + `PASSKEY_STEP_UP_DISABLED`，不允许创建 challenge 或签发 proof。MFA enabled 账号也可继续使用 TOTP challenge 获取对应 action proof；anonymous identity mode 下禁止 legacy password fallback，`DELETE /api/binary/auth/passkey/credentials/{id}` 与 `PUT /name` 都不得提交或解析 `MfaPasswordProofRequest` body。非匿名 legacy password fallback 如仍需保留，必须放在显式隔离的兼容路径，不能进入这些生产匿名敏感操作 endpoint。

WebAuthn Level 3 Signal API 是浏览器侧 best-effort 副作用，不属于账号或凭证事务。注册完成与删除成功在数据库提交后返回 `PasskeySignalState`；`GET /api/binary/auth/passkey/signal-state` 返回同一账号的最新 `revision`、RP ID、稳定 Base64Url user handle、公开显示元数据与完整 `allAcceptedCredentialIds`，并强制 `no-store`。`sys_user.passkey_signal_version` 必须在注册、Recovery 注册、删除及公开称呼变更的同一写事务中单调递增，客户端只允许向浏览器发送未落后于已观察 revision 的完整列表。Signal 不支持、超时、取消或 provider 失败都不得改变服务端提交结果。只有 login complete 明确判定 credential 不存在时，AEDS `ApiError.details` 才返回固定值 `passkey_credential_unknown`；签名、counter、风险与通用认证失败不得触发 `signalUnknownCredential`。Signal 遥测只允许记录 API 名、capability 与固定 outcome，禁止记录 RP user handle、credential ID 或公开称呼。

| FrameType | POD | 端点 / 用途 |
| ----------- | ----- | ------------- |
| `PasskeyRegisterBegin` (`63`) | `PasskeyRegisterBeginPod` | `POST /api/binary/auth/passkey/register/begin`；admin bootstrap begin 复用该响应 frame |
| `PasskeyLoginBegin` (`64`) | `PasskeyLoginBeginPod` | `POST /api/binary/auth/passkey/login/begin`；admin login begin 复用该响应 frame |
| `PasskeyCredentialList` (`65`) | `PasskeyCredentialSummaryPod[]` | `GET /api/binary/auth/passkey/credentials` |
| `PasskeyRegisterCompleteRequest` (`66`) | `PasskeyRegisterCompleteRequestPod` | 注册完成请求体；admin bootstrap complete 复用该请求 frame |
| `PasskeyLoginCompleteRequest` (`67`) | `PasskeyLoginCompleteRequestPod` | 登录完成请求体；admin login complete 复用该请求 frame |
| `PasskeyCredentialFriendlyNameUpdateRequest` (`68`) | `PasskeyCredentialFriendlyNameUpdateRequestPod` | Passkey 凭据友好名称更新请求体 |
| `PasskeySignalState` (`212`) | `PasskeySignalStatePod` + `PasskeySignalCredentialPod[]` | 注册完成、凭证删除与 `GET /api/binary/auth/passkey/signal-state` 的权威 Signal 状态 |

### Independent admin principal AEDS endpoints

后台控制面身份独立于 `sys_user`，只使用 admin principal / session / passkey 表。首次 root admin bootstrap 必须带 `X-Fsus-Admin-Bootstrap-Token`，该 token 只从 `FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN` 或 `Admin:BootstrapToken` 读取；存在 active root admin 后 bootstrap 端点固定拒绝。`X-Fsus-Admin-Handle` 只在 bootstrap begin 指定后台 handle，不写入匿名账号。所有后台控制面端点必须校验 `identity_kind=admin_principal` 与具体 `admin_permission` claim，不得接受 legacy `sys_user.role=admin`。


admin 登录只接受 Passkey/Security Key assertion。成功会写入独立 `AdminAccessToken` / `AdminSessionId` Cookie；生产读取只接受 `__Host-AdminAccessToken` / `__Host-AdminSessionId`，未前缀 admin Cookie 只在清理路径删除，不作为认证 fallback。JWT 必须包含 `identity_kind=admin_principal`、`admin_id`、`admin_sid` 与多值 `admin_permission` claim，不得签发 `ClaimTypes.Role` / `role=admin` 兼容 claim，也不得把 role claim 作为后台授权来源。请求期认证必须按 `admin_sid` 回查 `admin_session` 并校验 principal active、session 未撤销、idle/absolute 未过期、`AccessTokenHash` 与当前 token 匹配、session principal id 与 `admin_id` 一致；失败返回未认证/未授权并删除 admin session cookies，成功时只通过 row-version、旧 token hash 和旧过期时间谓词更新 `LastSeenAtUtc`，stale 更新按 session conflict 处理。`GET /api/binary/auth/admin/me` 从已验证的 admin principal claims 生成 `AdminPrincipalSnapshot`，用于前端从 HttpOnly Cookie 恢复 independent admin workspace，不得退回 legacy `sys_user.role=admin`。admin-sensitive step-up 只接受 `/api/binary/auth/admin/step-up/passkey/begin|complete` 的管理员 Passkey 再认证，不读取普通 `sys_user` MFA 状态，也不接受普通用户 MFA proof。

前端管理态只来自 `GET /api/binary/auth/admin/me` 返回的 independent principal；`AdminPrincipalSnapshot.permissions` 是导航、route guard 和按钮权限的唯一来源。普通 `IdentityAccountSnapshot` / `/auth/me` 不提供 admin 权限，客户端不得用 `legacy.admin`、`syncLegacyAdminPrincipal` 或 `user role=admin` 作为降级入口。

admin step-up challenge 绑定 `identity_kind=admin_principal`、`admin_id`、当前 `admin_sid`、action=`admin-sensitive`、challenge token 和过期时间。complete 成功后返回 `MfaChallengeResult(verified=true, action=admin-sensitive, proofToken=...)`；proof 存储使用 `CachePolicyId.SecurityMfaProof`，key 形如 `admin:{adminId}:{adminSid}:admin-sensitive:{token}`，只能消费一次，不能跨 admin principal 或 session 使用。敏感写入继续通过 `X-Fsus-Mfa-Proof` 传递该 proof header；缺失、过期、复用或 session 不匹配返回 `428` + `MFA_PROOF_REQUIRED`。

`POST /api/binary/auth/admin/logout` 会把当前 `admin_session.RevokedAtUtc` 置为当前 UTC 时间、`RevokeReason=logout`，并只清理 `AdminAccessToken` / `AdminSessionId` 及 `__Host-*` admin Cookie，不触碰普通用户 Cookie。普通用户认证读取只接受当前传输模式下签发的 Cookie；旧未前缀 `AccessToken` / `RefreshToken` / `SessionId` 不再作为 fallback，但 logout/clear 仍删除 legacy Cookie 以帮助浏览器收敛。`POST /api/binary/auth/admin/sessions/{sessionId}/revoke` 使用 `admin_session` row-version guard；目标不存在返回 `NotFound`，目标已被并发撤销或版本不匹配返回 `Conflict`，成功只写一条 `admin.session.revoked` admin audit。`POST /api/binary/auth/admin/sessions/revoke-others` 必须保留当前 `admin_sid` 对应 session，并逐 session 使用同样的 row-version revoke。

客户端通过 `binary_post_auth_admin_logout` 消费该 `EmptySuccess` 契约。若首次请求发生纯网络传输失败，客户端只重试一次；重试返回 `401` 时按服务端已不接受该 session 的 `already_inactive` 处理。无法确认服务端撤销时，客户端结果必须保持 `serverRevocationConfirmed=false`，即使本地 admin store、私有状态和其他标签页已按 fail-closed 清理，也不得伪装成成功。跨标签传输只允许 `admin-logout` 与时间戳，不携带 admin principal、permission、token、proof 或 session ID；该事件不得复用普通账号 `logout` 语义。

### User MFA / TOTP step-up

匿名身份模式下，TOTP 只作为敏感操作 step-up，不作为账户恢复凭据。`POST /api/binary/auth/mfa/setup/start` 使用 `FsusBlog:account:{accountId}` 作为 TOTP issuer account label，不得暴露 legacy `sys_user.username`；TOTP secret、pending secret、verified time 和 TOTP recovery-code hash 只允许存储在 `user_mfa_profile`，`sys_user` 只保留 `MfaEnabled` 状态投影。已启用 TOTP 的重新绑定 action 为 `mfa_setup_rebind`，初次启用 action 为 `mfa_setup`。`/mfa/setup/start`、`/mfa/disable` 与 `/mfa/recovery/regenerate` 在 anonymous identity mode 下都必须通过 `X-Fsus-Mfa-Proof` 提交对应 action 的一次性 proof，不接收 `MfaPasswordProofRequest` body。普通账号凭据变更 action（`account.delete`、`passkey.delete`、`passkey.credential-name.update`、`recovery-key.create`、`recovery-key.rotate`）可以通过 TOTP challenge 或开启状态下的 `/api/binary/auth/step-up/passkey/begin|complete` 获取同一类 action-bound proof；`/auth/mfa/challenge/start` 在未启用 TOTP 时不得为空签发这些 action 的 proof。缺失、action 不匹配、过期或重放 proof 返回 `428` + AEDS `ApiError`，Passkey step-up 通道关闭返回 `503` + `PASSKEY_STEP_UP_DISABLED`，且不得进入 secret 写入、停用或恢复码重生成。

TOTP recovery code 只允许绕过或完成 TOTP step-up；它不是账户 `Recovery Key`，不得用于匿名账号恢复、Passkey 重绑或 recovery session 签发。服务端只在 `user_mfa_profile.mfa_recovery_codes_hash` 存储 `v3$argon2id$m=65536,t=3,p=4$...` 哈希条目，并用 `user_mfa_profile.hash_version` 标记集合版本；裸 SHA-256 legacy 恢复码只允许在 2026-09-01 00:00:00Z 前消费并触发重生成，deadline 后 fail closed。非匿名 legacy 模式可继续使用 `MfaPasswordProofRequest` 支持旧密码 + 当前 TOTP/恢复码证明，但生产匿名模式必须走 header proof。

MFA challenge ticket 的内部契约使用 `AccountId` 与 `AccountSubjectHash`，不再暴露或序列化 `MfaChallengeTicket.UserId`。`/api/binary/auth/mfa/challenge` 验证失败时，attempt limiter 通过 `SecurityMfaChallenge` cache policy 写入 `fail:ticket:{ticketId}`、`fail:subject:{accountSubjectHash}` 与 `fail:ip:{clientIpHash}` 三类计数；这三类计数必须用统一缓存的单次 Redis Lua primitive 原子递增并返回同一 post-increment 快照，lock 决策不得混用分散递增结果。主体窗口按 stable subject hash 聚合，不按可重排的账号容器 id 聚合。audit context 字段为 `AccountId`、`AccountSubjectHash`、`TicketHash`、`ClientIpHash`、`UserAgentHash` 与失败计数，不得恢复 `UserId`。

### Recovery Key AEDS frames

Recovery Key 是匿名账号的账户恢复凭据，独立于 TOTP MFA recovery code。新明文格式为 `frk_<lookupId>_<secret>`：`lookupId` 是 128-bit hex 随机不可枚举定位符，`secret` 是完整恢复密钥材料；提交值超过 256 字符时必须在 lookup、HMAC 或 PBKDF2 前拒绝为 `RECOVERY_KEY_INVALID`。服务端只存储 `account_recovery_key.account_id`、`lookup_id_hash`、`key_hash`、`key_version`、`created_at`、`used_at`、`revoked_at`；`lookup_id_hash` 与完整 `key_hash` 都使用服务端 `RecoveryKeyPepper` 加固，完整 key hash 使用 PBKDF2-SHA256。`account_recovery_key` 索引最终态为 `idx_account_recovery_key_account`、`idx_account_recovery_key_version(account_id, key_version DESC)`、active unique 和 lookup active unique，历史 `user_id` / `idx_account_recovery_key_user` 只允许在迁移输入中出现。明文 Recovery Key 只在 create/rotate 响应中返回一次，不写数据库、日志、telemetry 或 browser storage。

`POST /api/binary/auth/recovery-key/create` 和 `/rotate` 必须通过统一 user security step-up：`X-Fsus-Mfa-Proof` 绑定 `recovery-key.create` 或 `recovery-key.rotate` 并一次性消费。客户端可通过 TOTP challenge 或普通账号 `/api/binary/auth/step-up/passkey/begin|complete` 获取该 proof；Passkey complete 返回的 `MfaChallengeResult.action` 必须与 create/rotate action 完全一致。生产 binary endpoint 不接收 `MfaPasswordProofRequest` body；anonymous identity mode 下发送旧 body proof 会被忽略或拒绝，并按缺失 / 无效 step-up proof 返回 `428` + AEDS `ApiError`。非匿名 legacy password fallback 如仍需保留，必须放在显式隔离的兼容路径，不能进入这些生产匿名敏感操作 endpoint。

验证请求不携带 account id。服务端从 Recovery Key 中解析 `lookupId`，按 peppered `lookup_id_hash` 定位候选记录，再校验完整 Recovery Key；无 lookup id 的旧格式不会扫描全表兼容，统一返回恢复失败并受同一 attempt limiter 约束，用户需要通过仍可登录设备重新生成新格式 Recovery Key。验证成功会把当前 Recovery Key 标记为 used，返回 10 分钟 recovery session token 与 `expiresAt`，不得返回 account id、user id、internalUserId 或其他身份字段。该 token 只允许调用 recovery passkey begin/complete 端点绑定新 Passkey；如果 verify 请求设置 `revokeSessions`，服务端会撤销该账号现有会话；如果设置 `revokePasskeys`，新 Passkey 绑定完成后删除旧凭据。TOTP MFA recovery code 仍只用于 MFA bypass，不得作为账户恢复。

| FrameType | POD | 端点 / 用途 |
| ----------- | ----- | ------------- |
| `RecoveryKeyCreateResponse` (`159`) | `RecoveryKeyCreateResponsePod` | `POST /api/binary/auth/recovery-key/create` 和 `/rotate` 响应 |
| `RecoveryKeyVerifyRequest` (`160`) | `RecoveryKeyVerifyRequestPod` | `POST /api/binary/auth/recovery-key/verify` 请求体；只携带 Recovery Key、`revokeSessions`、`revokePasskeys`，不携带 account id；匿名、`fixed_ip` 限流、RiskControl challenge、PoW、no-store |
| `RecoveryKeyVerifyResponse` (`161`) | `RecoveryKeyVerifyResponsePod` | verify 成功后只返回短期 recovery session token 与过期时间 |
| `RecoveryKeySessionRequest` (`162`) | `StringMutationRequestPod` | `POST /api/binary/auth/recovery-key/passkey/register/begin` 请求体；complete 复用 `PasskeyRegisterCompleteRequest.MfaProofToken` 传 recovery session token |

### Anonymous identity and comment policy AEDS frames

匿名身份不新增平行 Passkey 协议：注册、登录、credential list、rename、admin bootstrap 和 recovery bind 仍复用上面的 Passkey frame；账户恢复仍复用 `RecoveryKeyCreateResponse` / `RecoveryKeyVerifyRequest` / `RecoveryKeyVerifyResponse` / `RecoveryKeySessionRequest`。已发布运行时 frame 覆盖账户快照、评论策略、CommentCreateV2 和作者展示投影。177-183 是匿名凭证/root/ticket/匿名评论创建的独立 frame family；已注册的 root/circuit/ticket/submit endpoint 必须只使用对应 AEDS frame，未注册 frame 仍只代表跨栈 POD/codec、AEDS 编号、前端 adapter 和 golden fixture。

`POST /api/binary/auth/anonymous/bootstrap` 是匿名身份模式的新账号创建入口：匿名访问、`fixed_ip` 限流、`RequiresPowFilter`、`RequireNoStoreResponse()`，请求 `Content-Type` 必须为 `application/octet-stream`。请求 frame 为 `AuthAnonymousBootstrapRequest` (`189`)，只包含 `acceptedGuidelines` 和可选 `publicHandle`；不得携带 username、password、confirmPassword、Recovery Key 或 Passkey attestation。服务端在同一事务中创建 `registration_state=provisional` 的 `sys_user` 与独立 `account_enrollment_session`，仅通过 path 限定为 `/api/binary/auth/enrollment` 的 HttpOnly/Strict 短期 cookie 返回单用途 enrollment token；bootstrap 不创建 `sys_user_session`，不签发 Access JWT 或 Refresh Token。成功响应复用 `AuthLoginFlow` (`18`) 且 `authPhase=enrollment_required`。`AuthLoginFlowPod.AuthPhase` 的稳定值为 `1=authenticated`、`2=mfa_required`、`3=enrollment_required`。

enrollment token 只允许访问 `POST /auth/enrollment/passkey/register/begin`、`POST /complete`、`GET /status` 和 `POST /cancel`，四者均匿名、`fixed_ip`、`no-store`；它不能进入评论、消息、资料、Recovery Key 或普通 session 端点。begin/complete 复用 `PasskeyRegisterBegin` (`63`) 与 `PasskeyRegisterCompleteRequest` (`66`)；complete 成功返回 `AuthLoginFlow(authenticated)` 并写正式 user session cookies。首枚 credential、稳定 `passkey_user_handle`、`registration_state=active` 与正式 `sys_user_session` 在同一 PostgreSQL 事务提交。enrollment 行通过 `pending -> completing -> completed` 的请求哈希和短租约只允许一个 complete；相同 request 在响应丢失后可恢复同一 opaque refresh token并重签短期 Access JWT，不同 request 返回 conflict。完成后的 enrollment 行是短期幂等 receipt，不是正式 session；取消或 TTL 清理只删除仍为 provisional 的账号，并移除当前 challenge。后续第二枚及更多 Passkey 仍只走正式 session + action-bound step-up，不进入 enrollment。

`sys_user.registration_state` 固定为 `provisional|active|suspended|closed`，与封禁/删除 `Status` 独立。迁移将已有 Passkey、可用 Recovery Key或仍有有效 session 的账号标为 active；删除账号标为 closed，封禁及无凭据/无有效 session 的候选孤儿标为 suspended，绝不静默删除。兼容回退保留新列/表并关闭 bootstrap，让未完成 enrollment 按 TTL 清理，不回退 destructive DDL。旧 `/api/binary/auth/register` 与 `/api/binary/auth/login` password endpoints 仍保持移除。

普通账号自助 `/api/binary/auth/*` 端点只接受 `identity_kind=anonymous_account` 的账号主体，必须使用 `RequireAnonymousAccountPrincipal()` 或等价 `RequireClaim("identity_kind", "anonymous_account")` 策略；这包括 `/auth/me`、`/auth/public-handle`、普通 session 管理、MFA profile/setup/disable/recovery、Recovery Key create/rotate、Passkey credential 管理、自助注销和普通登出。AdminPrincipal JWT 即使 `NameIdentifier` 与 `sys_user.id` 数值碰撞，也不得进入这些 handler；授权层应返回 403，并记录 `security.auth.self_service_principal_rejected` 高价值审计。AdminPrincipal 只能访问 `/api/binary/auth/admin/*` 控制面端点，普通自助 handler 不得使用裸 `.RequireAuthorization()` 或把 `HttpContext.GetUserId()` 作为账号身份判定。

| FrameType | POD | 用途 |
| ----------- | ----- | ------ |
| `IdentityAccountSnapshot` (`163`) | `IdentityAccountSnapshotPod` + UTF-8 blob | `GET /api/binary/auth/me` 响应；account id、identity kind、nullable public handle、Passkey/Recovery/TOTP step-up 状态、anonymous credential status/level、status/ban/deletedAt；不暴露 internalUserId 或旧兼容 id |
| `AuthAnonymousBootstrapRequest` (`189`) | `AuthAnonymousBootstrapRequestPod` + UTF-8 blob | `POST /api/binary/auth/anonymous/bootstrap` 请求体；只含使用规范确认和可选 public handle，不含 password/username 注册字段 |
| `AuthUpdatePublicHandleRequest` (`190`) | `StringMutationRequestPod` + UTF-8 blob | `PUT /api/binary/auth/public-handle` 请求体；保存或清空当前匿名账号的 public handle |
| `CommentPolicySnapshot` (`164`) | `CommentPolicySnapshotPod` + UTF-8 blob | `GET /api/binary/comment/policy` 响应；评论 composer 渲染前读取 anonymous/public/ZK 开关、ZK-Prod readiness、默认 author mode、支持语言 `zh-CN` / `en` 与策略 `snapshotHash` |
| `CommentPolicyUpdateRequest` (`165`) | `CommentPolicyUpdateRequestPod` + UTF-8 blob | admin 匿名评论策略 patch；bool 字段用 `Has*` flag 表示未设置 |
| `CommentCreateV2Request` (`166`) | `CommentCreateV2RequestPod` + UTF-8/blob payload | 登录态 public 新评论请求；生产只接受 `authorMode=public` 且显式 opt-in。anonymous scope/proof 槽仅保留 wire 兼容，旧 `anonymous` 写入已退休，ZK 只能走 ticket-submit |
| `CommentAuthorView` (`167`) | `CommentAuthorViewPod` + UTF-8 blob | 评论读取侧作者投影：mode、display name、display language、badge/status/scope label；v5 强匿名投影不得携带精确 credential/reputation/account-age 属性，评论 cursor item blob 必须内嵌该 payload，客户端不得从 identity string 伪造 author |
| reserved (`177`) | none | 未分配；无路由、codec 或兼容行为 |
| reserved (`178`) | none | 未分配；无路由、codec 或兼容行为 |
| `AnonymousCredentialRootSnapshot` (`179`) | `AnonymousCredentialRootSnapshotPod` + shared blob | 匿名凭证 root/verifying-key snapshot：epoch、root expiry/grace expiry、ZK/verifier flags、circuit id、verifying key hash、issuer public key hash、credential/revocation root |
| `RetiredCredentialSpecificRevocationRequest/Response` (`186`/`187`) | 无有效 payload | 永久拒绝 credential-specific witness 网络交换 |
| `AnonymousCredentialRevocationSnapshot/Delta` (`196`/`197`) | `AnonymousCredentialRevocationArtifactPod` + shared blob | 公共 revoked-set full/delta；浏览器 privacy worker 本地派生 128 层 non-membership witness |
| `BlindCredentialIssuerMetadata` (`193`) | `BlindCredentialIssuerMetadataPod` + shared blob | RFC 9474 profile、root/circuit metadata、issuer key id/hash、3072-bit RSA DER SPKI |
| `BlindCredentialIssueRequest` (`194`) | `BlindCredentialIssueRequestPod` + shared blob | RFC 9474 384-byte blinded representative；不含 secret、opening、commitment 或 nullifier |
| `BlindCredentialIssueResponse` (`195`) | `BlindCredentialIssueResponsePod` + shared blob | 384-byte blind signature 与匹配 metadata；浏览器本地 Finalize/verify |
| `AnonymousCommentTicketRequest` (`180`) | `AnonymousCommentTicketRequestPod` + shared blob | 匿名评论 ticket 申请请求：article/root 上下文、action context、版本化 scope、verifying key hash、nullifier hash、credential root、revocation root、Groth16 proof、canonical public inputs；top ticket 不携带 reply id，thread ticket 只绑定 canonical root，最终 parent/reply target 在 submit 时由服务端校验 |
| `AnonymousCommentTicketResponse` (`181`) | `AnonymousCommentTicketResponsePod` + shared blob | 匿名评论 ticket 响应：one-time opaque ticket、expires_at、`rate_class=common|unknown`、`requires_moderation` 与 moderation subject hash；不得包含精确 credential/reputation/account-age 属性、user id、username、public handle 或 nullifier 原文 |
| `AnonymousCommentCreateRequest` (`182`) | `AnonymousCommentCreateRequestPod` + shared blob | 匿名评论创建请求：article/reply 上下文、credential epoch、scope、language、ticket、content；不携带用户身份或 Authorization token |
| `AnonymousPrivacyStateSnapshot` (`183`) | `AnonymousPrivacyStateSnapshotPod` + shared blob | 前端隐私状态快照：active credential、issue/submit capability、root/ticket expiry、circuit/verifying-key/status 与本地凭证可用性；不作为精确资格属性的公开投影 |

`CommentPolicySnapshot` 通过 `GET /api/binary/comment/policy` 公开读取，匿名访问、`public_read` 限流，用于让公开文章评论 composer 在渲染前应用当前服务端策略。生产 policy 的 `DefaultAuthorMode` 只能是 `3=public` 或 `4=zk_anonymous`，默认使用 ZK 并在 ZK 未就绪时保持不可提交；`1` / `0` 仅在历史作者展示中解释为 `legacy_server_visible_pseudonymous`，不能作为新建策略或写入模式。`SupportedDisplayLanguages` 使用换行分隔文本，当前只允许 `zh-CN` 与 `en`。`snapshotHash` 是服务端规范化匿名评论策略上下文的 64-hex SHA-256，用于 comment.v2 `policy_hash` public input；客户端只能读取并绑定，ticket service 会用当前服务端 policy 重新计算并比对 canonical public inputs。ZK-Prod 字段只暴露 coarse readiness，不得返回 proof、circuit、witness、credential secret 或 verifying key 细节。前端不得从 ZK 不可用状态自动降级到 public。

前端 comment policy contract 只从 Decoder/contract 层导出一个完整 `CommentPolicySnapshot`。当前 packed 41-byte POD 映射为 client contract version `3`；历史 48-byte padded 与 33-byte no-limits layout 分别映射为显式 legacy version `2` / `1`，只用于保守迁移，不改变后端 frame number 或 POD。公开快照同时包含五个 ZK-Prod 原始布尔字段、受控 `zkProdUnavailableReason` 与归一化 `zkProdReadiness`。readiness 固定为 `ready`、`disabled`、`verifier_missing`、`trusted_setup_unverified`、`credential_root_missing`、`policy_unavailable` 或 `contract_invalid`；只有当前版本、64-hex snapshot hash、所有必需布尔条件和空 unavailable reason 完整一致时才是 `ready`。旧 layout、字段缺失、类型损坏、未知 reason 或互相矛盾的字段组合都映射为 `contract_invalid`，禁止强匿名提交，也禁止自动降级为普通匿名或 public 发送。

`CommentCreateV2Request` 是 `POST /api/binary/comment` 的唯一登录态评论创建 frame，但生产写入只允许显式公开/可归因发送：`AuthorMode` 必须为 `public`，且 `PublicSendExplicitlySelected` 必须为 `1`。`AnonymousScope`、`ProofToken`、`zkProof` 等字段仅作为既有 wire layout / legacy contract 字段保留，不能作为默认匿名或强匿名提交通道；完整强匿名评论发布必须使用 `AnonymousCommentTicketRequest` / `AnonymousCommentCreateRequest` ticket-submit 流程。`DisplayLanguage` 是展示语言提示。`CommentCreateV2RequestPod` 偏移 4 的旧 `replyToUserId` 兼容槽和偏移 11 的 presence flag 必须固定写入 `0/0`；回复目标只能通过 `replyToCommentId`、端上 nullifier 和作者快照解析。退休的数值 37 frame 不再保留 happy path，必须在预读或 payload decode 阶段作为协议错误拒绝。

登录态 public 创建成功返回 `CommentCreateResult` (`205`) 而不是 `EmptySuccess`。40-byte `CommentCreateResultPod` 固定为 `commentId:int64`、`rootId:int64`、`parentId:int64`、`createdAtUnixMs:int64`、`moderationStatus:int32`、`visibilityState:uint8`、`isPubliclyVisible:uint8`、`idempotencyReplay:uint8`、`hasParentId:uint8`；`hasParentId=0` 时 `parentId` 必须为零并映射为 `null`。visibility 取值固定为 `0=pending`、`1=public`、`2=hidden`、`3=rejected`。客户端不得把非 `public` 结果自行插入公开评论流。强匿名创建改用 `AnonymousCommentCreateResult` (`214`)：只有首次成功响应携带独立 `managementSecret`，幂等 replay 不恢复 secret。服务端仅保存 SHA-256 commitment，响应固定 `Cache-Control: no-store`。

评论作者管理使用 frames `215`–`222`。public 作者通过账号所有权授权；强匿名作者通过 comment id + capability commitment 证明所有权，且 capability 只允许出现在 AEDS request body，不得进入 URL、日志、公共缓存、localStorage、分析遥测或账号映射。challenge 五分钟过期、绑定 comment 与 purpose，并以数据库 CAS 单次消费；edit/delete/appeal/status 均受 `fixed_ip` 限流。编辑提交 `expectedVersion`，在明确窗口内 CAS 更新，并重新执行 Markdown、内容、地区与模型审核；状态可从 Approved 回到 Pending/Hidden。公开 cursor 只增加当前版本的 `isEdited` 标记，不暴露历史正文或 capability。完整修订正文与 SHA-256 仅由 admin authoring endpoint 返回。capability 丢失后不可通过账号、credential 或 nullifier 反查恢复；浏览器默认只在当前页面内存保存并明确提示。

评论举报与审核时间线使用 frames `223`–`227`。`POST /api/binary/comment/{id}/report` 只接受登录账号，`POST /api/binary/comment/{id}/anonymous-report` 必须无 Cookie/session/Authorization，并在 body 提交至少 32 字节的 scoped credential；服务端只保存 comment-bound HMAC。重复举报返回既有 report id，举报不会修改 `comment.moderation_status`。public 作者通过 `/author/appeal` 提交申诉，强匿名作者继续通过 `/management/appeal`；两者都消费 purpose=`appeal` challenge。admin 通过 `/api/binary/author/comments/{id}/moderation-timeline` 读取重建结果，通过 `/api/binary/author/moderation/appeals/{id}/decision` 完成独立复核，写操作要求 CommentModerate、step-up、`fixed_ip`。

登录态 public 创建必须携带 `X-Fsus-Client-Mutation-Id`：唯一合法形式是 36 字符、规范小写 UUID `D` 字符串。缺失返回 `400 comment_client_mutation_id_required`，非法格式返回 `400 comment_client_mutation_id_invalid`。数据库以 `(accountId, clientMutationId)` 唯一约束并在同一事务保存规范请求 SHA-256；同键同内容返回最初的 ID、树坐标、创建时间和最终初始可见状态，并令 `idempotencyReplay=true`，同键不同内容返回 `409 comment_mutation_content_conflict`。强匿名提交不新增可关联客户端标识，而以 ticket SHA-256 承诺建立唯一坐标；原 ticket 同内容重放返回原结果，变更正文或树坐标同样返回 conflict。默认幂等 TTL 为 24 小时，配置 `Comments:MutationIdempotencyTtlHours` 被限制为 1..168 小时。

旧字符串 `authorMode=anonymous` 同样已经退休，服务端必须在内容过滤、风险信号、地区判定、限流/信誉和 comment 写入之前返回 `anonymous_author_mode_retired`。public 缺少显式选择返回 `public_opt_in_required`；ZK 通过该 frame 提交返回 `anonymous_ticket_required`。任何分支都不得自动切换 author mode。

匿名凭证与匿名评论 ticket frame 使用固定宽度 POD + shared blob，不走 JSON hot path。所有变长字段都通过 `Utf8SliceRef` 指向 blob slice，包括 blinded representative/blind signature、issuer key id/hash/SPKI、credential root、revocation root、Groth16 proof、public inputs 和 opaque ticket。credential commitment 与 finalized issuer signature 只允许留在浏览器 credential vault / prover 私有 witness，禁止出现在 ticket POD、public input transcript、日志或服务端 ticket 状态。当前匿名隐私 contract 固定为 `circuitId=fsus.anonymous.comment.v5`、`publicInputLayoutVersion=6`、RSA modulus/blind signature 384B、Groth16 proof 上限 4096B；任何非当前版本、malformed slice、尾随字节或超长字段必须 fail closed。

撤销 witness frame 同样使用固定 POD + shared blob：request 只提交公开 root/circuit/issuer 字段和不可逆 `revocationHandleHash`；response 返回 `algorithmId`、`pathDepth`、`leafKey`、`witnessHash` 与连续拼接的 sibling hash bytes。该 witness 仅是浏览器 prover 的 non-membership 输入材料，不能替代 `AnonymousCommentTicketRequest.zkProof`，也不能作为服务端已验证 Groth16 proof 使用。

`BlindCredentialIssueRequest.blindedMessage` 固定为 384B RFC 9474 RSA representative。canonical credential message、randomizer、PSS salt、blind factor/inverse 和 opening 全部由浏览器生成并保存在本地；服务端签名材料不包含这些值，也不接收客户端声明的 commitment。`BlindCredentialIssueResponse.blindSignature` 必须在浏览器 unblind 后通过 metadata SPKI 的 RSA-PSS/SHA-384 验证才能进入 credential vault。

`AnonymousCommentTicketRequest` 的当前 public input layout 6 固定包含 `action_context`、`scope`、`circuit_id`、`verifying_key_hash`、`public_input_layout_version`、`nullifier_hash`、`credential_root`、`revocation_root`、`issuer_public_key_hash`、`policy_hash`、`is_eligible`、`may_comment`、`rate_class` 和 `requires_moderation`；credential possession witness 必须是 finalized RFC 9474 credential。客户端 `publicInputs` 必须是后端 `NativeGroth16PublicInputCodec` 的 canonical binary transcript；ticket service 会重建 transcript 并做 byte-for-byte 比较。仓库尚无完成 ceremony 的 v5/layout 6 R1CS/proving key/verifying key/Wasm prover，因此 `production_usable=false` 且 ticket 路径必须 fail closed；不得拼接任何非当前 circuit artifact。

`AnonymousCommentCreateRequest` 不包含 `userId`、`replyToUserId`、`username`、`Authorization` token 或 `publicHandle` 字段；`POST /api/binary/comment/anonymous` 只能通过 consume-once ticket、nullifier 和策略上下文解析匿名 actor。所有强匿名 ticket / submit endpoint 必须挂 `RequireStrongAnonymousRequest()`，拒绝 `Cookie`、`Authorization`、session/bearer bridge header 和已认证 principal；拒绝时返回 AEDS `ApiError`，`Details=anonymous_identity_contaminated`。`AnonymousCommentTicketResponse` 同样不得返回可逆用户身份、nullifier 原文或精确资格属性，只能返回 opaque ticket、moderation subject hash、coarse rate class 与 moderation predicate。需要完整匿名凭证/ticket 流程的客户端必须使用当前 blind issuer、ticket 与 submit frame，不得从保留号或 `ProofToken` 派生兼容路径。

历史 `anonymous` 行迁移为只读 `legacy_server_visible_pseudonymous`。迁移必须保留行数、id、正文、父/根/回复层级、可见性、审核状态、时间和展示名；清除 nullifier hash/scope、moderation subject、credential/reputation/account-age 投影并删除对应 `comment_anonymous_nullifier` 行，使旧 identity key 不再参与 moderation、rate 或 reputation 聚合。AEDS author-view byte `1` 只表示该 legacy 读状态。

评论写入不再把 `comment.user_id` 作为作者展示的必填外键。v5 `zk_anonymous` 的 `CommentActor` 只投影 `author_mode`、匿名展示字段、scope、moderation subject hash、`rate_class=common|unknown` 与 `requires_moderation`；精确 credential level、reputation bucket 和 account-age bucket 不得从私有 witness 写入评论、审核、通知、provider、统计或审计。`CommentActor.UserId` 只有在 `author_mode = public` 且 public send 显式选择成功时允许为当前账号 id；`anonymous` 与 `zk_anonymous` resolve 结果必须为 null，即使请求携带登录账号 id 也不得把它写入评论、审核、通知或审计上下文。新 public send 写入只允许使用当前账号已保存的 `public_handle`，未设置时拒绝 public mode，不得回退内部 `sys_user.username` 或合成 user id；公开评论读取优先使用 `anonymous_display_name` / `public_handle`，旧数据缺少快照字段时只能按 `author_mode` 使用匿名或未署名兜底。`comment.reply_to_user_id` 不是客户端输入或回复者归因，而是由 `reply_to_comment_id` 目标的 active public account 单向派生的通知收件人；匿名目标、注销目标和 public 自回复保持 null，匿名回复公开目标则保留目标账号 id，不写入任何匿名回复者映射。admin 审核记录必须使用 `moderated_by_admin_principal_id`，不得继续写 `moderated_by_user_id`。默认匿名和强匿名路径不得按 `comment.user_id` 查询或授权。账号侧可归因评论读取的最终态索引是 `idx_comment_attributable_public_user_id_desc`，只覆盖 `author_mode = 'public' AND user_id IS NOT NULL`，旧 generic `idx_comment_user_id_desc` 必须被迁移删除。匿名 display name 由服务端按 `zh-CN` / `en` 的内置常见姓名列表生成，并在 scope 内稳定，不暴露 account id、username、public handle、credential id 或 nullifier 原文。

Authoring 和审核 schema 的 fresh DB 最终态不得创建旧用户归因列。`article_draft` 首次建表使用 `owner_admin_principal_id`，`article_revision` 首次建表使用 `created_by_admin_principal_id`，`comment` 首次建表/补列使用 `moderated_by_admin_principal_id`。历史库中的 `owner_user_id`、`created_by_user_id`、`moderated_by_user_id` 仅作为迁移输入被 rename/copy/drop，不能作为运行时 API、导入恢复或后台审核契约字段。

---

## Pagination and Cursor Envelope

源码：`src/shared/Contracts/Envelopes/PodEnvelopes.cs`

### `PageResponse<T>`（基于页码）

```json
{
  "items": [ /* T[] */ ],
  "total": 100,
  "nextCursor": "AQAA...",
  "hasMore": true,
  "page": 1,
  "pageSize": 20
}
```

文章列表页码参数不得静默修正：`page` 必须大于等于 `1`，`pageSize` / binary `size` 必须在 `1..100`。缺省参数仍按 `page=1`、`size=10` 处理；显式非法值返回 HTTP `400` + AEDS `ApiError`，不回退第一页，也不截断到最大页大小。
公共文章列表已一次性切换到 cursor-only：首次请求唯一形式为路径中的 `page=1` 且不带 `cursor`；后续请求必须把上一响应的 `nextCursor` 放入同一路径的 `?cursor=<opaque>`，并把逻辑页写入路径。`page>1` 缺少 cursor、第一页携带 cursor、cursor 过长、篡改、过期或跨 query 复用均返回 HTTP `400` + AEDS `ApiError(Validation)`。无 cursor 深页在访问 PostgreSQL 或 Redis 前结束；版本漂移在只读取当前 `ArticleListVersion` 后、访问 frame cache 或 PostgreSQL 前结束。opaque cursor v3 由 Data Protection 认证保护，15 分钟后过期，固定绑定最后一项的 UTC `createtime`/`id`、relevance/hot 排序值（适用时）、category、tag、规范化 keyword、size、排序模式与 `ArticleListVersion`；客户端不得解释或改写。

公开读取严格使用 `createtime < cursorTime OR (createtime = cursorTime AND id < cursorId)`，不包含公开 `OFFSET`、前页 replay、server-side cursor recovery、`legacy-page:{page}` identity、redirect 或双协议解析。标签并入主 projection 或一次批量 projection；count cache 使用 `ArticleListVersion + filter` identity 与同一 miss singleflight。有效请求在 count hit 时最多执行主查询与标签投影两条数据库命令，在 count miss 时最多再执行一条 COUNT，命令数不随逻辑页深增加。`ArticleList` 只接受 AEDS v2 cursor envelope，并返回 `nextCursor`/`hasMore`。管理端文章列表仍使用独立 page/offset 契约且拒绝 cursor。

### `CursorResponse<T>`（基于游标）

```json
{
  "items": [ /* T[] */ ],
  "nextCursor": "base64-encoded-cursor",
  "hasMore": true
}
```

The cursor is an opaque string generated by the server; a simple list can only encode the last ID or timestamp, composite
The sorted list must be bound to all keyset fields at the same time and can be accompanied by a first-screen snapshot border. The client can only send back the original data.
May not be parsed, rewritten, or reused across filters.

### Binary POD Envelope

Paging metadata within AEDS frames:

| Structure | Fields | Type | Description |
| ------ | ------ | ------ | ------ |
| `PodEnvelopeHeader` | Version | byte | 信封版本 |
| | Count | int | Number of records |
| | PayloadLength | int | 载荷字节长度 |
| | Reserved | int | Reserved (fill in 0) |
| `PageEnvelope` | Total | int | 总记录数 |
| | Count | int | Number of records on the current page |
| `ArticleListCursorEnvelopeV2` | Magic | int32 | `0x41535046`（`FSPA`） |
| | Version | int32 | `2` |
| | HasMore | byte | `0` 或 `1` |
| | Total | int32 | Current total number of filters |
| | NextCursor | bytes | length-prefixed UTF-8 opaque cursor，最大 64B；无更多时为空 |

`ArticleList` writer 只写 v2；decoder 只读兼容 v1 的 `nextCursorUnixMs:int64 + hasMore:byte + total:int32`。v2 必须满足 `hasMore` 与 cursor 是否非空完全一致，cursor 必须是 canonical base64url 字符串；未知版本、非法 UTF-8、尾随数据或状态不一致均按 protocol failure 拒绝。
| `CursorEnvelope` | NextCursor | long | 下一页游标值（-1 表示无更多） |
| | HasMore | bool | 是否有更多 |

---

## Authentication system contract

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

- This structure is mainly used for internal login of the server to /续签流程 and is not directly used as the final response body of public authentication API
- `accessTokenExpiresAtUtc` 由 JWT 签发结果直接给出并与 JWT `exp` 对齐；普通/MFA/Passkey 登录、refresh rotation 和 admin session 签发必须把该值原样传给 AccessToken Cookie，Cookie 层不得重新读取配置或解析 token
- `refreshTokenExpiresAt` 对齐 `sys_user_session.IdleExpiresAt`，用于 refresh-token 成功路径直接写 Cookie expiry，避免按新 refresh token 回查 session
- `POST /api/binary/auth/refresh-token` 成功仍只返回 `EmptySuccess`，token 不进入 AEDS payload。服务端以 refresh token hash 定位当前 generation，不依赖 `SessionId` Cookie 定位 family；`SessionId` 仅作为防混淆一致性检查。单条 PostgreSQL CTE 以 `session + family + generation + current hash` 做 CAS，成功时同时把旧 hash 写入有限期 tombstone、递增 generation 并更新 idle expiry；同一轮 CAS 的 loser 返回 `Conflict`/409 + `REFRESH_ROTATION_CONFLICT`，不得取得 token。
- 已经进入 tombstone 的旧 token 再次出现时，即使没有 `SessionId` Cookie，也会定位其 `RefreshFamilyId`、将该 family 标记 compromised 并撤销当前 session，返回 401 + `REFRESH_FAMILY_COMPROMISED`。token 与错误 `SessionId` 组合按 token 证据撤销 token 所属 family，返回 `REFRESH_SESSION_MISMATCH_COMPROMISED`，不得撤销 Cookie 指向的无证据 session 或账户其他 family。普通到期/未知 token 返回 `REFRESH_EXPIRED_OR_UNKNOWN`，与 compromise、CAS conflict 分离。
- CAS 轮换后，服务端在追加 Cookie 前后分别按新 refresh hash + session id 精确验证一条未撤销且未过期的 session。验证、Cookie 追加或交付确认失败时立即将已轮换 family 标记 `refresh_token_delivery_failure`、删除普通账号 access/refresh/session cookies，并返回 401 + `REFRESH_DELIVERY_FAILED`；旧 token 不恢复有效。客户端不得自动重放 refresh POST；网络结果未知时只按 5/10/20/40/60 秒有界退避重读幂等 `/auth/me`，401、取消、协议/解码错误均不得重试 refresh POST。完整持久化与回退约束见 [Refresh Token lineage](../security/refresh-token-lineage.md)。
- 该交付协议缩小并检测 DB/Cookie 边界故障，但不把 PostgreSQL commit 与浏览器接收响应声明为原子事务。最终验证后进程退出仍可能要求重新认证，且 replay-family revoke 语义不得为此放宽。
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
- 密码、MFA challenge 或 Passkey 断言完成后仍必须经过服务端最终会话签发校验；封禁账号在认证通过后返回 `AuthLoginFlowDto` 并写入 `session_mode=restricted` 的受限会话 Cookie，用于读取账号状态/封禁原因、登出、查看或撤销本人会话、删除本人账号及完成这些动作所需的 step-up。注销账号（`Deleted` / `DeletedAt`）只允许 server-side mode 进入 `revoked`，不得返回该结构，也不得写入 access / refresh / session Cookie。
- 普通账号 access token 不携带 legacy username 或 role claim；必须携带与 `sys_user.account_subject_hash` 完全一致的 `account_subject_hash`，并携带低基数 `session_mode=normal|restricted|revoked`。`session_mode` 不构成客户端授权：服务端每次认证从 `sys_user_session.session_mode`、账号状态及版本快照取得权威模式，并在 JWT 与服务端不一致时使用更严格值；解除封禁不会让旧 restricted JWT 静默恢复 normal，必须 refresh 或重新签发。账号 subject 由迁移或账号创建写入并保持稳定，签发/读取路径不得从账号 id、public handle 或 Passkey handle 动态重建。缺失或格式错误时 token 签发与相关安全边界 fail closed。`ClaimTypes.NameIdentifier` / `nameid` 仅作为账号容器 id 兼容字段，不能作为 RiskControl subject hash 材料。`sys_user.role=admin` 不能作为后台权限、notification admin group、rate-limit admin partition、评论管理员删除、普通账号状态治理保护条件或审计 admin actor 的来源。后台权限只能来自 independent admin principal token 的 `identity_kind=admin_principal`、`admin_id/admin_sid` 与多值 `admin_permission` claim。普通账号状态治理接口只治理 `identity_kind=anonymous_account` 容器；若旧数据出现 `identity_kind=admin_principal` 的 `sys_user` 影子行，接口必须拒绝并交由 independent admin principal plane 处理。
- `POST /api/binary/auth/delete-account` 在匿名身份模式下只接受 `AuthDeleteAccountRequest` 的确认文本，不包含旧 password、TOTP code 或 recovery-code 字段；敏感操作 proof 必须通过一次性 `X-Fsus-Mfa-Proof` 提交，action 固定为 `account.delete`。注销成功后服务端撤销当前账号 session、Passkey、Recovery Key 与匿名凭据状态，并把 `sys_user` 保留为 anonymous account tombstone，不再改写旧 username。
- 封禁状态以 `sys_user.Status/BanReason/ban_state_generation` 为权威来源；ban 在同一数据库事务内把全部 active `sys_user_session.session_mode` 转为 restricted，delete 转为 revoked，unban 转回 normal。Ban/Unban/Delete 在权威事务内递增代次并准备 durable cross-node obligation，提交后先更新本节点有界 `BanStateProjection` 再返回；已知 admission 只读进程内存，不访问 Redis/DB，Unknown、subject mismatch、同代冲突与 authority failure 均 fail closed。投影只保存 subject hash、Normal/Banned/Deleted、固定有界 reason code 和 generation；原始 `BanReason` 不驻留。远端按 generation 拒绝 stale/duplicate/out-of-order，PostgreSQL ledger 负责 publish failure、重启与 replay 收敛。`SecurityUserSessionValidation` 会话快照仍独立携带 session/account `xmin`、账号状态和 mode，不与 ban 投影合并。restricted 白名单只由 endpoint `RestrictedAccountActionMetadata` 声明：`GET /auth/me`、`GET /auth/sessions`、refresh、logout、单会话/其他会话撤销、`POST /auth/delete-account`、Passkey step-up begin/complete 与 MFA challenge start；refresh 是解除封禁后换取新 normal JWT 的显式路径。未标记的评论、消息、内容、身份、公开业务和 admin 路径默认拒绝。受限会话返回 `423 Locked` + `ACCOUNT_BANNED_WRITE_LOCKED`，notification stream preflight 返回 `423` + `restricted_session_not_allowed`，客户端不得只靠前端状态拦截。

### `IdentityAccountSnapshot`（当前匿名账号容器，`GET /api/binary/auth/me`）

Passkey complete、MFA verify 与匿名 bootstrap 的成功响应只表示服务端已尝试建立 Cookie session；浏览器必须通过共享 post-auth commit 强制读取本端点，并在确认 `IdentityAccountSnapshot` 已提交为当前 tab 的 authenticated state 后，才允许广播 login 或导航到私有路由。该读取必须绕过 fresh guest 负缓存；重复 commit 由单调 generation 取最新结果，组件卸载会取消在途读取，失败或取消不得把响应中的用户片段、bootstrap 完成或 Cookie 推断成已登录。

成功响应必须携带 `X-Fsus-Access-Expires-At-Utc: <ISO-8601 UTC>`；该值由服务端已验证 principal 的 JWT `exp` 生成，不进入 AEDS payload，也不改变 `IdentityAccountSnapshotPod` 布局。前端把它映射为仅客户端存在的 `accessExpiresAtUtc`，并按真实到期时间减安全余量调度。缺失、非法或已过期的 header 是协议/认证失败，不能回退到从页面启动时刻计算固定 TTL。

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
- 多标签页刷新优先用 Web Locks 串行化单一 leader；无 Web Locks 时用最小字段 BroadcastChannel 选举，事件不得携带 token、session/account id、proof 或用户资料。leader 与 follower 在结算后都以 `/auth/me` 重新验证 Cookie 会话；认证失败提升 `authGeneration` 并清理私有状态，普通网络失败保持 unknown/authenticated 状态而不直接写 Guest。回退和隐私约束见 [frontend-session-refresh-coordination.md](../security/frontend-session-refresh-coordination.md)。

### `UserSessionSummaryDto`（普通账号会话列表项）

```json
{
  "sessionId": "uuid-v4",
  "deviceLabel": "Chrome / Windows / Desktop",
  "createdAt": "2026-01-01T00:00:00Z",
  "lastSeenAt": "2026-01-01T01:00:00Z",
  "authenticationMethod": "passkey",
  "authenticationStrength": "webauthn_uv",
  "passkeyFriendlyName": "Work laptop",
  "durationPolicy": "browser_session",
  "isCurrent": true
}
```

普通账号可同时保留受服务端上限约束的多个 active `UserSession`。列表只提供可操作的 session id、由 browser family / OS family / form factor 组成的粗粒度设备标签、创建/最近活跃时间、登录来源与强度、可选 Passkey 友好名称、Cookie 持久化策略和当前会话标记。它不返回内部 credential row id、客户端设备指纹、raw user agent、原始 IP、内部 device/network HMAC、JWT/refresh token、长期 `mfaVerified` 状态或 user id。服务端只持久化 account-scoped rotating HMAC + epoch 及低基数 UA 标签；fingerprint 不参与授权、账号绑定、step-up 豁免或 refresh replay 撤销范围。signal 缺失仍可完成正常 Passkey 登录。

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

## Article Contract

源码：`src/shared/Contracts/Outputs/ServerResponseContracts.cs`

### Article Vault sync plans

Article Vault 的 closed manifest、coordinate 与 source-byte contracts 位于
`src/shared/Contracts/ArticleVault/`。唯一 planner
`ArticleVaultSyncPlanner.Build` 只接受已通过 #2103 validator 的 root/article manifests、
显式 content-addressed server observations，以及调用方明确给出的 atomic group/dependency
集合。`pull`、`push`、`sync` 只作为同一个 planner 的 direction policy；planner 不扫描目录，
也不读取 `mtime`、title、slug、latest receipt 或 import fallback 来发现状态。

sealed plan 使用 `fsusblog.article-vault.sync-plan.v1`，冻结 exact article membership、
base/local/server coordinates、server revision、permission/lifecycle preconditions、dependency
拓扑顺序、no-op/conflict decisions、expiry、cancel policy、idempotency key、candidate identity 与
content digest。任一 unresolved dependency、identity/schema ambiguity 或 invalid manifest 不产生
partial plan；three-way conflict 产生 `blocked` plan 且 operation order 为空。
`ArticleVaultSyncPlanVerifier.VerifyCurrent` 在交给后续 executor 前以显式 current manifests 与
server observations 及 caller direction/cancel policy 重新验证 membership、coordinate、revision、
permission、schema、expiry 和 digest；drift 必须拒绝，不能自动 rebase。此 contract 不执行 server writer、DB、filesystem、
Vault materialization、watcher 或 conflict resolution。

### Article embed provider contract

`src/shared/Contracts/ArticleEmbeds/` 是文章嵌入 target、provider request/result 与 dependency
coordinate 的唯一 closed/versioned authority。source grammar 只消费 FsusUI
`@ozwasyd/element-plus/markdown-runtime` 的 `parseMarkdownEmbedLine` 投影：directive 必须提供
`target`、`mode=article|heading|block` 与 raw range；属性顺序、escaping、行首独占和 malformed
diagnostics 仍由 FsusUI #290 parser 独占，Blog 不解析 Markdown，也不提供 regex、alias、include
或 mode inference。

target token 使用稳定且与 route、title、slug、display text、URL、file path、endpoint 和 raw DB ID
分离的 portable identity。article 是 `article:<canonical-lowercase-uuid>`；heading 是
`article:<uuid>#heading:<canonical-lowercase-uuid>`；block 是 `article:<uuid>#<canonical-anchor>`，
其中 #289 anchor 不含 `^`。request 绑定 host portable article/document epoch/source revision/raw
range、scope、actor/site/permission context、provider runtime/version、cancellation signal 与 content
digest。result 只携带 resolved coordinate、Markdown 或 renderer-owned safe projection reference、
typed attribution、visibility/lifecycle/permission、budgets、closed error 与 digests；HTML、DOM、Vue
component、iframe 和 private service object 都不是合法 payload。

relation、article package 与 document export 必须直接复用
`ArticleEmbedDependencyCoordinate`/`DependencyDigest`，不得另建 target codec。authoring scope 只声明
可使用 current authorized target；publication-plan scope 只接受 frozen public target coordinate。
本合同不执行 resolution、publication freeze/finalization、cache、relation edge、rendering 或 UI；
这些行为由后续 issue 实现。

### Article embed authoring resolution contract

`src/shared/Contracts/ArticleEmbeds/Authoring/` 是 authoring scope embed resolution 的唯一
authority。`ArticleEmbedAuthoringResolver.Resolve` 与 `ArticleEmbedAuthoringVerifier.Verify`
保留原递归入口的 traversal、整棵子树 memo、cycle 与 budget observation 语义；旧 `Resolve`
不转发新 graph planner。`ResolveProjection` / `VerifyProjection` 是同一 owner 的明确新入口，
只投影/验证当前目标，拒绝把 nested expansion 当成 projection。两种入口都只消费
sealed #2454 authoring requests 与
caller-verified `ArticleEmbedAuthoritySnapshot`（绑定 host article/document epoch、source
revision/digest、actor/site/permission context、provider runtime 与 material locale/theme）；
它不解析 Markdown、不读 rendered output、不修改 target 或 host source，也不把 memo state 保留到
resolution 之外。任何 host/source/actor/runtime/authority-generation drift 或 abort signal 都让
结果以 closed stale error 失败，而不是静默沿用旧状态。`ArticleEmbedAuthoringPipeline.Evaluate`
明确调用 `ResolveProjection`，再由 `ArticleEmbedDependencyGraphPlanner.Expand` 以
`VerifyProjection` 验证该阶段并显式展开依赖。旧入口复用整棵缓存树，新 graph stage 复用叶投影后
重新展开，预算/时钟观察不可互换；调用方通过明确入口选择语义，不根据 candidate 内容猜测。
调用方必须分别验证所选入口的兼容性，不能将不同预算/时钟观察语义视为等价。

article mode 返回整个 target body projection；heading mode 只返回 exact heading subtree；block
mode 只返回 #289 canonical anchor target。missing/duplicate/invalid coordinate 一律 fail closed，
绝不 first-match。private/draft/unpublished target 仅在 current actor 有权时可见，并明确标记
`AuthoringOnly`/`not-publication-eligible`，不得被 cache 或 receipt 误投公开。cycle detection 使用
stable host/target article+kind+anchor expansion path，self-cycle、多跳 cycle 与 shared subtree 在
stack overflow 前就以 typed failure 结束；depth、expanded node、source byte、elapsed time 与
authority message budget 逐 request/graph 累计并封闭上限。局部 embed failure 只影响该节点，不替换
整篇文档；`ArticleEmbedOpenSourceIntent` 只携带 stable target navigation coordinate，host editor
没有 target mutation API。

每次 resolution 产出 sealed `ArticleEmbedAuthoringReceipt`：只记录 host/target identities、
permission/lifecycle、graph/budget/cache fact、status、timing 与 content digest，绝不记录无权
content。`ArticleEmbedAuthoringVerifier.Verify` 独立验证旧递归结果，`VerifyProjection` 验证新 projection stage，
`ArticleEmbedDependencyGraphVerifier` 独立重算 graph 的 expected outcome、cycle/budget legitimacy、
memoization exactness 与全部 digest；任何 tamper 都 fail closed。本 slice 不执行
publication plan/freeze、relation index、cache invalidation、AOT 或 UI。

Graph 的每个 resolved descendant 与顶层一样，必须通过 coordinate schema/digest 校验，并与
snapshot 的 exact target、revision、target-version 和所选 article/heading/block projection identity/digest 一致。
Graph verifier 分别重放 projection 与 graph 的累计成本：复制 projection failure 不产生 graph
source read；fresh authorized projection read 累计 source bytes，memo hit 只复用叶投影，
descendant 仍重新展开计数。每个 provider result 与最终 receipt 的 byte/node/depth observation
必须精确对应，size failure 必须符合实际 node/message/byte 检查顺序，取消必须对应当前 request token。
result/receipt elapsed observation 必须单调，但候选自报时间与重算 digest 不是独立时钟证据。
现有 verifier API 没有独立时间见证输入，因此即使记录了真实 timeout，也拒绝将 `TimeExceeded`
graph 准入 relation/refresh；不得仅凭 error enum 或自报超限时间放行缺失子图。

`ArticleEmbedRefreshPlanner` / `ArticleEmbedRefreshPreparation` 只生成不可执行的内存计划，
Preparation 没有路由或 DI 注册。输入必须由 canonical caller 提供真实 current host draft observation：
actor/site/edit permission、draft key/server expected revision、document epoch、source revision/digest
及有界完整 dependency occurrence roster；摘要只绑定结构，不能证明 reader、权限或 roster 完整性。
显式 selection 最多 256 项，冻结 parser directive identity/range/token/mode、旧/desired exact
coordinate、目标 source digest、permission/lifecycle 和选中子图/budget。期望 host、authority 或
desired coordinate 漂移返回 `Stale`；无变化返回 `NoChange`；缺失/无权/结构或 graph/budget 不合法
返回 `Blocked`，取消不返回部分计划。只消费既有 authoring pipeline/refresh policy，不重新解析或
动态刷新到 latest，也不复制 target content。
完整选中集合验证后，pipeline 返回及后续验证/比较失败返回前会重读选中项取消状态；已观察到
取消时优先返回 `Cancelled`，最终计划构造后也检查取消，不把跨 stage 的取消失配报告为 `Blocked`。
这些取消观察点不提供原子提交。

`ArticleEmbedRefreshPlan.CanExecute` 恒为 false；选中子图不是完整 host persisted graph 的提交资格。
Policy/Pipeline/Graph 源码组合不提供执行能力；缺少真实 host dependency read、
current permission/whole-host graph revalidation、expected revision CAS/idempotency 和 canonical
no-source-change revision/outbox/audit commit 时不得启用。计划不修改 source bytes/token、target、
existing publication 或 publication receipts。

### Article embed publication freeze contract

`src/shared/Contracts/ArticleEmbeds/Publication/` 是 publication-plan scope embed freezing 的唯一
authority。`ArticleEmbedPublicationPlanner.Plan` 只接受 sealed #2454 `PublicationPlan` requests 与
sealed `ArticleEmbedPublicationAuthority`（绑定 host article/document epoch、current host
revision/source digest、publication request id、expected revision、authority generation、
actor/site/permission context、provider runtime、material locale/theme、frozen artifact retention
与逐 target 的 public facts）；它不解析 Markdown、不读 rendered output、不查询 authoring cache、
latest target 或任何 previous resolution，也不执行 DB/route/UI/business write。

每条 evaluated embed occurrence 产生一条 flat `ArticleEmbedPublicationEdge`：owner 是包含该
directive 的 document（host 或已 freeze 的 public target），edge 记录 owner identity/revision、
parser directive projection、target identity、exact `ArticleEmbedDependencyCoordinate`
（frozen public revision + heading/block coordinate + projection identity/digest）、depth 与
latest-observed fact。private、draft、scheduled/unpublished、archived、deleted、unknown、
permission-denied/unknown、revision-package-incomplete、missing 或 ambiguous target 一律产生
blocked edge；任何 blocked edge 使整个 plan `Blocked`，publication writer 必须以
`ValidateForCommit` 的 sealed+current-authority 检查为准，不得部分写入。后续 target update
不改写已 sealed plan 中的 coordinate；新的 publication build 在新的 authority snapshot 下重新
freeze。cycle、depth、expanded-node、source-byte、elapsed 与 authority-message bound 与 authoring
共享同一 closed budget 语义并在 plan 内累计。

sealed `ArticleEmbedPublicationReceipt` 只记录 host binding、authority generation/digest、
permission context、graph digest、budget meters 与 per-request 结果（identities/status/digest/
descendant counts），绝不记录 target content。`ArticleEmbedPublicationVerifier` 独立重算期望
edge graph、cycle/budget/memoization legitimacy 与 edge/graph/receipt/plan digest；无法重放的
wall-clock/abort 结果只在合法 preempt 时被接受。public delivery 只消费 sealed plan 的 frozen
artifact（`publication-frozen-artifact` policy），本 slice 不执行 relation edge store、cache
invalidation、publication write、AOT 或 UI。

### Article embed relation edge contract

`src/shared/Contracts/ArticleEmbeds/Relations/` 定义 #1808 relation authority 持久化的 embed 边的唯一
canonical shape。`ArticleEmbedRelationDeriver` 是纯投影：旧 `DeriveFromAuthoring` /
`ArticleEmbedRelationVerifier.VerifyFromAuthoring` 先使用递归 `ArticleEmbedAuthoringVerifier.Verify`；
新 `DeriveFromGraph` / `VerifyFromGraph` 先使用 `ArticleEmbedDependencyGraphVerifier`，Pipeline
明确调用 `DeriveFromGraph`。各自验证后复用私有 relation 投影/核验核心，不以一种 verifier 失败后
重试另一种来猜测语义。publication 仍由 #2456 `ArticleEmbedPublicationVerifier` 验证。未通过或 blocked 来源只
产出 closed rejection，绝不产生 edge。它不解析 source、不扫描 rendered output、不读 store/cache、不
改写 host 或 target 内容。

每条 `ArticleEmbedRelationEdge` 绑定 scope（`Authoring` / `FrozenPublication`）、status、
owner article/revision（directive 所在文章；host 为顶层，resolved target 为嵌套）、source range、
`ArticleEmbedTargetIdentity`、resolved 与 latest-observed revision、观测到的 visibility/lifecycle/
permission 与 dependency digest。`EdgeIdentity` 与 revision 无关，重推导幂等去重；`EdgeDigest` 密封
全记录。authoring 边承载 `Current`/`UpdateAvailable`/`Stale`/`Broken`；frozen 边永远是 `Frozen` 且
`Reconcile` 直接拒绝 frozen edge set——后续 target update 不能改写 frozen edge，每个 frozen edge 附
一条 sealed `ArticleEmbedDependencyReceipt` 绑定 plan digest、publication edge digest 与 sealed
coordinate。

`Reconcile` 对 authoring edge set 在 fresh authority snapshot 下重算每边 status：host binding 或
derivation context（actor/runtime/locale/theme）漂移→`Stale`，target 消失或歧义→`Broken`，
permission/lifecycle/visibility 失格→`Broken`，latest 超过 resolved→`UpdateAvailable`。只对
status 实际变化的边产出 sealed `ArticleEmbedInvalidationTicket`（绑定 edge identity、from/to
status、closed reason、原 family cache key digest 与单调递增 reconcile generation）——精准失效，
绝不 family flush。`ArticleEmbedRelationCacheKey` 绑定 host document id/epoch/revision、scope、
provider runtime、permission/site context 与 material locale/theme，authoring 与 frozen family 永不
共享。`Query` 只在 scope 匹配且 caller actor/runtime 等于 recorded derivation context 时返回 sealed
receipt：public delivery 仅接受 frozen-publication edge set（`frozen-edge-artifact-only`），
authoring 查询仅接受 authoring set；receipt 只携带 per-edge digests 与 status，绝不携带 content 或
隐藏边计数。`ArticleEmbedRelationVerifier` 独立重验证来源、重推导 edge、重算全部 digest 并检查
ticket 只覆盖真实变化的边。本 slice 不执行 relation store、cache、AOT 或 UI——#1808 负责持久化。

### Article relation closed contract

`src/shared/Contracts/ArticleRelations/`、`config/contracts/article-relation-catalog.json` 与
`config/schemas/article-relation-contract.schema.json` 共同定义 portable article relation 的唯一
closed/versioned contract authority。本 slice 的 kind catalog 精确包含 `outgoing`、`backlink`、
`broken`、`visibility-risk` 与 `unlinked-mention`，每个 kind 只有一个 semantic owner，并以
`ArticleRelationContractCoordinate` 绑定 contract、kind、resolution、visibility 与 lifecycle
catalog 版本。

`ArticleRelationRecord` 绑定 source article/revision、UTF-16 half-open occurrence range、link text、
stable target article/heading/block identity、target revision/lifecycle/permission、source/query actor
与 visibility context、resolution status、index version 及 identity/record digest。target identity 不
使用 URL、route、slug、title 或 rendered heading text；current public scope 只接受 current source、
published/allowed target 与 anonymous-public context，draft/private/unknown facts fail closed。
`ArticleRelationSet` 拒绝 orphan、duplicate 或 tampered records。

unlinked mention 只产生可解释的 `ArticleRelationUnlinkedMentionCandidate`：它携带 matched range、
候选 stable identities、match rule/reason、confidence、ambiguity 与可选 ignore-decision reference，
并且 `IsAuthoritative` 永远为 `false`。`ArticleRelationLifecycleEvent` 为 create/edit/publish/schedule/
archive/delete/restore/rollback/import/migration/rename 指定唯一 owner 与 rebuild/invalidate/reresolve
obligations。index/query/ignore/prepublish/inspector receipts 绑定 worktree/build、parser/renderer、
article/schema/permission policy、contract coordinate 与 content digest，只记录 identities/statuses/
digests，不携带 content。

unlinked-mention candidate 的 `Visibility.SourceActor` 必须与 `Source.SourceActor` 的完整
actor/site/permission context 相等；`QueryActor` 仍是独立查询身份，重新计算 candidate identity
与 digest 不能解除 source-actor 绑定。lifecycle `Changes` 只接受 `Slug`、`Title`、
`HeadingIdentity` 的闭合位域：rename 必须是七种非空组合之一，其他事件必须为 `None`。
未知位即使重新 seal 也拒绝；包含 heading 变更时仍必须同时履行 rebuild/invalidate/reresolve。

`ArticleRelationContractValidator` 与 `ArticleRelationDigest` 是独立的 fail-closed validation/sealing
authority；本 slice 不实现 Markdown parser、relation producer/rebuild、index/query、prepublish/inspector
或 UI 行为。后续实现必须消费这些 closed contracts，并在上游 source/editor 与 relation lifecycle
依赖完成且取得对应真实运行时证据后分别验收。

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
  "slug": "article-slug",
  "currentRevisionId": 801,
  "revisionNo": 7,
  "currentPublicationId": 1201,
  "publicationNo": 4
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

`ArticleDetail` 当前写入为 V5 envelope，外层仍使用 AEDS v2 frame。payload 以 44B header 开头，`Magic = 0x41524435` (`ARD5`)、`Version = 5`、`Flags = 0`，随后按 header offset 指向 116B `ArticleDetailV5RecordPod`、`ArticleDetailTagV3RecordPod[]`、必备 `ArticleRightsV3RecordPod` 和共享 UTF-8 blob。解码器只读兼容 `ARD4`/version 4 的 92B record 与 `ARD3`/version 3 的 84B record；旧版本缺失的发布坐标映射为零/空，V3 缺失的 `updatedAtUnixMs` 映射为空。旧 `ArticleDetailPod + tagCount + cover blob + lifecycle tail` payload 已废弃；magic/version 错配、缺失 rights block、offset/length 不一致、截断和尾随 payload 都必须拒绝。

`ArticleDetailV5RecordPod` 在 V4 上追加 `currentRevisionId:int64`、`revisionNo:int32`、`currentPublicationId:int64`、`publicationNo:int32`；tag record 只保存 tag id/name slice。`ArticleRightsV3RecordPod` 仍记录同一 publication 冻结的 snapshot：`snapshotId`、`articleRevisionId`、`revisionNo`、enabled/license/copyright/copy policy/excerpt/code-copy/badge/proof-binding、canonical URL、`policyHash`、`contentCanonicalHash`、proof pointer 和 proof status。所有文本通过 `Utf8SliceRef` 指向同一个 blob。

前端 `mapArticleDetailFromPodPayload` 接受当前 V5 与只读兼容 V4/V3 envelope。旧 detail tail payload、magic/version 错配、缺失 rights record、record offset/length 与共享 blob 不一致、截断、尾随 bytes 或 required rights 文本为空时，必须作为协议错误失败；不得 JSON parse 或回退到旧 ArticleDetail 解码。`ArticleList` 当前 100B record 和 `ArticleSearch` FAS4 record 也携带同一组 24B 坐标；旧 56B/76B list 与无版本 search payload 仅保留读取兼容。

---

## Real person reads proof contract

View count is not triggered by article details GET. After front-end hydration, a human reading event is generated through the AEDS proof endpoint.

### `POST /api/binary/read-proof/challenge.aeds`

请求 frame：`HumanReadChallengeRequest` (`73`)

| Field | Type | Description |
| ------ | ------ | ------ |
| `scope` | string | `site` 或 `article` |
| `routeKey` | string | 公开页 route key，例如 `home`、`article:42` |
| `articleId` | int? | `scope=article` 时必填 |

请求头必须包含浏览器上下文：`X-Fsus-Device-Fp`、`Sec-Fetch-Site`、`Sec-Fetch-Mode`、`Sec-Fetch-Dest`，并由可信 `Origin` 或 `Referer` 发起。

该端点受 `read_proof` 专用限流保护。被拒绝的 challenge 不产生有效 token，拒绝原因会进入 crawler risk 分，但公开内容访问不会因此被阻断。

响应 frame：`HumanReadChallengeResponse` (`28`)

| Field | Type | Description |
| ------ | ------ | ------ |
| `token` | string | HMAC-bound proof token；拒绝时为空字符串 |
| `scope` | string | 规范化后的 `site` 或 `article` |
| `routeKey` | string | 规范化后的公开页 route key |
| `articleId` | int? | 文章阅读对应 article id |
| `minDwellMs` | int | 最小可见停留时间，默认 8000 |
| `issuedAt` | unix ms | 签发时间 |
| `expiresAt` | unix ms | 过期时间 |

### `POST /api/binary/read-proof/submit.aeds`

请求 frame：`HumanReadSubmitRequest` (`74`)

| Field | Type | Description |
| ------ | ------ | ------ |
| `token` | string | challenge 返回的 proof token |
| `scope` | string | `site` 或 `article` |
| `routeKey` | string | 与 challenge 绑定的 route key |
| `articleId` | int? | 与 challenge 绑定的 article id |
| `dwellMs` | int | 客户端累计可见停留毫秒数 |

Submit 同样受 `read_proof` 专用限流保护。限流 key 是 path + 一分钟 epoch 下的用途隔离 HMAC，不保存 raw IP 或 raw forwarded header。`counted=true` 会写入 `ReadProofAccepted` 负分风险信号，仅用于降低后续 `public.read` 风险；`proof_replayed`、`proof_binding_mismatch`、`fetch_metadata_invalid`、`origin_invalid` 等拒绝状态会写入 crawler risk。`duplicate_viewer` 只表示同一 article/site + 15 分钟 epoch 内的短期去重，不计入风险；去重 lease 最长 20 分钟，并使用独立轮换 key。Redis/cache lease 不可用时返回 `counted=false, status=dedup_unavailable` 并丢弃本次统计，不创建 risk event、retry/dead-letter 或 fallback。read-proof 请求不携带稳定设备指纹。

被接受的阅读只记录 article/UTC hour 计数和 `<10s`、`10–30s`、`30–120s`、`>120s` dwell/day histogram。生产最终态没有 per-read row，也不保存 viewer/proof/device/IP/UA、route、精确时间或精确 dwell；`sys_visit_log` 整表删除。

响应 frame：`HumanReadSubmitResponse` (`29`)

| Field | Type | Description |
| ------ | ------ | ------ |
| `counted` | bool | 是否写入真人阅读事件 |
| `status` | string | `counted`、`paused`、`duplicate_viewer`、`dedup_unavailable`、`proof_replayed`、`proof_binding_mismatch`、`fetch_metadata_invalid`、`origin_invalid` 等状态 |

旧 JSON 端点 `GET /api/read-proof/challenge` 与 `POST /api/read-proof/submit` 已移除；生产前端不得调用，也不得作为 AEDS 解码失败 fallback。

`counted=false` 表示 proof 被拒绝或重复提交；内容读取不受影响。HumanReadProof submit / `humanReadProofV1` challenge proof 都不能授权 comment/auth/admin 写操作。

---

## Comment Contract

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

`replyCount` 是当前 viewer region 下该根线程完整公共投影中的回复节点总数，包含为公开后代补齐的安全墓碑祖先，并排除删除叶、审核不可见叶和地区不可见叶；它不等于 `repliesPreview.length`。`repliesPreview` 只受 preview limit 限制，`hasMoreReplies` 固定等于 `replyCount > repliesPreview.length`。服务端在批量 root 窗口查询中用 `COUNT(*) OVER (PARTITION BY root_id)` 计算，不允许逐根 N+1 count；任意层级回复都归入其 `root_id`。

`CommentArticleCursor`、`CommentThreadReplyCursor` 与 `CommentUserCursor` 的二进制 item payload 先保存 content slice，随后追加两个 `int32 length + CommentAuthorView payload` 段：第一个为必备 `author`，第二个为可空 `replyToAuthor`。固定 POD 不再携带 author display string；缺少必备 author 或 payload 尾部残留数据都必须被前端 adapter 视为 `ProtocolFailure`。

公开评论读取会按 viewer IP 解析出的地区过滤 `comment_blocked_region` 规范化 lookup 行，并把 viewer region 纳入 `CommentCursorFrame` cache identity；cache runtime counters 会按 roots/replies 与规范化 region 记录 hit/miss。`CN-MAINLAND` 严格策略只对 `CN-MAINLAND` viewer 隐藏，不会自动套用到 `CN-HK`、`CN-MO`、`CN-TW`；viewer region 解析为 `UNKNOWN` 时，只要 comment 存在任意 blocked region lookup 行就保守隐藏。评论提交同样按 request IP 解析 submit region：submit region 为 `CN-MAINLAND` 且命中大陆严格类别时直接返回 validation error；其他地区可发布但会记录对应 blocked regions；submit region 为 `UNKNOWN` 时记录人工复核和 `hide_until_reviewed=true` 地区原因，但评论初始状态仍为 `Approved`，不会仅因地区未知默认隐藏。`X-Fsus-Region` / `CF-IPCountry` / `X-Geo-Country` 只在 loopback 或 `ReverseProxy:KnownProxies` / `ReverseProxy:KnownNetworks` 命中的可信代理来源上生效，直连请求携带这些头必须按 `connection_ip` 处理。

地区合规结果存储在 `comment_region_compliance`：`comment_id`、`submit_region`、`submit_region_confidence`、`region_provider`、`submit_ip_hash`、`policy_version`、`can_publish`、`requires_manual_review`、`hide_until_reviewed`、`blocked_regions`、`risk_labels`、`decision_reason`、`rule_hits_json`、`created_at_utc`、`updated_at_utc`。其中 `blocked_regions` 继续作为审核展示和 replay diff 的序列化来源；公共读取的可索引过滤写入 `comment_blocked_region(comment_id, region_code)`，主键为 `(comment_id, region_code)`，并有 `(region_code, comment_id)` 索引。IP 只保存由独立 `Moderation:RegionPolicy:IpHashKey` 生成的 HMAC hash；缺失 key 时 fail closed，不使用硬编码或 JWT fallback。轮换该 pepper 后旧 `submit_ip_hash` 不可重算，应通过安全轮换工具清空旧 hash。匿名评论 `moderation_subject_hash` 由 `HMAC-SHA256(Moderation:Pepper, nullifierHash)` 派生，不拼接 scope，不使用裸 SHA-256；缺失 `Moderation:Pepper` 时启动和运行时均 fail closed。策略 replay 通过服务层生成 `RegionPolicyReplayDiff`，用于比较 blocked regions、risk labels、publishability 和公开可见性变化。

---

## Classification and Tag Contract

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

管理端分类和标签写入均使用 binary mutation path。`CategoryWriteRequest(33)` 与 `TagWriteRequest(34)` 的当前 payload 是 136-byte `TaxonomyMetadataMutationRequestPod`（`Utf8Fixed128 Name` + `Utf8SliceRef Description`），后接标准 `int32 blobByteLength` 与 UTF-8 description blob。description 持久化前 trim，空白归一化为 `NULL`，超过 500 个 Unicode scalar value 的请求在数据库修改前返回 validation error。迁移期后端同时接受精确 128-byte legacy `NameMutationRequestPod`：legacy create 写 `Description = NULL`，legacy update 只更新名称并保留已有 description。新格式 update 同时替换名称与 description。该 description 不进入 `CategoryList`、`TagList`、文章 taxonomy projection 或文章列表契约。匿名精确读取使用独立 `TaxonomyExactMetadata(243)` frame，路径为 `GET /api/binary/category/{id}.aeds`、`GET /api/binary/tag/{id}.aeds` 与 `GET /api/binary/tag/by-name.aeds?name=`，成功 payload 仅含 `id`、`name` 与 nullable `description`，不含 `articleCount` 或文章列表。缺失 id/name 返回普通 binary `NotFound`。Tag-by-name 使用与 Public AOT filter bootstrap 相同的显示名规范化与 `TagUrlAlias` 解析，命中后返回当前规范标签身份，不把 alias 当作第二身份。精确元数据缓存按 taxonomy kind + canonical id 独立于 list frame 失效。 公开 Filter SPA 在无可用 seed 时用上述精确读取解析当前 Category/Tag 目标（分类 id、标签 id、或标签名/alias），不再为单个 Filter 目标下载 `CategoryList`/`TagList`。有效公开 Filter seed 若已含 taxonomy 元数据则直接使用，不追加精确读取。Search 模式不请求 taxonomy 元数据。`CategoryList`/`TagList` 仍供导航、管理端和列表使用。 Category/Tag update 先按同一规范化规则比较持久化 Name/Description：两边未变则成功且无下游失效；`nameChanged` 保持既有 rename 投影/outbox、taxonomy list-frame bump、`ArticleList` 与 RequiredTaxonomy PublicHot；仅 Description 变化只失效该实体 exact metadata 与 `category:{id}`/`tag:{id}` Filter AOT 路由族（含分页、hydration 与 `filter.description` SEO），不插入 article taxonomy outbox、不 bump list frame、不失效 `ArticleList`、不改 `TagUrlAlias`。

创建成功响应 `MutationId`，编辑器可用返回的 `id` 立即选中新建分类或关联新建标签，不能只依赖刷新列表后按名称猜测；更新和删除成功响应 `EmptySuccess`：


上述六个 admin mutation 只有在 PublicHot `required-taxonomy` dirty generation 已持久化且 typed delivery receipt 允许成功后才返回成功。bounded channel 已满时，持久化的 `persisted-dirty` receipt 仍授权成功并由 full rebuild 恢复；delivery result 为 `cancelled`、`closed` 或 `failed` 时返回 HTTP `500` + AEDS `ApiError(Code=InfraFailure)`，不得返回 `MutationId` / `EmptySuccess`。该失败可能发生在 taxonomy 数据库写入已经提交之后，不表示事务回滚。客户端必须先重读 `/api/binary/author/taxonomy/categories` 或 `/api/binary/author/taxonomy/tags` 再决定是否重试，尤其不能盲目重放 create。运维恢复 Redis 后按 [PublicHot recovery runbook](../architecture/public-aot-runtime-state-boundary.md#recovery-runbook) 触发或等待 full rebuild。

该变更的调用面边界如下：anonymous 请求在进入 mutation handler 前返回 binary `401 ApiError`；普通登录 principal 缺少 admin permission，在 handler 前返回 binary `403 ApiError`；具备 `article.write` 且通过 PoW 的 admin 才能进入写入与 delivery 链。notification stream 的 route、event 和 durability contract 均未修改，不参与 taxonomy delivery receipt。binary response 仍只使用 AEDS v2；已提交写入后的 delivery failure 由真实 endpoint 返回 HTTP `500` 的 `ApiError(InfraFailure)`，没有 JSON/text fallback。无需重启恢复时，先修复 Redis，再通过 `/api/binary/author/cache/actions` 的 `public-hot-rebuild` action 触发保留 generation 的 full rebuild；不得把 required delivery 热切换为进程内成功。

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

## Message system contract

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

### `ConversationList` 游标分页

The account list request is
`GET /api/binary/messages/conversations?size=20&filter=<filter>&cursor=<opaque>`；admin
The list is the same query contract, the default workspace page size is 30, and the server limit is 100. Omit the first screen
`cursor`，响应的 `total` 是该首屏 message-id 快照内符合筛选条件的会话总数；
`hasMore=true` 时 `nextCursor` 必须非空。筛选变化必须重新请求首屏。

排序固定为 `lastMessageAt DESC, conversationId DESC`。opaque cursor 内部绑定首屏
`snapshotMessageId`、末项 `lastMessageAt` 与末项 `conversationId`；后续页的列表排序和
消息预览都只读取 `message.id <= snapshotMessageId` 的非 internal 消息。并发新消息不会
Moving old conversations that have not been traversed out of the results will not replace old previews with new messages.

`ConversationList(56)` 在有后续页时使用 cursor envelope v1：

| Offset | Field | Type | Description |
| ------ | ------ | ------ | ------ |
| 0 | Magic | int32 LE | `0x4D534743` (`MSGC`) |
| 4 | Version | int32 LE | `1` |
| 8 | HasMore | byte | `0` 或 `1` |
| 9 | NextCursor | `Utf8SliceRef` | 指向当前 frame shared blob 的 opaque cursor |
| 17 | Total | int32 LE | Total number in snapshot |
| 21 | Count | int32 LE | 本页项数，随后为 `ConversationListItemPod[count]` 与 shared blob |

无后续页时编码器保留 legacy `total + count + pods + blob` 布局，decoder 必须同时接受
legacy 和 envelope v1；legacy 布局归一化为 `nextCursor=null, hasMore=false`。未知
version、非法 `HasMore` 或 `hasMore=true` 但 cursor 为空均按 protocol failure 拒绝。

`Messages:CursorPaginationEnabled=false` 可通过配置 reload 在不重启进程的情况下让两个
列表端点返回 `503 message_cursor_pagination_disabled`。该降级不恢复旧 `page` 参数、
Local slice or OFFSET query.

admin `ConversationListItemResponse.unreadCount` 与最新详情的 `unreadCount` 只来自共享
`msg_admin_queue_state`，不能使用 `msg_participant_state` 的账号未读聚合。该状态按
conversation 保存 `lastReadMessageId/unreadCount/lastReadAt/version`：账号创建工单或回复
在消息事务内增加 admin unread；admin/system 消息不增加；打开最新 admin 详情按响应的
`readSnapshotMessageId` 单调清除已读范围，并保留并发到达的后续账号消息。`filter=unread`
Use the same projection. Old session backfill conservatively counts account messages without proven admin read cursor as unread; internal
Consistency check and reconstruction are only recalculated for messages sent by account, non-internal, and located after the admin cursor.
`Messages:AdminQueueProjectionEnabled=false` 通过配置 reload 暂停 admin 列表与详情并返回
`503 message_admin_queue_projection_disabled`，不允许回退到账号参与者聚合。

消息行与 `lastReadMessageId` 是未读语义的权威事实；participant/admin queue 的
`unreadCount` 只是不小于 0 的可重建数据库投影，Redis 账号 total 只是可丢弃缓存。数据库
trigger rejects cursor backoff and requires a non-null cursor to point to a non-internal message in the same conversation. Account projection
Only the messages after the cursor, non-internal and not sent by the account itself are counted; the admin queue only counts the messages after the cursor.
Non-internal account information.

Maintenance boundaries support single conversation, single account, single admin conversation and full admin queue respectively.
Recalculate. Invalid cursors are conservatively reset to null in a controlled repair transaction and recalculated from message facts; log only records
scope、conversation/account id 和差异行数，不记录 subject/body。Redis total miss、非整数、
If negative or CAS fails continuously, return the database projection and use versioned refresh to try to restore the cache.
`Messages:UnreadRepairEnabled=false` 可热暂停维护写入；正常消息读写继续使用现有投影，修复后
Direct re-enabling does not allow bypassing constraints or promoting Redis as source of truth.

notification stream 的消息 payload 是正文最小化引用：`InboxMessageAppend.message.body`
固定为空字符串，`InboxConversationUpsert.conversation.lastMessage` 固定为 `null`。事件仍保留
conversation/message ID、sender type/name、createdAt 与 unread count；正文和预览只能通过
List of authorized binary /详情/delta endpoints to read. The account client executes after receiving the empty text append.
`afterMessageId` 权威增量恢复，admin 客户端刷新当前列表/详情，不得把空正文显示为消息。

消息保留以 UTC 活动时间执行：open/pending 365 天、closed 180 天、system governance 90 天。
到期后保留 conversation/message ID、时间、状态、必要的 `AdminPrincipalId` 与不可逆 session
audit reference，只把 subject/body 替换为固定 redaction marker 并删除附件 metadata。账号注销
Tombstone will clear the body, conversation topics, attachments, participant status and account mutation associations written by the account in the next cleanup;
admin/system 写入按正常期限保留。清理可重复执行且日志、指标只记录计数，不包含正文。
`Messages:RetentionCleanupEnabled=false` 可热暂停后续清理，但不恢复已清除内容。

管理端列表与详情分别使用 `AdminConversationList(206)` 和 `AdminConversationDetail(207)`。
这两个 admin-only frame 在原有 conversation 投影之外只增加
`counterpartyAccountId` 与 `counterpartyAccountStatus`（`0=active`、`1=restricted`、
`2=deleted`、`3=missing`）。账号端继续使用 `ConversationList(56)` 和
`ConversationDetailV3(204)`，不得出现对方 account id、账户状态、public handle、管理员
principal/session 或其它资料。`senderName` 由 viewer 决定：账号端为“你/管理员/系统”，
管理端为“账号 #ID/管理员/系统”；admin notification upsert 必须复用同一最小投影。

`Messages:AdminAccountProjectionEnabled=false` 可热重载暂停两个 admin 读取端点并返回
`503 message_admin_account_projection_disabled`，同时停止生成 admin projection upsert；
Account reading and writing and account frames are not affected. It can be re-enabled directly after data is restored and must not be inferred from sender display
Account identity, and identity fields may not be temporarily added to the account frame.

管理员系统消息使用 `POST /api/binary/admin/messages/system-send` 的 `SystemMessageRequest` frame。当前契约只支持单账号目标，`targetAccountId` 必须存在且大于 0；`targetAccountId=null` 不表示广播，后端会返回 validation error。前端管理入口位于 `/user/manage/messages`，普通 `/user/messagebox` 只承载账号消息和工单。

新系统消息在消息事务内以 `SELECT ... FOR UPDATE` 锁定 `sys_user` 目标行，再创建 conversation、
participant 与 outbox。普通 admin/事务通知使用 `ActiveAccountOnly`：缺失目标返回
`404 system_message_target_not_found`，已注销目标返回 `404 system_message_target_deleted`，受限
目标返回 `403 system_message_target_restricted`。封禁/恢复通知显式使用
`AllowRestrictedForGovernance`，只额外允许 status=restricted，仍拒绝缺失、注销和未知状态。
数据库外键保留为最后兜底，但这些领域结果不得统一映射成 `InfraFailure`。

source event 幂等检查先于目标状态检查：已经提交的同 key/同摘要重放即使目标随后受限或注销，
仍返回原 conversation 且 `idempotencyReplay=true`；新写入必须使用锁后状态。动态设置
`Messages:SystemMessageTargetValidationEnabled=false` 会在幂等重放之后 fail closed 新系统消息，
返回 `503 system_message_target_validation_disabled`，不回退到仅依赖外键的旧路径。

The request identity of the message mutation is in the HTTP header and does not change the existing AEDS request frame or POD size:

| write | required header | identity scope |
| ------ | ------ | ------ |
| 账号创建工单 | `X-Fsus-Client-Mutation-Id`（1..64 字符） | `account + accountId` |
| 账号回复 | `X-Fsus-Client-Mutation-Id`（1..64 字符） | `account + accountId` |
| admin 回复 | `X-Fsus-Client-Mutation-Id`（1..64 字符） | `admin + adminPrincipalId` |
| 系统消息 | `X-Fsus-Source-Event-Id`（正 `int64`） | 全局 source event |

同一次用户意图的双击合并、timeout retry 和 response-loss retry 必须重用同一
`ClientMutationId`；新的用户意图必须生成新值。服务端在消息事务内保存主体、mutation id 与
规范化请求 SHA-256，并在 conversation/message 两张表之间做主体级唯一判断。相同 key 与相同
摘要返回首次提交的 ID；相同 key 与不同摘要返回 `409 client_mutation_content_conflict`。
系统消息按唯一 `sourceMessageId` 执行同样的摘要校验，冲突返回
`409 source_event_content_conflict`。

`ConversationDetailV2.idempotencyReplay` 与 `ConversationMessageResponse.idempotencyReplay`
在首次提交时为 `false`，返回已存在结果时为 `true`。它们复用既有 reserved byte，frame type、
POD total length and v2 decoder compatible bounds remain unchanged.

普通消息端点 `/api/binary/messages/**` 只接受 `identity_kind=anonymous_account` 的账号主体，并从 `AccountPrincipalContext.AccountId` 解析当前账号；不得使用 legacy `CurrentUser` 参数绑定器或把 AdminPrincipal 的 `NameIdentifier` 当作账号 id。管理消息端点 `/api/binary/admin/messages/**` 继续要求 admin principal + `admin.manage`，并用 `AdminMessageActor` 携带 `admin_id/admin_sid`。

管理员更新对话状态必须发送 `ConversationStatusRequest`，其中 `status` 为目标状态，`reason`
为 1..256 字符的审计原因。允许的转换固定为 `open -> pending/closed`、
`pending -> open/closed`、`closed -> open`；相同状态不写库，返回
`ConversationStatusMutationResult(211)` 且 `outcome=no_change`。其它转换返回 HTTP `409` +
AEDS `ApiError`。

服务端先读取 `msg_conversation.status + xmin`，再用 `id + expected status + row version` 执行
CAS updated. Only one transition in a concurrent administrator request takes effect; if the later request finds that the target state has been completed by the concurrent request, it returns
`no_change`，若当前状态不同则返回 `409`，不得 last-write-wins。成功转换必须在同一 PostgreSQL
事务中追加不可更新/删除的 `msg_conversation_status_event` 审计记录，并为账号和 admin 写入携带
Outbox delivery of this precise target state. Unified consumption at both ends
`InboxConversationStatusChanged(15)`，不得把 pending/reopen 伪装成 closed 事件，也不得在 worker
When delivery is delayed, the latest status will be reread to overwrite historical events.

`Messages:StatusMutationsEnabled=false` 可通过配置 reload 在不重启进程的情况下暂停状态写入并
返回 `503 message_status_mutations_disabled`；读取、回复和 notification stream 继续工作。修复
Can be directly re-enabled after auditing or outboxing the link, not allowing fallback to no auditing, no CAS or requesting threads to post events directly.

消息表最终 schema 只允许账号 / 管理员主体列：`msg_conversation.initiatoraccountid`、`msg_message.senderaccountid`、`msg_participant_state.accountid` 以及对应 admin-principal 列。共享 admin 队列只通过 `msg_admin_queue_state.conversationid` 关联会话，不保存 admin principal/session id。`msg_conversation.initiatoruserid`、`msg_message.senderid`、`msg_participant_state.userid` 和 `*_identity_sync` trigger/function 只属于一次性迁移兼容面，finalize 后不得出现在备份、恢复或运行时契约中。

### `ConversationMessageResponse`

```json
{
  "messageId": "456",
  "conversationId": "123",
  "senderType": 0,
  "senderName": "你",
  "body": "消息内容",
  "createdAt": "2026-01-01T00:00:00Z",
  "idempotencyReplay": false
}
```

`senderType` 的数值保持 wire 兼容：`0=Account`、`1=Admin`、`2=System`。响应不暴露 sender account id、用户名、公开昵称或头像；显示名只使用“你 / 管理员 / 系统”这类上下文安全文本。

### `ConversationDetailV3`、消息向前分页与精确已读推进

账号与 admin 的 GET 详情返回 `ConversationDetailV3` (`204`)；创建会话和系统消息继续使用
`ConversationDetailV2` (`203`) 返回单条初始快照。V3 响应 DTO 为：

```json
{
  "conversationId": "123",
  "readSnapshotMessageId": "456",
  "previousCursor": "407",
  "hasOlder": true,
  "unreadCount": 2,
  "messages": []
}
```

首屏固定返回最新 50 条非 internal 消息。`hasOlder=true` 时，`previousCursor` 是本页
最旧消息 ID；下一页调用同一路径并传 `beforeMessageId={previousCursor}`。后续页严格读取
`id < beforeMessageId`，按 ID 升序返回，边界不得重复。分页期间插入的新消息不会进入旧页；
The front end uses message ID to merge the real-time patch and the history page. The account view excludes internal notes on all pages.

notification stream 重连报告 `replayMissed=true` 时，当前账号会话使用最后已知的可见
message ID 调用同一路径并传 `afterMessageId={lastKnownMessageId}`。服务端严格读取
`id > afterMessageId` 的非 internal 消息，按 ID 升序每页返回最多 50 条；差量超过一页时，
`hasOlder=true` 表示仍有后续差量，`previousCursor` 在该模式下承载下一次
`afterMessageId`。`beforeMessageId` 与 `afterMessageId` 互斥。客户端循环差量页、按 message
The read cursor is advanced after ID is deduplicated; the HTTP response for the old selection must not overwrite the new selection or the arriving real-time
patch. List, current details, and total unread are simultaneously read from the database to reconverge the status.

reload-capable `Messages:ThreadPaginationEnabled=false` 可在不重启进程的情况下同时停止历史页
和重连差量读取并返回 `503 message_thread_pagination_disabled`；notification stream 与现有消息
Sending and receiving are not affected. It can be re-enabled directly after fixing, without returning the text API or overwriting the database snapshot with cached values.

### Message content boundary

`FsusBlog.Shared.Contracts.Validation.MessageContentPolicy` 是手工消息与系统治理通知共用的
权威策略。主题上限为 320 Unicode scalar、160 grapheme、640 UTF-8 bytes；正文上限为
8000 Unicode scalar、4000 grapheme、16000 UTF-8 bytes；消息写入 AEDS frame 上限为
20 KiB。任一维度超限均返回 `Validation` 与稳定的
`message_{subject|body}_{scalar|grapheme|utf8}_limit_exceeded`，AEDS 解码后的服务端校验始终为
Final access control. The client MAY display the same error in advance, but MUST NOT send it truncated; original topic /正文（含首尾空白）按原样
Storage, blank body is still rejected, blank theme only uses existing business fallback.

列表 `bodyPreview` 最多取前 96 个 grapheme 后追加省略号，截断只作用于读模型预览，不回写
`msg_message.body`。账号创建/回复、admin 回复、system-send 均受相同 frame 与内容策略约束。
紧急情况下可热设 `Messages:ReplyWritesEnabled=false` 停止双方回复，并设
`Messages:MutationIdempotencyEnabled=false` 停止创建/system-send；读取、notification stream 和
The existing original text will not be affected, and the policy can be re-enabled directly after repair.

`readSnapshotMessageId` 是该响应页中最后一条非 internal、对账号可见的消息 ID。账号读取
后使用 `ConversationReadRequest` (`201`) 调用
`POST /api/binary/messages/conversations/{id}/read`：

```json
{ "readThroughMessageId": "456" }
```

账号回复不再使用 admin 的 body-only `ConversationReplyRequest` (`60`)，而使用
`AccountConversationReplyRequest` (`202`)：

```json
{ "readThroughMessageId": "456", "body": "回复内容" }
```

服务端在 PostgreSQL 事务内锁定 `msg_participant_state`，验证目标消息属于该会话、
`isinternalnote=false` 且游标不后退，再把未读数重算为“目标 ID 之后、非 internal、非
The number of messages sent by the current account. New messages inserted after GET, the account's own concurrent replies and internal notes
都不能被旧快照误标已读；游标后退返回 `409`，不可见/跨会话/internal 目标返回
`404`。`InboxReadUpdated.lastReadMessageId` 回显被接受的读取位置，未读数保留快照之后
New messages that have not been read yet.

`Messages:PreciseReadCursorEnabled=false` 可通过配置 reload 在不重启进程的情况下让
账号 mark-read/reply 返回 `503 message_read_cursor_disabled`，保留详情/list/admin
读取；不得以旧无游标 request、当前 `MAX(id)` 或 JSON/text fallback 降级。

账号与 admin 回复复用同一事务状态屏障：先锁定 `msg_conversation` 并在锁内重新校验
status，`closed` 返回 `409`，只能由独立 status mutation 显式重开；随后在同一事务内写入
`msg_message`、推进 `lastMessageAt/updatedAt`、更新对侧 unread 投影并写入
`message_mutation_outbox` delivery event。创建会话、账号/admin 回复、系统消息、显式已读和
State changes all follow the same transaction boundary; any phase failure will be rolled back. Only local workers can claim event after submission
And deliver the notification stream. Failure in delivery shall not revoke the submitted message or unread status. Reply status preconditions
不使用 `xmin`；会话不存在返回 `404`，锁后状态冲突返回 `409`，基础设施失败返回 `503`。
重复提交以主体级 `ClientMutationId` 或系统 `SourceEventId` 为边界：相同请求返回最初 ID且不再
写入 unread/activity/outbox，不同内容返回 `409`。并发相同 key 由 transaction advisory lock
Serializing to the same idempotent record cannot rely on unique violation as the normal response path.

每条 outbox event 为每个目标保存稳定 `deliveryKey`；键绑定已提交的 message ID、read cursor
or status mutation coordinate, and reuse the same event ID by the Redis notification backlog. worker use
`pending -> processing -> processed/poison` 状态、claim token、短 lease 和指数退避；进程在提交后
Or when you exit after publishing, the expired claim will be reclaimed, and the same delivery key will still be passed for repeated consumption. Runtime metrics
`fsus.message_outbox.backlog`、`failure_backlog`、`poison` 与 `stuck_claims` 仅暴露低基数计数，
Message text, account identity, or delivery key are not logged.

`MessageMutationOutbox:Enabled=false` 可通过配置 reload 在不重启进程的情况下暂停 claim 和
投递；消息写入及 outbox 持久化继续，pending event 不丢弃。修复 notification/Redis 后重新启用
即可从数据库重放。这是实时交付的降级开关，不允许回退为事务提交后直接 best-effort 发布。

`Messages:ReplyWritesEnabled=false` 可通过配置 reload 同时让账号与 admin reply 端点返回
`503 message_reply_writes_disabled`，无需重启；它不关闭读取、status mutation 或显式重开，
Rollback to a split transaction or notify-then-commit is also not allowed.

`Messages:MutationIdempotencyEnabled=false` 可通过配置 reload 让创建工单、账号/admin 回复和
系统消息写入统一返回 `503 message_mutation_idempotency_disabled`。该开关只用于 schema 或
幂等写链路故障时 fail closed；读取、mark-read 和 status mutation 保持可用，且禁止绕过 header
Restore non-idempotent writes.

---

## 通知 WebSocket 契约

源码：`src/shared/Contracts/NotificationStream/NotificationStreamContracts.cs`

### aisle

- 路径：`GET /api/notifications/stream`
- 预检路径：`GET /api/notifications/stream/preflight`
- 协议：WebSocket，子协议固定为 `fsus-aeds.v2`
- Message type: binary
- Per message: full AEDS v2 frame
- 传输语义：notification stream 不是标准 Server-Sent Events，不使用 `EventSource` 或 `text/event-stream`
- Origin 语义：preflight 与正式 WebSocket 握手共用 allowlist 校验；允许 `Seo:BaseUrl`、`Fido2:Origins`、`CORS_ALLOWED_HOSTS` 与开发 localhost，生产跨站、非 HTTPS/WSS 或浏览器缺失 Origin 返回 AEDS `ApiError`，错误码 `origin_not_allowed`
- 匿名连接：优先走 `notification.subscribe` RiskControl 准入；UI 与 notification headless 共用同一 ordered envelope runner，preflight 使用 `X-Fsus-Challenge-*` header 原子消费最终 aggregate proof，并设置短效一次性 HttpOnly grant；浏览器 WebSocket 只消费 grant，member proof / aggregate proof 原文都不进入 URL。旧 `pow` query 参数继续兼容，用于传递二进制 FPOW 证明的 base64 文本形式
- 断线续传：使用 `cursor` query 参数传递最后确认的事件 ID；event id 分配、route backlog append 与本机 fanout enqueue 按 storage route 排序提交。同一或重叠 route 由 route-scoped ownership lock 保持 Redis stream id 单调，互不相关 route 不共享进程级或 Redis 全局串行区

### Handshake Preflight

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

Load layout:

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

Load layout:

```text
int64 timestampUnixMs
```

### Backpressure close instructions

| Close code | Reason | Cursor | Client action |
| --- | --- | --- | --- |
| `4010` | `fsus_replay_required:<bounded-reason>` | preserve | 快速重连，并从最后已确认 cursor replay |
| `4011` | `fsus_full_resync_required:<bounded-reason>` | clear | 事件 policy 要求丢弃局部状态并执行 full resync |
| `4009` | `fsus_replay_miss` | clear | retention gap；执行 full resync |
| `1012` | `fsus_service_restart` | preserve | deployment restart；快速重连 |

lossless/state/low lane 无法继续安全实时投递时必须按 delivery policy 使用 `4010` 或 `4011`，不能普通关闭或静默丢失。`bounded-reason` 只使用固定低基数值，例如 `connection_frame_budget`、`connection_byte_budget`、`connection_age_budget`、`local_fanout_max_age`；不得携带账号、route、cursor、payload 或异常文本。

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
Nor will it register.

`POST /api/release-evidence/schema-bridge/write`

ask:

```json
{
  "operationId": "source-migration-run-001",
  "sequence": 1
}
```

`operationId` trim 后必须为 3..96 个 ASCII letters/digits/`-_.`；`sequence` 必须为
1..1,000,000。无效输入返回 `400 {"code":"schema_qualification_write_invalid"}`。
Successfully executes the idempotent upsert of the qualification control table and returns:

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

受保护的 qualification 诊断字段中，`releaseId` 是严格
`YYYYMMDDHHmmss-sha12` 部署身份，`schemaCompatibilityCoordinate` 是独立的数据库
兼容坐标。坐标允许规范 min/max fence，但 fence 不得出现在 `releaseId` 字段；历史
记录的 `appliedByRelease` 也必须始终是规范部署身份。

两条响应都携带 `X-Fsus-Release-Id`、`X-Fsus-Release-Slot` 与
`Cache-Control: no-store`。这些 header 用于 source/target identity 对账，不是认证
Credentials. route is only for #1031 isolation migration qualification; real production migrations can still only be made by
`tools/deployment/release-rollout.sh` 串联正式 migration runner。

### Development local auth fixture

### Development public-content security matrix fixture

`POST /api/local/public-content-fixture/prepare` 保留原有 loopback、Development 和
`X-Fsus-Local-Public-Content-Fixture-Secret` 门控。可选 `securityMatrix` 仅供
Production Release 浏览器安全验收，字段为 `cases[{id,category,markdown}]`、
`aboutMarkdown`、`metadataText` 和可选 `actorUserId`。case 数限制为 1..256，ID 必须
使用 FsusUI `mxss-*` 稳定 ID；服务端通过领域端口创建文章、根评论、回复和 About
内容，并在响应的 `entityIdentities[].handle` 返回 case 到实体的映射。该字段不进入
公开 OpenAPI/AEDS 契约，Production 环境不映射此入口。

`GET /__local/auth-fixture/admin` 与 `GET /api/local/auth-fixture/admin` 只在 `Development` 且 `fsus:allowLocalAuthFixture=true` 时映射；调用方还必须来自 loopback 地址，并提供 `X-Fsus-Local-Auth-Fixture-Secret`，其值用固定时间比较匹配 `fsus:localAuthFixtureSecret`。配套的 `/status` 端点使用相同的 loopback + shared-secret 门控。生产启动校验会拒绝 `fsus:allowLocalAuthFixture=true`。该入口只用于本地 Playwright fixture 刷新和 cookie 注入，不能在测试、预发布或生产环境作为匿名 admin 登录 fallback；刷新失败只返回固定失败文案，不回显脚本 stderr/stdout、异常消息或本地 storage-state 绝对路径。

前端只在 localhost + DEV + development mode + 非 PROD 四项同时成立时消费 `fsusLocalFixtureLogin` / `fsusLocalFixtureAdmin`。成功写入当前 tab 的 SessionStorage marker 后必须立即从当前 URL 删除这两个参数，同时保留其他显式本地测试参数、pathname 与 hash。传给 fixture endpoint 的 `redirect` 和 endpoint 成功后的 `Location` 都必须再次删除两个激活参数；失败返回固定本地 Problem 响应且不重定向，避免把 fixture 状态带回业务 URL 或形成循环。

fixture 刷新进程只能通过 `UseShellExecute=false` + `ArgumentList` 调用仓库内固定脚本 `tests/frontend/fixtures/prepare-auth-smoke-users.mjs`。服务端在启动子进程前必须对 repo root、fixtures 目录和脚本路径执行 canonical path 校验，确认目标仍位于预期 fixtures 目录内；executable 与脚本路径都不接受请求参数、配置值、环境派生的相对逃逸或替换文件名。默认 runner 设有 60 秒上限，传播请求取消，非零退出、启动失败和超时均在写 Cookie 前返回固定失败，不向响应或日志转发 stdout/stderr。Production 不映射 fixture endpoint，因而不会从请求链解析或调用 runner；行为测试可通过 DI 注入 fake runner，以真实端点和 storage-state 文件验证成功/失败边界而不启动子进程。

fixture 成功读取 `user.storage-state.json` 的 `AccessToken.expires` 与 `admin.storage-state.json` 的 `AdminAccessToken.expires`，按 Unix 秒转换为绝对 UTC 后原样写入对应 `Set-Cookie Expires`。该路径不得把 access expiry 替换为 fixture 请求时间、refresh/admin idle expiry 或 `Jwt:AccessTokenExpiresMinutes`；runner 失败、storage-state 缺失或 access expiry 非法时不得发出任何新认证 Cookie。

fixture redirect query 最大 2048 字符；`user.storage-state.json` / `admin.storage-state.json` 单文件最大 256 KiB，超过上限视为 fixture 不可用，不解析 JSON。

### `NotificationStreamEventType` 枚举

| Value | Name | Load Type | Description |
| ---- | ------ | --------- | ------ |
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
| 15 | `InboxConversationStatusChanged` | `InboxConversationStatusChangedPayload` | 对话状态变更；载荷携带精确目标状态，覆盖 pending/closed/reopen |
| 16 | `SessionRevoked` | `SessionRevokedPayload` | 已验证的 Passkey counter 回滚等账号级安全事件撤销全部普通会话；客户端立即进入重新认证，独立 admin principal 不受影响 |

### Notification delivery policy

权威源码为 `src/shared/Contracts/NotificationStream/NotificationStreamDeliveryPolicy.cs`。每个 active `NotificationStreamEventType` 必须显式声明 ordering scope、durability、loss policy、coalescing key、priority、maximum useful age 与 recovery action；catalog 未登记的 enum 值在 publisher 入口 fail closed，不能落入默认可丢弃 lane。

| Event | Ordering | Loss / lane | Coalescing key | Recovery |
| --- | --- | --- | --- | --- |
| `NoticeReceived`、`MessageReceived`、`SessionRevoked` | target | lossless | — | cursor replay；账号/会话状态要求 full resync |
| `GlobalNoticePublished` | global | lossless | — | cursor replay |
| `CommentAdded`、`CommentRemoved` | route | lossless | — | cursor replay |
| `MessageRevoked`、`InboxMessageAppend` | conversation | lossless | — | cursor replay |
| `UnreadCountUpdated`、`AccountStatusChanged`、`ArticleChanged` | target / route | replaceable state | target | cursor replay；账号状态要求 full resync |
| `CacheControl` | route | replaceable state | type + scope + cache | cursor replay |
| `InboxConversationUpsert`、`InboxReadUpdated`、`InboxConversationStatusChanged` | conversation | replaceable state | conversation id | cursor replay |
| `SearchIndexUpdated` | route | coalescible low | manifest URL | cursor replay |

所有当前 active event 都要求 Redis backlog；coalescing 只影响 live shallow lane，不删除 durable frame，也不改变 event id、cursor、conversation/message ordering 或 multi-route dedupe。只有未来显式登记为 `diagnostic-drop` 的事件才允许静默丢弃。

`ArticleChangedPayload` 固定包含 `articleId:int32`、`action:string`、`eventTime:datetime`、可空 `preview`，并为 v2 article mutation 携带可空 decimal-string `revisionId` 与 `releaseId`。两项坐标标识通知实际对应的不可变 revision/release；前端禁止将它们转为 JavaScript `number`。dispatcher 必须在发送前重新核验当前 publication/revision 坐标；若已被新版本取代，不发送旧通知，并将 notification 及其余未完成 edge 以相同 superseded reason 持久化为 skipped。legacy v1 payload 允许两项均为空。

### `SessionRevokedPayload`

```json
{
  "reason": "passkey_counter_rollback",
  "revokedSessionCount": 2,
  "time": "2026-07-15T00:00:00Z"
}
```

该事件只在服务端持久会话撤销成功后发布，不携带 session id、credential id、token 或账号可关联标识。事件投递失败不回滚撤销；旧 principal 仍由 session validation DB/cache 边界 fail closed，客户端最迟在下一次请求或 refresh 时重新认证。

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

## File upload contract

源码：`src/shared/Contracts/Outputs/ServerResponseContracts.cs`

所有上传端点在 `/api/binary/upload/` 路径下，需要 admin principal + `article.write` 权限。分片上传是唯一入口，`uploadId` 由服务端生成并返回，wire 格式固定为 32 位 GUID `N` 格式；status、part map、part upload、complete 和 abort 路由都必须携带 `X-Fsus-Upload-Token`，并与创建会话的 admin principal 同时匹配。非法 id 返回 validation error；不存在、过期、旧/损坏 manifest、owner 不符以及缺失或错误 token 都返回同一个 `404 UPLOAD_SESSION_NOT_FOUND`。服务层在 session lock 内读取一次且仅接受 v4 manifest；manifest 保存 token 的 SHA-256 而非原 token，使用固定时间哈希比较。旧版本与损坏会话会删除而不迁移。`/part` 必须携带明确 `Content-Length`，chunked transfer-encoding 返回 411；上传总大小上限为 20 MiB，Kestrel request body limit 必须覆盖该上限和协议开销。允许的目标图片格式为 jpg/jpeg/png/gif/webp，品牌图标生成允许额外上传 `ico` favicon 成品；AVIF 与 SVG 在具备像素维度、metadata bomb、decoder 风险防护和 SVG 清洗前不属于 upload allow-list。`.upload-sessions` manifest 和 part 文件只允许 owner read/write，manifest 使用随机 sibling temp path 后原子发布。

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

## System configuration contract

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

`keywords` 是迁移兼容字段：旧 AEDS frame 和持久配置可以继续携带它，但 AOT/SPA HTML 不得生成 `<meta name="keywords">`，发布前检查也不得把它当作搜索排名信号。新客户端不应要求作者维护该字段。

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

## Management side statistics contract

### `AdminStatsQueryDto`（`GET /api/binary/stats`，Binary 响应）

对应 `AedsFrameType.AdminStats`，POD 结构包含：

```text
SiteStatsPod、共享 UTF-8 blob、popular article records、recent comment records、region records
```

服务端对外 query model 是 `AdminStatsQueryDto`：`Overview` 对应统计摘要与热门文章，`RecentComments` 对应最近评论，`Regions` 对应地区分布。前端 dashboard 从单个 `AdminStats` frame 派生三个视图区块；`/api/binary/stats/recent-comments` 与 `/api/binary/stats/regions` 仅保留为兼容窄读入口。

`RecentComments` 只使用 comment 行内作者快照，不连接 `sys_user`，字段为 `authorDisplayName`、`authorMode`、`authorBadge`、`authorScopeLabel`、`credentialLevel`、`content`、`createTime`；不得恢复账号作者标识或 legacy display 字段。

`Overview.Summary` 的阅读字段为匿名安全口径：

| Field | Description |
| ------ | ------ |
| `totalReads` | `daily_read_stats` 中的聚合阅读计数 |
| `humanVerifiedReads` | 通过 human-read proof 的聚合计数 |
| `uniqueViewerKeyEstimate` | 兼容字段，固定为 `0`，不再收集 viewer identity |
| `articleReads` | `event_type_read_stats` 中的文章聚合计数 |
| `siteReads` | `event_type_read_stats` 中的站点聚合计数 |

该摘要不暴露注册/匿名账号拆分。`Regions` 只返回达到 `k=10` 的 cell，并应用每天固定的 `ε=0.5` Laplace noise；物理迁移会清空旧地区数据，当前聚合写路径不再收集地区。

---

## AOT public page contract

源码：`src/shared/Contracts/Outputs/PublicPageContracts.cs`

### `PublicPageId` 枚举

| value | page | routing key format |
| ---- | ------ | ----------- |
| 1 | `Home` | `"home"` |
| 2 | `ArticleDetail` | `"article:{id}"` |
| 3 | `Filter` | 成功页面：`"category:{id}"`、`"tag:{id}"`；兼容解析入口：`"tag-name:{name}"`（只返回 301/404，不得进入成功 payload） |
| 4 | `Archive` | `"archive"` |
| 5 | `About` | `"about"` |
| 6 | `Account` | `"account"`，非 SEO |
| 7 | `Privacy` | `"privacy"` |
| 8 | `Guidelines` | `"guidelines"` |
| 9 | `Copyright` | `"copyright"` |

### Public AOT Single Product Requirements

Each public page AOT entry must come from the same render chain:

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

constraint:

- `html`、`bootstrapPayload`、`hydrationPropsPayload` 不能分别由不同模板层独立拼装。
- AOT 产物只允许由服务端 `server-ssr` backfill 写入；客户端、管理端和脚本不得上传 AOT bundle。
- `Filter` / `ArticleDetail` 不允许持久化错误态壳层，例如 markdown fallback/error 文案。
- 服务端 backfill 使用 `PublicAot:SsrWorkerMode=Pooled` 的 Node/Vue SSR worker 池生成条目；
  如缓存未命中，shell service 必须先用 bootstrap provider 分类真实资源状态。只有 provider 成功的有效路由才可返回 SPA index fallback，并通过 `X-Fsus-Public-Aot-Backfill` 标记 `queued` 或 `dropped`；`NotFound`/invalid identity 返回 404，临时 provider/DB gate 故障返回 503，不得排队 backfill。
- 过期或 renderer/frontend asset version 不匹配的条目不得作为 stale HTML 返回；运行时必须删除旧
artifact, returns SPA index fallback, and queues backfill. Response headers only use
  `X-Fsus-Public-Aot-State: fresh|fallback|not-found|gone|transient-failure` 区分 fresh 命中、有效路由 SPA fallback 与真实失败状态。
- AOT HTML 缓存同时校验 `rendererVersion` 与 frontend asset version；前端 `index.html` 或
  `.vite/manifest.json` 变化会自动拒绝旧缓存，并按 frontend asset version 隔离文件 artifact。
- AOT HTML template only accepts the following 5 named sentinels; sentinels are string equality matches and do not accept wildcard tags:
    - `<!--fsus:aot:head-start-->`：SEO/head 注入起点。
    - `<!--fsus:aot:head-end-->`：SEO/head 注入终点。
    - `<!--fsus:aot:app-->`：SPA/AOT shell 挂载点。
    - `<!--fsus:aot:payloads-->`：bootstrap AEDS 注入点与 hydration `.aeds` sidecar marker 注入点。
    - `<!--fsus:aot:spa-boot-->`：PublicBootConfig 与外部 BootKernel 注入点。
- 由 Public AOT 管理的 SEO head 节点必须带 `data-fsus-aot-head`，包括 `<title>` 和 `script[data-fsus-seo-head-model]`。HTML、navigation snapshot 和 SPA takeover 必须使用 `PublicSeoHeadModel` 同一语义实例；不得由客户端从 route meta 另行拼接 canonical、OG、Twitter 或 JSON-LD。新增 sentinel/head 字段必须同步 `src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs`、`docs/api/design.md` 和 `tests/frontend/checks/public/check-public-aot-contracts.mjs`。
- 含 `<head>`、inline `script` 或 inline `style` 的 document 在 publication/decode 阶段编译 CSP nonce UTF-8 segment template。模板绑定 renderer version、frontend asset version、artifact ETag/digest；请求只写预计算 segment/slot，不重新扫描或生成完整 rendered string/byte array。malformed/重复 nonce、预渲染 `csp-nonce` meta、原始 placeholder、重复 head、非法 self-closing marker、非法 unquoted attribute、带属性的 executable closing tag、未闭合或自闭合 script/style 必须 fail closed。writer 在首字节及 segment/slot 边界传播 request cancellation；预取消请求的 response pipe 必须保持零 `Advance`、零 flush。
- nonce document 响应固定为 identity、`Cache-Control: private,no-store`、无 `Content-Encoding`、无 `ETag`/`304`；`Accept-Encoding` 明确 `identity;q=0` 时返回 406。无 nonce document 继续使用预生成 identity/br/gzip variant 与各自 strong ETag。HEAD 只返回按实际随机 nonce 长度计算的 Content-Length，不写 body。
- PublicHotRead 只接受 `PublicHotReadRouteSecurityCatalog` 中逐项登记且带 `PublicFastPathRouteMetadata` 的精确公开 route；不得通过 `/api`、`/api/binary` 或其它 broad prefix 推导公开性。任何已认证 principal、Authorization/Cookie/`RequestVerificationToken`/`X-CSRF-TOKEN`/`X-XSRF-TOKEN`、`Origin` 或非 `GET`/`HEAD` 请求必须绕过 L0，进入常规认证、授权、CORS、antiforgery 与审计链。横切控制的权威注册是 `PublicHotReadCrossCuttingControlCatalog`：每项必须且只能声明为 `global-before-branch`、带两端 stage 与 double-execution guard 的 `early-replayed`，或绑定 executable route constraint 的 `endpoint-only/not-applicable`；启动与 CI checker 任一侧缺失、重复、metadata 漂移或 predicate 放宽均 fail closed。
- PublicHotRead snapshot publication 必须携带 `visibilityPolicy=published-visible-at-cutoff-v1`、`sourceVisibility=public`、与 snapshot version 相同的 `visibilitySourceVersion` 以及 `visibilityCutoffUtc`。仓库无独立 `Private` 状态；private/non-public 契约由 only-Published admission 表达，projector 在查询与最终 frame 物化两处都必须排除 `Draft`、`Scheduled`、`Archived`、`Deleted`、`IsDeleted=true`、未来 `PublishedAt` 或未来 `ScheduledPublishAt`/embargoed 内容；evidence 缺失、source visibility/策略不匹配或 version 不一致时 publication fail closed 并保留旧 snapshot。fast/canonical focused test 必须对 production mapped canonical endpoint 与 L0 请求执行 raw byte-for-byte parity，不能只比较 DTO 或测试 dummy writer。
- PublicHotRead runtime snapshot 的 `residentBytes` 是 `independent-readonly-arrays-upper-bound-v1` 总上界，包含 binary variants、HTML bytes、nonce template UTF-8 bytes、slot table、构建生成的静态 inline SHA-256 feasibility list、metadata 与 key/index 估算；`htmlTemplateResidentBytes` 单独可观测。分项或 candidate/current overlap 超出动态/显式 budget 时新 snapshot 不得发布，旧 snapshot/version/ETag/invalidation 语义保持不变。
- PublicHotRead candidate 在原子交换前必须先通过廉价的 publication evidence 与 `visibilityCutoffUtc` age 检查，再通过 resident byte budget，最后执行 AEDS v2 schema/CRC/frame-type、br/gzip 可逆性与进程内 `hmac-sha256-128-process-memory-v2` 完整性校验。每个 binary raw/br/gzip variant 的 HMAC 同时绑定 route/list key、frame type、artifact version、ETag、cache policy 与 content encoding；HTML body 和实际 CSP nonce template bytes 分别封签，并绑定 route、content type、ETag、renderer/frontend version 与 template descriptor。请求命中只校验将要写出的 variant，HTML 同时校验 body/template；失败或快照超过 `PublicHotRead:MaxSnapshotAge` 时不得发送旧 bytes，必须恢复原 request feature 并进入 canonical endpoint pipeline。后台在 age 上限一半处排队刷新；刷新失败时 age gate 仍 fail closed。HMAC key 仅存在于当前进程内存，保护发布后 backing array 被意外改写，不充当跨主机签名或持久证明。
- 文章写入、删除、定时发布等 DB transition 的一致性边界仍由 pre-commit Redis revocation tombstone + durable mutation outbox 提供：写入 scope 先持有绑定 `IRuntimeKeyScope + articleId` 的 PostgreSQL session advisory owner lock，再建立 `TransitionPending` tombstone，最后才允许 DB commit；`UseFsusPublicArtifactRevocation` 必须排在 `UseFsusPublicHotReadFastPath` 之前，active article/global tombstone 返回 `410 + Cache-Control: no-store`。commit/abort 后只允许 CAS-promote 同一 generation 为 rebuild-ready，新 snapshot 发布且对应 generation 完成后才能 compare-delete tombstone。owner 进程崩溃时 recovery worker 只有成功取得同一 advisory lock 才能证明 writer 已结束并 promote；活 writer、较新 generation 或不同 runtime/test-session scope 均不得被覆盖。恢复周期由 `PublicArtifactRevocation:MutationFenceRecoveryIntervalSeconds` 控制。L0 命中不得为了 sanity check 增加每请求 PostgreSQL/Redis 查询。Redis Pub/Sub 不提供 subscriber ACK，因此不声明跨实例传播的线性化屏障，节点间失效与 snapshot 收敛分别由 #399、#400 的验收覆盖。

### Public HTML real-status contract

公共动态路径只接受 `/article/{positive-int}`、`/category/{positive-int}` 与 `/tag/{positive-int|valid-name}` 的完整匹配。`/tag/{positive-int}` 是唯一标签成功页；可解析的历史名称 URL 单跳 301 到 `/tag/{id}`，不生成成功 HTML。`/article/123/extra`、`/category/8/extra`、`/tag/vue/extra`、零值、空 segment、无效 percent encoding 和未知 path 都是 404。除根路径外，尾斜杠使用 301 单跳规范化到无尾斜杠 canonical。

Home、category 与稳定 ID tag 页面支持公开 HTML 页码。输入只允许单个 `page` query：省略或规范值 `1` 表示第一页，第一页 self-canonical 为基础 URL；`page=N (N>1)` 的 self-canonical、Open Graph URL、navigation snapshot canonical 与分页链接都必须逐字使用 `?page=N`。显式 `page=1`、非十进制正整数、0、负数、重复值、前导零或任何无关 query 参数返回 301 到规范 URL；有效但超过总页数返回 404。服务端 AOT provider 必须以目标页读取数据，首屏 HTML 的文章集合和分页 indicator 不得等待 JavaScript 修正。可用上一页/下一页必须渲染带 `href` 的 `<a data-aot-action="page-prev|page-next">`；SPA 只可拦截该真实链接做等价导航，禁用 JavaScript 时链接仍可逐页抓取。

规范分页身份进入 `routeKey`：第一页沿用 `home` / `category:{id}` / `tag:{id}`，后续页为 `{base}:page:{N}`。AOT document cache、hot HTML、route quarantine、backfill、hydration seed、navigation payload hash/ETag 都以该身份隔离；`QueryString` 只保存规范 `?page=N`，不保留其它 query。`scope=all` route manifest 必须按公开文章总数和固定 page size 10 枚举 Home/category/tag 的全部有效页面。文章 mutation 必须按 Home/Archive/Filter page prefix 清除所有分页 HTML 与版本，并在失效后仅把第一页作为优先 backfill；其它页由 manifest 或首次访问重建。

Public AOT 冷 miss 的分类结果固定为 `Success`、`NotFound`、`Gone`、`TransientFailure`。`Success` 才允许读取/排队普通 AOT；`NotFound` 返回 404；仅在持久化模型明确表达永久删除时使用 410；provider、数据库 gate 或基础设施不可用返回 503 + `Retry-After: 5`。所有 404/410/503 页面均满足：

- `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`、`X-Robots-Tag: noindex, follow`；
- HTML 内含 `<meta name="robots" content="noindex,follow">`；
- `X-Fsus-Public-Aot-Backfill: none`，且不写普通 AOT cache；
- 不输出 canonical、`og:url`、`BlogPosting` 或任何 SPA/hydration script；
- GET/HEAD 状态、content type、content length 与索引控制头一致，HEAD body 为空。

The current deletion model cannot distinguish between "permanently deleted and never restored" and ordinary hidden /删除. Therefore, if the article is missing, unpublished, timed out, archived and deleted, 404 will be returned conservatively; 410 cannot be inferred out of thin air.

### Public AOT Route Manifest

`GET /internal/public-aot/manifest` 返回后端权威公开 SEO route 清单，供预热脚本和内容变更驱动 backfill 使用。该端点只列出公开可访问 route；文章 route 必须满足 `Published`、未删除、已到 `PublishedAt` / `ScheduledPublishAt` 时间。生产环境 `PublicAot:ManifestToken` 是必填独立 secret；调用方必须携带匹配的 `X-Fsus-Public-Aot-Token`，否则返回 `403`。非生产环境可空 token 以支持本地工具链。

`GET /internal/public-aot/health` 返回 Public AOT SSR worker 诊断快照，同样受 `X-Fsus-Public-Aot-Token` 保护并返回 `Cache-Control: no-store`。响应包含 resource check（client root、worker script、prebuilt bundle 与 bundle path）、Node executable probe、`validateBundle` sample worker probe、backfill queue depth/capacity、scheduled/dropped/completed/failed counters、timeout/restart/stderr warning counters、last failure、circuit breaker 状态和 route quarantine 列表。breaker 打开或 route 被 quarantine 时只阻断新的 backfill 调度；公开读必须继续通过 fresh/stale AOT 命中或 SPA fallback 服务，不能因为 SSR worker degraded 阻断匿名阅读。

Query parameters:

| Parameters | Description |
| ------ | ------ |
| `scope=all` | 默认，列出 Home / About / Privacy / Guidelines / Copyright / Archive / 全部公开文章，以及 Home/分类/标签的全部有效分页 |
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

`dependencyKeys` 是预生成和失效收敛的稳定键：`article:{id}`、`category:{id}`、`tag:{id}`、兼容失效键 `tag-name:{name}`、`article:list`、`seo`、`compliance`。manifest 只生成 `tag:{id}` / `/tag/{id}` 成功 route；`tag-name:*` 只能作为旧名称失效与 301 解析依赖，不能成为第二条预热页面。内容变更后服务端会根据已知依赖主动调度 Home、Archive、ArticleDetail、Category/Tag Filter 与静态页的 AOT backfill；SEO 或 compliance 变更会按 manifest 调度所有 public routes。

### Public Navigation Snapshot

`GET /api/public/navigation-snapshot.aeds?path={publicPath}` 返回公开路由的原子接管快照，供 SPA 在路由切换前预取并写入 `PublicRouteSeedStore`。该端点匿名可读，`Accept` 允许空值、`*/*`、`application/octet-stream` 或 `application/vnd.fsus.aeds`；成功响应固定为 `Content-Type: application/vnd.fsus.aeds`，AEDS frame type 复用 `PublicAotBootstrap`。成功帧使用内容 ETag 与 `Cache-Control: no-cache`，缓存可以保存响应但每次使用前必须向源站重验证；`Content-Language` 绑定快照的 canonical `renderLocale`，`Vary` 固定包含 `Accept, Accept-Language, Cookie, X-Fsus-Test-Session`。内容突变后的 micro-navigation 不允许命中旧 `max-age` / `stale-while-revalidate` 快照。

`path` 必须是同站相对 URL、长度不超过 512 字符，可包含 query；服务端会丢弃 fragment，并通过 Public AOT route registry 校验目标。允许范围与 SEO/AOT 公开页一致：`/`、`/archive`、`/article/{id}`、`/category/{id}`、`/tag/{id}`、`/about`、`/privacy`、`/guidelines`、`/copyright`。兼容名称 `/tag/{name}` 会先解析为稳定 ID，成功 snapshot 的 `path`、`canonicalPath`、`routeKey` 和内部 payload 均改写为 `/tag/{id}` / `tag:{id}`，不得发出 name self-canonical snapshot。`/account`、`/search`、`/admin`、空 path、协议相对 URL 和绝对外链必须 fail closed。端点受 `public_read` 限流。

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
  "renderLocale": "zh-CN",
  "localeCatalogDigest": "sha256-hex",
  "payloadHash": "sha256-hex",
  "generatedAtUtc": "2026-06-18T00:00:00.0000000Z",
  "bootstrapPayload": "<base64url AEDS frame>",
  "hydrationPropsPayload": "<base64url AEDS frame>",
  "seoHead": {
    "schema": "fsusblog.public-seo-head",
    "version": 1,
    "digest": "sha256-hex",
    "documentTitle": "Archive - FsusBlog",
    "description": "...",
    "canonicalUrl": "https://fsus.blog/archive",
    "publicOrigin": "https://fsus.blog",
    "robots": "index,follow",
    "locale": "zh-CN",
    "pageType": "Archive",
    "pageEntityId": "https://fsus.blog/archive",
    "openGraph": { "title": "...", "description": "...", "type": "website", "url": "https://fsus.blog/archive", "locale": "zh_CN", "imageUrl": null },
    "twitter": { "card": "summary_large_image", "title": "...", "description": "...", "imageUrl": null },
    "jsonLdGraph": "{...}",
    "articlePublishedAtUtc": null,
    "articleModifiedAtUtc": null,
    "articleAuthor": null,
    "articleImageUrl": null
  }
}
```

`bootstrapPayload`、`hydrationPropsPayload` 与 `seoHead` 必须来自 `PublicAotRenderRequest` -> `PublicAotShellEntryContract` -> document service 的同一条输出，不能由 endpoint 或客户端自行重建。服务端在一次 render 开始时捕获权威 `generatedAtUtc`，并把同一 instant 作为 canonical UTC `options.renderTimestamp` 传入真实 Node/Vue renderer；bootstrap、hydration、navigation envelope 与 backfill artifact 不得各自读取时钟。缺失、空白、非法或非 canonical timestamp 必须在 SSR、seed 写入和日期格式化前 fail closed，不得回退到 `SYSTEM_CLOCK`、Unix epoch、`generatedAt` 别名或默认 locale。envelope、bootstrap 与 hydration 的 `renderLocale` / `localeCatalogDigest` 必须逐项一致，并分别等于当前 canonical request locale 与共享 catalog digest。`PublicSeoHeadModel` 的 digest 对除 digest 本身以外的字段按固定顺序做 UTF-8 byte-length-prefix 编码后计算 SHA-256；snapshot 的 `payloadHash` 覆盖 locale identity、两个 payload 与该 SEO digest。客户端在提交 route seed 前必须重新计算 hash、验证 page/locale/catalog/SEO identity，并先准备该精确 locale runtime/bundle。任一检查失败不得写入 route seed 或局部改写 head，而是退回同 URL 整页导航。

成功响应写入 `ETag`、`Cache-Control: no-cache`、canonical `Content-Language`、`Vary: Accept, Accept-Language, Cookie, X-Fsus-Test-Session`，并暴露 `X-Fsus-Public-Aot-Route-Key`、`X-Fsus-Public-Aot-Renderer-Version`、`X-Fsus-Public-Aot-Frontend-Asset-Version`。`If-None-Match` 命中返回 `304`。path 语法错误返回 `400`，不支持或不可公开的 route 返回 `404`，内容协商失败返回 `406`，renderer/provider/gate 失败返回 `503`；所有负响应固定 `Cache-Control: no-store`。

The URL hydration payload sidecar only allows resolution to static file paths within the web root. AOT cache reads persistent entries, document service writes sidecars, and Node SSR worker scripts must use canonical full path + relative path verification before starting to confirm that the target does not escape the respective root; out-of-bounds sidecars treat cache entries as invalid or skip writing, and out-of-bounds worker scripts directly fail closed without trying to execute.

`/api/public/navigation-snapshot` 的 `path` query 最大 512 字符，且必须是站内相对公开路径；超长、跨站 URL、反斜杠、CR/LF 或私有路径一律返回固定错误。

### `PublicAotShellEntryContract`

```text
{
  "pageId": 2,
  "routeKey": "article:42",
  "rendererVersion": "public-app-ssr@2026-05-01-1",
  "renderLocale": "ja-JP",
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
- `renderLocale`：共享 catalog 中的 canonical locale code；entry、bootstrap、hydration、visible shell marker、document lang/dir、SEO locale 和响应 `Content-Language` 必须一致

Public AOT HTML 的 representation identity 是 `(pageId, routeKey, renderLocale, invalidationVersion, frontendAssetVersion, rendererVersion)`。`renderLocale` 只能是 catalog 的十项 enabled code；原始 `Accept-Language`、cookie 原文、account/session/user identity 均不得进入公共 key。响应携带 `Content-Language` 与 `Vary: Accept-Language, Cookie`（压缩实体再包含 `Accept-Encoding`）。payload/HTML locale mismatch、未知 locale 或缺失目标 bundle 均 fail closed，不允许 hydration 使用浏览器语言修正。

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
  "routeKey": "tag:1",
  "title": "AcceptanceTag",
  "filter": {
    "filterType": "tag",
    "filterKey": "tag:1",
    "filterId": 1,
    "filterName": "AcceptanceTag",
    "description": "Acceptance tests for public taxonomy pages",
    "isInvalidTarget": false,
    "pageIndex": 1,
    "pageSize": 10,
    "total": 2,
    "articles": []
  }
}
```

Additional constraints:

- `filterKey` 是成功筛选页的稳定身份，只能是 `category:{id}` 或 `tag:{id}`。`tag-name:{name}` 仅供服务端解析历史 URL，解析成功后必须先 301，不能出现在 200 AOT payload。
- `filter.description` 是所选 Category/Tag 的可选说明。实体无描述时必须为 `null`。该字段来自 Filter identity 的同一轮数据库查找，不得为 Description 再发第二次查询。
- Public Filter SEO description 复用同一 `filter.description`：document service 先读 hydration、再回退 bootstrap；非空值经现有 160 字符摘要路径写入 meta/OG/Twitter/JSON-LD；缺失时保留现有分类/标签生成回退。不得新增 `SeoDescription` 或 `MetaDescription`。
- AOT shell HTML 与 hydration 的 Filter header 必须使用同一 `description` 值，并交给共享 Filter header contract。
- 无效分类/标签目标必须设置 `isInvalidTarget=true`，且 `articles` 必须为空。
- Clients must no longer infer title or filter semantics from path strings.

### `ArticleDetail` AOT payload shape

文章详情 hydration 只使用 `bodyContent` 承载原始 Markdown，不序列化或信任 SSR HTML。SSR/AOT 在同进程调用当前 FsusUI runtime 获得 opaque `MarkdownSafeRenderResult` 并直接交给 `initialRender`；客户端 hydrate 前必须从 `bodyContent` 重新调用当前 runtime 获得本进程授权结果。runtime 失败或返回非法结果时构建/hydration 明确失败，不生成本地 HTML fallback。`content` 和 `bodyHtml` 均不属于 AOT hydration 契约字段。`rights` 是 ArticleDetail hydration 与 `detailView.rights` 的必填字段，来自冻结 `article_rights_snapshot`；旧的无 rights hydration 合同已废弃，前端 normalizer 必须拒绝。

同一 payload 的 `publishedAt` 表示首次公开时间，`updatedAt` 表示正文最后实质修改时间。`detailView.header.meta.published` 必须来自 `publishedAt`（legacy 空值才回退 `createTime`）；只有 `updatedAt > publishedAt` 时才生成 `meta.modified` 和可见“更新于”。这两个值同时驱动文章 Microdata 与 document service 的 JSON-LD，不得由评论数、浏览量或 shell 生成时间替代。

```json
{
  "pageKind": "ArticleDetail",
  "routeKey": "article:42",
  "articleId": 42,
  "bodyContent": "# Heading",
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
  "href": "/tag/17"
}
```

Category links must also be provided directly by the page model and cannot be deduced by the component layer.

---

## PoW Contract

### `PowChallenge`（`GET /api/binary/auth/pow-challenge`）

```json
{
  "challenge": "hex-encoded-challenge-string",
  "difficulty": 16,
  "expiresAt": "2026-01-01T00:05:00Z"
}
```

- `difficulty`：bit 级前导零个数，客户端需找到使 `SHA256(salt + ":" + nonce + ":" + browserFp)` 有 `difficulty` 个前导零 bit 的 `nonce`
- The challenge token is stored in Redis, expires in 5 minutes, and is deleted immediately after use (anti-replay)

### PoW request header

Requests carrying PoW answers must include the following HTTP request header:

```http
X-Fsus-Pow-Challenge: <challenge 值>
X-Fsus-Pow-Answer: <nonce 值>
```

---

## 开放分发与作者工作台契约（2026-05-18）

### Feed / Sitemap / Robots

公开分发端点只暴露 `published` 且到达发布时间的文章；`draft`、`scheduled`、`archived`、`deleted` 不得出现在 feed、sitemap、related-reading、搜索索引或 PublicAOT 公开缓存中。


feed、sitemap 与 robots 响应使用 `Cache-Control: public, max-age=60, stale-while-revalidate=300` 并挂载 OutputCache ArticleList/Seo tag；端点不按正文手写 ETag，也不在请求线程解析 `If-None-Match`。RSS channel 的 copyright 来源于合规配置；`robots.txt` 明确禁止 `/api/`、`/user`、`/admin`、搜索索引二进制与 patch 目录，同时保留 `/api/public/`、`/feed/`、`/sitemap.xml` 与公开路由可抓取。

Feed article projection 固定最多 50 条；sitemap article projection 无 Feed 限制，且只选择 article identity、发布时间和 `article_body.updated_at`，不加载 Markdown。文章 `lastmod`、JSON Feed `date_modified`、Atom `updated` 和 AOT `dateModified` 使用同一实质正文更新时间；首次公开时间单独写入 `date_published`/Atom `published`/RSS `pubDate`。首页/归档、分类、标签分别使用其公开集合的最近实质变化；静态页只读取自身 `page_content.updated_at`；来源不存在时省略 `lastmod`。空站重复生成不得引入当前时间。sitemap 不输出 `priority`。

urlset 每页上限为 45,000，超过后根 `/sitemap.xml` 改为 sitemap index 并引用 `/sitemap/{page}.xml`。诊断的 URL/item 数直接解析最终 XML 产物；不能以另一条 COUNT 查询替代。`Seo:BaseUrl` 是配置侧权威 public origin，持久 SEO 值只允许相同 origin或项目占位值；AOT artifact、canonical、OG、JSON-LD、Feed、sitemap 与 robots 必须一致，生产启动检测到非占位冲突时以 `public_origin_conflict` fail closed。

公开评论读取、公开 taxonomy 与 `related-reading` AEDS 端点受 `public_read` 限流和风险感知过滤保护。风险分达到 50 时动态 API 要求 `X-Fsus-Pow-Proof`，达到 100 时返回 429；verified crawler 走独立高额度，social preview bot 不允许访问 `/api/**`。

### Crawler Range Ops

| Method | Path | Permissions | Description |
| ------ | ------ | ------ | ------ |
| GET | `/api/ops/crawler-ranges/status` | admin | 返回 Google/Bing CIDR 数量、最近同步时间、最近成功时间、来源和错误摘要 |

该状态来自 `CrawlerUpdateWorker` 的远程官方 JSON → last-known-good snapshot → 配置项 → empty degraded 加载链，只用于运维诊断，不返回客户端 IP、User-Agent 或用户数据。远程 CIDR URL 必须是 HTTPS，host 只允许 `developers.google.com` 或 `www.bing.com`，且不得使用非默认 HTTPS 端口；生产启动校验、`PUT /api/binary/admin/security/anti-crawler/options` 和 worker 同步前都会拒绝非法 URL，不做兼容回退。

### Site Subscription

订阅表单使用 AEDS，不保存明文 email；服务端只写入由 `Subscription:EmailHashPepper` 派生的 `HMAC-SHA256(normalizedEmail)` keyed lookup identifier、`hash_version` 与归一化 channel。该值仅用于本部署内去重/查找，不是明文 email，也不是跨环境或跨系统稳定身份标识；旧裸 `SHA256(normalizedEmail)` 只允许在迁移期作为一次性匹配来源并在下一次写入时升级到当前 HMAC。公开退订必须额外携带一次性 `X-Fsus-Subscription-Proof`，proof 由服务内部签发并可交给受控外部投递域发送，绑定 keyed email hash 与 channel；当前公开 API 不提供明文 email 查询或无 proof 退订入口。


`SiteSubscriptionRequest` payload 是 `SiteSubscriptionRequestPod`：fixed UTF-8 `Email(256)` + `Channel(32)`。`SiteSubscriptionResponse` payload 是 `SiteSubscriptionResponsePod`：`subscribed:byte`、`unsubscribed:byte`、reserved、fixed UTF-8 `Channel(32)`。非法 email 返回 HTTP 400 + `ApiError` frame，响应不得回显明文 email。退订 proof 不进入 AEDS payload，cache key 只使用 proof token hash，不包含原始 email；DELETE 先按绑定的 `email_hash` + `channel` 非消费校验 proof，只有 `site_subscription` 更新成功后才提交一次性消费，DB 失败或请求取消时 proof 保持可重试。

服务端在 normalization、lowercase、HMAC/SHA-256 前拒绝超过 254 字符的 email，避免匿名订阅接口对超大输入执行无意义分配或 hash。

`ArticleRelatedReading` frame payload 使用 `RelatedReadingHeaderPod` + `RelatedReadingItemPod[]` + UTF-8 blob 编码；业务视图为 `RelatedReadingResponse`：

| Field | Type | Description |
| ------ | ------ | ------ |
| `related` | `RelatedReadingItem[]` | 最多 6 条相关文章，按同分类、共同标签、全文关键词命中和发布时间接近度综合排序 |
| `previous` | `RelatedReadingItem \| null` | 按 `publishedAt ?? createTime` 定位的上一篇公开文章 |
| `next` | `RelatedReadingItem \| null` | 按 `publishedAt ?? createTime` 定位的下一篇公开文章 |

`RelatedReadingItem` 包含 `id`、`title`、`summary`、`createTime`、`reason`。公开 title、summary、category 与 tag 固定从 `article.current_publication_id -> article_publication.article_revision_id` 的不可变发布快照读取，不读取可变 authoring 行作为公开投影。`reason` 只允许来自公开内容关系，例如 `同分类`、`共同标签`、`全文关键词`、`发布时间接近`、`上一篇`、`下一篇`；不得使用点赞、收藏、关注、用户画像或登录态行为。文章详情页的 SPA 与 PublicAOT 均消费同一个 `relatedReading` 视图契约，避免首屏静态输出与 hydration 后页面结构漂移。

当目标文章不存在、未发布、已删除或尚未到达公开发布时间时，AEDS endpoint 返回 `AedsFrameType.ApiError`，语义错误码为 `ErrorCode.NotFound`，消息为 `article_not_found`。

### SEO Discovery

`PublicAotDocumentComposer` 为 AOT 公开页输出 canonical、页面相关的纯文本 description、OpenGraph、Twitter card 与 feed discovery。JSON-LD 使用单个 `@graph`：恰好一个站点级 `WebSite`、页面路径 `BreadcrumbList`，普通页为 `WebPage`，归档/分类/标签为 `CollectionPage`，文章为 `BlogPosting`；不得重复页面级 `WebSite`，也不得输出指向 noindex `/search` 的 `SearchAction`。文章封面经 `http/https`、绝对化和受支持图片格式校验后，必须在 `og:image`、`twitter:image`、`BlogPosting.image` 使用同一 URL；无合法封面时统一回退站点图片。结构化数据只表达页面真实可见内容，用于页面理解与展示资格，不是固定排名因子或富结果保证。`check:public-seo-smoke` 会对 home、article detail、archive、about、privacy、guidelines、copyright、category、tag 的 AOT 命中和 shell-only SPA fallback 做一致性校验。

社交图片的字节可读性、`image/*` Content-Type 与像素尺寸在上传/品牌配置写入和发布产物 smoke 边界验证；公开 AOT 请求只消费已验证 URL，不在每次 document compose 时执行外网探测。runtime smoke 必须实际 GET 最终 `og:image` 并取得 2xx 与 `image/*`，browser smoke 必须观察 `HTMLImageElement.complete` 且 `naturalWidth/naturalHeight > 0`，同时覆盖文章封面和站点回退图。

`GET/HEAD /search` 是 shell-only 搜索文档契约，固定响应 `X-Robots-Tag: noindex, follow` 和等效 HTML meta，不生成 Public AOT、canonical 或页面 JSON-LD。query 的唯一顺序为 `q`、非默认 `sort`、非默认 `page`；共享 `PublicSearchRoutePolicy` 固定 `q <= 128`、`page <= 100`、raw query `<= 2048`，前端生成 manifest 消费同一组边界。可规范输入 301 到唯一 URL，危险超长/控制字符输入返回 400 noindex；HEAD 与 GET 的状态及索引控制头一致。

### Article life cycle

Current article canonical payloads/hashes, rights canonical binding, pure rights input normalization, status transition policy and responsibility draft/validation have one source in `src/shared/Contracts/Articles/`, consumed by Core, Server and offline Migration. Writer normalization still rejects negative excerpt limits and trims bounded text; wire encoding retains its existing non-trimming and zero-clamping behavior. Responsibility persistence, actor admission and publication/content-filter services remain Server-owned. These pure contracts do not grant publication eligibility or fabricate missing rights/responsibility snapshots.

The current raw revision content-block address and stored revision/responsibility field encodings also have a single pure owner in `src/shared/Contracts/Articles/`. Production persistence retains the original null-to-empty Markdown input, UTF-8 byte length and uppercase SHA-256 block key, comma-separated sorted tag IDs without new filtering/deduplication, and Web JSON encoding for responsibility authors/reviewer/sources. These encoders do not change transaction ownership, global content-block sharing, snapshot validation or authoring admission.

`Article.Status` 的 exact set 由 [`design.md`](design.md) 的 generated section 拥有；
本文件只保留下方由同一 observation 生成的 allowed/forbidden transition projections。

`CreateArticleRequest` 与 `UpdateArticleRequest` 支持 `status`、`scheduledPublishAt`、`rights` 和独立 `resetRights`。rights 省略表示 `preserve`，完整 payload 表示 `replace`，`resetRights=true` 且 rights 省略表示 `reset`；reset 与 replacement payload 同时出现返回 `Validation/details=article_rights_reset_payload_conflict`，replace 缺少完整 payload 返回 `article_rights_payload_required`，未知 mutation 返回 `article_rights_mutation_invalid`。create 的 preserve/reset 使用仓库默认值；普通 update 的 preserve 保留当前有效策略；revision rollback 不接受 rights mutation，而是复制源 revision 的不可变 rights snapshot，缺失时返回 `Validation/details=article_revision_package_incomplete`；内容 import 没有 rights 时按 create preserve 绑定默认值。公开读路径必须检查 `IsDeleted=false`、`Status=Published` 和有效 `current_publication_id`，并沿 publication 绑定的 revision/rights/responsibility 读取。首次定时发布仍检查 `ScheduledPublishAt<=now`；已发布文章的未来更新记录在 `pending_publication_at`，不会提前替换当前 publication，worker 直接使用目标 revision 已绑定的 rights snapshot。

写入状态不得做 fallback：未知枚举返回 `Validation/details=article_status_undefined`；`Scheduled` 缺少时间返回 `article_scheduled_at_required`，时间不晚于服务端当前 UTC 返回 `article_scheduled_at_must_be_future`；非 `Scheduled` 附带时间返回 `article_scheduled_at_not_allowed`；普通写入目标为 `Deleted` 返回 `article_deleted_requires_delete_flow`；其它不在矩阵内的边返回 `article_status_transition_invalid`。完整矩阵与 restore/rollback/worker 限制见 [`article-publication-revisions.md`](article-publication-revisions.md)。

`CreateArticleRequest`、`UpdateArticleRequest`、revision rollback、内容导入和 `/api/binary/author/prepublish-check` 共用 `ArticlePublicationValidator`。标题、摘要、正文、封面 URL 上限依次为 256、512、200000、512 字符；超限必须拒绝，不得先截断再写入。`Scheduled` / `Published` 的标题、正文和分类为必填；`Draft` / `Archived` 可保存缺失内容，但危险 Markdown/HTML、内容过滤拒绝、超限以及任何已提供但不存在的 taxonomy 仍是 hard error。分类必须存在；标签 ID 必须全为正数、去重前最多 32 个且每个都存在。taxonomy 查询与文章 mutation 使用同一个 scoped 数据库连接并位于同一事务，数据库约束继续作为最终防线。

文章写校验失败统一返回 `Validation`，`details` 至少稳定区分 `title_invalid`、`summary_invalid`、`content_invalid`、`cover_url_invalid`、`category_not_found`、`tag_not_found`、`tag_limit_exceeded` 及上述状态码。`/api/binary/author/prepublish-check` 在相同条件下把这些分类放入 `issues[].code`，`canPublish=false`；warning override 不得令 error 可写。

Binary 写入帧 **ArticleWriteRequest V5**（`ArticleWriteRequest` 当前版本）使用旧 `ArticleWriteRequestPod` + `tagIds:int32[]` + article blob 作为主体，随后按顺序追加 `status:int32`、`scheduledPublishAtUnixMs:int64`、`version:int32=5`、`rightsMutation:int32`、`rightsFlags:int32`、`copyrightYear:int32`、`maxExcerptChars:int32`、`ArticleRightsWriteRequestPod`、rights blob、`baseRevisionId:int64`。create 使用 `0`；update 必须使用作者详情返回的正数 revision ID。`rightsMutation` 固定为 `0 preserve`、`1 replace`、`2 reset`；`rightsFlags` bit 定义为：`1 enabled`、`2 allowCodeCopy`、`4 showPublicBadge`、`8 proofBindingEnabled`、`16 hasCopyrightYear`。V4/V3 与更早 payload 仅保留 create 读取兼容，不能绕过 update 的 base revision 门禁。

`POST /api/binary/admin/article`、`PUT /api/binary/admin/article/{id}` 与 revision rollback 成功时使用 frame `MutationId(241)`，payload 为 48B `ArticleMutationResultPod`：`articleId:int32`、`revisionId:int64`、`revisionNo:int32`、`releaseId:int64`、`releaseNo:int32`、`status:int32`、`rightsSnapshotId:int64`、`rightsRevisionNo:int32`、`idempotencyReplay:uint8`、`errorCode:uint8`、`outcome:uint8`、`reserved:uint8`。`outcome=0` 表示 `applied`，`outcome=1` 表示 `no_change`；旧 payload 的保留位为零，因此按 `applied` 读取。成功时 `errorCode=0`；失败仍使用 `ApiError`，从而稳定区分 validation、revision conflict、invalid transition、not found 与 infrastructure failure。分类、标签等其它 mutation 继续返回 8B `MutationIdPod`，前端只为兼容缓存读取旧 16B/28B article response。

文章 create 必须携带 `X-Fsus-Client-Mutation-Id`，唯一合法形式是规范小写 UUID `D`。缺失/非法分别返回 `article_client_mutation_id_required` / `article_client_mutation_id_invalid`。数据库以 `(adminPrincipalId, clientMutationId)` 唯一约束，并在文章事务内保存请求 payload SHA-256 和完整 mutation 结果；同键同内容返回原结果且 `idempotencyReplay=true`，同键不同内容返回 HTTP 409 `article_mutation_content_conflict`。浏览器对同一未确认请求在超时、网络错误和响应丢失后复用原 mutation id，只有收到成功结果才清除。notification/outbox 消费以返回的 revision/release 坐标去重，不从“当前最新 revision”猜测。`Articles:MutationIdempotencyEnabled=false` 支持配置热重载并将 create fail closed 为 503；update/rollback/read/notification stream 不受影响。迁移是 additive；回退代码保留表与唯一约束，恢复前验证迁移。服务端必须返回事务内精确绑定坐标；坐标不可得时返回 `InfraFailure/details=article_mutation_coordinates_unavailable`。update 的 `baseRevisionId` 失配返回 HTTP 409 `ApiError(message=article_revision_conflict)`，details 为 `currentRevisionId/revisionNo/status/updatedAt`；该事务不得产生正文、标签、rights、publication 或 outbox 写入。

update 在 PostgreSQL 事务内锁定当前 article 坐标，并比较规范化后的 title、summary、cover、category、排序去重 tags、status、schedule、完整 Markdown 与最终 rights policy。全部相同则返回现有强类型坐标和 `outcome=no_change`，不写 article/body/tag/revision/rights/publication/outbox，也不触发 cache、AOT、search、notification stream 或 integrity side effect。只有 metadata 或版权策略变化仍创建可直接重建的完整 revision package，但复用原 `content_block_id`；Markdown 改变时才按 SHA-256 内容寻址创建新块。

`article_revision_content_block` 保存不可变完整 Markdown、SHA-256、UTF-8 byte length 与创建时间；`article_revision` 保存完整 metadata 与 `content_block_id`，因此每个 revision 可通过一次 join 直接重建，不依赖 diff 链。Expand migration 按正文去重回填旧 revision，验证所有引用可达后清空旧内联正文；运行时可达性检查必须报告 missing/orphan 数量，孤块清理只删除早于安全 cutoff 且没有任何 revision 引用的块。发生风险时无需重启服务：在网关暂停 admin article write 与 rollback，继续提供匿名读、登录读、admin 读、notification stream 和 binary read；停止孤块清理，核验可达性并恢复写流量。不得回退为继续写内联正文或长差异链。

Binary 读取帧 **ArticleDetail AEDS V5** 使用 `magic=ARD5`、`version=5` + 116B `ArticleDetailV5RecordPod` + `ArticleDetailTagV3RecordPod[]` + 必备 `ArticleRightsV3RecordPod` + 共享 blob；V4 `ARD4`/92B 与 V3 `ARD3`/84B record 仅保留只读兼容。后端 public artifact、admin detail 和 server cache 都必须从 publication 固定的 revision 与 `article_rights_snapshot` 投影字段；retired ArticleDetail tail 必须拒绝，不得新增独立 `/rights.aeds` fallback。

Public Rights V3 presentation 只读取已解码的 `ArticleDetail.rights` / `detailView.rights`，does not request a separate rights endpoint，也不新增 `/rights`、`rights.aeds` 或其它 side channel。公开文章页和 PublicAOT ArticleDetail 由同一个 `PublicArticleDetailPageContent` 渲染可见版权提示与 metadata，PublicAOT ArticleDetail output includes rights metadata：`license`、`copyrightHolder`、`copyrightYear`、rights snapshot id、policy hash、content canonical hash、copy policy。代码块复制增强必须读取 `allowCodeCopy`；当 decoded rights 关闭代码复制时，运行时不得插入复制按钮，并清理已经注入的 code-copy DOM。

`GET /api/binary/admin/article` 的 `status` 查询参数仅 admin 可用。公开 `/api/binary/article/**.aeds` 不接受 query string、请求体或 credentials；admin 不带 `status` 时读取所有非删除状态，带 `status=0/1/2/3/4` 时读取对应 draft/scheduled/published/archived/deleted 集合。admin article list 的 `page` / `size` 缺省为 `1` / `10`，显式传入 `page<1`、`size<1` 或 `size>100` 返回 `400`。

文章更新请求不得把 `status` 设为 `Deleted`；删除必须走专用 delete endpoint，以便写入回收站状态、失效缓存、搜索、PublicAOT、notification stream 和 outbox。对已删除文章重复删除必须是 no-op，不得重复触发派生副作用。restore 只允许从 `IsDeleted=true` 恢复；恢复动作通过统一 publication transition 基于当前修订创建新的不可变发布记录并原子切换，不能直接复用删除前的 projection 或从“最新修订”猜测公开内容。`DELETE /api/binary/admin/article/trash` 是批量破坏性操作，要求 admin principal、`article.write`、`fixed_ip`、PoW 和一次性 `X-Fsus-Mfa-Proof`，缺失或复用 proof 返回 `428`，不可信 `Origin` / `Referer` 返回 `403`，并写入包含销毁数量与 outcome 的高价值审计。

delete、restore、permanent-delete 必须先读取 article `xmin`，写入时带 `xmin::text = @RowVersion` 和对应 trash 状态条件。permanent-delete 只允许处理 `IsDeleted=true` 的文章，并在事务内先 `FOR UPDATE` 锁定同一 row-version，再删除评论、标签、正文和文章主行；若 row-version 或 trash 状态已变化，返回 no-op，不得删除子表或发出新 outbox 事件。clear-trash 只能批量处理仍处于 `IsDeleted=true` 的文章，并按实际销毁数量返回 `TrashClearResponse`。

Public and management end article response matrix:

| Path Family | Identity | State Scope | Failure Semantics |
| -------- | ------ | ---------- | ---------- |
| `/api/binary/article/**.aeds` | 仅无身份匿名公开，客户端 `credentials: omit`；存在 principal/credential/CSRF header 时强制常规管线 | 仅 `Published` 且发布时间已到、`IsDeleted=false`；帧内管理尾字段只允许公开安全值；snapshot evidence 与 source version/cutoff 必须匹配 | L0 miss/not-ready/协议错误只返回 HTTP 状态；前端按 `404`/`503`/`400`/`406` 分别处理 |
| `/api/binary/admin/article/**` | admin | draft/scheduled/published/archived/deleted 按 `status` 查询参数精确读取 | AEDS `ApiError` frame，错误码与 JSON 语义保持一致 |

旧公开 query 路径（如 `/api/binary/article?page=1`、`/api/binary/article/hot?size=10`）不再 fallback；fast path 返回 `400 no-store`，并通过 `X-Fsus-Required-Route` 提示新的 segment artifact 路径。

### Author recent article history authority (#2230)

作者最近文章历史的唯一权威是服务端 `AuthorRecentArticleHistoryApplicationFacade` 与 PostgreSQL
`author_recent_history_*` 表。每个事实按 `(ownerAdminPrincipalId, siteScope, articleId)` 归属，`articleId`
必须是现存服务端 `Article.Id`，并绑定调用时的 `Article.CurrentRevisionId`；route、slug、title、local tab、
`Article.UpdatedAt`、浏览器 history 和客户端缓存都不是身份或排序来源。closed schema version 为 `1`，每条 entry
保存 `lastOpenedAtUtc`、`lastEditedAtUtc`、`lastActivatedAtUtc`、`serverRevision`、`lastCommand`、entry revision
和内容 digest，投影只按这三个服务端事实时间再以 `articleId` 降序稳定排序。

`Open`、`Edit`、`Activate` 通过同一 application/domain port 写入；请求必须携带正数 server revision、唯一
UUID request id、预期 history collection revision 和 content digest。事务取得 owner/site advisory lock，先做
`Article.CurrentRevisionId` 与权限校验，再做 collection CAS；同一 request 的相同命令返回原 receipt，payload 不同
返回 idempotency conflict，过期 CAS 返回 revision conflict。每次提交原子写入 history entry、collection revision、
receipt、idempotency row、outbox 和 audit row；任一 durable side effect 缺失或 digest 不一致，verifier 只能返回
`Invalid`，不可生成已验证投影。

读取使用真实服务端 empty projection；没有 entry 时不回退到 `updatedAt`、浏览器 history、route 扫描或本地存储。
projection provider 在 permission、account/site scope、article deletion 或 archive 状态变化后过滤并失效；被拒绝的
article 不泄露 title、slug、status、existence 或其它 metadata。cursor 由 ASP.NET Core Data Protection 认证保护，
并绑定 owner、site、permission/session revision、collection revision 和最新 server fact，执行 bounded keyset
pagination；offline 本地读取不写 authority，reconnect 只能重放正式 command 并接受服务端 receipt/CAS 结果。receipt
同时封存 open/edit/activate 三类服务端事实时间，replay 与 independent verifier 都会重读并精确核对 idempotency、
outbox、audit、permission 和 projection digest；缺失、字段漂移或重封后的 command drift 均 fail closed。此 issue
只提供服务端 authority、commands、projection、receipt 与 verifier，不提供 client、UI 或 search 行为。返回当前
projection 前必须通过 direct server read-model cache publication 校验；该边界不保存第二份 history authority，
publication 拒绝、异常或 digest/page slice 不一致时返回空的 `Unavailable` 投影，不暴露部分缓存结果。
实际读取与 independent verifier 共用同一快照绑定检查：验证结果必须为有效，且 revision、item count、content digest
与本次读取快照逐项一致。另一快照的有效结果不能证明本次读取；不匹配时返回空的 `Unavailable`，不发布缓存投影。
caller-facing verifier 只有在当前权限快照有效且所有 history entry 均可投影时才返回 collection revision、总计数
与完整 authority digest；任一 entry 被拒绝时返回通用拒绝理由，所有 verifier 事实清空，空集合的有效校验不受影响。
terminal projection 仅在同一当前权限快照有效且全部 entry 可投影时保留授权 metadata；否则保留原 status/reason，
但使用 canonical empty projection，不返回 collection facts 或无权摘要。正常读取仍按服务端权限过滤可见 entry。

### Admin Author Workbench

生产前端使用 `/api/binary/author/**`，外层为 AEDS v2 frame。写入请求使用 route-specific request frame（如 `AuthorDraftSaveRequest`、`ModerationRuntimeGlobalStateRequest`、`ContentImportRequest`），响应使用 route-specific response frame（如 `AuthorDraftResponse`、`ModerationRuntimeStatus`、`AuditLogList`）；payload 当前承载类型化 JSON DTO bytes，浏览器不可访问 `JsonApiResponse<T>` envelope，错误统一为 `ApiError` frame。授权、MFA、fixed_ip rate limit、审计和缓存失效边界均由原生 authoring binary endpoint 直接执行；外部 `/api/author/**` JSON endpoint 已移除，且不保留 internal bridge 兼容层：

Authoring binary 写入请求 body 最大 1 MiB。`ServerDraftSaveRequest` 字段上限为：`DraftKey` 96、`Title` 256、`Content` 200000、`Summary` 512、`CoverImageUrl` 512、`ClientRevision` 128、`WarningOverrideReason` 500；编辑草稿同时保存 nullable `baseRevisionId`，恢复时原样返回。超限请求在 Markdown、内容过滤、快照构建或持久化前按 validation fail closed，并与正式文章写入字段上限保持一致。

Admin Rights V3 editor panel 是文章编辑器内的 `rights` 写入面板，字段与 `ArticleWriteRequest.rights` 一一对应：`enabled`、`licenseType`、`copyrightHolder`、`copyrightYear`、`rightsStatement`、`attributionTemplate`、`copyPolicy`、`maxExcerptChars`、`allowCodeCopy`、`showPublicBadge`、`proofBindingEnabled`。新文章默认选择“继承站点设置”，管理端会读取站点合规版权配置生成当前生效的文章版权值，并在提交时写入完整 `ArticleWriteRequest.rights` replacement；这不是发布后继续动态跟随站点配置。用户切换为“自定义本文版权”后才允许修改单篇文章字段；编辑既有文章时从冻结 `ArticleDetail.rights` 载入当前策略并进入自定义模式。metadata-only 或旧客户端请求可以省略 rights，以 V5 preserve 语义保持当前策略；显式恢复仓库默认策略只能发送独立 reset flag，不得伪造一份默认 replacement。浏览器短期恢复 journal 只保存未得到服务端精确确认的正文与 identity/article/tab/revision/hash 坐标，不保存或替代完整表单、`rights`、服务端草稿或文章 revision；恢复只替换正文，当前完整 `rights` 和初始化时的 `baseRevisionId` 继续由当前表单构造 `ServerDraftSaveRequest`、私有预览、发布前检查和最终提交。journal 为 168 小时 TTL、容量上限的 IndexedDB 明文 UTF-8 恢复面，未加密且不得回退 localStorage；服务端草稿仍是长期和跨设备权威；退休的 localStorage metadata key 只做一次性删除，不能被解码为恢复候选。客户端会提前校验 enum values、`copyrightYear`、`maxExcerptChars` 和必填文本字段，但 server-side validation remains authoritative，服务端仍按 Article write path 拒绝非法 mutation 或不完整 replacement。

Revision detail 的 JSON DTO 固定把内容修订与历史绑定放在同一响应：基础 metadata 包含 `id/articleId/revisionNo/title/content/summary/coverImageUrl/categoryId/tagIds/diffSummary/createdByAdminPrincipalId/createdAt/rollbackSourceRevisionId/rollbackReason`；`rights` 是该 revision 的完整不可变 Rights V3 snapshot；`responsibility` 是该 revision 的责任作者、reviewer、sources、更新说明与方法/适用范围/局限 snapshot；`release` 是关联的最新 `id/publicationNo/transitionKind/publishedAt`。`packageComplete` 仅在 rights 与 responsibility 都存在且可复制时为 true。历史包缺失时读取仍返回现有部分供排障和比较，但回滚必须 fail closed，不能从当前文章策略、站点默认值或空责任人构造替代 snapshot。

Rollback request frame `ArticleRevisionRollbackRequest(213)` 的 payload 是 AEDS JSON：`{baseRevisionId:int64,targetStatus:int32,reason:string}`。`baseRevisionId` 必须是正数；`targetStatus` 只能显式为 `0 Draft`、`2 Published` 或 `3 Archived`，不能省略、默认成 Published 或使用 Scheduled；trim 后的 `reason` 长度为 8..500。响应使用 `MutationId(241)` 的 48B `ArticleMutationResultPod`，与 create/update 共用同一强类型结果；目标 revision 不存在时返回 `NotFound/revision_not_found`，不再以 nullable success 表示。请求不再接受 `X-Fsus-Base-Revision-Id` 或 `X-Fsus-Article-Revision-Force` 绕过；MFA proof header 与 admin `article.write` 授权保持不变。

服务端在同一 PostgreSQL 事务中执行 base revision CAS、复制源 revision 的正文/分类/标签、复制源 rights 与 responsibility 到新 snapshot 绑定、创建新 revision/release，并写只引用新坐标的 mutation outbox。新 revision 持久化 `rollback_source_revision_id`、执行 admin principal 与 `rollback_reason`；源 revision/publication 永不更新或重新启用。base 冲突返回 `409 article_revision_conflict`，缺少完整历史绑定返回 `Validation/details=article_revision_package_incomplete`，非法目标与原因分别返回 `article_rollback_status_invalid`、`article_rollback_reason_invalid`；所有失败分支均不得留下 revision、snapshot、release、公开 artifact 或 outbox。Draft/Archived release 是不可变非公开坐标，只有 Published rollback 进入公开读取；AOT/search/feed/binary cache 与 notification stream 只消费新 outbox 坐标。


草稿 `draft_conflict` 使用 HTTP 409 `ApiError(251)`；`details` 是有界 JSON `{currentServerRevision,currentUpdatedAt,titleSummary}`，不包含正文、摘要、封面、分类标签、rights、article revision 或任何身份材料。双标签页、乱序自动保存和 stale discard 都走同一失败面；客户端不得自动重放冲突 mutation。普通网络失败可用原 `clientRevision + expectedServerRevision` 重试，服务端用内容一致性识别已成功但响应丢失的幂等重试。
| POST | `/api/binary/author/articles/{articleId}/assets/reindex` | 从正文和封面重建资产引用 |
| GET | `/api/binary/author/assets` | 资产库列表 |
| DELETE | `/api/binary/author/assets/orphans` | 删除引用计数为 0 的孤儿资产库记录 |
| GET | `/api/binary/author/taxonomy/categories` | 管理端分类真实引用计数和删除锁定状态 |
| GET | `/api/binary/author/taxonomy/tags` | 管理端标签真实引用计数和删除锁定状态 |
| GET | `/api/binary/author/analytics` | 单作者公开内容与真实阅读事件概览 |
| GET | `/api/binary/author/comments/moderation?status={0..3}&limit={1..100}&cursor={opaque}` | 评论审核队列；默认读取待审、边界风险、未处理举报和待决申诉，按申诉、风险、等待时间、ID 稳定 keyset 排序；要求 `comment.moderate` |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim` | 创建 15 秒至 15 分钟的审核 lease，并返回只出现一次的 claim token；要求 `comment.moderate` |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim/renew` | 携带 token、generation、claim row version 续租；过期或并发变更返回 409 |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim/release` | 携带 token、generation、claim row version 释放；过期或并发变更返回 409 |
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
| POST | `/api/binary/author/articles/import` | Markdown + frontmatter 导入；未提供 rights 时按 create preserve 绑定默认策略；必须携带 `X-Fsus-Mfa-Proof` |
| GET | `/api/binary/author/audit` | 结构化审计日志列表，支持 actor/action/target/outcome/severity/time 过滤；默认 `piiMode=pii-redacted`，完整 `IpHash`/`UserAgentHash`/`SessionIdHash`/`DeviceFingerprintHash` 仅限具备 `audit.investigate` 且显式传 `piiMode=investigation` 的 admin，并写高价值审计 |
| GET | `/api/binary/author/audit/summary` | 当前过滤条件下的审计 facet 与写入 runtime |
| GET | `/api/binary/author/audit/{id}` | 审计详情、context JSON 与防篡改校验结果；敏感 hash 字段与列表相同，默认 redacted，investigation 读取要求 `audit.investigate` |
| GET | `/api/binary/author/audit/{id}/verify` | 单条审计 `record_hash` / `record_mac` 与同链 `prev_hash` 前驱校验 |
| GET | `/api/binary/author/ops/health` | 运维健康面板数据：PostgreSQL、Redis、audit、Crawler CIDR、备份、PublicHotRead、search、worker、队列和结构化最近错误 |
| GET | `/api/ops/health/ready-detail` | 受保护详细 readiness JSON：配置、PostgreSQL、Redis、资源、runtime、observability、RiskControl/perception-sealed@v2 gate；要求 admin principal `audit.read` |
| GET | `/api/ops/deployment/status` | 受保护发布状态 JSON；要求 admin principal `system.config`、fixed-IP limit 与 loopback source |
| POST | `/api/ops/deployment/activate` | 受保护激活 CAS；body 为 `releaseId/slot/generation`，仅 Ready Candidate 接受；正确重复请求幂等 |
| POST | `/api/ops/deployment/drain` | 受保护排空 CAS；body 为 `releaseId/slot/generation/timeoutSeconds?`，超时仅限 5..300 秒；正确重复请求幂等 |
| GET/POST | `/api/ops/deployment/fence/status`、`/api/ops/deployment/fence/acquire`、`/api/ops/deployment/fence/revoke`、`/api/ops/deployment/fence/challenge-kind-cutover`、`/api/ops/deployment/fence/perception-character-v3-cutover` | 受保护 active-release fence 查询/CAS/撤销、challenge-kind 状态切换与 V3 单次切换；要求 admin principal `system.config`、fixed-IP limit 与 loopback source。通用 cutover request 绑定 release/slot/generation、完整数值集合 3/10/13、权威 target fingerprint 与 operation id。V3 request 另外绑定 canonical contract digest、active pool generation/manifest digest、backend/shared/frontend AEDS schema fingerprint 与当前 RiskControl policy version；服务端验证 target 后关闭 V3 issuance，幂等撤销 V3 DB/Redis/envelope/旧 pool generation 状态，复验 fence，持久化无敏感字段的 hashed receipt，通过 activation smoke 后才写 release/slot/generation marker。重试读取同一 durable mutation/receipt，不二次计数、不租用 pool entry。V3 issue/verify 在 marker 缺失、cache failure、pool/policy/schema 漂移或 fence 复验失败时统一 fail closed |
| GET/POST | `/api/ops/deployment/notification-stream/restart/status`、`/api/ops/deployment/notification-stream/restart` | 受保护 notification stream 1012 restart 协议；请求必须绑定精确 release/slot/generation |
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

### Admin Security System

生产前端使用 `/api/binary/admin/security/**`，外层为 AEDS v2 frame。写入请求使用 route-specific request frame（如 `AntiCrawlerOptionsUpdateRequest`、`SecurityRiskResetRequest`、`AntiCrawlerRuleRequest`、`PowOptionsUpdateRequest`），控制面 dry-run 可使用 `SecurityOverview` JSON frame 承载 route-specific request/response DTO；响应使用 route-specific response frame（如 `SecurityOverview`、`AntiCrawlerPolicySnapshot`、`SecurityRiskEventList`、`PowPolicySnapshot`）；payload 当前承载类型化 JSON DTO bytes，浏览器不可访问 `JsonApiResponse<T>` envelope，错误统一为 `ApiError` frame。admin principal + `system.config` permission、MFA、fixed_ip rate limit、device fingerprint、审计和运行时策略更新边界均由原生 security binary endpoint 直接执行；外部 `/api/admin/security/**` JSON endpoint 已移除，且不保留 internal bridge 兼容层。

`/api/binary/admin/security/**` 全部要求 admin principal + `system.config` 权限。写入型和高价值操作必须携带 admin passkey step-up 产生的 action=`admin-sensitive` 一次性 `X-Fsus-Mfa-Proof`，并写入高价值安全审计。`X-Fsus-Mfa-Proof` 与 PoW replay proof 共用 consume-once cache primitive：L1 先失效，Redis 删除成功后同一进程内也不能再次读取该 proof。安全控制面 actor 只允许从 independent admin principal claims 解析，wire/内部归因格式为 `admin:{admin_id}`；缺失 `identity_kind=admin_principal` 或 `admin_id` 时拒绝请求，不得使用普通账号 `NameIdentifier`、legacy user id 或 `sys_user.role=admin` 作为 fallback。

Security system IA and API boundaries:

- `GET /api/binary/admin/security/overview` 返回 `SecurityOverviewResponse(status, checkedAtUtc, antiCrawler, pow, risk)`。
- `GET /api/binary/admin/security/risk-control/overview` 返回 `RiskControlConsoleResponse(activePolicy, risk, riskEventAggregate, challengeMetrics, recentEvents, topRiskSnapshots)`；`activePolicy` 为 `SecurityRiskPolicySnapshotV2`，`riskEventAggregate` 按 `source/reason` 聚合最近风险事件，`challengeMetrics` 复用最近 24 小时 challenge attempt 成功 / 失败率。
- `GET|PUT /api/binary/admin/security/risk-control/options` 读取或热更新 `SecurityRiskPolicySnapshotV2`。PUT 可更新 global mode、PoSpace、public-read、comment、auth、strict multiplier 与 reason，要求 `X-Fsus-Mfa-Proof`，写入 `security_policy_snapshot(policy_id=risk-control)` 和高价值审计。`globalMode` 只接受 `disabled | observe | enforce | strict | lockdown`；关闭某 action enforcement 会投影到对应 RiskControl override。
- `POST /api/binary/admin/security/risk-control/options/rollback` 回滚上一份 RiskControl last-known-good policy；优先从 `security_policy_snapshot` 读取 LKG，失败时回退内存上一版本，并写高价值审计。
- `POST /api/binary/admin/security/risk-control/simulate` 使用 `SecurityOverview` request/response frame 承载 `RiskControlSimulationRequest(action?, routeKey?, subject?, riskScore?, clientIp?, userAgent?, deviceFingerprint?, region?, actorStatus?, identityKind?, verifiedCrawler?, socialPreviewBot?)`，返回 `RiskControlSimulationResponse(riskScore, effectiveRiskScore, decision, decisionKind, reasons, requiredChallenges, policyVersion, action, routeKey, subject, clientIp, actorStatus, identityKind, escalationLevel, simulated)`。该端点调用生产 `RiskDecisionService` 与当前 `SecurityRiskPolicySnapshotV2`，不签发 `security_challenge`，不修改策略或风险分；每次调用写入 admin security audit。
- `GET /api/binary/admin/security/challenges/overview?kind={kind}` 返回 `SecurityChallengeMetricsResponse(kind, windowStartedAtUtc, totalIssued, totalAttempts, verified, failed, replayed, expired, revoked, successRate, failureRate, kindBreakdown, recentAttempts)`；`kind` 只接受当前 provider wire kind，不传则返回全部 challenge。
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

统一风险抽象为 `SecurityRisk`：`ISecurityRiskSignalSink` 写入当前稳定来源事件，`ISecurityRiskScoreReader` 读取和重置主体风险分，`ISecurityRiskPolicyProvider` 提供策略快照。生产事件同时落到 PostgreSQL `security_risk_event` 并按不可逆 binding 聚合；持久化失败只写 structured fallback log，不改变原业务判定。

`AiAssistResponse` 返回 `providerEnabled`、`providerMode`、`externalProviderAllowed`、`auditEvent`、`suggestedSummary`、`suggestedTags`、`titleCandidates`、`translationDraft`、`structureIssues`。前端编辑器只能在 admin 作者工作台内调用该接口；调用结果可用于使用摘要草稿、匹配已有标签、使用标题备选、使用翻译草稿或查看结构检查。外部 provider 必须同时满足 `Authoring:AiAssist:Enabled=true`、非 `local` provider、`AllowExternalProvider=true`、`ExternalProviderReviewed=true`，否则 `externalProviderAllowed=false` 且服务端只返回本地建议。

`ArticlePreviewResponse` 只用于作者工作台内嵌预览，字段固定为 `normalizedTitle`、`normalizedSummary`、`normalizedCoverImageUrl`、`normalizedMarkdownSource`、`plainText`、`sourceIdentity`、`issues`，不包含 HTML。标题使用 256 字符 authoring 归一化；Markdown 使用 200000 字符边界并把 CRLF/CR 规范为 LF；摘要使用 180 字符 `ArticleSummaryProjection`；封面只接受无 userinfo 的 `http/https` absolute URL 或非 protocol-relative 的单斜杠站内路径。`sourceIdentity` 为 `preview:sha256:<lowercase hex>`：SHA-256 输入先写 UTF-8 域 `fsusblog.article-preview.v1\0`，再按 raw title/content/summary/cover 顺序写每字段的 ASCII 十进制 UTF-8 byte length、`:`、原始 UTF-8 bytes、`\0`，null 按空字符串。前端必须在请求前从精确 snapshot 计算 expected identity，并同时核对响应 identity、最新 generation 与当前四字段 snapshot；旧响应或 identity mismatch 必须 fail closed。解码若发现 `html`/`srcdoc`/`trustedHtml` 字段必须协议失败，不得读取或回退。标题、摘要和 issues 只用 Vue 文本插值，封面只绑定服务端规范化 URL（`javascript:`、`data:text/html`、协议相对 URL 和 userinfo URL 不得渲染），正文只交给 FsusUI `MarkdownRenderer`；不得恢复 iframe/srcdoc、本地 sanitizer 或服务端 HTML renderer。该响应不得被缓存为公开 AOT、不得进入 feed/sitemap/search/related-reading，也不得被匿名接口返回。

编辑器侧栏必须基于当前表单和 `SeoConfigContract.baseUrl` 实时给出搜索/分享预览：标题、description、canonical URL、OG image 与当前公开路由 slug。提交 `Published` 或 `Scheduled` 前必须调用 `/api/binary/author/prepublish-check`；`severity=error` 阻断提交，`severity=warning` 必须在确认发布弹窗中要求作者填写 `warningOverrideReason` 后才能跳过，服务端写入 `prepublish-warning-override` 审计事件。检查项覆盖标题/摘要/封面、危险 HTML 标签和事件属性、Markdown 未闭合代码块、超大/密集 Markdown 结构、正文图片 alt text、空链接、不安全协议、私有站内路径以及 `/article|category|tag/{id}` 格式错误。当前真实公开文章路由仍以 `/article/{id}` 为准，新文章在落库前只显示 draft-preview slug，不新增持久化 slug 字段。

`AssetLibraryItemResponse` 暴露 `id`、`url`、`altText`、`sourceArticleId`、`referenceCount`、`sha256`、`updatedAt`；其中 `id` 是 canonical UUID `AssetId`，`url` 只是 `PublicAssetUrlCodec` 从 `storage_key` 生成的展示边界。资产列表只聚合 `content_asset` 与 `content_asset_reference`，不扫描 Markdown、不运行 DDL，也不维护第二份引用计数。`DELETE /api/binary/author/assets/orphans` 将零引用资产标记为 `pending_delete` 并放入 24 小时延迟清理队列；宽限期恢复引用会取消清理。`DELETE /api/binary/file/delete` 的 AEDS string payload 必须是 `AssetId`；被 article、draft 或 revision 引用时返回 conflict，endpoint 不接受 URL/路径且不构造物理路径。

`AuditLogListResponse` 返回 `items`、`total`、`page`、`pageSize`、`nextCursor` 和 `runtime`。列表查询参数包括 `source`、`type`、`actor`、`action`、`targetType`、`targetId`、`outcome`、`severity`、`fromUtc`、`toUtc`、`cursor`；`actor` 会匹配 actor id/type/role，target 可按 type 和 id 分别过滤。`page/pageSize/total` 保留给旧 UI 兼容和显示估算，真实翻页使用 `occurredAtUtc + id` keyset cursor：首屏不传 `cursor`，下一页传上次响应的 `nextCursor`，服务端按 `occurred_at_utc DESC, id DESC` 查询。`/audit/summary` 对归一化过滤条件使用短 TTL cache，避免每次刷新都重新执行 total/source/action/outcome/severity 多路聚合。`AuditLogItemResponse` 暴露 `source/type/action/outcome/severity/isHighValue`、`actorType/actorId/actorRole`、`targetType/targetId`、`reasonCode`、`eventInfo`、trace/path/method、`ipHash/userAgentHash/sessionIdHash/deviceFingerprintHash` 和 `chainId/prevHash/recordHash/recordMac`。`AuditLogDetailResponse` 额外返回 `contextJson` 与 `tamperEvidenceValid`；`AuditTamperVerifyResponse` 校验当前记录 hash/mac，并按 `chainId` 查询前一条记录，要求当前 `prevHash` 等于前驱 `recordHash`，首条记录则要求不存在前驱。所有审计查询端点位于 admin-only `/api/binary/author/audit/**`，并会写入 `admin.audit.queried` 审计事件。

`OpsHealthResponse` 的 `releaseIdentity` 为 `OpsReleaseIdentityResponse(releaseId, commitSha, releaseSlot)`；三者直接来自 `IReleaseIdentityProvider` 的同一快照，不再返回含义模糊的 `version` / `commit` 字段，也不得从 `GITHUB_SHA`、`FSUSBLOG_COMMIT` 或 assembly version 推断。该响应仅限 admin 运维端点，允许返回完整 commit SHA；`/user/manage/ops` 默认显示 12 位 SHA，并以 title/copy 等受保护交互保留完整值。本地开发返回明确的 `local-unversioned` / `local` 非发布身份，前端显示“本地开发（未发布）”，不得伪造成生产 ReleaseId。公网 `/health/ready` body 与公共响应头边界不变：只公开既有最小 readiness 字段和 `X-Fsus-Release-Id` / `X-Fsus-Release-Slot`，不新增完整 commit、image ref 或 digest。

`OpsHealthResponse` 的 `services` 至少包含 `postgres`、`redis`、`audit`、`crawler-cidr`、`backup`、`public-hot-read`、`search-index`、`dependency-graph`；`dependency-graph` 的 detail 只汇总 registration/singleton/scoped/transient/hosted/opaque/captive 计数，不返回类型名或依赖路径。`workers` 包含 `scheduled-publish` 和启动任务快照；`queueBacklog` 包含 `articleMutationPending`、`articleMutationFailed`、`auditQueued`、`auditDropped`；`backup` 内嵌 `BackupStatusResponse`，用于 `/user/manage/ops` 的后台状态展示。`recentErrors` 返回 `RecentOpsErrorResponse[]`，每项包含 `occurredAt`、`severity`、`action`、`message`、`detail` 和 `count`；服务端只查询审计行的原始字段，物化后清理 `CAST(...)` 等 SQL 投影残片、提取短摘要、保留可展开详情，并按 `action + normalized message` 合并重复错误。`BackupStatusResponse` 只暴露 artifact 路径、mtime、size 和状态，不返回 secret 内容。

`CacheDiagnosticsResponse` 返回 `aot`、`search`、`distribution`、`commentCache`、`hotStatsInvalidation`、`outputCache`、`articlePolicies`、`publicHotReadCounters` 和可选 `article`。`aot` 来自 `PublicHotReadStore` 和 `PublicAotInvalidationTracker`；`search` 读取 `/search/index.manifest.aeds` 的 schema/version/shard count；`distribution` 通过实际生成 sitemap/rss 统计 URL/item 数；`commentCache` 来自 `CacheInvalidationRuntimeState`。`hotStatsInvalidation` 来自 `IHotStatsInvalidationCoalescer`，暴露当前 HotArticles version、dirty/flush 次数、coalesced dirty 数、pending 状态和最近 dirty/flush reason，用于 VisitLog 驱动失效压力 evidence。`articlePolicies` 按 Article cache policy 返回 `policyId/policy/owner/consumers/writes/invalidation/retention/keyCount/bytes/hitCount/missCount`，用于定位 DTO/Core/AEDS frame 缓存 ownership、当前 Redis registry key 数和可读运行时命中/未命中计数。`publicHotReadCounters` 的 article/list/html hit 与 `fsus.hotread.*.hit` 在 `CounterMode=Sampled` 下为加权命中（`observedHitSamples * CounterSampleRate`），miss/rejected/sanityFallback 保持全量；`hitRate` 收据给出唯一容量公式 `calibrated-hits / (calibrated-hits + exact-misses)`，与 L1 striped hit 计数同一公式，禁止用未加权 sample 去除以全量 miss。`POST /api/binary/author/cache/actions` 会写入 `admin.cache.action_executed` 高价值审计。

`IntegrityReportResponse` 返回 `checks`，每项包含 `code/title/status/severity/count/autoFixAvailable/detail/sampleKeys/previewDiffs`。巡检覆盖 `article_missing_body`、`article_body_without_revision`、`article_missing_category`、`article_tag_missing_tag`、`article_tag_missing_article`、`comment_missing_article`、`comment_chain_invalid`、`session_deleted_user`、`upload_untracked`、`asset_missing_file`、`sitemap_visibility`、`search_visibility`、`taxonomy_count_runtime`。`IntegrityFixPreviewResponse` 和 `IntegrityFixResponse` 使用 `AdminDiffResponse(field,before,after)` 表示变更摘要；实际修复端点只应用 safe fixes，并写入 `admin.integrity.safe_fix_applied` 高价值审计。

`AuthorAnalyticsResponse` 聚合单作者运营数据：文章状态计数、`totalHumanReadEvents`、`totalSearchableArticles`、`aotHitRate`、`averageDwellMs`、`readingCompletionRate`，以及 `topSearchKeywords`、`topSourceRoutes`、`notFoundHotspots`、`rumMetrics`、`rumPageTypes`、`rumAotSources`。阅读总数只来自 `daily_read_stats` aggregate；event-level VisitLog/route sequence 已删除，因此三个 route/search/hotspot 列表为空，`averageDwellMs` 与 `readingCompletionRate` 保留兼容字段并固定为零。AOT 命中率由 aggregate 总数与 `Public AOT cache miss` 聚合估算。RUM 列表来自匿名 `POST /api/binary/telemetry/rum` 写入的 `frontend_rum_metric`，只接受 `web_vital_lcp`、`web_vital_cls`、`navigation_timing`、`hydration_time`、`wasm_decode_timing`、`markdown_render_timing` 和低基数 `pageType/aotSource/value/duration` 字段。`accepted=false` 或 `rejectedCount>0` 表示部分/全部样本被丢弃但不向公开读链泄露校验细节；服务端只保存净化后的 `frontend_rum_metric` 行，不写入 `sys_audit_log`。

评论通过长度、受限 Markdown 和地区硬拒绝校验后，由地区裁决、匿名凭证 `RequiresModeration`、风险队列和模型开关共同计算初始状态：`HideUntilReviewed -> Hidden`，人工/匿名/模型复核 -> `Pending`，仅确定性低风险且无需模型 -> `Approved`。需要模型的评论在评分前保持 `Pending`，公开评论线程、回复预览和回复游标始终只返回最终 `Approved`。账号侧 `GET /api/binary/comment/me` 保留 public 评论的全部审核/可见性状态，强匿名评论不能通过账号 ID 找回。公开展示仍只能使用评论作者快照，不能 join `sys_user`。

`POST /api/binary/comment/anonymous-ticket` 是强匿名评论写入前置 ticket 端点：请求为 `AnonymousCommentTicketRequest` frame，包含 article/reply context、action context、credential epoch、circuit id、verifying key hash、public input layout、anonymous scope、nullifier hash、credential root、revocation root、issuer public key hash、policy hash、`is_eligible`、`may_comment`、`rate_class=common|unknown`、`requires_moderation`、proof 与 canonical public inputs；精确 credential level、reputation/account-age bucket 和 credential commitment 只存在于浏览器私有 prover witness，不进入该 frame。服务端必须拒绝登录态污染，只使用当前 root snapshot 校验 verifying key/root/issuer 绑定，不在请求线程查询 DB root。root snapshot 只接受 root lifecycle 用独立 `AnonymousCredentialRoot:AttestationKey` 签过的 active root 或 freshness 窗口内 Grace root，attestation 绑定 epoch、credential root、revocation root、issuer public key hash、circuit/verifying key、layout version 和 circuit metadata；revocation accumulator profile 的 hash/tree/pathDepth 必须与 production circuit metadata 匹配。成功响应为 `AnonymousCommentTicketResponse` frame，返回 opaque ticket、expiresAt、`rateClass`、`requiresModeration` 和 `moderationSubjectHash`；Redis/统一缓存只保存 `SHA256(ticket)` 下的 compact binary payload，绑定 articleId、scope、parentId/rootId/replyToCommentId、nullifierHash、credentialEpoch、coarse rate class、moderation predicate 和 expiresAt，TTL 默认 120 秒且只能被后续匿名 submit consume-once。proof、publicInputs mismatch、root 过期、nullifier blocked、scope limit 或并发抢占失败统一对外返回 `ApiError` message=`anonymous_comment_ticket_denied`，不得泄露 verifier 细节。

当前 scope contract 为 `comment:v1:article:{articleId}:top`（每份匿名凭据周期、每篇文章 1 条）或 `comment:v1:article:{articleId}:thread:{rootId}`（每份匿名凭据周期、每个讨论串 3 条）。服务端从 article/root context 生成期望值并精确匹配；空 scope、旧 `article:{id}`、跨文章值、非 canonical root 和未知版本均 fail closed。删除、审核拒绝与隐藏不返还额度；凭据轮换会产生新 nullifier，scope 语义变化必须提升版本。旧版本数据库行只保留历史治理用途，不再签发新 ticket；POD 与 frame number 不因 v1 scope 语义升级而变化。

`POST /api/binary/comment/anonymous` 是强匿名最终提交端点：请求为 `AnonymousCommentCreateRequest` frame，只携带 article/reply context、credential epoch、scope、display language、content 和 opaque ticket；端点必须 `AllowAnonymous`、`public_read` 限流并通过 `RequireStrongAnonymousRequest()` 拒绝身份污染。服务端校验内容、consume-once ticket、reply context 与地区合规后写入匿名治理字段；ticket `RequiresModeration`、地区人工复核和模型开关会使初始状态为 `Pending`，`HideUntilReviewed` 为 `Hidden`，只有确定性低风险且无需模型时才直接 `Approved`。模型自动隐藏强匿名评论时无账号站内信收件人，只写审核和审计信号；ticket、proof、credential 原文和任何可逆用户身份不得写入 comment。

登录态创建 `POST /api/binary/comment` 只接受 `CommentCreateV2Request`，AEDS frame 上限为 16 KiB；该端点仅用于显式公开/可归因发送，服务端要求 `authorMode=public` 且 `publicSendExplicitlySelected=true`，否则拒绝写入。`CommentCreateV2Dto.content` 与 `AnonymousCommentSubmitDto.content` 均表示受限 Markdown 源文，不存 HTML，长度由当前匿名评论策略统一控制。退休的数值 37 frame 不得执行评论写入。目标文章必须是未删除、已发布且发布时间/定时发布时间已到达的公开文章。回复必须引用同文章、未删除、已通过的父评论和根评论，回复展示使用 `reply_to_comment_id` 对应的作者投影，不要求父评论存在非空 `reply_to_user_id`。普通用户删除只允许删除自身可归因 public 评论；强匿名评论暂不支持账号侧自删，需后续 receipt/capability/nullifier proof 方案或由管理员处理。管理员删除匿名评论时，通知和用户评论缓存失效不得假设存在可通知的 `user_id`。`POST /api/binary/comment` 先通过 `CommentRiskActionFilter` 预读 AEDS frame 判定 root create / reply 并写 RiskControl action metadata；低风险继续要求 legacy `X-Fsus-Pow-Proof`，中风险要求当前策略指定的 challenge proof 后再校验 PoW，高风险 `queue` 允许写入但把初始原因标记为 `published_risk_control_queue`，极高风险 `block` 返回 429。内容过滤、地区合规和匿名 nullifier 重复/封禁会写入 comment 风险信号，但不得反查匿名 nullifier 到真实账号，也不得改写匿名 display name 生成规则。

`CommentModerationItemResponse.id` 使用字符串承载 Snowflake ID，避免前端整数精度损失；响应同时包含文章、内容、状态、审核原因、审核人、审核时间、`hitReasons`、`submitRegion`、`submitRegionConfidence`、`blockedRegions`、`regionPolicyVersion`、`regionDecisionReason`、`regionCanPublish`、`regionRequiresManualReview`、`regionHideUntilReviewed`。审核队列响应契约不包含真实 `userId` 或 `userName`；管理端只读取 `authorDisplayName` 和作者安全快照字段生成展示与过滤。v5 强匿名作者投影只包含 `authorMode`、`anonymousDisplayLanguage`、`moderationSubjectHash`、`anonymousNullifierHash`、`anonymousScope`、`rateClass=common|unknown` 与 `requiresModeration`；精确 credential/reputation/account-age 属性不得进入审核响应。coarse rate class、moderation predicate 和 nullifier 状态用于审核解释、封禁和本地队列过滤，不暴露 account id、username、credential commitment 或 nullifier 原文。作者展示名统一由评论行快照投影生成：public 使用 `public_handle` 后接 `未署名用户` 兜底，anonymous/zk anonymous 使用 `anonymous_display_name` 后接匿名兜底；审核读取、审核通过实时推送和回复站内通知均不得 join `sys_user` 或回退 `sys_user.username` / 账号 `public_handle`。启用可选反垃圾模型后，响应追加最新 `modelSignals` 及摘要字段 `modelLabel/modelConfidence/modelPrimaryReason/modelProvider/modelUnavailable`；这些字段只表示风险信号，不包含或代表最终审核动作。`hitReasons` 来自内容过滤器、HTML 风险、密集链接、重复刷屏、人工原因、地区风险标签和 `model:{category}`，用于解释敏感词/垃圾评论/地区策略/模型命中；管理端可按命中原因、blocked region、模型标签、provider 和匿名作者投影做本地队列过滤。审核读取和写入受 `fixed_ip` 限流，并显式要求 `comment.moderate`；该权限只覆盖普通评论审核，不覆盖匿名评论策略、nullifier 封禁或匿名凭证撤销。单条与批量审核需要先完成 `/api/binary/auth/admin/step-up/passkey/begin` / `/api/binary/auth/admin/step-up/passkey/complete`，再把返回的 action=`admin-sensitive` 一次性 proof 放入 `X-Fsus-Mfa-Proof`。proof 缺失、过期、跨 session 或已被消费时返回 `428` + `MFA_PROOF_REQUIRED`；普通用户 MFA proof 不能用于 admin-sensitive 操作。

`CommentModerationQueueResponse.nextCursor` 是 opaque base64url keyset，客户端不得解析或自行构造；`leases` 与 `items` 按 comment id 对齐，包含评论 `xmin`、风险/等待排序坐标以及 claim owner/state/claimedAt/expiry/processSlaDue/note/escalation/generation/`xmin`。claim token 仅在成功抢占的 `CommentModerationClaimResponse` 中返回一次，数据库只保存 SHA-256；同一响应还返回抢占后的当前 comment `xmin`，供决策 CAS 使用。续租与释放必须同时匹配 owner、token、generation、claim `xmin` 和未过期状态。单条审核必须提交 `expectedStatus/commentRowVersion/claimToken/claimGeneration/claimRowVersion`；批量审核必须为每个 comment 提交同样的 `preconditions`。评论 CAS 与 claim 完成位于同一事务；任一条件失配返回 409，批量响应通过 `conflicts` 明确列出冲突 ID，不能静默覆盖。queue list 与 pending count 使用同一集合：未删除且 Pending、边界风险、存在 open/reviewing report 或 pending appeal。

`CommentArticleCursor` 与 `CommentThreadReplyCursor` 的公共可见集合由“当前 viewer 地区直接可见节点 + 递归祖先链”组成。直接可见要求 `Approved && !is_deleted` 且未命中 viewer 的 `comment_blocked_region`；祖先若不直接可见，只能返回 `isDeleted=true`、固定内容 `该回复已删除` 和固定作者 `已删除评论`，`replyToAuthor` 指向非直接可见目标时也使用同一安全占位。删除且无直接可见后代的叶子、整条无公开后代的线程不返回。对这两个旧 frame，该规则不增加字段或改号：`isDeleted` 同时表达公共读取中的 opaque tombstone。管理员隐藏与用户删除在公共 wire 上均为不可区分占位；地区屏蔽按 viewer region 计算；账户注销不改变已写入的公开作者快照。删除事件之后客户端必须回源同地区首屏，不能永久依赖仅修改本地数组的乐观状态。

递归读取的新主契约为 `CommentTreeRootCursor(208)`、`CommentChildCursor(209)` 与 `CommentPermalinkContext(210)`。`GET /api/binary/comment/{articleId}?cursor&limit` 返回根节点 keyset 页，每个根只内联直接子节点预览；`GET /api/binary/comment/{articleId}/children/{parentId}?cursor&limit` 只返回该父节点的直接子节点，并携带父/根坐标、`childCount` 与 `hasMoreChildren`；`GET /api/binary/comment/{articleId}/context/{commentId}?window` 返回从根到父节点的有序祖先、目标和目标附近的兄弟窗口。所有 ID 在前端以十进制字符串承载，不能转换为 JavaScript `number`。服务端保存的 `parent_id/root_id/depth` 为结构真源；创建回复必须在事务中校验同文章可见父/根，使用 parent-scoped advisory transaction lock 原子保留直接子节点配额，并按 reloadable `CommentThreads:MaxDepth`（默认 32）与 `CommentThreads:MaxChildrenPerNode`（默认 500）拒绝超限，错误 message 固定为 `comment_thread_depth_limit` 或 `comment_child_limit`。删除、隐藏或地区不可见目标的 permalink 与不存在目标统一返回 status=`unavailable`、空路径/目标/兄弟窗口，防止存在性泄露；可见后代需要的不可见祖先仍只返回 opaque tombstone。

旧 `CommentThreadReplyCursor` 保留为滚动部署期间的 binary 兼容读取，但新客户端不得把它当成递归树真源。`CommentAdded` / `CommentRemoved` notification stream 继续携带 article/root/parent/comment 坐标，客户端必须按真实 parent 合并或遮盖节点；站内回复通知与 permalink 均使用 `/article/{articleId}#comment-{commentId}`。无需重启回退时设置 reloadable `CommentThreads:RecursiveReadsEnabled=false`，三个新读端点返回 503 `comment_recursive_reads_disabled`；旧 binary thread 读取、评论写入、审核与 notification stream 保持可用。

`GET /api/binary/comment/me` 的可选 `articleId` query 提供认证私有 ownership overlay。指定时，`CommentUserCursor` 只包含当前 account、该 article、`author_mode=public` 的记录；未指定时保持账号评论历史语义。overlay 客户端只消费 comment ID 形成 `selfOwned/canDelete` 集合，不把 `user_id`、account ID、session ID 或 capability 写入公共 comment frame、公共 cache 或 notification stream。私有 frame cache identity 必须同时绑定 account、article scope、cursor、limit 和 account-scoped version；创建/删除通过既有 account comment version 失效，登出/换账号由认证门禁和浏览器清空隔离。伪造前端集合不影响 `DELETE` 的服务端 owner 校验。

`published_risk_control_queue` 仅是 #1189 之前的历史原因示例；新写入不得使用 `published_*` 原因暗示已经公开。RiskControl queue 通过地区裁决映射为 `pending_region_review` 或 `hidden_region_review`，并遵守 `CommentCreateResult` 的非公开可见性。

单条与批量审核都会写入 `comment-moderation` / `comment-moderation-bulk` 审计；模型自动状态变化写入 `model_moderation_auto_disposition`。权威迁移矩阵只允许 `Pending -> Approved|Rejected|Hidden`、`Approved -> Rejected|Hidden`、`Rejected -> Approved|Hidden`、`Hidden -> Approved|Rejected`；自迁移和任何回到 `Pending` 的迁移均返回未更新。服务层用读取到的旧 `ModerationStatus` 做 CAS 条件更新，模型路径额外绑定 PostgreSQL `xmin`；并发失败不得产生审计、缓存失效或实时通知。单条与模型审计记录 previous/next state，批量审计记录确定性的 `from->to:count` 汇总。`Pending/Rejected/Hidden -> Approved` 会通过 notification stream 推送 `CommentAdded`，但推送内容只能携带同一个安全 `authorDisplayName` 投影，不能读取账号表；合规记录 `can_publish=false` 的发布地违法评论不能被批准。审核通过的回复站内通知同样用当前评论和父评论的快照投影拼接正文，父评论缺少快照时回退为“您”，不得通过 `reply_to_user_id` 查账号名；通知只在成功 CAS 状态迁移后发送，稳定 operation identity 绑定 comment id 与收件人，并携带 `/article/{articleId}#comment-{commentId}` 定位。`Approved -> Rejected/Hidden` 和删除会推送 `CommentRemoved`。评论游标缓存按 article/root/user scope 清理，公开读取的 frame identity 额外包含 viewer region，不再全局清 `CacheTag.Comment`；当 `status=Rejected|Hidden` 且 `banUser(s)=true` 时，服务端会把非 admin、非注销用户更新为封禁状态并同步黑名单缓存。误判恢复使用 `status=Approved`，不会触发封禁联动。机器可读状态图见 [`comment-moderation-state-machine.yaml`](../moderation/comment-moderation-state-machine.yaml)。

第三方审核模型 Provider 只返回风险信号，不返回最终动作。需要模型的评论先写 `Pending`；`timeout|unavailable|contract_invalid|error` 默认 `FailOpen=false` 并保留审核队列，provider DI 缺失也不能静默公开。显式 `FailOpen=true` 仅允许地区安全、无需人工且匿名凭证无需复核的评论转为 `Approved`。`score-only` 保持 `Pending`；`auto-low-risk-approve` 通过高置信 clean；`auto-hide-high-risk` 隐藏高风险；`strict-auto-moderate` 同时执行两类转换。所有模型转换绑定旧状态与 PostgreSQL `xmin`，成功的 `Pending -> Approved` 才失效公开缓存并发布 `CommentAdded`。模型 runtime reload 失败保留旧快照，不禁用硬词库、地区策略或人工审核。

硬词库和地区策略由 `config/moderation/**` 加载为 immutable snapshot。词库只输出 `category/severity/reason/evidence_policy`，地区策略负责把 category 映射为 `submit_action/display_action`；reload 构建失败时保留旧 snapshot 并记录 `lastError`，rollback 只回到上一份成功 snapshot。运行时禁用某个词库只从匹配集合移除该词库，不禁用模型或地区策略；运行时禁用某个地区策略时必须回落到 `GLOBAL` baseline，不进入无审核状态。`GET /api/binary/author/moderation/dictionaries` 返回 `snapshotId/version/checksum/createdAtUtc/lastError`、词库 metadata（id/version/scope/region/category/source/reviewedBy/checksum/termCount）和地区策略 metadata（region/version/inherits/dictionaryIds/checksum/ruleCount）。详见 [../moderation/dictionary-architecture.md](../moderation/dictionary-architecture.md)。

内容导出使用 `ContentExportResponse`：`fileName`、`markdownWithFrontmatter`、`metadata`。frontmatter 固定写入 `fsusFormat: content-export-v1`、`sourceArticleId`、`title`、`summary`、`cover`、`categoryId`、`status`、`scheduledPublishAt`、`tagIds`、`revisionCount` 与 `fsusMetadataJson`；`fsusMetadataJson` 是 base64url 编码的 `ContentExportMetadataResponse`，用于无损恢复分类、标签、封面、文章状态和修订元数据，但不得携带 `createdByUserId` 或 `createdByAdminPrincipalId` 这类可导入 numeric actor id。`GET /api/binary/author/content/export` 返回 `ContentBackupExportResponse`，以 JSON 包含所有文章的导出结果。导入时 `publish=true` 会强制导入为 `Published`，否则按 metadata 的 `status` 恢复；`preserveRevisions=true` 会用导出包中的 revisions 替换导入时生成的初始 revision，恢复出的修订不得把外部环境 actor id 写入本地账号或 admin principal 字段。

### 公共 ArticleDetail DB projection

公开 `GET /api/binary/article/{id}.aeds` 的 wire contract 是 `AedsFrameType.ArticleDetail` + 新写 `ARD5` V5 payload，并只读兼容 `ARD4` V4 与 `ARD3` V3；V5 携带正文 `updatedAt` 和精确 revision/publication 坐标，没有 JSON/text fallback。文件 artifact miss 时，内部 `public_article_projection` 只返回 `version/aeds_payload/etag/updated_at_utc`；`aeds_payload` 是 projector 生成的完整 immutable AEDS v2 frame。直接 Npgsql reader 使用 `$1` positional parameter、prepared statement、固定 ordinal 和 `SequentialAccess | SingleRow`，每个请求至多执行一次 projection query。CRC、frame type、受支持的 payload magic/version 与 `SHA-256` ETag 任一不符均视为 corrupt，记录 repair evidence 后走既有动态兜底，不能把损坏 bytes 写入缓存或响应。

投影 row 的 `visible=false` 表示 negative/不可公开状态，payload、etag、content hash 必须为空；publish/restore/update 会通过 outbox 重建为 visible row，archive/delete/permanent-delete 会写回不可用状态。backfill durable watermark 保存 `paused|running|completed`、last article id、rate 和成功/失败计数；author cache action 支持 `public-article-projection-backfill-status`、`public-article-projection-backfill-pause`、`public-article-projection-backfill-resume`。这些动作只控制内部 read model，不改变公开 endpoint、admin permission 或 notification stream 契约。

受保护 readiness 的 `runtime.dbGateClasses` 暴露 public-short-read、admin-heavy-read、foreground-write、background-projection-rebuild 的 limit/queue/active/waiting/timeouts/p99；`runtime.publicArticleProjection` 暴露独立 pool capacity、active/waiting、hit/miss/invalid/timeout/broken connection、pool wait p99 与 query p99。公开 `/health/ready` 仍只返回 `status/checkedAt`。

### Subscribe

`POST /api/binary/subscriptions` 与 `DELETE /api/binary/subscriptions` 使用 `SiteSubscriptionRequest` / `SiteSubscriptionResponse` AEDS frame，只保存 `HMAC-SHA256(Subscription:EmailHashPepper, normalizedEmail)` keyed lookup identifier、`hash_version`、`channel`、启用状态和退订时间，不保存明文 email。`DELETE` 还必须携带 `X-Fsus-Subscription-Proof`；proof 与 keyed email hash/channel 绑定、TTL 生效，端点先非消费校验，DB 退订成功后再一次性消费，旧 email-only 退订返回 428 且不得更新 DB。旧裸 SHA-256 值仅用于迁移期双读匹配，订阅写入会升级为当前 HMAC，不得作为跨系统身份标识使用。订阅能力是 RSS/Atom 的增强，不构成关注、点赞、收藏或社交关系链。默认实现不发送邮件或 Web Push；`channel=email` 只记录读者显式偏好，外发增强必须以后续配置开关和退订 smoke 为准。

### Source code capability split contract constraints

后端 runtime type 可以用 partial capability files 分隔 orchestration、policy、persistence、codec 与 metrics，但这不是 wire-contract 版本。issue #1119 的拆分不改变公开 type/interface、`/api/binary/author` method/path、AEDS request/response frame、统一错误、admin permission、notification stream 或 schema migration descriptor 顺序。任何后续 capability 拆分若需要改变上述任一项，仍必须按正常 API/protocol 变更同步 frame catalog、quick reference、OpenAPI/route evidence 与跨端测试，不能把文件移动当作兼容性证明。

---

## See

- [design.md](design.md) — API 设计哲学与格式约定
- [quick-reference.md](quick-reference.md) — 端点路由速查表
- [schemas-and-errors.md](schemas-and-errors.md) — 错误码枚举与 Binary 帧格式
- `src/shared/Contracts/Outputs/ServerResponseContracts.cs` — 所有 DTO 权威源码
- `src/shared/Contracts/NotificationStream/NotificationStreamContracts.cs` — notification stream 信封权威源码
## `article_body_missing` 公开读取契约

`GET /api/binary/article/{id}.aeds` 及其公共投影发现 Published 文章缺少非空 `article_body.markdown_content` 时，返回 `InfraFailure`，稳定错误 detail 为 `article_body_missing`。该状态不是 `NotFound`，客户端应显示正文暂不可用并允许稍后重试；不得把列表 `summary` 渲染为详情正文。

错误路径不生成新的 ArticleDetail AEDS frame、缓存、Public AOT、public-hot 正文或搜索正文投影。admin/private Draft 读取允许空正文并返回空字符串。此变更不修改 `AedsFrameType`、ArticleDetail V5 POD、路由或 notification stream 信封；修复完成后沿既有文章缓存、AOT、搜索和热读失效链恢复，无需新增客户端 fallback。

## Article/thread comment policy

- `GET /api/binary/comment/policy` 接受可选 `articleId`、`rootId`；响应仍为 AEDS `CommentPolicySnapshot`。给定文章时，开关与 `snapshotHash` 表示全站默认、文章 override 和线程状态合成结果。
- `GET|PUT /api/authoring/moderation/articles/{articleId}/comment-policy` 读取/更新文章策略；更新请求包含 nullable override、`moderationMode=direct|premoderated|risk_based`、`slowModeSeconds`、`closedAtUtc` 与 `expectedPolicyVersion`。
- `PUT /api/authoring/moderation/articles/{articleId}/comment-threads/{rootId}` 原子锁定/解锁单一根线程；请求包含 `locked`、`expectedPolicyVersion`、`reason`。
- 稳定写入拒绝码：`comment_policy_closed`、`comment_thread_locked`、`comment_slow_mode_active`、`comment_policy_version_conflict`。所有评论读取在关闭后保持可用。

## Cluster membership operational contract

Cluster capability values are a closed catalog: `web.api`, `admin.ui`, `comment.api`, `comment.audit`, `antispam.inference`, `search.query`, `search.indexer`, `media.processor`, and `scheduler.worker`. `CapabilityId` rejects unknown values before registration.

Each member snapshot contains a stable configured or host-derived `nodeId`, a per-process UUID `instanceId`, version, start time, runtime mode, capability set, `Alive|Suspect|Dead|Draining|Maintenance` status, last heartbeat, resource hints, and active responsibilities. A heartbeat with a stale `instanceId` cannot revive a restarted node. Heartbeat timeout first marks `Suspect`, then `Dead`; records are retained for diagnosis rather than deleted.

`GET /api/ops/cluster/nodes` returns
`{ enabled, mode, currentNodeId, schedulingAllowed, health, scheduler, nodes, leases, tasks, events, metrics }`. `scheduler` contains
`{ generation, observedAt, mode, enabled, assignments, unassigned }`; every assignment
contains `responsibilityId`, `capability`, `replica`, `nodeId`, `assignedAt`,
`placementScore`, `reason`, and nullable `fencingToken`. Responsibility IDs are the
seven values in `CoreResponsibilityCatalog`; capability values remain the closed
membership catalog. `unassigned` contains bounded machine reasons such as
`<responsibility-id>:no-healthy-capability`. `leases` contains opaque lease ID, holder
node, fencing token, TTL, last-renew and expiry coordinates. `tasks[].checkpoint` contains
only version, payload byte count, SHA-256 and update time; checkpoint payload is never
returned. Events are bounded in-process lifecycle/decision records with optional W3C
trace ID, and metrics use the documented low-cardinality cluster counter names.

This endpoint is JSON only because `/api/ops/**` is an explicitly protected operational
surface. It requires `identity_kind=admin_principal`, `admin_id`,
`admin_permission=system.config`, `fixed_ip`, and `Cache-Control: no-store`. It does not
accept Cookie-derived normal account authorization or an AEDS compatibility fallback.
The additive operations view does not create a public JSON fallback for binary APIs and
is not emitted to notification stream.

The three mutation routes share the same admin/fixed-IP/no-store boundary and additionally
require trusted origin/referer plus a one-use `X-Fsus-Mfa-Proof` bound to
`admin-sensitive`:

- `POST /api/ops/cluster/nodes/{nodeId}/state` accepts
  `{ state: alive|draining|maintenance, reason }`;
- `POST /api/ops/cluster/scheduler` accepts `{ enabled, reason }` and updates the
  in-process hot scheduling latch;
- `POST /api/ops/cluster/leases/{leaseId}/release-expired` accepts `{ reason }` and
  removes only a lease already expired by the authoritative clock.

Invalid state, active lease release, missing node, missing step-up proof and untrusted
origin fail closed without changing assignment or fencing state.

## Plugin Admin binary contract

Plug-in management is only registered in the authoring surface of the independent admin principal:


安装 request payload 是未经文本转码的完整 `.fspkg` bytes，受 package reader 的
32 MiB, entry count, path, checksum, signature and manifest constraints; must also carry
`X-Fsus-Plugin-Confirm: install`。action payload 是 authoring JSON payload，action
仅允许 `grant|revoke|enable|disable|reload|quarantine|restore|uninstall|update-config`。
`quarantine|restore|uninstall` 必须显式 `confirmed=true`。配置写入携带
`expectedConfigVersion`，先按已验证包内 Schema 校验，再 CAS 递增版本；enabled
插件保存后立即 reload，失败则隔离且返回固定 `plugin_runtime_action_failed`。

所有四个 endpoint 要求 admin principal、`system.config`、`fixed_ip`、`no-store`；
所有写入还要求一次性 `X-Fsus-Mfa-Proof`。响应只含 manifest 摘要、服务端分类的权限
Plan, current grant, Hook metadata, bounded execution indicator /日志/错误和逐节点状态; package must not be returned
bytes, signature, uncut manifest or exception message. Must return when the non-current node has not submitted the running state
`not-reported`，不能伪装为 healthy/loaded/cluster-consistent。

## Current cache policy catalog

### Current AEDS version

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.aeds-version
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.aeds-version
render: scalar
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.aeds-version -->
2
<!-- FSUSBLOG-GENERATED:END api.aeds-version -->

### Current article transitions

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.article-transitions
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.allowed-transitions
render: transition-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.article.allowed-transitions -->
| From | To | Guard |
| --- | --- | --- |
| Archived | Archived | Create |
| Archived | Archived | Rollback |
| Archived | Archived | Update |
| Archived | Draft | Rollback |
| Archived | Draft | Update |
| Archived | Published | Rollback |
| Archived | Published | Update |
| Archived | Scheduled | Update |
| Deleted | Published | Restore |
| Draft | Archived | Rollback |
| Draft | Archived | Update |
| Draft | Draft | Create |
| Draft | Draft | Rollback |
| Draft | Draft | Update |
| Draft | Published | Rollback |
| Draft | Published | Update |
| Draft | Scheduled | Update |
| Published | Archived | Rollback |
| Published | Archived | Update |
| Published | Draft | Rollback |
| Published | Draft | Update |
| Published | Published | Create |
| Published | Published | Rollback |
| Published | Published | ScheduledPublish |
| Published | Published | Update |
| Published | Scheduled | Update |
| Scheduled | Archived | Rollback |
| Scheduled | Archived | Update |
| Scheduled | Draft | Rollback |
| Scheduled | Draft | Update |
| Scheduled | Published | Rollback |
| Scheduled | Published | ScheduledPublish |
| Scheduled | Published | Update |
| Scheduled | Scheduled | Create |
| Scheduled | Scheduled | Update |
<!-- FSUSBLOG-GENERATED:END content.article.allowed-transitions -->

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.article-forbidden-transitions
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.article.forbidden-transitions
render: transition-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN content.article.forbidden-transitions -->
| From | To | Guard |
| --- | --- | --- |
| Archived | Archived | article_status_transition_invalid |
| Archived | Archived | article_status_transition_invalid |
| Archived | Deleted | article_deleted_requires_delete_flow |
| Archived | Deleted | article_deleted_requires_delete_flow |
| Archived | Deleted | article_deleted_requires_delete_flow |
| Archived | Deleted | article_deleted_requires_delete_flow |
| Archived | Deleted | article_deleted_requires_delete_flow |
| Archived | Draft | article_status_transition_invalid |
| Archived | Draft | article_status_transition_invalid |
| Archived | Draft | article_status_transition_invalid |
| Archived | Published | article_status_transition_invalid |
| Archived | Published | article_status_transition_invalid |
| Archived | Published | article_status_transition_invalid |
| Archived | Scheduled | article_status_transition_invalid |
| Archived | Scheduled | article_status_transition_invalid |
| Archived | Scheduled | article_status_transition_invalid |
| Archived | Scheduled | article_status_transition_invalid |
| Deleted | Archived | article_status_transition_invalid |
| Deleted | Archived | article_status_transition_invalid |
| Deleted | Archived | article_status_transition_invalid |
| Deleted | Archived | article_status_transition_invalid |
| Deleted | Archived | article_status_transition_invalid |
| Deleted | Deleted | article_deleted_requires_delete_flow |
| Deleted | Deleted | article_deleted_requires_delete_flow |
| Deleted | Deleted | article_deleted_requires_delete_flow |
| Deleted | Deleted | article_deleted_requires_delete_flow |
| Deleted | Deleted | article_deleted_requires_delete_flow |
| Deleted | Draft | article_status_transition_invalid |
| Deleted | Draft | article_status_transition_invalid |
| Deleted | Draft | article_status_transition_invalid |
| Deleted | Draft | article_status_transition_invalid |
| Deleted | Draft | article_status_transition_invalid |
| Deleted | Published | article_status_transition_invalid |
| Deleted | Published | article_status_transition_invalid |
| Deleted | Published | article_status_transition_invalid |
| Deleted | Published | article_status_transition_invalid |
| Deleted | Scheduled | article_status_transition_invalid |
| Deleted | Scheduled | article_status_transition_invalid |
| Deleted | Scheduled | article_status_transition_invalid |
| Deleted | Scheduled | article_status_transition_invalid |
| Deleted | Scheduled | article_status_transition_invalid |
| Draft | Archived | article_status_transition_invalid |
| Draft | Archived | article_status_transition_invalid |
| Draft | Archived | article_status_transition_invalid |
| Draft | Deleted | article_deleted_requires_delete_flow |
| Draft | Deleted | article_deleted_requires_delete_flow |
| Draft | Deleted | article_deleted_requires_delete_flow |
| Draft | Deleted | article_deleted_requires_delete_flow |
| Draft | Deleted | article_deleted_requires_delete_flow |
| Draft | Draft | article_status_transition_invalid |
| Draft | Draft | article_status_transition_invalid |
| Draft | Published | article_status_transition_invalid |
| Draft | Published | article_status_transition_invalid |
| Draft | Published | article_status_transition_invalid |
| Draft | Scheduled | article_status_transition_invalid |
| Draft | Scheduled | article_status_transition_invalid |
| Draft | Scheduled | article_status_transition_invalid |
| Draft | Scheduled | article_status_transition_invalid |
| Published | Archived | article_status_transition_invalid |
| Published | Archived | article_status_transition_invalid |
| Published | Archived | article_status_transition_invalid |
| Published | Deleted | article_deleted_requires_delete_flow |
| Published | Deleted | article_deleted_requires_delete_flow |
| Published | Deleted | article_deleted_requires_delete_flow |
| Published | Deleted | article_deleted_requires_delete_flow |
| Published | Deleted | article_deleted_requires_delete_flow |
| Published | Draft | article_status_transition_invalid |
| Published | Draft | article_status_transition_invalid |
| Published | Draft | article_status_transition_invalid |
| Published | Published | article_status_transition_invalid |
| Published | Scheduled | article_status_transition_invalid |
| Published | Scheduled | article_status_transition_invalid |
| Published | Scheduled | article_status_transition_invalid |
| Published | Scheduled | article_status_transition_invalid |
| Scheduled | Archived | article_status_transition_invalid |
| Scheduled | Archived | article_status_transition_invalid |
| Scheduled | Archived | article_status_transition_invalid |
| Scheduled | Deleted | article_deleted_requires_delete_flow |
| Scheduled | Deleted | article_deleted_requires_delete_flow |
| Scheduled | Deleted | article_deleted_requires_delete_flow |
| Scheduled | Deleted | article_deleted_requires_delete_flow |
| Scheduled | Deleted | article_deleted_requires_delete_flow |
| Scheduled | Draft | article_status_transition_invalid |
| Scheduled | Draft | article_status_transition_invalid |
| Scheduled | Draft | article_status_transition_invalid |
| Scheduled | Published | article_status_transition_invalid |
| Scheduled | Published | article_status_transition_invalid |
| Scheduled | Scheduled | article_status_transition_invalid |
| Scheduled | Scheduled | article_status_transition_invalid |
| Scheduled | Scheduled | article_status_transition_invalid |
<!-- FSUSBLOG-GENERATED:END content.article.forbidden-transitions -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.cache-policies
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: api.security-cache-policies
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.security-cache-policies -->
| Key | Value |
| --- | --- |
| AdminStats | {"class":"admin","domain":"admin","id":"AdminStats","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"stats","securityCritical":false} |
| AdminStatsFrame | {"class":"admin","domain":"admin","id":"AdminStatsFrame","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"stats-frame","securityCritical":false} |
| AdminStatsOverview | {"class":"admin","domain":"admin","id":"AdminStatsOverview","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"stats-overview","securityCritical":false} |
| AdminStatsRecentComments | {"class":"admin","domain":"admin","id":"AdminStatsRecentComments","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"stats-recent-comments","securityCritical":false} |
| AdminStatsRegions | {"class":"admin","domain":"admin","id":"AdminStatsRegions","l1Ttl":{"unit":"minutes","value":5},"l2Ttl":{"unit":"minutes","value":30},"negativeTtl":{"state":"null"},"resource":"stats-regions","securityCritical":false} |
| AnonymousCommentPolicyVersion | {"class":"security-critical","domain":"sec","id":"AnonymousCommentPolicyVersion","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"days","value":7},"negativeTtl":{"state":"null"},"resource":"anonymous-comment-policy-version","securityCritical":true} |
| AnonymousCommentTicket | {"class":"security-critical","domain":"sec","id":"AnonymousCommentTicket","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":2},"negativeTtl":{"state":"null"},"resource":"anonymous-comment-ticket","securityCritical":true} |
| ArticleDetail | {"class":"blog","domain":"blog","id":"ArticleDetail","l1Ttl":{"unit":"minutes","value":5},"l2Ttl":{"unit":"hours","value":1},"negativeTtl":{"unit":"minutes","value":5},"resource":"article-detail","securityCritical":false} |
| ArticleDetailFrame | {"class":"blog","domain":"blog","id":"ArticleDetailFrame","l1Ttl":{"unit":"minutes","value":5},"l2Ttl":{"unit":"hours","value":1},"negativeTtl":{"state":"null"},"resource":"article-detail-frame","securityCritical":false} |
| ArticleHot | {"class":"blog","domain":"blog","id":"ArticleHot","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"article-hot","securityCritical":false} |
| ArticleHotFrame | {"class":"blog","domain":"blog","id":"ArticleHotFrame","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"article-hot-frame","securityCritical":false} |
| ArticleList | {"class":"blog","domain":"blog","id":"ArticleList","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"article-list","securityCritical":false} |
| ArticleListCount | {"class":"blog","domain":"blog","id":"ArticleListCount","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":30},"negativeTtl":{"state":"null"},"resource":"article-list-count","securityCritical":false} |
| ArticleListFrame | {"class":"blog","domain":"blog","id":"ArticleListFrame","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"article-list-frame","securityCritical":false} |
| ArticleListVersion | {"class":"blog","domain":"blog","id":"ArticleListVersion","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"days","value":7},"negativeTtl":{"state":"null"},"resource":"article-list-version","securityCritical":false} |
| ArticleRss | {"class":"blog","domain":"blog","id":"ArticleRss","l1Ttl":{"unit":"minutes","value":3},"l2Ttl":{"unit":"minutes","value":30},"negativeTtl":{"state":"null"},"resource":"article-rss","securityCritical":false} |
| ArticleSearch | {"class":"blog","domain":"blog","id":"ArticleSearch","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"article-search","securityCritical":false} |
| ArticleSearchVersion | {"class":"blog","domain":"blog","id":"ArticleSearchVersion","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"days","value":7},"negativeTtl":{"state":"null"},"resource":"article-search-version","securityCritical":false} |
| ArticleViewLock | {"class":"security-critical","domain":"sec","id":"ArticleViewLock","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"hours","value":1},"negativeTtl":{"state":"null"},"resource":"article-view-lock","securityCritical":true} |
| BackgroundWorkerLease | {"class":"runtime","domain":"runtime","id":"BackgroundWorkerLease","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"seconds","value":30},"negativeTtl":{"state":"null"},"resource":"worker-lease","securityCritical":false} |
| CategoryFrame | {"class":"blog","domain":"blog","id":"CategoryFrame","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"category-frame","securityCritical":false} |
| CommentCursor | {"class":"blog","domain":"blog","id":"CommentCursor","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"comment-cursor","securityCritical":false} |
| CommentCursorFrame | {"class":"blog","domain":"blog","id":"CommentCursorFrame","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"comment-cursor-frame","securityCritical":false} |
| CommentCursorVersion | {"class":"blog","domain":"blog","id":"CommentCursorVersion","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"days","value":7},"negativeTtl":{"state":"null"},"resource":"comment-cursor-version","securityCritical":false} |
| HumanReadProof | {"class":"security-critical","domain":"sec","id":"HumanReadProof","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"days","value":1},"negativeTtl":{"state":"null"},"resource":"human-read-proof","securityCritical":true} |
| MessageUnread | {"class":"msg","domain":"msg","id":"MessageUnread","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"days","value":3},"negativeTtl":{"state":"null"},"resource":"unread","securityCritical":false} |
| NotificationStreamDrillNonce | {"class":"security-critical","domain":"sec","id":"NotificationStreamDrillNonce","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":1},"negativeTtl":{"state":"null"},"resource":"notification-drill-nonce","securityCritical":true} |
| PublicAotBackfillLease | {"class":"public","domain":"public","id":"PublicAotBackfillLease","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"seconds","value":30},"negativeTtl":{"state":"null"},"resource":"aot-backfill-lease","securityCritical":false} |
| PublicAotDocument | {"class":"public","domain":"public","id":"PublicAotDocument","l1Ttl":{"unit":"minutes","value":30},"l2Ttl":{"unit":"days","value":30},"negativeTtl":{"state":"null"},"resource":"aot-doc","securityCritical":false} |
| PublicAotRegistry | {"class":"public","domain":"public","id":"PublicAotRegistry","l1Ttl":{"unit":"minutes","value":5},"l2Ttl":{"unit":"days","value":30},"negativeTtl":{"state":"null"},"resource":"aot-registry","securityCritical":false} |
| RelatedReading | {"class":"blog","domain":"blog","id":"RelatedReading","l1Ttl":{"unit":"minutes","value":5},"l2Ttl":{"unit":"minutes","value":30},"negativeTtl":{"unit":"minutes","value":5},"resource":"related-reading","securityCritical":false} |
| SecurityBlockedUser | {"class":"security-critical","domain":"sec","id":"SecurityBlockedUser","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"minutes","value":20},"negativeTtl":{"state":"null"},"resource":"blocked-user","securityCritical":true} |
| SecurityChallengeEnvelope | {"class":"security-critical","domain":"sec","id":"SecurityChallengeEnvelope","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"challenge-envelope","securityCritical":true} |
| SecurityChallengeProof | {"class":"security-critical","domain":"sec","id":"SecurityChallengeProof","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"challenge-proof","securityCritical":true} |
| SecurityChallengeVerifyRateLimit | {"class":"security-critical","domain":"sec","id":"SecurityChallengeVerifyRateLimit","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":2},"negativeTtl":{"state":"null"},"resource":"challenge-verify-rate","securityCritical":true} |
| SecurityMfaChallenge | {"class":"security-critical","domain":"sec","id":"SecurityMfaChallenge","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"mfa-challenge","securityCritical":true} |
| SecurityMfaProof | {"class":"security-critical","domain":"sec","id":"SecurityMfaProof","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"mfa-proof","securityCritical":true} |
| SecurityPasskeyAuthChallenge | {"class":"security-critical","domain":"sec","id":"SecurityPasskeyAuthChallenge","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"pk-auth","securityCritical":true} |
| SecurityPasskeyRegChallenge | {"class":"security-critical","domain":"sec","id":"SecurityPasskeyRegChallenge","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"pk-reg","securityCritical":true} |
| SecurityPerceptionChallenge | {"class":"security-critical","domain":"sec","id":"SecurityPerceptionChallenge","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"perception-challenge","securityCritical":true} |
| SecurityPoSpaceChallenge | {"class":"security-critical","domain":"sec","id":"SecurityPoSpaceChallenge","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"pospace-challenge","securityCritical":true} |
| SecurityPowProof | {"class":"security-critical","domain":"sec","id":"SecurityPowProof","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"pow-proof","securityCritical":true} |
| SecurityPowRisk | {"class":"security-critical","domain":"sec","id":"SecurityPowRisk","l1Ttl":{"unit":"seconds","value":10},"l2Ttl":{"unit":"minutes","value":2},"negativeTtl":{"state":"null"},"resource":"pow-risk","securityCritical":true} |
| SecurityRecoveryKeyAttempt | {"class":"security-critical","domain":"sec","id":"SecurityRecoveryKeyAttempt","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"rk-attempt","securityCritical":true} |
| SecurityRecoveryKeySession | {"class":"security-critical","domain":"sec","id":"SecurityRecoveryKeySession","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"rk-session","securityCritical":true} |
| SecurityUserSessionValidation | {"class":"security-critical","domain":"sec","id":"SecurityUserSessionValidation","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":2},"negativeTtl":{"state":"null"},"resource":"user-session-validation","securityCritical":true} |
| SiteSubscriptionUnsubscribeProof | {"class":"security-critical","domain":"sec","id":"SiteSubscriptionUnsubscribeProof","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":15},"negativeTtl":{"state":"null"},"resource":"site-subscription-unsubscribe-proof","securityCritical":true} |
| SystemCompliance | {"class":"sys","domain":"sys","id":"SystemCompliance","l1Ttl":{"unit":"minutes","value":10},"l2Ttl":{"unit":"days","value":1},"negativeTtl":{"state":"null"},"resource":"compliance","securityCritical":false} |
| SystemPage | {"class":"sys","domain":"sys","id":"SystemPage","l1Ttl":{"unit":"minutes","value":10},"l2Ttl":{"unit":"days","value":1},"negativeTtl":{"unit":"minutes","value":2},"resource":"page","securityCritical":false} |
| SystemSeo | {"class":"sys","domain":"sys","id":"SystemSeo","l1Ttl":{"unit":"minutes","value":10},"l2Ttl":{"unit":"days","value":1},"negativeTtl":{"state":"null"},"resource":"seo","securityCritical":false} |
| TagFrame | {"class":"blog","domain":"blog","id":"TagFrame","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"tag-frame","securityCritical":false} |
| TaxonomyExactMetadataFrame | {"class":"blog","domain":"blog","id":"TaxonomyExactMetadataFrame","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"minutes","value":10},"negativeTtl":{"state":"null"},"resource":"taxonomy-exact-metadata-frame","securityCritical":false} |
| TaxonomyFrameVersion | {"class":"blog","domain":"blog","id":"TaxonomyFrameVersion","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"days","value":7},"negativeTtl":{"state":"null"},"resource":"taxonomy-frame-version","securityCritical":false} |
| TopArticles | {"class":"blog","domain":"blog","id":"TopArticles","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"hours","value":2},"negativeTtl":{"state":"null"},"resource":"top-articles","securityCritical":false} |
| TopArticlesFrame | {"class":"blog","domain":"blog","id":"TopArticlesFrame","l1Ttl":{"unit":"minutes","value":2},"l2Ttl":{"unit":"hours","value":2},"negativeTtl":{"state":"null"},"resource":"top-articles-frame","securityCritical":false} |
| UserCommentCursor | {"class":"blog","domain":"blog","id":"UserCommentCursor","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"user-comment-cursor","securityCritical":false} |
| UserCommentCursorFrame | {"class":"blog","domain":"blog","id":"UserCommentCursorFrame","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"minutes","value":5},"negativeTtl":{"state":"null"},"resource":"user-comment-cursor-frame","securityCritical":false} |
| UserCommentCursorVersion | {"class":"blog","domain":"blog","id":"UserCommentCursorVersion","l1Ttl":{"unit":"minutes","value":1},"l2Ttl":{"unit":"days","value":7},"negativeTtl":{"state":"null"},"resource":"user-comment-cursor-version","securityCritical":false} |
| VisitLock | {"class":"security-critical","domain":"sec","id":"VisitLock","l1Ttl":{"unit":"seconds","value":0},"l2Ttl":{"unit":"minutes","value":30},"negativeTtl":{"state":"null"},"resource":"visit-lock","securityCritical":true} |
<!-- FSUSBLOG-GENERATED:END api.security-cache-policies -->

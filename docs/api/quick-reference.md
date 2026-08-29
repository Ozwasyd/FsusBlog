# 路由速查表

所有 FsusBlog API 端点的快速索引。

## 图例

| 符号 | 含义 |
| ------ | ------ |
| 🔓 | 匿名可访问 |
| 🔑 | 需要登录（HttpOnly Cookie session / AEDS auth frame） |
| 👑 | 需要 admin 角色 |
| 🚦 | IP 速率限制（fixed_ip 固定窗口） |
| 📦 | Binary 端点（`application/octet-stream`，AEDS v2 帧） |
| 🗄️ | 有输出缓存（L1 内存 + OutputCache） |

---

## 认证 — `/api/binary/auth`

### PoW 与账号入口


### 当前用户


### 会话管理


### MFA / TOTP


---

### Recovery Key


---

## Passkey / WebAuthn — `/api/binary/auth/passkey`


---

## Admin principal / Passkey — `/api/binary/auth/admin`


---

## 公共 HTML 状态

| 请求 | 首响应 | 说明 |
| ------ | -------- | ------ |
| `GET/HEAD /article/{positive-int}` | 200 / 404 / 503 | 仅公开文章为 200；缺失、隐藏、未到发布时间为 404；临时依赖故障为 503 |
| `GET/HEAD /category/{positive-int}` | 200 / 404 / 503 | 不存在分类不生成空 200 SEO 页 |
| `GET/HEAD /tag/{positive-int}` | 200 / 404 / 503 | 唯一标签成功页与 self-canonical；不存在标签不生成空 200 SEO 页 |
| `GET/HEAD /tag/{valid-name}` | 301 / 404 / 503 | 当前名称或持久旧 alias 单跳到 `/tag/{id}`；不产生第二个 200 canonical |
| `GET/HEAD /search[?q&sort&page]` | 200 / 301 / 400 | 首响应始终 noindex；NFC/空白、`relevance` / `latest` / `hot`、`page=1..100` 规范化到唯一 URL，危险超限输入 400 |
| `GET/HEAD /unknown` 或额外 path segment | 404 | 服务器首响应 noindex，不交给 SPA catch-all 改写语义 |
| 除 `/` 外的 `.../` | 301 | 单跳到无尾斜杠 canonical，并保留 query |

400/404/410/503 HTML 固定 `Cache-Control: no-store`、`X-Robots-Tag: noindex, follow`、`X-Fsus-Public-Aot-Backfill: none`；503 额外带 `Retry-After: 5`。负响应不含成功页 canonical、Open Graph URL、`BlogPosting` 或 hydration script。SPA-only `/search`、认证入口与 `/user/**` 不属于此 SEO 成功页集合；搜索成功壳层也不输出 canonical、JSON-LD 或 AOT entry。

Public AOT 成功 HTML 按有效 `fsusblog.locale` cookie > `Accept-Language` > `zh-CN` 协商，只使用共享 catalog 的 canonical code。响应 `Content-Language`、HTML lang/dir、OG、visible copy、payload `renderLocale` 与 cache identity 必须一致，并声明 `Vary: Accept-Language, Cookie`；其它 cookie 仍使 PublicHotRead L0 回常规管线。

## 文章

> 已迁移至 [Binary 端点 — `/api/binary`](#binary-端点--apibinary) 下的 `/api/binary/article/**` AEDS v2 frame。旧 `/api/Article/**` JSON 路径不再注册。

## 评论 — `/api/binary/comment`


---

## 分类 / 标签

> 已迁移至 [Binary 端点 — `/api/binary`](#binary-端点--apibinary) 下的 `/api/binary/category.aeds`、`/api/binary/tag.aeds` AEDS v2 frame。旧 `/api/Category/**`、`/api/Tag/**` JSON 路径不再注册。


PublicHot delivery result 为 `cancelled`、`closed` 或 `failed` 时，上述 mutation 返回 HTTP `500` + AEDS `ApiError(Code=InfraFailure)`，即使 taxonomy 数据库写入可能已经提交。客户端应先重读管理端 taxonomy 状态，再决定是否重试。
无需重启恢复时，修复 Redis 后调用 `/api/binary/author/cache/actions` 的 `public-hot-rebuild` action；保留 pending generation，禁止降级为进程内成功或盲目重放 create。

## 系统配置 — `/api/binary/system`


---

## Integrity verification sidecars — `/integrity`

> 公开 JSON manifest，不属于 `/api/binary/**` AEDS 主链路。

| 方法 | 路径 | 权限 | 缓存 | 说明 |
| ------ | ------ | ------ | ------ | ------ |
| GET | `/integrity/keys.json` | 🔓 | 🗄️ | 公开签名 key registry，不包含 private key |
| GET | `/integrity/article/{articleId}` | 🔓 | 🗄️ | 当前公开文章 publish proof；ready/superseded immutable，其他状态 no-store |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}` | 🔓 | 🗄️ | 指定公开文章 revision number 的 publish proof |
| GET | `/integrity/article/{articleId}/rights` | 🔓 | 🗄️ | 当前公开文章 Rights V3 proof；ready/superseded immutable，其他状态 no-store |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}/rights` | 🔓 | 🗄️ | 指定公开文章 revision number 的 Rights V3 proof |
| GET | `/integrity/article/{articleId}/responsibility` | 🔓 | 🗄️ | 当前责任 manifest；无历史 revision 的公开旧文章返回确定性 legacy fallback |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}/responsibility` | 🔓 | 🗄️ | 指定 revision 的责任 manifest；revision 不存在时返回 404 |
| GET | `/integrity/revisions/{articleRevisionId}` | 🔓 | 🗄️ | 按 `ArticleRevision.Id` 查询 publish proof |
| GET | `/integrity/checkpoints/latest` | 🔓 | 🗄️ | 最新 Merkle checkpoint manifest |
| GET | `/integrity/checkpoints/{date}` | 🔓 | 🗄️ | `yyyy-MM-dd` UTC daily checkpoint manifest |
| GET | `/integrity/log/head` | 🔓 | 🗄️ | transparency log 当前 head |
| GET | `/api/admin/integrity/console` | 👑🚦 | no-store | 后台 Integrity Proof 状态视图，需 `system.config` |
| POST | `/api/admin/integrity/console/proofs/{proofId}/retry` | 👑🚦 step-up | no-store | 重试 failed/retrying/pending proof，需 `system.config` 与 admin step-up |

---

## Binary 端点 — `/api/binary`

> 所有运行时 API 输出 `Content-Type: application/octet-stream`（AEDS v2 帧）。
> 客户端必须优先使用 `/api/binary/**`；旧文本 API 不再注册。

### Binary 路由

| Binary 路径 | 权限 | FrameType | 说明 |
| ------------ | ------ | ----------- | ------ |
| GET `/api/binary/article/list/home/{page}/{size}.aeds?cursor={nextCursor}` | 🔓 📦 | `ArticleList`(1) | 首页文章列表；首屏省略 cursor，后续原样回传 opaque cursor；page URL 保留兼容 |
| GET `/api/binary/article/list/archive/{page}/{size}.aeds?cursor={nextCursor}` | 🔓 📦 | `ArticleList`(1) | 归档文章列表；cursor/page 兼容语义同首页 |
| GET `/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds?cursor={nextCursor}` | 🔓 📦 | `ArticleList`(1) | 分类文章列表；cursor 绑定 category 筛选，不可跨筛选复用 |
| GET `/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds?cursor={nextCursor}` | 🔓 📦 | `ArticleList`(1) | 标签文章列表；cursor 绑定 tag 筛选，不可跨筛选复用 |
| GET `/api/binary/article/{id}.aeds` | 🔓 📦 | `ArticleDetail`(2) | 文章详情 L0 artifact |
| GET `/api/binary/article/hot/{size}.aeds` | 🔓 📦 | `ArticleHot`(3) | 热门文章 L0 artifact |
| GET `/api/binary/category.aeds` | 🔓 📦 | `CategoryList`(9) | 分类元数据 L0 artifact |
| GET `/api/binary/tag.aeds` | 🔓 📦 | `TagList`(10) | 标签元数据 L0 artifact |
| GET `/api/binary/article/html/{pathKey}.html` | 🔓 | `text/html` | AOT HTML 诊断/预览 artifact；不替代真实公开 URL |
| GET `/api/public/navigation-snapshot.aeds?path={publicPath}` | 🔓 📦 | `PublicAotBootstrap`(71) | 公开路由切换快照；携带 versioned/digested `seoHead`；客户端校验 origin/path/entity 后原子接管；`Content-Type: application/vnd.fsus.aeds`；ETag + `Cache-Control: no-cache` 强制重验证 |
| GET `/api/binary/comment/{articleId}` | 🔓 📦 | `CommentArticleCursor`(5) | 文章评论 |
| GET `/api/binary/comment/{articleId}/thread/{rootId}` | 🔓 📦 | `CommentThreadReplyCursor`(8) | 评论线程 |

公开文章 list/detail/search payload 均携带 `currentRevisionId/revisionNo/currentPublicationId/publicationNo`。已发布文章安排未来修订时，上述文章路由在切换点前持续返回旧 publication；定时 worker 原子切换后各投影才进入新坐标。端点不提供“读取最新修订”的公开 fallback。
| GET `/api/binary/comment/me` | 🔑 📦 | `CommentUserCursor`(6) | 当前用户可归因评论记录；可选 `articleId` 形成私有 ownership overlay，强匿名评论不进入账号侧记录 |
| GET `/api/binary/comment/policy` | 🔓 📦 | `CommentPolicySnapshot`(164) | 公开评论 composer 策略与 ZK-Prod readiness |
| POST `/api/binary/comment` | 🔑 🚦 📦 | `CommentCreateV2Request`(166) → `CommentCreateResult`(205) | 仅显式 opt-in 的 public 评论；必需规范小写 UUID `X-Fsus-Client-Mutation-Id`；响应返回 ID、树坐标、创建时间、最终可见状态与 replay 标记 |
| POST `/api/binary/comment/anonymous-ticket` | 🔓 🚦 📦 | `AnonymousCommentTicketRequest`(198) → `AnonymousCommentTicketResponse`(199) | v5/layout 6 最小资格谓词；必须 `credentials: omit`；scope v1 按 article top（1 条/凭据周期）或 article+thread（3 条/凭据周期）绑定，ticket 短 TTL 且一次性消费 |
| POST `/api/binary/comment/anonymous` | 🔓 🚦 📦 | `AnonymousCommentCreateRequest`(182) → `AnonymousCommentCreateResult`(214) | 强匿名评论提交；首次成功响应附带一次性返回的管理 secret，服务端只保存 SHA-256 commitment；幂等 replay 不恢复 secret；拒绝登录态污染 |
| POST `/api/binary/comment/{id}/author/challenge` | 🔑 🚦 📦 | `CommentManagementChallengeRequest`(215) → `CommentManagementChallengeResponse`(216) | public 作者按账号所有权签发一次性 edit/delete challenge，并返回当前版本 |
| POST `/api/binary/comment/{id}/author/edit` | 🔑 🚦 📦 | `CommentAuthorEditRequest`(217) → `CommentAuthorMutationResult`(218) | public 作者按 expectedVersion CAS 编辑并重新审核 |
| POST `/api/binary/comment/{id}/author/delete` | 🔑 🚦 📦 | `CommentAuthorStatusRequest`(219) → `CommentAuthorMutationResult`(218) | public 作者以一次性 challenge 软删除自己的评论 |
| POST `/api/binary/comment/{id}/management/challenge` | 🔓 🚦 📦 | `CommentManagementChallengeRequest`(215) → `CommentManagementChallengeResponse`(216) | 强匿名作者在 body 中提交 capability；不接受 URL 或账号恢复路径 |
| POST `/api/binary/comment/{id}/management/edit` | 🔓 🚦 📦 | `CommentAuthorEditRequest`(217) → `CommentAuthorMutationResult`(218) | 强匿名作者按 capability、challenge 与 expectedVersion 编辑 |
| POST `/api/binary/comment/{id}/management/delete` | 🔓 🚦 📦 | `CommentAuthorStatusRequest`(219) → `CommentAuthorMutationResult`(218) | 强匿名作者以一次性 challenge 删除自己的评论 |
| POST `/api/binary/comment/{id}/management/status` | 🔓 🚦 📦 | `CommentAuthorStatusRequest`(219) → `CommentAuthorStatusResult`(220) | capability-scoped 单评论审核状态读取；不支持枚举 |
| POST `/api/binary/comment/{id}/management/appeal` | 🔓 🚦 📦 | `CommentAuthorAppealRequest`(221) → `CommentAuthorMutationResult`(218) | capability-scoped 申诉；secret/challenge 仅在 no-store body 中传输 |
| POST `/api/binary/comment/{id}/author/appeal` | 🔒 🚦 📦 | `CommentAuthorAppealRequest`(221) → `CommentAuthorMutationResult`(218) | public 作者账号所有权 + 单次 challenge |
| POST `/api/binary/comment/{id}/report` | 🔒 🚦 📦 | `CommentReportRequest`(223) → `CommentReportResult`(224) | 账号按评论去重；不自动隐藏 |
| POST `/api/binary/comment/{id}/anonymous-report` | 🔓 🚦 📦 | `CommentReportRequest`(223) → `CommentReportResult`(224) | 无身份污染；comment-scoped credential HMAC |
| GET `/api/binary/author/comments/{id}/moderation-timeline` | 🛡️ 🚦 📦 | → `CommentModerationTimeline`(225) | admin 重建投影并检查一致性 |
| POST `/api/binary/author/moderation/appeals/{id}/decision` | 🛡️ 🚦 📦 | `CommentAppealDecisionRequest`(226) → `CommentAppealDecisionResult`(227) | 独立复核 + step-up |
| GET `/api/binary/author/comments/{id}/revisions` | 🛡️ 🚦 📦 | `CommentRevisionList`(222) | admin 查看完整修订序列；公共读取永不返回历史正文 |

评论创建的幂等窗口默认 24 小时（`Comments:MutationIdempotencyTtlHours` 限制为 1..168）。public 相同账号/相同 mutation ID、anonymous 相同 ticket 承诺在窗口内最多写入一次；完整结果固定为 `commentId/rootId/parentId/createdAtUtc/moderationStatus/visibilityState/isPubliclyVisible/idempotencyReplay`。`Comments:MutationIdempotencyEnabled=false` 可热重载 fail closed 两类创建并返回 `503 comment_mutation_idempotency_disabled`，读取与 notification stream 不受影响。
| GET `/api/binary/system/seo` | 🔓 📦 | `SeoConfig`(13) | 公开 SEO/品牌/PWA 配置 |
| GET `/api/binary/system/compliance` | 🔓 📦 | `SiteComplianceConfig`(26) | 公开合规 footer 配置 |
| GET `/api/binary/system/page/{slug}` | 🔓 📦 | `PageContent`(14) | 公开静态页内容，slug allowlist 同上 |
| POST `/api/binary/read-proof/challenge.aeds` | 🔓 🚦 📦 | `HumanReadChallengeRequest`(73) → `HumanReadChallengeResponse`(28) | 真人阅读 challenge；受 `read_proof` 限流 |
| POST `/api/binary/read-proof/submit.aeds` | 🔓 🚦 📦 | `HumanReadSubmitRequest`(74) → `HumanReadSubmitResponse`(29) | 真人阅读 proof 提交；raw IP 只同步生成短期 HMAC，去重不可用时丢弃统计 |
| POST `/api/binary/security/challenge` | 🔓 🚦 📦 | `SecurityChallengeIssueRequest`(173) → `SecurityChallengeIssueResponse`(175) | 签发 UUIDv7 envelope，只返回服务端 ordered plan 的首个 actionable member；后续 member 保持 planned；不提供 JSON fallback |
| POST `/api/binary/security/challenge/verify` | 🔓 🚦 📦 | `SecurityChallengeVerifyRequest`(174) → `SecurityChallengeVerifyResponse`(176) | 原子完成当前 member 并签发唯一 next assignment/payload；仅全部完成时返回 aggregate `proofToken` 与权威 `expiresAtUnixMs` |
| POST `/api/binary/security/challenge/cancel` | 🔓 🚦 📦 | `SecurityChallengeCancelRequest`(200) → `EmptySuccess`(240) | refresh/cancel/身份或路由变化/卸载时撤销整个 envelope；完整 binding 不匹配也返回 opaque idempotent success，不提供 JSON fallback |
| `PerceptionCharacterV3` union | 🔓 🚦 📦 | issue: final PNG/Ogg Opus + opaque state；verify: answer + opaque state | `kind=14` typed member；32/48 KiB hard limits；两次原子尝试；无 retired V3/JSON/V1/V2 fallback |
| GET `/api/binary/anonymous-credential/root` | 🔓 🚦 📦 | `AnonymousCredentialRootSnapshot`(179) | 公开 credential root / epoch / expiry / circuit metadata；`public_read` 限流 |
| GET `/api/binary/anonymous-credential/circuit` | 🔓 🚦 📦 | `AnonymousCredentialRootSnapshot`(179) | 同 root snapshot，用于 prover 预热读取 circuit/verifying key metadata |
| POST `/api/binary/anonymous-credential/revocation-witness` | 🔓 🚦 📦 | 固定 `ApiError` / 410 | credential-specific witness 永久 retired；body/参数均不读取 |
| GET `/api/binary/anonymous-credential/revocation/{epoch}/{version}/{root}/full.aeds` | 🔓 🚦 📦 | `AnonymousCredentialRevocationSnapshot`(196) | 所有客户端相同、content-addressed、immutable 的公共 full snapshot；坐标冲突 `409`、未生成 `404`、provider 不可用 `503` |
| GET `/api/binary/anonymous-credential/revocation/{epoch}/{version}/{root}/delta/{baseVersion}.aeds` | 🔓 🚦 📦 | `AnonymousCredentialRevocationDelta`(197) | 公共 append-only delta；客户端仅允许精确上一 version 更新；坐标冲突 `409`、未生成 `404`、provider 不可用 `503` |
| GET `/api/binary/anonymous-credential/blind-issuer` | 🔓 🚦 📦 | `BlindCredentialIssuerMetadata`(193) | RFC 9474 profile、root 绑定、issuer SPKI/hash；`public_read`、`no-store`，runtime disable 时 503 |
| POST `/api/binary/anonymous-credential/blind-issue` | 🔑 🚦 📦 | `BlindCredentialIssueRequest`(194) → `BlindCredentialIssueResponse`(195) | RFC 9474 blind issuance；只接收 384B blinded representative，统一拒绝与延迟桶，`no-store` |
| POST `/api/binary/telemetry/rum` | 🔓 🚦 📦 | `RumMetricBatchRequest`(75) → `RumMetricIngestResponse`(76) | 匿名 RUM 批量 ingestion；`credentials: omit` |

### 管理端 Binary


---

## 消息系统 — `/api/binary/messages`

> 整个路由组需要登录（🔑）。


---

## 管理端消息 — `/api/binary/admin/messages`

> 整个路由组需要 admin 角色（👑）。


`Messages:ReplyWritesEnabled=false` 可动态暂停两个 reply 端点并返回
`503 message_reply_writes_disabled`，不影响读取和显式状态变更。
`Messages:MutationIdempotencyEnabled=false` 可动态 fail closed 创建、两类回复和 system-send，
返回 `503 message_mutation_idempotency_disabled`；不得回退到无 mutation/source identity 写入。
`Messages:AdminAccountProjectionEnabled=false` 可动态暂停两个 admin 读取端点并返回
`503 message_admin_account_projection_disabled`；账号消息端点与原有账号 frame 保持可用。
`Messages:StatusMutationsEnabled=false` 可动态暂停 admin 状态写入并返回
`503 message_status_mutations_disabled`；读取与 notification stream 不受影响。
`Messages:SystemMessageTargetValidationEnabled=false` 可动态 fail closed 新系统消息并返回
`503 system_message_target_validation_disabled`；已提交 source event 的同摘要 replay 仍返回原结果。

## 开放分发与作者工作台

> 作者工作台生产前端调用原生 `/api/binary/author/**` AEDS v2 端点；外部 `/api/author/**` JSON 入口和 internal bridge 兼容层均已移除。
>
> Admin security 生产前端使用原生 `/api/binary/admin/security/**` AEDS v2 入口；外部 `/api/admin/security/**` JSON 入口和 internal bridge 兼容层均已移除。


| POST | `/api/binary/author/drafts` | 👑 | 以 `expectedServerRevision` CAS 保存草稿；返回递增 `serverRevision` 与原始 `baseRevisionId` |
| GET | `/api/binary/author/drafts/{draftKey}` | 👑 | 读取服务端草稿、`serverRevision` 与原始 `baseRevisionId` |
| DELETE | `/api/binary/author/drafts/{draftKey}?expectedServerRevision={revision}` | 👑 | 版本前置条件匹配后丢弃；stale 返回 `draft_conflict` |
| POST | `/api/binary/author/preview` | 👑 | admin-only 结构化私有预览（规范化字段 + source identity + issues；无 HTML） |
| POST | `/api/binary/author/prepublish-check` | 👑 | 发布前 SEO/内容质量检查 |
| GET | `/api/binary/author/articles/{articleId}/revisions` | 👑 | 文章修订列表 |
| GET | `/api/binary/author/articles/{articleId}/revisions/{revisionId}` | 👑 | 完整历史版本包：正文、rights、responsibility 与 release 坐标；缺项通过 `packageComplete` 明示 |
| GET | `/api/binary/author/articles/{articleId}/revisions/{revisionId}/responsibility` | 👑 | `ArticleResponsibilityHistory(228)`；按版本倒序读取 append-only 责任历史 |
| PUT | `/api/binary/author/articles/{articleId}/revisions/{revisionId}/responsibility` | 👑 | 以 `expectedVersion` CAS 追加责任版本；冲突返回 HTTP 409 |
| POST | `/api/binary/author/articles/{articleId}/revisions/{revisionId}/rollback` | 👑 | `ArticleRevisionRollbackRequest(213)` → `MutationId(241)` 48B 强类型结果；提交 base revision、Draft/Published/Archived 目标和审计原因，复制完整历史包到新 revision/release；冲突或不完整包不写入 |
| POST | `/api/binary/author/articles/{articleId}/assets/reindex` | 👑 | 重建资产引用 |
| GET | `/api/binary/author/assets` | 👑 | 资产库列表 |
| DELETE | `/api/binary/author/assets/orphans` | 👑 | 删除孤儿资产库记录 |
| GET | `/api/binary/author/taxonomy/categories` | 👑 | 管理端分类真实引用计数 |
| GET | `/api/binary/author/taxonomy/tags` | 👑 | 管理端标签真实引用计数 |
| GET | `/api/binary/author/analytics` | 👑 | 单作者分析 |
| GET | `/api/binary/author/comments/moderation?status&limit&cursor` | 👑 `comment.moderate` | 稳定 keyset 评论审核队列；响应返回 `nextCursor`、评论/claim row version 与 lease 状态 |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim` | 👑 `comment.moderate` | 抢占审核 lease；活跃 lease 冲突返回 409 |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim/renew` | 👑 `comment.moderate` | 以 token + generation + claim row version 续租 |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim/release` | 👑 `comment.moderate` | 以 token + generation + claim row version 释放 lease |
| POST | `/api/binary/author/comments/moderation/bulk` | 👑 `comment.moderate` 🚦 MFA | 批量评论审核 |
| POST | `/api/binary/author/comments/{commentId}/moderation` | 👑 `comment.moderate` 🚦 MFA | 评论审核 |
| GET | `/api/binary/author/moderation/overview` | 👑 | 审核系统总览 |
| GET | `/api/binary/author/moderation/anonymous-comment-policy` | 👑 | 读取匿名评论策略 |
| PUT | `/api/binary/author/moderation/anonymous-comment-policy` | 👑🚦 MFA | 更新匿名评论策略 |
| POST | `/api/binary/author/comments/moderation/nullifiers/block` | 👑🚦 MFA | 封禁匿名评论 nullifier |
| POST | `/api/binary/author/comments/moderation/anonymous-credentials/{credentialId}/revoke` | 👑🚦 MFA | 撤销匿名凭证 |
| GET | `/api/binary/admin/anonymous-governance/status` | 👑🚦 MFA | 匿名治理后台状态与 root/revocation 聚合 |
| GET | `/api/binary/admin/anonymous-governance/nullifiers` | 👑🚦 MFA | 匿名 nullifier 治理列表，仅展示 masked hash |
| POST | `/api/binary/admin/anonymous-governance/nullifiers/block` | 👑🚦 MFA | 匿名治理后台封禁 nullifier |
| POST | `/api/binary/admin/anonymous-governance/credentials/revoke` | 👑🚦 MFA | 按 revocation handle 撤销匿名凭证 |
| GET | `/api/binary/author/moderation/dictionaries` | 👑 | 只读审核词库和地区策略 snapshot metadata |
| POST | `/api/binary/author/moderation/dictionaries/reload` | 👑🚦 MFA | 手动 reload 审核词库和地区策略 snapshot |
| POST | `/api/binary/author/moderation/dictionaries/rollback` | 👑🚦 MFA | 回滚到上一份成功加载的词库/地区策略 snapshot |
| POST | `/api/binary/author/moderation/dictionaries/{dictionaryId}/enable` | 👑🚦 MFA | 启用运行时词库 override |
| POST | `/api/binary/author/moderation/dictionaries/{dictionaryId}/disable` | 👑🚦 MFA | 禁用运行时词库 override；CN-MAINLAND 强制词库需确认短语 |
| GET | `/api/binary/author/moderation/policies` | 👑 | 地区策略 summary 与 CN-MAINLAND 强制检查 |
| GET | `/api/binary/author/moderation/regions` | 👑 | 地区定义 catalog，含内置/自定义地区和模板绑定 |
| GET | `/api/binary/author/moderation/region-groups` | 👑 | 地区大区 catalog，含成员地区和大区模板 |
| GET | `/api/binary/author/moderation/policy-templates` | 👑 | 默认/自定义策略模板 presets、review marker 和 checksum |
| GET | `/api/binary/author/moderation/effective-policy/{regionCode}` | 👑🚦 | 指定地区 effective policy preview |
| POST | `/api/binary/author/moderation/effective-policy/preview` | 👑🚦 | 带 operator override 的 effective policy preview |
| POST | `/api/binary/author/moderation/replay/preview` | 👑🚦 | 策略回放 preview diff，不执行变更 |
| GET | `/api/binary/author/moderation/runtime/status` | 👑 | 审核运行时全局/地区/词库/模型状态 |
| POST | `/api/binary/author/moderation/runtime/global-state` | 👑🚦 MFA | 调整全局审核运行状态 |
| POST | `/api/binary/author/moderation/runtime/region-state` | 👑🚦 MFA | 调整地区审核运行状态并清理评论 frame 缓存 |
| GET | `/api/binary/author/moderation/model/status` | 👑 | 审核模型配置与 latency/error 观测 |
| POST | `/api/binary/author/moderation/model/runtime` | 👑🚦 MFA | 热切换模型 provider/profile/启停状态 |
| POST | `/api/binary/author/moderation/model/reload` | 👑🚦 MFA | 从配置热重载模型运行快照 |
| POST | `/api/binary/author/moderation/model/rollback` | 👑🚦 MFA | 回滚上一份模型运行快照 |
| GET | `/api/binary/admin/security/overview` | 👑 | 安全系统总览：AntiCrawler、PoW、SecurityRisk |
| GET | `/api/binary/admin/security/risk-control/overview` | 👑 | RiskControl active policy、风险事件聚合、challenge 成功/失败率 |
| GET | `/api/binary/admin/security/risk-control/options` | 👑 | RiskControl active runtime policy snapshot |
| PUT | `/api/binary/admin/security/risk-control/options` | 👑🚦 MFA | 更新 RiskControl mode、PoSpace/PublicRead/Comment/Auth 开关和 strict multiplier |
| POST | `/api/binary/admin/security/risk-control/options/rollback` | 👑🚦 MFA | 回滚上一份 RiskControl last-known-good policy |
| POST | `/api/binary/admin/security/risk-control/simulate` | 👑🚦 | RiskControl dry-run：调用生产决策链返回 riskScore、decision、reasons、requiredChallenges、policyVersion，不签发 challenge、不改风险分 |
| GET | `/api/binary/admin/security/challenges/overview?kind={kind}` | 👑 | challenge 签发、尝试、成功/失败率；`kind` 只接受当前 provider wire kind |
| GET | `/api/binary/admin/security/policies/overview` | 👑 | active RiskControl、AntiCrawler、PoW 与持久化策略版本 |
| GET | `/api/binary/admin/security/anti-crawler/overview` | 👑 | 反爬虫总览、CIDR、风险事件、规则与 list |
| GET | `/api/binary/admin/security/anti-crawler/options` | 👑 | 反爬虫运行策略快照 |
| PUT | `/api/binary/admin/security/anti-crawler/options` | 👑🚦 MFA | 更新 AntiCrawler mode、局部开关、阈值、限流额度和 CIDR 更新配置 |
| POST | `/api/binary/admin/security/anti-crawler/options/rollback` | 👑🚦 MFA | 回滚上一份反爬虫策略快照 |
| GET | `/api/binary/admin/security/anti-crawler/crawler-ranges/status` | 👑 | CIDR worker 状态、更新时间、下次同步和 range 数量 |
| POST | `/api/binary/admin/security/anti-crawler/crawler-ranges/sync` | 👑🚦 MFA | 手动同步 Google/Bing crawler CIDR |
| GET | `/api/binary/admin/security/anti-crawler/risk-events` | 👑 | 反爬虫风险事件列表；`limit` clamp 到 1..1000 |
| GET | `/api/binary/admin/security/anti-crawler/rules` | 👑 | 反爬虫规则列表 |
| POST | `/api/binary/admin/security/anti-crawler/rules` | 👑🚦 MFA | 新增反爬虫规则 |
| PUT | `/api/binary/admin/security/anti-crawler/rules/{id}` | 👑🚦 MFA | 更新反爬虫规则 |
| DELETE | `/api/binary/admin/security/anti-crawler/rules/{id}` | 👑🚦 MFA | 删除反爬虫规则 |
| GET | `/api/binary/admin/security/anti-crawler/allowlist` | 👑 | 反爬虫 allowlist |
| POST | `/api/binary/admin/security/anti-crawler/allowlist` | 👑🚦 MFA | 新增 allowlist 条目 |
| DELETE | `/api/binary/admin/security/anti-crawler/allowlist/{id}` | 👑🚦 MFA | 删除 allowlist 条目 |
| GET | `/api/binary/admin/security/anti-crawler/blocklist` | 👑 | 反爬虫 blocklist |
| POST | `/api/binary/admin/security/anti-crawler/blocklist` | 👑🚦 MFA | 新增 blocklist 条目 |
| DELETE | `/api/binary/admin/security/anti-crawler/blocklist/{id}` | 👑🚦 MFA | 删除 blocklist 条目 |
| POST | `/api/binary/admin/security/anti-crawler/simulate` | 👑🚦 | 反爬虫策略模拟器，不执行变更 |
| GET | `/api/binary/admin/security/pow/overview` | 👑 | PoW 系统总览 |
| GET | `/api/binary/admin/security/pow/options` | 👑 | PoW 独立策略快照 |
| PUT | `/api/binary/admin/security/pow/options` | 👑🚦 MFA | 更新 PoW mode、difficulty、TTL、replay 和风险联动 |
| POST | `/api/binary/admin/security/pow/options/rollback` | 👑🚦 MFA | 回滚上一份 PoW 策略快照 |
| GET | `/api/binary/admin/security/pow/events` | 👑 | PoW 风险事件；`limit` clamp 到 1..1000 |
| GET | `/api/binary/admin/security/risk/events` | 👑 | 统一安全风险事件；`limit` clamp 到 1..1000 |
| GET | `/api/binary/admin/security/risk/snapshots` | 👑 | 统一安全风险主体快照；`limit` clamp 到 1..1000 |
| POST | `/api/binary/admin/security/risk/ip/reset` | 👑🚦 MFA | 重置指定 IP 风险分 |
| GET | `/api/binary/author/content/export` | 👑 | 全站内容备份包 |
| GET | `/api/binary/author/articles/{articleId}/export` | 👑 | 导出 Markdown + frontmatter |
| POST | `/api/binary/author/articles/import` | 👑 | create-new 导入 Markdown + frontmatter，不按 source article ID 覆盖现有文章；未提供 rights 时绑定默认策略 snapshot |
| GET | `/api/binary/author/audit` | 👑🚦 | 审计日志 cursor 列表，支持 actor/action/target/outcome/time 过滤 |
| GET | `/api/binary/author/audit/summary` | 👑🚦 | 审计 facet 汇总与写入 runtime |
| GET | `/api/binary/author/audit/{id}` | 👑🚦 | 审计详情与 context |
| GET | `/api/binary/author/audit/{id}/verify` | 👑🚦 | 单条防篡改证据校验 |
| GET | `/api/binary/author/ops/health` | 👑🚦 | 运维健康：DB/Redis/audit/worker/search/backup/队列/结构化最近错误 |
| GET | `/api/binary/author/ops/backup` | 👑🚦 | 最近站点备份和 restore drill 状态 |
| GET | `/api/binary/author/ops/dangerous-operations/policy` | 👑🚦 | 管理端危险操作确认、MFA 与 diff 策略 |
| GET | `/api/binary/author/cache/diagnostics` | 👑🚦 | AOT/PublicHotRead/search/sitemap/feed/comment cache 与 HotArticles/Stats 失效合并状态 |
| POST | `/api/binary/author/cache/actions` | 👑🚦 | 手动重建 search/AOT 或清理 output cache |
| GET | `/api/binary/author/integrity` | 👑🚦 | 数据一致性巡检报告 |
| GET | `/api/binary/author/integrity/fix-preview` | 👑🚦 | 安全修复 diff 预览 |
| POST | `/api/binary/author/integrity/fix` | 👑🚦 step-up | 应用安全修复，要求确认短语和 admin step-up proof |
| POST | `/api/binary/author/ai-assist` | 👑 | 默认关闭的作者 AI 辅助 |

---

## 通知与健康检查


通知通道是 AEDS WebSocket notification stream，不是标准 Server-Sent Events，不使用 `EventSource` 或 `text/event-stream`。
`ArticleChanged(8)` 的 v2 payload 携带可空 `revisionId/releaseId` 精确坐标；前端按 decimal string 接收 int64。发送前坐标已 superseded 时该事件不发布，outbox 将剩余 edge 记为 skipped。
账号 Passkey counter 回滚会在全部普通会话持久撤销后发布 `NotificationStreamEventType.SessionRevoked=16`；浏览器立即清除普通账号态并跨 tab 强制重新认证，独立 admin session 不随之撤销。

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

## 文章/线程评论策略

| 端点 | 认证 | 响应 | 用途 |
|---|---|---|---|
| GET `/api/binary/comment/policy?articleId=&rootId=` | 🔓 📦 | `CommentPolicySnapshot`(164) | 全站→文章→线程有效 composer 策略 |
| GET/PUT `/api/authoring/moderation/articles/{articleId}/comment-policy` | 🔐 📦 | `CommentPolicySnapshot`(164) envelope | admin 文章 override、审核/慢速模式与乐观版本 |
| PUT `/api/authoring/moderation/articles/{articleId}/comment-threads/{rootId}` | 🔐 📦 | `CommentPolicySnapshot`(164) envelope | admin 单线程锁定/解锁与审计 |

## Cluster operations

| 方法与路径 | 权限 | 响应 | 说明 |
| --- | --- | --- | --- |
| GET `/api/ops/cluster/nodes` | independent admin principal + `system.config` + `fixed_ip` | JSON cluster runtime snapshot, `no-store` | 节点、职责状态、lease/checkpoint 摘要、事件、健康与指标；single 返回本地健康节点 |
| POST `/api/ops/cluster/nodes/{nodeId}/state` | 同上 + trusted origin + `X-Fsus-Mfa-Proof` | JSON node state, `no-store` | 仅 `alive|draining|maintenance` |
| POST `/api/ops/cluster/scheduler` | 同上 + trusted origin + `X-Fsus-Mfa-Proof` | JSON scheduling latch, `no-store` | 无重启停止/恢复新职责调度 |
| POST `/api/ops/cluster/leases/{leaseId}/release-expired` | 同上 + trusted origin + `X-Fsus-Mfa-Proof` | JSON release result, `no-store` | 只清理已过期 lease，不允许强制释放 active lease |

## Plugin Admin

## Current operation identities

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.operation-keys
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.operation-keys
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.operation-keys -->
- `DELETE /api/binary/admin/article/permanent/{id:int}`
- `DELETE /api/binary/admin/article/trash`
- `DELETE /api/binary/admin/article/{id:int}`
- `DELETE /api/binary/admin/security/anti-crawler/allowlist/{id}`
- `DELETE /api/binary/admin/security/anti-crawler/blocklist/{id}`
- `DELETE /api/binary/admin/security/anti-crawler/rules/{id}`
- `DELETE /api/binary/auth/passkey/credentials/{id:int}`
- `DELETE /api/binary/author/assets/orphans`
- `DELETE /api/binary/author/drafts/{draftKey}`
- `DELETE /api/binary/category/{id:int}`
- `DELETE /api/binary/comment/{id:long}`
- `DELETE /api/binary/file/delete`
- `DELETE /api/binary/subscriptions`
- `DELETE /api/binary/tag/{id:int}`
- `DELETE /api/binary/upload/{uploadId}`
- `GET /api/binary/admin/anonymous-governance/nullifiers`
- `GET /api/binary/admin/anonymous-governance/status`
- `GET /api/binary/admin/article`
- `GET /api/binary/admin/article/featured`
- `GET /api/binary/admin/article/hot`
- `GET /api/binary/admin/article/{id:int}`
- `GET /api/binary/admin/messages/conversations`
- `GET /api/binary/admin/messages/conversations/{id:long}`
- `GET /api/binary/admin/security/anti-crawler/allowlist`
- `GET /api/binary/admin/security/anti-crawler/blocklist`
- `GET /api/binary/admin/security/anti-crawler/crawler-ranges/status`
- `GET /api/binary/admin/security/anti-crawler/events`
- `GET /api/binary/admin/security/anti-crawler/options`
- `GET /api/binary/admin/security/anti-crawler/overview`
- `GET /api/binary/admin/security/anti-crawler/risk-events`
- `GET /api/binary/admin/security/anti-crawler/rules`
- `GET /api/binary/admin/security/challenges/overview`
- `GET /api/binary/admin/security/overview`
- `GET /api/binary/admin/security/perception-v2/options`
- `GET /api/binary/admin/security/perception-v2/overview`
- `GET /api/binary/admin/security/policies/overview`
- `GET /api/binary/admin/security/pow/events`
- `GET /api/binary/admin/security/pow/options`
- `GET /api/binary/admin/security/pow/overview`
- `GET /api/binary/admin/security/risk-control/options`
- `GET /api/binary/admin/security/risk-control/overview`
- `GET /api/binary/admin/security/risk/events`
- `GET /api/binary/admin/security/risk/snapshots`
- `GET /api/binary/admin/users`
- `GET /api/binary/anonymous-credential/blind-issuer`
- `GET /api/binary/anonymous-credential/circuit`
- `GET /api/binary/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/delta/{baseVersion:long}.aeds`
- `GET /api/binary/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/full.aeds`
- `GET /api/binary/anonymous-credential/root`
- `GET /api/binary/article/featured/{size}.aeds`
- `GET /api/binary/article/hot/{size}.aeds`
- `GET /api/binary/article/list/archive/{page:int}/{size:int}.aeds`
- `GET /api/binary/article/list/category/{categoryId:int}/{page:int}/{size:int}.aeds`
- `GET /api/binary/article/list/home/{page:int}/{size:int}.aeds`
- `GET /api/binary/article/list/tag/{tagId:int}/{page:int}/{size:int}.aeds`
- `GET /api/binary/article/{articleId:int}/related.aeds`
- `GET /api/binary/article/{id}.aeds`
- `GET /api/binary/auth/admin/me`
- `GET /api/binary/auth/admin/sessions`
- `GET /api/binary/auth/enrollment/status`
- `GET /api/binary/auth/me`
- `GET /api/binary/auth/mfa/profile`
- `GET /api/binary/auth/passkey/credentials`
- `GET /api/binary/auth/passkey/signal-state`
- `GET /api/binary/auth/pow-challenge`
- `GET /api/binary/auth/sessions`
- `GET /api/binary/auth/{id:int}`
- `GET /api/binary/author/analytics`
- `GET /api/binary/author/articles/{articleId:int}/export`
- `GET /api/binary/author/articles/{articleId:int}/revisions`
- `GET /api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}`
- `GET /api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/responsibility`
- `GET /api/binary/author/assets`
- `GET /api/binary/author/audit`
- `GET /api/binary/author/audit/summary`
- `GET /api/binary/author/audit/{id:long}`
- `GET /api/binary/author/audit/{id:long}/verify`
- `GET /api/binary/author/cache/diagnostics`
- `GET /api/binary/author/comments/moderation`
- `GET /api/binary/author/comments/{commentId:long}/moderation-timeline`
- `GET /api/binary/author/comments/{commentId:long}/revisions`
- `GET /api/binary/author/content/export`
- `GET /api/binary/author/drafts/{draftKey}`
- `GET /api/binary/author/integrity`
- `GET /api/binary/author/integrity/fix-preview`
- `GET /api/binary/author/moderation/anonymous-comment-policy`
- `GET /api/binary/author/moderation/articles/{articleId:int}/comment-policy`
- `GET /api/binary/author/moderation/dictionaries`
- `GET /api/binary/author/moderation/effective-policy/{regionCode}`
- `GET /api/binary/author/moderation/model/status`
- `GET /api/binary/author/moderation/overview`
- `GET /api/binary/author/moderation/policies`
- `GET /api/binary/author/moderation/policy-templates`
- `GET /api/binary/author/moderation/region-groups`
- `GET /api/binary/author/moderation/regions`
- `GET /api/binary/author/moderation/runtime/status`
- `GET /api/binary/author/ops/backup`
- `GET /api/binary/author/ops/dangerous-operations/policy`
- `GET /api/binary/author/ops/health`
- `GET /api/binary/author/plugins`
- `GET /api/binary/author/plugins/{pluginId}`
- `GET /api/binary/author/taxonomy/categories`
- `GET /api/binary/author/taxonomy/tags`
- `GET /api/binary/category`
- `GET /api/binary/category.aeds`
- `GET /api/binary/comment/me`
- `GET /api/binary/comment/policy`
- `GET /api/binary/comment/{articleId:int}`
- `GET /api/binary/comment/{articleId:int}/children/{parentId:long}`
- `GET /api/binary/comment/{articleId:int}/context/{commentId:long}`
- `GET /api/binary/comment/{articleId:int}/thread/{rootId:long}`
- `GET /api/binary/locale-preference`
- `GET /api/binary/messages/conversations`
- `GET /api/binary/messages/conversations/{id:long}`
- `GET /api/binary/stats`
- `GET /api/binary/stats/recent-comments`
- `GET /api/binary/stats/regions`
- `GET /api/binary/system/admin/compliance`
- `GET /api/binary/system/admin/page/{slug}`
- `GET /api/binary/system/admin/seo`
- `GET /api/binary/system/compliance`
- `GET /api/binary/system/page/{slug}`
- `GET /api/binary/system/seo`
- `GET /api/binary/tag`
- `GET /api/binary/tag.aeds`
- `GET /api/binary/upload/{uploadId}/status`
- `GET /api/binary/upload/{uploadId}/status/parts`
- `POST /api/binary/admin/anonymous-governance/credentials/revoke`
- `POST /api/binary/admin/anonymous-governance/nullifiers/block`
- `POST /api/binary/admin/article`
- `POST /api/binary/admin/messages/conversations/{id:long}/reply`
- `POST /api/binary/admin/messages/conversations/{id:long}/status`
- `POST /api/binary/admin/messages/system-send`
- `POST /api/binary/admin/security/anti-crawler/allowlist`
- `POST /api/binary/admin/security/anti-crawler/blocklist`
- `POST /api/binary/admin/security/anti-crawler/crawler-ranges/sync`
- `POST /api/binary/admin/security/anti-crawler/options/rollback`
- `POST /api/binary/admin/security/anti-crawler/rules`
- `POST /api/binary/admin/security/anti-crawler/simulate`
- `POST /api/binary/admin/security/perception-v2/options/rollback`
- `POST /api/binary/admin/security/pow/options/rollback`
- `POST /api/binary/admin/security/pow/simulate`
- `POST /api/binary/admin/security/risk-control/options/rollback`
- `POST /api/binary/admin/security/risk-control/simulate`
- `POST /api/binary/admin/security/risk/{dimension}/reset`
- `POST /api/binary/anonymous-credential/blind-issue`
- `POST /api/binary/anonymous-credential/revocation-witness`
- `POST /api/binary/auth/admin/bootstrap/passkey/begin`
- `POST /api/binary/auth/admin/bootstrap/passkey/complete`
- `POST /api/binary/auth/admin/login/passkey/begin`
- `POST /api/binary/auth/admin/login/passkey/complete`
- `POST /api/binary/auth/admin/logout`
- `POST /api/binary/auth/admin/sessions/revoke-others`
- `POST /api/binary/auth/admin/sessions/{sessionId}/revoke`
- `POST /api/binary/auth/admin/step-up/passkey/begin`
- `POST /api/binary/auth/admin/step-up/passkey/complete`
- `POST /api/binary/auth/anonymous/bootstrap`
- `POST /api/binary/auth/delete-account`
- `POST /api/binary/auth/enrollment/cancel`
- `POST /api/binary/auth/enrollment/passkey/register/begin`
- `POST /api/binary/auth/enrollment/passkey/register/complete`
- `POST /api/binary/auth/logout`
- `POST /api/binary/auth/mfa/challenge`
- `POST /api/binary/auth/mfa/challenge/start`
- `POST /api/binary/auth/mfa/disable`
- `POST /api/binary/auth/mfa/recovery/regenerate`
- `POST /api/binary/auth/mfa/setup/start`
- `POST /api/binary/auth/mfa/setup/verify`
- `POST /api/binary/auth/passkey/login/begin`
- `POST /api/binary/auth/passkey/login/complete`
- `POST /api/binary/auth/passkey/register/begin`
- `POST /api/binary/auth/passkey/register/complete`
- `POST /api/binary/auth/recovery-key/create`
- `POST /api/binary/auth/recovery-key/passkey/register/begin`
- `POST /api/binary/auth/recovery-key/passkey/register/complete`
- `POST /api/binary/auth/recovery-key/rotate`
- `POST /api/binary/auth/recovery-key/verify`
- `POST /api/binary/auth/refresh-token`
- `POST /api/binary/auth/sessions/revoke-others`
- `POST /api/binary/auth/sessions/{id}/revoke`
- `POST /api/binary/auth/step-up/passkey/begin`
- `POST /api/binary/auth/step-up/passkey/complete`
- `POST /api/binary/author/ai-assist`
- `POST /api/binary/author/articles/import`
- `POST /api/binary/author/articles/{articleId:int}/assets/reindex`
- `POST /api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/rollback`
- `POST /api/binary/author/cache/actions`
- `POST /api/binary/author/comments/moderation/anonymous-credentials/{credentialId:long}/revoke`
- `POST /api/binary/author/comments/moderation/bulk`
- `POST /api/binary/author/comments/moderation/nullifiers/block`
- `POST /api/binary/author/comments/{commentId:long}/moderation`
- `POST /api/binary/author/comments/{commentId:long}/moderation/claim`
- `POST /api/binary/author/comments/{commentId:long}/moderation/claim/release`
- `POST /api/binary/author/comments/{commentId:long}/moderation/claim/renew`
- `POST /api/binary/author/drafts`
- `POST /api/binary/author/integrity/fix`
- `POST /api/binary/author/moderation/appeals/{appealId:long}/decision`
- `POST /api/binary/author/moderation/dictionaries/reload`
- `POST /api/binary/author/moderation/dictionaries/rollback`
- `POST /api/binary/author/moderation/dictionaries/{dictionaryId}/disable`
- `POST /api/binary/author/moderation/dictionaries/{dictionaryId}/enable`
- `POST /api/binary/author/moderation/effective-policy/preview`
- `POST /api/binary/author/moderation/model/reload`
- `POST /api/binary/author/moderation/model/rollback`
- `POST /api/binary/author/moderation/model/runtime`
- `POST /api/binary/author/moderation/replay/preview`
- `POST /api/binary/author/moderation/runtime/global-state`
- `POST /api/binary/author/moderation/runtime/region-state`
- `POST /api/binary/author/plugins/install`
- `POST /api/binary/author/plugins/{pluginId}/actions`
- `POST /api/binary/author/prepublish-check`
- `POST /api/binary/author/preview`
- `POST /api/binary/category`
- `POST /api/binary/comment`
- `POST /api/binary/comment/anonymous`
- `POST /api/binary/comment/anonymous-ticket`
- `POST /api/binary/comment/{id:long}/anonymous-report`
- `POST /api/binary/comment/{id:long}/author/appeal`
- `POST /api/binary/comment/{id:long}/author/challenge`
- `POST /api/binary/comment/{id:long}/author/delete`
- `POST /api/binary/comment/{id:long}/author/edit`
- `POST /api/binary/comment/{id:long}/management/appeal`
- `POST /api/binary/comment/{id:long}/management/challenge`
- `POST /api/binary/comment/{id:long}/management/delete`
- `POST /api/binary/comment/{id:long}/management/edit`
- `POST /api/binary/comment/{id:long}/management/status`
- `POST /api/binary/comment/{id:long}/report`
- `POST /api/binary/messages/conversations`
- `POST /api/binary/messages/conversations/{id:long}/read`
- `POST /api/binary/messages/conversations/{id:long}/reply`
- `POST /api/binary/read-proof/challenge.aeds`
- `POST /api/binary/read-proof/submit.aeds`
- `POST /api/binary/security/challenge`
- `POST /api/binary/security/challenge/cancel`
- `POST /api/binary/security/challenge/verify`
- `POST /api/binary/subscriptions`
- `POST /api/binary/system/page/refresh/{slug}`
- `POST /api/binary/tag`
- `POST /api/binary/telemetry/rum`
- `POST /api/binary/upload/init`
- `POST /api/binary/upload/{uploadId}/complete`
- `PUT /api/binary/admin/article/restore/{id:int}`
- `PUT /api/binary/admin/article/{id:int}`
- `PUT /api/binary/admin/security/anti-crawler/options`
- `PUT /api/binary/admin/security/anti-crawler/rules/{id}`
- `PUT /api/binary/admin/security/perception-v2/options`
- `PUT /api/binary/admin/security/pow/options`
- `PUT /api/binary/admin/security/risk-control/options`
- `PUT /api/binary/admin/users/status`
- `PUT /api/binary/auth/passkey/credentials/{id:int}/name`
- `PUT /api/binary/auth/public-handle`
- `PUT /api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/responsibility`
- `PUT /api/binary/author/moderation/anonymous-comment-policy`
- `PUT /api/binary/author/moderation/articles/{articleId:int}/comment-policy`
- `PUT /api/binary/author/moderation/articles/{articleId:int}/comment-threads/{rootId:long}`
- `PUT /api/binary/category/{id:int}`
- `PUT /api/binary/locale-preference`
- `PUT /api/binary/system/compliance`
- `PUT /api/binary/system/page`
- `PUT /api/binary/system/seo`
- `PUT /api/binary/tag/{id:int}`
- `PUT /api/binary/upload/{uploadId}/part`
<!-- FSUSBLOG-GENERATED:END api.operation-keys -->

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

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/auth/pow-challenge` | 🔓 🚦 📦 | 获取 PoW 挑战 |
| POST | `/api/binary/auth/anonymous/bootstrap` | 🔓 🚦 📦 | 创建 provisional 账号和短期 enrollment cookie；不写正式 session，不接受密码 |
| POST | `/api/binary/auth/enrollment/passkey/register/begin` | 🔓 🚦 📦 | 仅凭 enrollment cookie 开始首枚 Passkey 注册 |
| POST | `/api/binary/auth/enrollment/passkey/register/complete` | 🔓 🚦 📦 | 原子提交首枚 Passkey、active 状态和正式 session；响应 `AuthLoginFlow` |
| GET | `/api/binary/auth/enrollment/status` | 🔓 🚦 📦 | 查询短期 enrollment 状态，不签发正式凭据 |
| POST | `/api/binary/auth/enrollment/cancel` | 🔓 🚦 📦 | 取消并清理仍为 provisional 的账号和 challenge |
| POST | `/api/binary/auth/refresh-token` | 🔓 🚦 📦 | 用 HttpOnly Cookie 原子轮换 refresh family generation；成功返回 `EmptySuccess`，同一 CAS 的 loser 返回 `409 REFRESH_ROTATION_CONFLICT`，已使用 token replay 会撤销其 family；网络未知结果不得自动重放 POST |

### 当前用户

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/auth/me` | 🔑 📦 | 获取当前匿名账号容器快照；成功响应带 `X-Fsus-Access-Expires-At-Utc` 绝对到期时间，前端据此协调跨标签页刷新 |
| PUT | `/api/binary/auth/public-handle` | 🔑 📦 | 保存或清空当前匿名账号公开称呼 |
| POST | `/api/binary/auth/logout` | 🔑 📦 | 安全登出（吊销当前 Refresh Token） |
| POST | `/api/binary/auth/delete-account` | 🔑 🚦 📦 | 注销账号；请求 frame 只含确认文本，敏感操作 proof 走 `X-Fsus-Mfa-Proof` |

### 会话管理

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| GET | `/api/binary/auth/sessions` | 🔑 📦 | 获取隐私安全的活跃会话列表（粗粒度设备、认证来源/强度、持续时间） |
| POST | `/api/binary/auth/sessions/{id}/revoke` | 🔑 📦 | 吊销指定会话 |
| POST | `/api/binary/auth/sessions/revoke-others` | 🔑 📦 | 吊销全部其他会话 |

### MFA / TOTP

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| POST | `/api/binary/auth/mfa/setup/start` | 🔑 📦 | 开始 MFA 设置，返回 TOTP 密钥与二维码 |
| POST | `/api/binary/auth/mfa/setup/verify` | 🔑 📦 | 验证 TOTP 码，完成 MFA 启用 |
| GET | `/api/binary/auth/mfa/profile` | 🔑 📦 | 查询 MFA 状态与恢复码剩余数 |
| POST | `/api/binary/auth/mfa/disable` | 🔑 📦 | 禁用 MFA |
| POST | `/api/binary/auth/mfa/recovery/regenerate` | 🔑 📦 | 重新生成恢复码 |
| POST | `/api/binary/auth/mfa/challenge/start` | 🔑 📦 | 登录后发起 MFA 挑战（返回挑战令牌） |
| POST | `/api/binary/auth/mfa/challenge` | 🔓 📦 | 提交 TOTP 码或恢复码完成 MFA |
| POST | `/api/binary/auth/step-up/passkey/begin` | 🔑 📦 | 普通账号敏感操作 Passkey step-up 开始；`Auth:PasskeyStepUp:Enabled=false` 时 503 fail closed |
| POST | `/api/binary/auth/step-up/passkey/complete` | 🔑 📦 | 完成普通账号 Passkey step-up，返回同 action 的一次性 `MfaChallengeResult.proofToken`；同受 `Auth:PasskeyStepUp:Enabled` 控制 |

---

### Recovery Key

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| POST | `/api/binary/auth/recovery-key/create` | 🔑 🚦 📦 | 创建账户恢复密钥，明文只在响应中返回一次 |
| POST | `/api/binary/auth/recovery-key/rotate` | 🔑 🚦 📦 | 轮换账户恢复密钥 |
| POST | `/api/binary/auth/recovery-key/verify` | 🔓 🚦 📦 | 验证恢复密钥并返回短期 recovery session；RiskControl proof 与 legacy PoW 均由统一 transport 附加 |
| POST | `/api/binary/auth/recovery-key/passkey/register/begin` | 🔓 🚦 📦 | 使用 recovery session 开始绑定新 Passkey |
| POST | `/api/binary/auth/recovery-key/passkey/register/complete` | 🔓 🚦 📦 | 使用 recovery session 完成新 Passkey 绑定 |

---

## Passkey / WebAuthn — `/api/binary/auth/passkey`

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| POST | `/api/binary/auth/passkey/register/begin` | 🔑 | 开始注册 Passkey |
| POST | `/api/binary/auth/passkey/register/complete` | 🔑 | 完成 Passkey 注册 |
| POST | `/api/binary/auth/passkey/login/begin` | 🔓 🚦 | 开始 Passkey 无密码登录；使用 challenge-aware command 的 `auth.passkey.begin` proof |
| POST | `/api/binary/auth/passkey/login/complete` | 🔓 🚦 | 完成 Passkey 登录断言；固定 challenge token mutation identity 后使用 `auth.passkey.complete` proof |
| GET | `/api/binary/auth/passkey/credentials` | 🔑 | 获取已注册 Passkey 列表（最多 5 枚） |
| GET | `/api/binary/auth/passkey/signal-state` | 🔑 | 获取 WebAuthn Signal API 所需的服务端权威凭证集与账号元数据（`no-store`） |
| DELETE | `/api/binary/auth/passkey/credentials/{id}` | 🔑 | 删除指定 Passkey |
| PUT | `/api/binary/auth/passkey/credentials/{id}/name` | 🔑 | 重命名指定 Passkey |

---

## Admin principal / Passkey — `/api/binary/auth/admin`

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| POST | `/api/binary/auth/admin/bootstrap/passkey/begin` | 🔓 🚦 📦 | 首次 root admin Passkey 注册开始；必须带 `X-Fsus-Admin-Bootstrap-Token` 和 `X-Fsus-Admin-Handle` |
| POST | `/api/binary/auth/admin/bootstrap/passkey/complete` | 🔓 🚦 📦 | 首次 root admin Passkey 注册完成；root admin 已存在后拒绝 |
| POST | `/api/binary/auth/admin/login/passkey/begin` | 🔓 🚦 📦 | admin Passkey 登录开始 |
| POST | `/api/binary/auth/admin/login/passkey/complete` | 🔓 🚦 📦 | admin Passkey 登录完成并写入独立 admin Cookie |
| POST | `/api/binary/auth/admin/step-up/passkey/begin` | 👑 🚦 📦 | 当前 admin session 的 Passkey step-up 开始，响应 `PasskeyLoginBegin` |
| POST | `/api/binary/auth/admin/step-up/passkey/complete` | 👑 🚦 📦 | 完成 admin Passkey step-up，响应 action=`admin-sensitive` 的一次性 proof |
| GET | `/api/binary/auth/admin/me` | 👑 📦 | 返回当前 admin principal 快照（`AdminPrincipalSnapshot`），需要 `admin.manage` permission |
| POST | `/api/binary/auth/admin/logout` | 👑 📦 | 登出当前 admin session，撤销 `admin_session` 并清理 admin Cookie |
| GET | `/api/binary/auth/admin/sessions` | 👑 📦 | 获取当前 admin principal 的 session 列表 |
| POST | `/api/binary/auth/admin/sessions/{sessionId}/revoke` | 👑 📦 | 撤销指定 admin session |
| POST | `/api/binary/auth/admin/sessions/revoke-others` | 👑 📦 | 撤销除当前 session 外的其他 admin sessions |

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

## 文章 — `/api/Article`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
| ------ | ------ | ------ | ------ | ------ |
| GET | `/api/Article/` | 🔓 | 🗄️ | 文章列表（分页），查询参数：`page`、`pageSize`、`categoryId`、`tagId` |
| GET | `/api/Article/{id}` | 🔓 | 🗄️ | 文章详情 |
| GET | `/api/Article/hot` | 🔓 | 🗄️ | 热门文章列表 |

---

## 评论 — `/api/binary/comment`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
| ------ | ------ | ------ | ------ | ------ |
| GET | `/api/binary/comment/{articleId}` | 🔓 | 🗄️ | 根节点 keyset 页 + 直接子节点预览，`CommentTreeRootCursor(208)` |
| GET | `/api/binary/comment/{articleId}/children/{parentId}` | 🔓 | 🗄️ | 单个父节点的直接子节点 keyset 页，`CommentChildCursor(209)` |
| GET | `/api/binary/comment/{articleId}/context/{commentId}` | 🔓 | 🗄️ | 永久链接祖先路径、目标和兄弟窗口；不可见目标统一 `unavailable`，`CommentPermalinkContext(210)` |
| GET | `/api/binary/comment/{articleId}/thread/{rootId}` | 🔓 | 🗄️ | 滚动部署兼容的旧 binary 扁平回复游标 |
| GET | `/api/binary/comment/me` | 🔑 | — | 当前用户可归因评论记录 |

---

## 分类 — `/api/Category`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
| ------ | ------ | ------ | ------ | ------ |
| GET | `/api/Category/` | 🔓 | 🗄️ | 所有分类列表 |

---

## 标签 — `/api/Tag`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
| ------ | ------ | ------ | ------ | ------ |
| GET | `/api/Tag/` | 🔓 | 🗄️ | 所有标签列表 |

---

## 系统配置 — `/api/binary/system`

| 方法 | 路径 | 权限 | 缓存 | 说明 |
| ------ | ------ | ------ | ------ | ------ |
| GET | `/api/binary/system/seo` | 🔓 | 🗄️ | 站点 SEO/品牌/PWA 配置，`SeoConfig` frame |
| GET | `/api/binary/system/compliance` | 🔓 | 🗄️ | 公开页 footer 合规配置，`SiteComplianceConfig` frame |
| GET | `/api/binary/system/page/{slug}` | 🔓 | 🗄️ | 指定 slug 的静态页面内容；当前只支持 `about/privacy/guidelines/copyright` |
| GET | `/api/binary/system/admin/seo` | 👑 | — | admin 读取 SEO 配置 |
| GET | `/api/binary/system/admin/compliance` | 👑 | — | admin 读取完整合规配置 |
| PUT | `/api/binary/system/seo` | 👑🚦 | — | admin 保存 SEO/品牌/PWA 配置，`SeoConfigUpdateRequest` |
| PUT | `/api/binary/system/compliance` | 👑🚦 | — | admin 保存大陆合规配置，`SiteComplianceConfigUpdateRequest` |
| PUT | `/api/binary/system/page` | 👑🚦 | — | admin 保存静态页面内容 |
| POST | `/api/binary/system/page/refresh/{slug}` | 👑🚦 | — | 强制刷新静态页面缓存 / AOT |

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
| POST `/api/binary/security/challenge` | 🔓 🚦 📦 | `SecurityChallengeIssueRequest`(173) → `SecurityChallengeIssueResponse`(175) | 签发 UUIDv7 envelope 与 1..8 个 ordered assignments，保留每个 member 的 provider payload 对应关系；单 challenge 使用同一状态机；不提供 JSON fallback |
| POST `/api/binary/security/challenge/verify` | 🔓 🚦 📦 | `SecurityChallengeVerifyRequest`(174) → `SecurityChallengeVerifyResponse`(176) | 请求显式携带 envelope/member identity；成功返回 member progress，仅全部完成时返回 aggregate `proofToken` 与权威 `expiresAtUnixMs` |
| POST `/api/binary/security/challenge/cancel` | 🔓 🚦 📦 | `SecurityChallengeCancelRequest`(200) → `EmptySuccess`(240) | refresh/cancel/身份或路由变化/卸载时撤销整个 envelope；完整 binding 不匹配也返回 opaque idempotent success，不提供 JSON fallback |
| `PerceptionCharacterV3` union | 🔓 🚦 📦 | issue: final Gray8/WAV + opaque state；verify: answer + opaque state | `kind=14` typed member；两次原子尝试；无 JSON/V1/V2 alias/fallback；公开失败仅 `retryable/reissueRequired/unavailable/rejected` |
| GET `/api/binary/anonymous-credential/root` | 🔓 🚦 📦 | `AnonymousCredentialRootSnapshot`(179) | 公开 credential root / epoch / expiry / circuit metadata；`public_read` 限流 |
| GET `/api/binary/anonymous-credential/circuit` | 🔓 🚦 📦 | `AnonymousCredentialRootSnapshot`(179) | 同 root snapshot，用于 prover 预热读取 circuit/verifying key metadata |
| POST `/api/binary/anonymous-credential/revocation-witness` | 🔓 🚦 📦 | 固定 `ApiError` / 410 | credential-specific witness 永久 retired；body/参数均不读取 |
| GET `/api/binary/anonymous-credential/revocation/{epoch}/{version}/{root}/full.aeds` | 🔓 🚦 📦 | `AnonymousCredentialRevocationSnapshot`(196) | 所有客户端相同、content-addressed、immutable 的公共 full snapshot；坐标冲突 `409`、未生成 `404`、provider 不可用 `503` |
| GET `/api/binary/anonymous-credential/revocation/{epoch}/{version}/{root}/delta/{baseVersion}.aeds` | 🔓 🚦 📦 | `AnonymousCredentialRevocationDelta`(197) | 公共 append-only delta；客户端仅允许精确上一 version 更新；坐标冲突 `409`、未生成 `404`、provider 不可用 `503` |
| GET `/api/binary/anonymous-credential/blind-issuer` | 🔓 🚦 📦 | `BlindCredentialIssuerMetadata`(193) | RFC 9474 profile、root 绑定、issuer SPKI/hash；`public_read`、`no-store`，runtime disable 时 503 |
| POST `/api/binary/anonymous-credential/blind-issue` | 🔑 🚦 📦 | `BlindCredentialIssueRequest`(194) → `BlindCredentialIssueResponse`(195) | RFC 9474 blind issuance；只接收 384B blinded representative，统一拒绝与延迟桶，`no-store` |
| POST `/api/binary/anonymous-credential/issue` | 🔑 🚦 📦 | `ApiError`(251) | 已撤销的 circuit-native issuance；固定 `410 Gone`，不得重新挂载旧 handler |
| POST `/api/binary/telemetry/rum` | 🔓 🚦 📦 | `RumMetricBatchRequest`(75) → `RumMetricIngestResponse`(76) | 匿名 RUM 批量 ingestion；`credentials: omit` |

### 管理端 Binary

| 方法 | 路径 | 权限 | FrameType | 说明 |
| ------ | ------ | ------ | ----------- | ------ |
| GET | `/api/binary/stats` | 👑 📦 | `AdminStats`(7) | Binary 聚合统计（overview + recent comments + regions） |
| GET | `/api/binary/admin/article` | 👑 📦 | `ArticleList`(1) | 管理端文章列表，可带 `status` / `isDeleted`；`page>=1`、`size=1..100`，非法值返回 400 |
| GET | `/api/binary/admin/article/{id}` | 👑 📦 | `ArticleDetail`(2) | 管理端文章详情 |
| POST | `/api/binary/admin/article` | 👑 📦 🚦 PoW | `ArticleWriteRequest` → `MutationId`(241) | 创建文章；必须携带 admin-scoped `X-Fsus-Client-Mutation-Id`；同键同内容安全重放，同键异内容 409；返回 48B 强类型 article/revision/release/result |
| PUT | `/api/binary/admin/article/{id}` | 👑 📦 🚦 PoW | `ArticleWriteRequest` → `MutationId`(241) | 更新文章；必须提交详情中的 `baseRevisionId`，失配返回 409 且不写入；完全相同请求返回原坐标与 `outcome=no_change`，不新增修订/事件；返回同一 48B 强类型结果 |
| POST | `/api/binary/upload/init` | 👑 | `UploadInit`(20) | 初始化分片上传 |
| GET | `/api/binary/upload/{id}` | 👑 📦 | `UploadStatus`(21) | 查询上传状态 |
| PUT | `/api/binary/upload/{id}/part/{n}` | 👑 📦 | `UploadPartAck`(22) | 上传分片 |
| POST | `/api/binary/upload/{id}/complete` | 👑 📦 | `UploadComplete`(23) | 完成上传 |
| DELETE | `/api/binary/upload/{id}` | 👑 | — | 中止并清理上传 |
| GET | `/api/binary/upload/{id}/parts` | 👑 📦 | `UploadPartMap`(24) | 分片清单 |

---

## 消息系统 — `/api/binary/messages`

> 整个路由组需要登录（🔑）。

| 方法 | 路径 | 说明 |
| ------ | ------ | ------ |
| GET | `/api/binary/messages/conversations?size=20&filter={filter}&cursor={nextCursor}` | 当前用户对话列表；`lastMessageAt + conversationId` 稳定游标，首屏省略 cursor |
| GET | `/api/binary/messages/conversations/{id}?beforeMessageId={previousCursor}` | `ConversationDetailV3(204)`；最新 50 条或向前一页，返回 `previousCursor/hasOlder/readSnapshotMessageId` |
| GET | `/api/binary/messages/conversations/{id}?afterMessageId={lastKnownMessageId}` | `ConversationDetailV3(204)`；replay miss 后按 ID 升序补齐差量；与 `beforeMessageId` 互斥，`hasOlder/previousCursor` 表示后续差量页 |
| POST | `/api/binary/messages/conversations` | 发起新对话；必需 `X-Fsus-Client-Mutation-Id`；响应 `ConversationDetailV2(203)` 与 `idempotencyReplay` |
| POST | `/api/binary/messages/conversations/{id}/reply` | 必需 `X-Fsus-Client-Mutation-Id`；`AccountConversationReplyRequest(202)` 正文 + 显式 `readThroughMessageId`；响应保留首次 message ID |
| POST | `/api/binary/messages/conversations/{id}/read` | `ConversationReadRequest(201)`；精确推进已读游标，不读取当前 `MAX(id)` |

---

## 管理端消息 — `/api/binary/admin/messages`

> 整个路由组需要 admin 角色（👑）。

| 方法 | 路径 | 说明 |
| ------ | ------ | ------ |
| GET | `/api/binary/admin/messages/conversations?size=30&filter={filter}&cursor={nextCursor}` | `AdminConversationList(206)`；最小对方账号投影；未读/筛选只读取共享 admin queue state |
| GET | `/api/binary/admin/messages/conversations/{id}?beforeMessageId={previousCursor}` | `AdminConversationDetail(207)`；最小对方账号投影；最新页推进共享 admin read cursor，历史页不回退 |
| POST | `/api/binary/admin/messages/conversations/{id}/reply` | 必需 `X-Fsus-Client-Mutation-Id`；以管理员身份回复；closed 必须先显式重开，事务冲突返回 409 |
| POST | `/api/binary/admin/messages/conversations/{id}/status` | `ConversationStatusRequest` 目标状态 + 审计原因；显式状态机/CAS；响应 `ConversationStatusMutationResult(211)`，同状态为 `no_change`，非法或并发冲突为 409 |
| POST | `/api/binary/admin/messages/system-send` | 必需稳定正整数 `X-Fsus-Source-Event-Id`；单 active 账号系统消息；事务内锁定目标，missing/deleted/restricted 返回明确领域错误；响应 `ConversationDetailV2(203)` |

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

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| GET | `/feed/rss.xml` | 🔓 | RSS 2.0 feed |
| GET | `/api/Article/rss` | 🔓 | RSS 历史兼容路径 |
| GET | `/feed/atom.xml` | 🔓 | Atom feed |
| GET | `/feed/feed.json` | 🔓 | JSON Feed 1.1 |
| GET | `/sitemap.xml` | 🔓 | 公开 sitemap；全量 canonical URL，超过 45,000 条时返回 sitemap index |
| GET | `/sitemap/{page}.xml` | 🔓 | sitemap index 子 urlset；不存在的页返回 404 |
| GET | `/robots.txt` | 🔓 | robots + sitemap 声明 |
| GET | `/api/binary/article/{articleId}/related.aeds` | 🔓 🚦 | AEDS 延伸阅读：相关文章 / 上一篇 / 下一篇；受 `public_read` 风险感知限流 |
| GET | `/api/ops/crawler-ranges/status` | 🔐 admin | Crawler CIDR 同步状态 |
| GET | `/internal/public-aot/manifest` | 🔓 | Public AOT route manifest；配置 `PublicAot:ManifestToken` 时需 `X-Fsus-Public-Aot-Token` |
| GET | `/internal/public-aot/health` | 🔓 | Public AOT SSR worker health / breaker / quarantine snapshot；配置 `PublicAot:ManifestToken` 时需 `X-Fsus-Public-Aot-Token` |
| POST | `/api/binary/subscriptions` | 🔓 | AEDS 更新订阅，保存 email hash |
| DELETE | `/api/binary/subscriptions` | 🔓 | AEDS 退订 |

| POST | `/api/binary/author/drafts` | 👑 | 以 `expectedServerRevision` CAS 保存草稿；返回递增 `serverRevision` 与原始 `baseRevisionId` |
| GET | `/api/binary/author/drafts/{draftKey}` | 👑 | 读取服务端草稿、`serverRevision` 与原始 `baseRevisionId` |
| DELETE | `/api/binary/author/drafts/{draftKey}?expectedServerRevision={revision}` | 👑 | 版本前置条件匹配后丢弃；stale 返回 `draft_conflict` |
| POST | `/api/binary/author/preview` | 👑 | admin-only 私有 Markdown/AOT-like 预览 |
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
| PUT | `/api/binary/admin/security/risk-control/options` | 👑🚦 MFA | 更新 RiskControl mode、CaptchaV1/PoSpaceV1/PublicRead/Comment/Auth 开关和 strict multiplier |
| POST | `/api/binary/admin/security/risk-control/options/rollback` | 👑🚦 MFA | 回滚上一份 RiskControl last-known-good policy |
| POST | `/api/binary/admin/security/risk-control/simulate` | 👑🚦 | RiskControl dry-run：调用生产决策链返回 riskScore、decision、reasons、requiredChallenges、policyVersion，不签发 challenge、不改风险分 |
| GET | `/api/binary/admin/security/challenges/overview?kind={kind}` | 👑 | challenge 签发、尝试、成功/失败率；`kind` 可筛选 `captchaV1` / `argon2idPoSpaceV1` |
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

| 方法 | 路径 | 权限 | 说明 |
| ------ | ------ | ------ | ------ |
| GET | `/api/notifications/stream/preflight` | 🔓 🚦 | WebSocket 通知握手预检；notification headless 与 UI 共用 ordered envelope runner，只有 completed aggregate proof 可通过 header 原子消费并换取短效 HttpOnly 一次性 grant；legacy PoW 保持兼容 |
| GET | `/api/notifications/stream` | 🔓 🚦 | WebSocket 通知通道（子协议 `fsus-aeds.v2`，握手校验 Origin/completed aggregate RiskControl proof 或 legacy PoW） |
| POST | `/_fsus/testing/notification-stream/publish` | 🔓 | Development/Test-only notification resilience drill；需 `X-Fsus-Notification-Drill-Secret`，生产不映射 |
| POST | `/api/binary/telemetry/rum` | 🔓🚦 | AEDS RUM 批量遥测入口 |
| GET | `/health/live` | 🔓 | JSON 存活探针（仅检查进程） |
| GET | `/health/ready` | 🔓 | JSON 最小就绪探针（仅 `status` / `checkedAt`，HTTP 200/503 表示 ready/not ready）；响应 `X-Fsus-Release-Id` / `X-Fsus-Release-Slot` 供 loopback 与公网切流核验，不表示认证身份 |
| GET | `/api/ops/health/ready-detail` | 👑 | 详细就绪报告（不可变 release ID/slot/commit/image digest、配置、Observability、启动状态、DB、Redis、runtime、RiskControl/perception-sealed@v2 gate） |
| GET | `/api/ops/deployment/status` | 👑🚦 loopback | 发布运行态、generation、普通 HTTP/notification/background 独立计数与 drain blockers；要求 `system.config` |
| POST | `/api/ops/deployment/activate` | 👑🚦 loopback | 以 `releaseId + slot + generation` CAS 激活 Ready Candidate；幂等；要求 `system.config` |
| POST | `/api/ops/deployment/drain` | 👑🚦 loopback | 以 `releaseId + slot + generation` CAS 开始排空；幂等，立即使 readiness 503；要求 `system.config` |
| GET | `/api/ops/deployment/fence/status` | 👑🚦 loopback | 对账 PostgreSQL durable witness + Redis mirror，并校验本地 release/slot/generation 所有权；要求 `system.config` |
| POST | `/api/ops/deployment/fence/acquire` | 👑🚦 loopback | CAS 获取或单调推进 active-release fence；旧 generation/token 不得复用 |
| POST | `/api/ops/deployment/fence/revoke` | 👑🚦 loopback | 精确撤销当前 fence 所有者；身份不匹配返回 409 |
| GET | `/api/ops/deployment/notification-stream/restart/status` | 👑🚦 loopback | 读取当前 1012 restart epoch、原因与连接排空快照 |
| POST | `/api/ops/deployment/notification-stream/restart` | 👑🚦 loopback | 按精确 release/slot/generation 触发一次有序 1012 重连 |
| POST | `/api/ops/deployment/notification-stream/drill/publish` | 👑🚦 loopback | 仅显式启用的发布演练事件；校验 active fence 后发布 1..32 个可对账 event ID，生产默认 404 |
| POST | `/api/release-evidence/schema-bridge/write` | 👑🚦 Test-only | 仅 environment=`Test` + `SchemaMigration:QualificationEnabled=true` 映射；`system.config`；执行有界幂等双槽 qualification write，生产不映射 |
| GET | `/api/release-evidence/schema-qualification/readiness` | 👑🚦 Test-only | 同一双重 guard；missing Expand 返回 503 `schema_incompatible`，生产不映射 |

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

# API 契约文档

本文件是 FsusBlog 所有请求/响应 DTO、通知 WebSocket 信封与 AOT 契约的**完整参考**。
所有定义的权威源码位于 `src/shared/Contracts/` 目录。

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

---

## 基础包装结构

运行时主 API 已收敛到 AEDS Binary：`/api/binary/**` 响应使用 AEDS v2 frame，错误也通过 `ApiError` frame 表达，不再通过旧文本响应包装。真人阅读 proof 使用 `/api/read-proof/**` JSON 包装响应，避免把计数 proof 扩展进 AEDS/Wasm 协议面。

所有 HTTP 响应都会带 `X-Fsus-Trace-Id`，值与当前 OpenTelemetry `Activity.TraceId`、`HttpContext.TraceIdentifier`、Serilog/audit `TraceId` 对齐。客户端可用该值报告问题；它不是认证凭据，也不得包含用户身份或请求正文。

### AEDS 通用响应 POD

源码：`src/shared/Contracts/Models/CommonPods.cs`

| FrameType | POD | 说明 |
|-----------|-----|------|
| `EmptySuccess` (`240`) | `EmptySuccessPod` | 无数据成功响应，`Ok = 1` |
| `MutationId` (`241`) | `MutationIdPod` | 写操作返回的 `int64 Id` |
| `ApiError` (`251`) | `ApiErrorPod` | Binary 错误响应，包含 `Code`、`Category`、`HttpStatus`、`Message`、`Details`、`TraceId` |

### AEDS v2 payload layout

AEDS v2 frame header 固定 16 字节，字段顺序为 `Magic:uint32`、`Version:uint8`、`HeaderLength:uint8`、`Flags:uint16`、`FrameType:uint16`、`PayloadLength:uint32`、`PayloadCrc16:uint16`。服务端、TypeScript adapter、Worker 与 Wasm decoder 只接受 v2；v1 frame 不再兼容。

高频读取 frame 改为 compact POD：

| FrameType | Payload layout |
|-----------|----------------|
| `ArticleList` | `total:int32` + `count:int32` + `tagRecordCount:int32` + shared UTF-8 blob + 76B article records + 12B tag records |
| `ArticleSearch` | `total:int32` + `count:int32` + `tagRecordCount:int32` + shared UTF-8 blob + 52B search records + 12B tag records |
| `ArticleHot` | `count:int32` + shared UTF-8 blob + 16B article records |
| `CategoryList` / `TagList` | `count:int32` + shared UTF-8 blob + 16B taxonomy records |
| `AdminStats` | `SiteStatsPod` + shared UTF-8 blob + 16B popular records + 32B recent-comment records + 12B region records |

compact record 内所有文本字段均为 `Utf8SliceRef`，指向当前 payload 的共享 blob。`ArticleList` 的 76B record 在原 56B 公开字段后追加 `status:int32`、`scheduledPublishAtUnixMs:int64`、`publishedAtUnixMs:int64`。写请求、Passkey、上传、`ArticleDetail` 和复杂评论游标仍使用 v2 header 包裹的 POD + blob 结构，但不再允许旧 v1 header。

### JSON proof 包装

`/api/read-proof/**` 使用 JSON：

```json
{
  "success": true,
  "data": {},
  "message": null
}
```

### Passkey AEDS frames

Passkey/WebAuthn 载荷不再以文本字符串传输。服务端返回 AEDS POD，前端 adapter 将 POD 还原为浏览器 WebAuthn API 需要的选项对象；浏览器返回的 attestation/assertion 由前端编码为二进制 request POD。

| FrameType | POD | 端点 / 用途 |
|-----------|-----|-------------|
| `PasskeyRegisterBegin` (`63`) | `PasskeyRegisterBeginPod` | `POST /api/binary/auth/passkey/register/begin` |
| `PasskeyLoginBegin` (`64`) | `PasskeyLoginBeginPod` | `POST /api/binary/auth/passkey/login/begin` |
| `PasskeyCredentialList` (`65`) | `PasskeyCredentialSummaryPod[]` | `GET /api/binary/auth/passkey/credentials` |
| `PasskeyRegisterCompleteRequest` (`66`) | `PasskeyRegisterCompleteRequestPod` | 注册完成请求体 |
| `PasskeyLoginCompleteRequest` (`67`) | `PasskeyLoginCompleteRequestPod` | 登录完成请求体 |
| `PasskeyRenameRequest` (`68`) | `StringMutationRequestPod` | 设备名更新请求体 |

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
- `POST /api/Auth/register` 成功时同样返回该结构，并在同一响应内写入登录 Cookie，实现“注册后自动登录”

### `CurrentUserSnapshotDto`（当前用户信息，`GET /api/Auth/me`）

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

浏览计数不由文章详情 GET 触发。前端 hydration 后通过 JSON proof 端点产生真人阅读事件。

### `GET /api/read-proof/challenge`

Query：

| 参数 | 说明 |
|------|------|
| `scope` | `site` 或 `article` |
| `routeKey` | 公开页 route key，例如 `home`、`article:42` |
| `articleId` | `scope=article` 时必填 |

请求头必须包含浏览器上下文：`X-Fsus-Device-Fp`、`Sec-Fetch-Site`、`Sec-Fetch-Mode`、`Sec-Fetch-Dest`，并由可信 `Origin` 或 `Referer` 发起。

响应 `data`：

```json
{
  "token": "hmac-bound-token",
  "scope": "article",
  "routeKey": "article:42",
  "articleId": 42,
  "minDwellMs": 8000,
  "issuedAt": "2026-05-13T00:00:00Z",
  "expiresAt": "2026-05-13T00:05:00Z"
}
```

### `POST /api/read-proof/submit`

请求体：

```json
{
  "token": "hmac-bound-token",
  "scope": "article",
  "routeKey": "article:42",
  "articleId": 42,
  "dwellMs": 9000
}
```

响应 `data`：

```json
{
  "counted": true,
  "status": "counted"
}
```

`counted=false` 表示 proof 被拒绝或重复提交；内容读取不受影响。

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

源码：`src/shared/Contracts/Sse/SseContracts.cs`

### 通道

- 路径：`GET /api/notifications/stream`
- 预检路径：`GET /api/notifications/stream/preflight`
- 协议：WebSocket，子协议固定为 `fsus-aeds.v2`
- 消息类型：binary
- 每条消息：完整 AEDS v2 frame
- 匿名连接：仍需 PoW，浏览器 WebSocket 使用 `pow` query 参数传递二进制 FPOW 证明的 base64 文本形式
- 断线续传：使用 `cursor` query 参数传递最后确认的事件 ID

### 握手预检

客户端在打开 WebSocket 前可以先调用：

```http
GET /api/notifications/stream/preflight?pow=<base64-fpow>&cursor=<last-event-id>
X-Fsus-Sse-Protocol: fsus-aeds.v2
```

成功时返回 `204 No Content`，不返回 body。失败时返回统一 JSON 错误信封，并带上可观测头：

```http
X-Fsus-Sse-Error-Code: account_blocked
X-Fsus-Sse-Status-Code: 423
```

失败 body 保持统一响应信封：

```json
{
  "ok": false,
  "statusCode": 423,
  "errorCode": "account_blocked",
  "message": "account_blocked",
  "data": null
}
```

预检不要求 WebSocket upgrade；正式通道仍必须使用 `Sec-WebSocket-Protocol: fsus-aeds.v2`。WebSocket 主通道握手失败时继续返回 AEDS `ApiError` frame，同时写入相同的 `X-Fsus-Sse-*` 头。

### `NotificationEvent`

对应 `AedsFrameType.NotificationEvent = 69`。

载荷布局：

```text
int64 eventId
int64 timestampUnixMs
int32 sseEventType
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

### `SseEventType` 枚举

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

所有上传端点在 `/api/binary/upload/` 路径下，需要 admin 角色。

### `UploadInitDto`（初始化响应）

```json
{
  "uploadId": "uuid",
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

```json
{
  "siteName": "Fsu's Blog",
  "description": "站点描述",
  "keywords": "博客,技术,写作",
  "author": "Fsu",
  "ogImage": "/og-image.jpg",
  "twitterHandle": "@fsu"
}
```

### `PageContentContract`

```json
{
  "slug": "about",
  "title": "关于",
  "content": "Markdown 内容",
  "updatedAt": "2026-01-01T00:00:00Z"
}
```

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

### Public AOT 单一产物要求

每个公开页 AOT 条目都必须来自同一条渲染链：

```text
bootstrap model
  → hydration payload
  → Vue SSR renderer
  → document composer
  → html / PublicAotBootstrap AEDS payload
```

HTML bootstrap、hydration props 和 islands payload 均以 `script type="application/octet-stream"` 嵌入；脚本文本是完整 `AedsFrameType.PublicAotBootstrap` frame 的 base64url 表示，不再嵌入 JSON script。

约束：

- `html`、`bootstrapPayload`、`hydrationPropsPayload` 不能分别由不同模板层独立拼装。
- AOT 产物只允许由服务端 `server-ssr` backfill 写入；客户端、管理端和脚本不得上传 AOT bundle。
- `Filter` / `ArticleDetail` 不允许持久化错误态壳层，例如 markdown fallback/error 文案。
- 服务端 backfill 使用 `PublicAot:SsrWorkerMode=Pooled` 的 Node/Vue SSR worker 池生成条目；
  如缓存未命中、过期或 worker 不可用，公开页请求一律返回 SPA index fallback，并通过
  `X-Fsus-Public-Aot-Backfill` 标记 `queued` 或 `dropped`。
- AOT HTML 缓存同时校验 `rendererVersion` 与 frontend asset version；前端 `index.html` 或
  `.vite/manifest.json` 变化会自动拒绝旧缓存。

### `PublicAotShellEntryContract`

```text
{
  "pageId": 2,
  "routeKey": "article:42",
  "rendererVersion": "public-app-ssr@2026-05-01-1",
  "bootstrapPayload": "<base64url AEDS frame>",
  "hydrationPropsPayload": "<base64url AEDS frame>",
  "islandsPayload": "<base64url AEDS frame>",
  "html": "<div id=\"fsus-aot-shell\">...</div>",
  "title": "文章标题",
  "baseUrl": "https://fsus.blog"
}
```

- `bootstrapPayload`：页面初始数据 AEDS payload，供 SPA 直接初始化 Pinia store
- `hydrationPropsPayload`：hydration props AEDS payload，传递给客户端渲染器
- `islandsPayload`：islands 配置 AEDS payload，定义哪些区域需要客户端接管
- `html`：Vue SSR 产出的页面 shell HTML；上传模板仍可含占位符（如 `{{articleId}}`），写入前会规范化

### `Filter` 页面最小契约

`bootstrapPayload` 与 `hydrationPropsPayload` 至少需要共享以下字段：

```json
{
  "pageKind": "Filter",
  "routeKey": "tag-name:AcceptanceTag",
  "filterType": "tag",
  "filterKey": "tag-name:AcceptanceTag",
  "filterId": 1,
  "filterName": "AcceptanceTag",
  "title": "AcceptanceTag",
  "isInvalidTarget": false
}
```

其中 `filter` 节点继续承载分页数据：

```json
{
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

### `PowChallenge`（`GET /api/Auth/pow-challenge`）

```json
{
  "challenge": "hex-encoded-challenge-string",
  "difficulty": 4,
  "expiresAt": "2026-01-01T00:05:00Z"
}
```

- `difficulty`：前导零个数，客户端需找到使 `SHA256(challenge + nonce)` 有 `difficulty` 个前导零的 `nonce`
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
| GET | `/sitemap.xml` | `application/xml` | 首页、文章、归档、关于、分类、标签；排除登录、用户、admin |
| GET | `/robots.txt` | `text/plain` | 声明 sitemap，并拒绝私有路由 |
| GET | `/api/public/articles/{articleId}/related` | `JsonApiResponse<RelatedReadingResponse>` | 基于分类、标签、全文关键词和发布时间的公开延伸阅读 |

`RelatedReadingResponse`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `related` | `RelatedReadingItem[]` | 最多 6 条相关文章，按同分类、共同标签、全文关键词命中和发布时间接近度综合排序 |
| `previous` | `RelatedReadingItem \| null` | 按 `publishedAt ?? createTime` 定位的上一篇公开文章 |
| `next` | `RelatedReadingItem \| null` | 按 `publishedAt ?? createTime` 定位的下一篇公开文章 |

`RelatedReadingItem` 包含 `id`、`title`、`summary`、`createTime`、`reason`。`reason` 只允许来自公开内容关系，例如 `同分类`、`共同标签`、`全文关键词`、`发布时间接近`、`上一篇`、`下一篇`；不得使用点赞、收藏、关注、用户画像或登录态行为。文章详情页的 SPA 与 PublicAOT 均消费同一个 `relatedReading` 视图契约，避免首屏静态输出与 hydration 后页面结构漂移。

### SEO Discovery

`PublicAotDocumentComposer` 为 AOT 公开页输出 canonical、description、OpenGraph、Twitter card 与 feed discovery。JSON-LD 使用单个 `@graph`，必须包含站点级 `WebSite` + `SearchAction`、页面路径 `BreadcrumbList`，文章详情页额外包含 `BlogPosting`。`check:public-seo-smoke` 会对 home、article detail、archive、about、category、tag 的 AOT 命中和 shell-only SPA fallback 做一致性校验。

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

`GET /api/binary/article` 的 `status` 查询参数仅 admin 可用。匿名或普通用户请求 `status` 或 `isDeleted=true` 必须得到 `ApiError` frame；admin 不带 `status` 时读取所有非删除状态，带 `status=0/1/2/3/4` 时读取对应 draft/scheduled/published/archived/deleted 集合。

### Admin 作者工作台

`/api/author/**` 全部要求 admin 角色，统一返回 `JsonApiResponse<T>`：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/author/drafts` | 保存服务端草稿，按 `ownerUserId + draftKey` 幂等覆盖；payload 包含 `status` 与 `scheduledPublishAt` |
| GET | `/api/author/drafts/{draftKey}` | 读取服务端草稿；不存在时返回 `success=true,data=null`，存在时返回 `updatedAt`、`clientRevision`、发布状态与定时发布时间 |
| DELETE | `/api/author/drafts/{draftKey}` | 丢弃服务端草稿；编辑器同步清除浏览器本地兜底缓存 |
| POST | `/api/author/preview` | admin-only 私有预览，输出经过转义的 Markdown/AOT-like HTML，根节点带 `data-preview-only=true`、`data-markdown-renderer=server-preview`，不写 PublicAOT cache |
| POST | `/api/author/prepublish-check` | 发布前检查标题、SEO 描述、封面 URL、Markdown 结构、链接、图片 alt 与危险 HTML |
| GET | `/api/author/articles/{articleId}/revisions` | 最近 50 条修订摘要 |
| GET | `/api/author/articles/{articleId}/revisions/{revisionId}` | 单个修订详情，包含标题、摘要、正文、分类、标签和审计时间，用于编辑器内比较 |
| POST | `/api/author/articles/{articleId}/revisions/{revisionId}/rollback` | 回滚到指定修订并触发文章更新链 |
| POST | `/api/author/articles/{articleId}/assets/reindex` | 从正文和封面重建资产引用 |
| GET | `/api/author/assets` | 资产库列表 |
| DELETE | `/api/author/assets/orphans` | 删除引用计数为 0 的孤儿资产库记录 |
| GET | `/api/author/analytics` | 单作者公开内容与真实阅读事件概览 |
| GET | `/api/author/comments/moderation?status={0..3}&limit={1..100}` | 评论审核队列，默认读取待审项 |
| POST | `/api/author/comments/moderation/bulk` | 批量通过、拒绝或隐藏评论，可联动封禁用户 |
| POST | `/api/author/comments/{commentId}/moderation` | 评论审核状态更新 |
| GET | `/api/author/content/export` | 全站内容备份包，包含每篇 Markdown + frontmatter |
| GET | `/api/author/articles/{articleId}/export` | Markdown + frontmatter 导出 |
| POST | `/api/author/articles/import` | Markdown + frontmatter 导入 |
| POST | `/api/author/ai-assist` | 作者 AI 辅助；默认 provider disabled/local fallback，不把未发布正文发往外部服务 |

`AiAssistResponse` 返回 `providerEnabled`、`providerMode`、`externalProviderAllowed`、`auditEvent`、`suggestedSummary`、`suggestedTags`、`titleCandidates`、`translationDraft`、`structureIssues`。前端编辑器只能在 admin 作者工作台内调用该接口；调用结果可用于采用摘要、关联已有标签、采用标题候选或查看结构检查。外部 provider 必须同时满足 `Authoring:AiAssist:Enabled=true`、非 `local` provider、`AllowExternalProvider=true`、`ExternalProviderReviewed=true`，否则 `externalProviderAllowed=false` 且服务端只返回本地建议。

`ArticlePreviewResponse` 只用于作者工作台内嵌预览：`html` 是服务端按公开阅读页常用 Markdown block/inline 语义生成的安全片段，前端放入 sandboxed iframe；`plainText` 用于字数和摘要提示；`issues` 复用发布前检查结果。该响应不得被缓存为公开 AOT、不得进入 feed/sitemap/search/related-reading，也不得被匿名接口返回。

编辑器侧栏必须基于当前表单和 `SeoConfigContract.baseUrl` 实时给出搜索/分享预览：标题、description、canonical URL、OG image 与当前公开路由 slug。提交 `Published` 或 `Scheduled` 前必须调用 `/api/author/prepublish-check`；`severity=error` 阻断提交，`severity=warning` 必须在确认发布弹窗中要求作者填写 `warningOverrideReason` 后才能跳过，服务端写入 `prepublish-warning-override` 审计事件。检查项覆盖标题/摘要/封面、危险 HTML 标签和事件属性、Markdown 未闭合代码块、超大/密集 Markdown 结构、正文图片 alt text、空链接、不安全协议、私有站内路径以及 `/article|category|tag/{id}` 格式错误。当前真实公开文章路由仍以 `/article/{id}` 为准，新文章在落库前只显示 draft-preview slug，不新增持久化 slug 字段。

`AssetLibraryItemResponse` 暴露 `id`、`url`、`altText`、`sourceArticleId`、`referenceCount`、`sha256`、`updatedAt`。重建资产索引会扫描所有文章正文中的 Markdown 图片和文章封面，只接受 `/uploads/illustration/*` 图片 URL；正文图片的 alt text 写入资产库，封面作为可复用资产参与引用计数。仍被正文或封面引用的资产 `referenceCount > 0`，失去引用的资产先保留为 `referenceCount=0` 供作者审计，只有 `DELETE /api/author/assets/orphans` 会删除这些孤儿资产库行；该清理不删除上传文件本体。

`AuthorAnalyticsResponse` 聚合单作者运营数据：文章状态计数、`totalHumanReadEvents`、`totalSearchableArticles`、`aotHitRate`、`averageDwellMs`、`readingCompletionRate`，以及 `topSearchKeywords`、`topSourceRoutes`、`notFoundHotspots`、`rumMetrics`、`rumPageTypes`、`rumAotSources`。阅读列表来自 `VisitLog.routeKey` 的匿名化公开页面读证明，不包含账号、email、token、cookie 或正文输入；AOT 命中率由真实阅读事件与 `Public AOT cache miss` 审计日志估算。RUM 列表来自匿名 `POST /api/telemetry/rum`，只接受 `web_vital_lcp`、`web_vital_cls`、`navigation_timing`、`hydration_time`、`wasm_decode_timing`、`markdown_render_timing` 和低基数 `pageType/aotSource/value/duration` 字段。

`POST /api/telemetry/rum` 请求体：

```json
{
  "name": "web_vital_lcp",
  "pageType": "article",
  "aotSource": "server-aot",
  "value": 1234,
  "metrics": {
    "value": 1234,
    "durationMs": 1234
  },
  "timestamp": "2026-05-18T19:24:00Z"
}
```

响应为 `JsonApiResponse<RumMetricIngestResponse>`，`accepted=false` 表示样本被丢弃但不向公开读链泄露校验细节。前端发送该请求时使用 `credentials: omit`，服务端只保存净化后的 performance audit payload。

评论创建默认进入 `CommentModerationStatus.Pending`，公开评论线程、回复预览和回复游标只返回 `Approved`；用户自己的评论历史仍可看到本人提交记录。`CommentModerationItemResponse.id` 使用字符串承载 Snowflake ID，避免前端整数精度损失；响应同时包含文章、用户、内容、状态、审核原因、审核人、审核时间和 `hitReasons`。`hitReasons` 来自内容过滤器、HTML 风险、密集链接、重复刷屏和人工原因，用于解释敏感词/垃圾评论命中。单条与批量审核都会写入 `comment-moderation` / `comment-moderation-bulk` 审计并清理评论游标缓存；当 `status=Rejected|Hidden` 且 `banUser(s)=true` 时，服务端会把非 admin、非注销用户更新为封禁状态并同步黑名单缓存。误判恢复使用 `status=Approved`，不会触发封禁联动。

内容导出使用 `ContentExportResponse`：`fileName`、`markdownWithFrontmatter`、`metadata`。frontmatter 固定写入 `fsusFormat: content-export-v1`、`sourceArticleId`、`title`、`summary`、`cover`、`categoryId`、`status`、`scheduledPublishAt`、`tagIds`、`revisionCount` 与 `fsusMetadataJson`；`fsusMetadataJson` 是 base64url 编码的 `ContentExportMetadataResponse`，用于无损恢复分类、标签、封面、文章状态和修订元数据。`GET /api/author/content/export` 返回 `ContentBackupExportResponse`，以 JSON 包含所有文章的导出结果。导入时 `publish=true` 会强制导入为 `Published`，否则按 metadata 的 `status` 恢复；`preserveRevisions=true` 会用导出包中的 revisions 替换导入时生成的初始 revision。

### 订阅

`POST /api/subscriptions` 与 `DELETE /api/subscriptions` 只保存 `SHA256(email)`、`channel`、启用状态和退订时间，不保存明文 email。订阅能力是 RSS/Atom 的增强，不构成关注、点赞、收藏或社交关系链。默认实现不发送邮件或 Web Push；`channel=email` 只记录读者显式偏好，外发增强必须以后续配置开关和退订 smoke 为准。

---

## 参见

- [design.md](design.md) — API 设计哲学与格式约定
- [quick-reference.md](quick-reference.md) — 端点路由速查表
- [schemas-and-errors.md](schemas-and-errors.md) — 错误码枚举与 Binary 帧格式
- `src/shared/Contracts/Outputs/ServerResponseContracts.cs` — 所有 DTO 权威源码
- `src/shared/Contracts/Sse/SseContracts.cs` — SSE 信封权威源码

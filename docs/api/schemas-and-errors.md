# 错误码、Binary 帧格式与 POD 大小目录

本文件是 FsusBlog 错误码枚举、AEDS v2 二进制帧格式规格和 POD 类型大小的**完整参考**。

---

## 目录

- [错误码枚举](#错误码枚举)
- [AEDS v2 帧格式](#aeds-v2-帧格式)
- [AedsFrameType 枚举](#aedsframetype-枚举)
- [POD 大小目录](#pod-大小目录)
- [C++ POD 对齐规则](#c-pod-对齐规则)

---

## 错误码枚举

错误码以固定宽度 UTF-8 字段写入 AEDS `ApiError` frame，按模块分组。

### 通用错误

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `InvalidRequest` | 400 | 请求参数格式无效 |
| `NotFound` | 404 | 资源不存在 |
| `Unauthorized` | 401 | 未认证或令牌失效 |
| `Forbidden` | 403 | 权限不足 |
| `RateLimited` | 429 | 请求频率超限 |
| `InternalError` | 500 | 服务端内部错误 |

### 认证错误

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `InvalidCredentials` | 401 | 用户名或密码错误 |
| `AccountBanned` | 403 | 账号已被封禁 |
| `AccountNotFound` | 404 | 账号不存在 |
| `UsernameAlreadyTaken` | 409 | 用户名已被占用 |
| `EmailAlreadyTaken` | 409 | 邮箱已被注册 |
| `TokenExpired` | 401 | 令牌已过期 |
| `TokenInvalid` | 401 | 令牌格式无效 |
| `RefreshTokenInvalid` | 401 | Refresh Token 无效或已轮换 |
| `SessionNotFound` | 404 | 会话不存在或已过期 |

### PoW 错误

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `PowChallengeNotFound` | 400 | 挑战令牌不存在或已过期 |
| `PowAnswerInvalid` | 400 | PoW 答案不满足难度要求 |
| `PowChallengeAlreadyUsed` | 400 | 挑战令牌已被使用（防重放） |

### MFA 错误

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `MfaAlreadyEnabled` | 409 | MFA 已启用 |
| `MfaNotEnabled` | 400 | MFA 未启用 |
| `MfaCodeInvalid` | 400 | TOTP 码错误 |
| `MfaRecoveryCodeInvalid` | 400 | 恢复码无效 |
| `MfaRecoveryCodesExhausted` | 400 | 恢复码已全部使用 |
| `MfaChallengeTokenInvalid` | 401 | MFA 挑战令牌无效或过期 |

### Passkey 错误

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `PasskeyCredentialLimitReached` | 409 | 已达到最大密钥数量（5 枚） |
| `PasskeyCredentialNotFound` | 404 | 指定密钥不存在 |
| `PasskeyAssertionFailed` | 401 | Passkey 断言验证失败 |
| `PasskeyRegistrationFailed` | 400 | Passkey 注册失败 |
| `PasskeyMfaProofRequired` | 403 | 注册新 Passkey 需提供 MFA 证明令牌 |

### 内容错误

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `ArticleNotFound` | 404 | 文章不存在 |
| `CommentNotFound` | 404 | 评论不存在 |
| `CommentContentEmpty` | 400 | 评论内容为空 |
| `CommentContentTooLong` | 400 | 评论内容超出长度限制 |
| `CategoryNotFound` | 404 | 分类不存在 |
| `TagNotFound` | 404 | 标签不存在 |

### 消息系统错误

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `ConversationNotFound` | 404 | 对话不存在 |
| `ConversationClosed` | 400 | 对话已关闭，无法回复 |
| `MessageNotFound` | 404 | 消息不存在 |
| `MessageRevoked` | 400 | 消息已撤回 |

### Binary / 文件上传错误

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `UploadNotFound` | 404 | 上传任务不存在 |
| `UploadExpired` | 400 | 上传任务已过期 |
| `UploadPartMissing` | 400 | 分片未完整上传 |
| `FileTooLarge` | 400 | 文件超出大小限制 |
| `FileTypeNotAllowed` | 400 | 文件类型不允许 |

### Notification Stream 握手失败码

Notification stream preflight 与 WebSocket 握手失败会在 `X-Fsus-Notification-Stream-Error-Code` 头、JSON preflight body 或 AEDS `ApiError` frame 中携带以下传输级失败码：

| 失败码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `websocket_required` | 426 | 正式通知通道不是 WebSocket upgrade |
| `protocol_mismatch` | 409 | 缺失或不接受 `fsus-aeds.v2` 子协议 |
| `auth_failed` | 401 | 携带认证头但认证失败 |
| `pow_failed` | 401/400 | 匿名连接缺失或提交了无效 PoW |
| `account_blocked` | 423 | 登录用户处于封禁状态 |
| `account_deleted` | 401 | 登录用户不存在、已删除或已停用 |
| `notification_handshake_failed` | 500 | 未分类握手失败 |

---

封禁类错误不得依赖 Redis 黑名单是否命中：服务端以 `sys_user.Status/BanReason` 为真源，`SecurityBlacklistUser` 只做无过期缓存；缓存 miss 会回查数据库并回填后再返回 `AccountBanned` 或 `account_blocked`。

## AEDS v2 帧格式

权威规格：`src/core/Algorithms/AEDS_V1_PROTOCOL.md`（文件名沿用历史路径，内容为当前 v2 规格）

### 帧头布局（16 字节，小端序）

```
偏移   大小   字段           类型      说明
 0      4    Magic          uint32   固定值 0x53444541 ("AEDS" 小端序)
 4      1    Version        uint8    协议版本，当前为 2
 5      1    HeaderLength   uint8    帧头长度，当前固定为 16
 6      2    Flags          uint16   保留标志位，当前填 0
 8      2    FrameType      uint16   帧类型（见 AedsFrameType 枚举）
10      4    PayloadLength  uint32   载荷字节数（不含帧头）
14      2    PayloadCrc16   uint16   载荷 CRC16
```

**总帧大小** = 16（帧头）+ PayloadLength（载荷）

### CRC16 计算规则

```
PayloadCrc16 = CRC16(payload_bytes)
```

CRC16 使用 Modbus 多项式 `0xA001`，初始值 `0xffff`。v2 删除 header CRC；header 只做字段边界与版本校验。

### Flags 登记

当前生产协议不启用 `NoPayloadCrc` 或协议内 `PayloadCompressed`。request frame 必须写 `Flags = 0`，服务端请求 binder 对非零 flags 返回协议校验失败；response frame 默认也写 `0`。如果后续采用 response-only flag，必须同步更新 `aeds-protocol.json`、负向 contract matrix、TypeScript/Worker/Wasm decoder 与本文件。

HTTP `Content-Encoding: br|gzip` 是 artifact-level transport compression，不占用 AEDS flags；浏览器 fetch 解压后，客户端仍按原始 AEDS frame 计算 payload CRC16。

### 解码校验流程

1. 读取 16 字节帧头
2. 验证 Magic == `0x53444541`
3. 验证 Version == 2，HeaderLength == 16
4. 验证 PayloadLength 不超过安全上限（见 POD 大小目录）
5. 按 PayloadLength 读取载荷字节
6. 计算载荷 CRC16 并与 PayloadCrc16 比对
7. 按 FrameType 解析 payload layout

AEDS v1 frame、未知版本、错误 header length 均直接拒绝；服务端和前端不做旧 frame fallback。

任一校验失败 → 丢弃帧。Binary 调用链不得把错误重新包装成文本响应；可恢复的服务端错误使用 `ApiError` 帧返回。

### 载荷结构

高频公开与统计 frame 使用 compact layout，载荷由计数、固定数值记录、共享 UTF-8 blob 与 `Utf8SliceRef` 组成：

```
[count/meta] [blobLength:int32 + blob] [fixed numeric records] [slice refs into blob]
```

- `ArticleList`：`total:int32`、`count:int32`、`tagRecordCount:int32`、共享 blob、每篇 56B record、每个 tag 12B record。
- `ArticleHot`：`count:int32`、共享 blob、每篇 16B record。
- `Category` / `Tag`：`count:int32`、共享 blob、每条 16B record。
- `AdminStats`：`SiteStatsPod`、共享 blob、popular 16B record、recent comment 32B record、region 12B record。
- 写请求、认证、上传和少量复杂详情 frame 仍使用 v2 header 包裹的 POD + blob 结构；线格式只接受 v2。

当前兼容的 payload 字典化落点是 shared UTF-8 blob + `Utf8SliceRef`：ArticleList/ArticleSearch/Conversation records 不重复内嵌文本，category/tag/title/summary/body 均通过 slice 引用共享 blob。后续若新增 ArticleList category/tag dictionary layout，应以新版本 payload/golden fixture 登记，不复用未标记的旧 record layout。

---

## AedsFrameType 枚举

生成输入：`src/shared/Contracts/Validation/aeds-protocol.json`

生成产物：`src/core/Algorithms/AedsFrameType.cs`、`src/shared/AedsFrameHeader.cs`、`src/frontend/wasm/web/protocol/frame.ts`

| 值 | 名称 | POD 类型 | 对应二进制端点 / 用途 |
|----|------|---------|----------------|
| 0 | `Unknown` | — | — |
| 1 | `ArticleList` | `ArticleListPod` | `GET /api/Article/` |
| 2 | `ArticleDetail` | `ArticleDetailPod` | `GET /api/Article/{id}` |
| 3 | `ArticleHot` | `ArticleListPod` | `GET /api/Article/hot` |
| 4 | `ArticleSearch` | `ArticleListPod` | — |
| 5 | `CommentArticleCursor` | `CommentPod` | `GET /api/Comment/{articleId}` |
| 6 | `CommentUserCursor` | `CommentPod` | `GET /api/Comment/me` |
| 7 | `AdminStats` | `AdminStatsPod` | — |
| 8 | `CommentThreadReplyCursor` | `CommentPod` | `GET /api/Comment/{articleId}/thread/{rootId}` |
| 9 | `CategoryList` | compact taxonomy records | `GET /api/binary/category` / `category.aeds` |
| 10 | `TagList` | compact taxonomy records | `GET /api/binary/tag` / `tag.aeds` |
| 11 | `RecentCommentStats` | compact stats records | `GET /api/binary/stats/recent-comments` |
| 12 | `RegionStats` | compact stats records | `GET /api/binary/stats/regions` |
| 13 | `SeoConfig` | `SeoConfigPod` | `GET /api/binary/system/seo` |
| 14 | `PageContent` | `PageContentPod` | `GET /api/binary/system/page/{slug}` |
| 15 | `ArticleFeatured` | compact article records | `GET /api/binary/article/featured/{size}.aeds` |
| 16 | `TrashClearResponse` | `TrashClearResponsePod` | `DELETE /api/binary/admin/article/trash` |
| 17 | `AdminUserList` | compact user records | `GET /api/binary/admin/users` |
| 18 | `AuthLoginFlow` | auth login payload | `POST /api/binary/auth/login` |
| 19 | `CurrentUserSnapshot` | user snapshot payload | `GET /api/binary/auth/me` |
| 20 | `UploadInit` | `UploadInitPod` | `POST /api/binary/upload/init` |
| 21 | `UploadStatus` | `UploadStatusPod` | `GET /api/binary/upload/{id}` |
| 22 | `UploadPartAck` | `UploadPartAckPod` | `PUT /api/binary/upload/{id}/part/{n}` |
| 23 | `UploadComplete` | `UploadCompletePod` | `POST /api/binary/upload/{id}/complete` |
| 24 | `UploadPartMap` | `UploadPartMapPod` | `GET /api/binary/upload/{id}/parts` |
| 25 | `AuthSessionList` | session list payload | `GET /api/binary/auth/sessions` |
| 26 | `SiteComplianceConfig` | `SiteComplianceConfigPod` | `GET /api/binary/system/compliance` |
| 30 | `PowChallenge` | `PowChallengePod` | `GET /api/binary/auth/pow-challenge` |
| 31 | `UploadInitRequest` | `UploadInitRequestPod` | `POST /api/binary/upload/init` 请求体 |
| 32 | `UploadCompleteRequest` | `UploadCompleteRequestPod` | `POST /api/binary/upload/{id}/complete` 请求体 |
| 35 | `SeoConfigUpdateRequest` | `SeoConfigPod` | `PUT /api/binary/system/seo` 请求体 |
| 36 | `PageContentUpdateRequest` | `PageContentPod` | `PUT /api/binary/system/page` 请求体 |
| 63 | `PasskeyRegisterBegin` | `PasskeyRegisterBeginPod` | `POST /api/binary/auth/passkey/register/begin` |
| 64 | `PasskeyLoginBegin` | `PasskeyLoginBeginPod` | `POST /api/binary/auth/passkey/login/begin` |
| 65 | `PasskeyCredentialList` | `PasskeyCredentialSummaryPod[]` | `GET /api/binary/auth/passkey/credentials` |
| 66 | `PasskeyRegisterCompleteRequest` | `PasskeyRegisterCompleteRequestPod` | `POST /api/binary/auth/passkey/register/complete` 请求体 |
| 67 | `PasskeyLoginCompleteRequest` | `PasskeyLoginCompleteRequestPod` | `POST /api/binary/auth/passkey/login/complete` 请求体 |
| 68 | `PasskeyRenameRequest` | `StringMutationRequestPod` | `PUT /api/binary/auth/passkey/credentials/{id}/name` 请求体 |
| 69 | `NotificationEvent` | binary notification value | `/api/notifications/stream` WebSocket 事件 |
| 70 | `NotificationHeartbeat` | `int64 timestampUnixMs` | `/api/notifications/stream` WebSocket 心跳 |
| 71 | `PublicAotBootstrap` | binary tagged value | Public AOT HTML bootstrap / hydration |
| 72 | `SiteComplianceConfigUpdateRequest` | `SiteComplianceConfigPod` | `PUT /api/binary/system/compliance` 请求体 |
| 240 | `EmptySuccess` | `EmptySuccessPod` | 通用空成功响应 |
| 241 | `MutationId` | `MutationIdPod` | 通用变更 ID 响应 |
| 251 | `ApiError` | `ApiErrorPod` | 二进制错误响应 |

---

## POD 大小目录

源码：`src/shared/Contracts/Validation/PodSizeCatalog.cs`

以下尺寸为**编译期常量**，C# 和 C++ 两侧必须保持一致。任何修改须同时更新：
1. `PodSizeCatalog.cs` 中对应字段
2. C++ 头文件中的 `static_assert` 验证
3. 本表格

### 基本类型

| 类型 | 字节数 |
|------|--------|
| `Utf8Fixed32` | 32 |
| `Utf8Fixed64` | 64 |
| `Utf8Fixed128` | 128 |
| `Utf8Fixed256` | 256 |
| `Utf8Fixed512` | 512 |
| `Utf8SliceRef` | 8（int32 Offset + int32 Length） |

### 信封

| 类型 | 字节数 |
|------|--------|
| `PodEnvelopeHeader` | 16 |
| `PageEnvelope` | 8 |
| `CursorEnvelope` | 16 |
| `PagedPodEnvelope` | 24 |
| `CursorPodEnvelope` | 32 |

### 通用响应 POD

| 类型 | 字节数 |
|------|--------|
| `EmptySuccessPod` | 4 |
| `MutationIdPod` | 8 |
| `ApiErrorPod` | 584 |

### 文章 POD

| 类型 | 字节数 |
|------|--------|
| `ArticleListPod` | ~512（含 Title/Summary 字段） |
| `ArticleDetailPod` | ~1024（含内容 SliceRef） |

### 评论 POD

| 类型 | 字节数 |
|------|--------|
| `CommentPod` | ~256 |

### 消息 POD

| 类型 | 字节数 |
|------|--------|
| `MessagePod` | ~512 |

### 用户 / 认证 POD

| 类型 | 字节数 |
|------|--------|
| `UserPod` | ~256 |

### 系统 POD

| 类型 | 字节数 |
|------|--------|
| `SystemPod` | ~128 |
| `SeoConfigPod` | 5000 |
| `SiteComplianceConfigPod` | 1709 |

### 统计 POD

| 类型 | 字节数 |
|------|--------|
| `AdminStatsPod` | ~64 |

### 文件 / PoW POD

| 类型 | 字节数 |
|------|--------|
| `FileUploadOutputPod` | 640 |
| `UploadInitPod` | 440 |
| `UploadStatusPod` | 136 |
| `UploadPartMapPod` | 72 |
| `UploadPartRangePod` | 8 |
| `UploadPartAckPod` | 92 |
| `UploadCompletePod` | 648 |
| `UploadInitRequestPod` | 428 |
| `UploadCompleteRequestPod` | 64 |
| `PowChallengePod` | 204 |

> 精确值以 `PodSizeCatalog.cs` 为准；`PodContractValidation.AreAllPodModelsReferenceFree()` 在测试和启动时校验。

---

## C++ POD 对齐规则

源码：`src/shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md`

### 类型映射

| C# 类型 | C++ 类型 | 大小 |
|---------|---------|------|
| `int` / `int32_t` 值类型 | `std::int32_t` | 4 |
| `long` / `int64_t` 值类型 | `std::int64_t` | 8 |
| `byte` / `uint8_t` | `std::uint8_t` | 1 |
| `bool` 值语义 | `std::uint8_t`（0/1） | 1 |
| `Utf8Fixed32` | `uint8_t[32]` | 32 |
| `Utf8Fixed64` | `uint8_t[64]` | 64 |
| `Utf8Fixed128` | `uint8_t[128]` | 128 |
| `Utf8Fixed256` | `uint8_t[256]` | 256 |
| `Utf8Fixed512` | `uint8_t[512]` | 512 |
| `Utf8SliceRef` | `struct { int32_t Offset; int32_t Length; }` | 8 |
| `DateTime` / `DateTimeOffset` | `std::int64_t`（Unix 毫秒） | 8 |
| 可空值 `T?` | `T Value; uint8_t HasValue;`（+对齐填充） | 取决于 T |

### 字符串长度预算

| 用途 | 固定宽度类型 |
|------|------------|
| 用户名 | `Utf8Fixed64` |
| 角色名 | `Utf8Fixed32` |
| 分类名 / 标签名 / 地区 | `Utf8Fixed128` |
| 文章标题 / 简短 ID | `Utf8Fixed256` |
| URL / Base URL | `Utf8Fixed256` |
| Token / 长字符串 | `Utf8Fixed512` |
| 长文本（正文 / 摘要） | `Utf8SliceRef`（指向 blob 区） |

### 关键约束

1. 所有 POD 类型**不得包含引用类型**（string、class、数组引用）
2. 使用 `PodContractValidation.AreAllPodModelsReferenceFree()` 在单元测试和启动时断言
3. 结构体字段按**从大到小**顺序声明，避免隐式填充
4. C++ 端需用 `static_assert(sizeof(T) == expected)` 验证每个 POD 大小
5. `PodSizeCatalog` 中的值是跨语言对齐的**权威来源**

---

## 参见

- [design.md](design.md) — API 设计哲学
- [contracts.md](contracts.md) — 响应 DTO 完整定义
- [quick-reference.md](quick-reference.md) — 端点速查表
- `src/core/Algorithms/AEDS_V1_PROTOCOL.md` — 完整协议规格
- `src/shared/Contracts/Validation/aeds-protocol.json` — 帧类型与 AEDS header 的生成输入
- `tools/frontend/generate-aeds-protocol.mjs` — 生成并校验三端协议常量
- `src/shared/Contracts/Validation/PodSizeCatalog.cs` — POD 大小权威源码

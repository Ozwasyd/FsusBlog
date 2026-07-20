# 错误码、Binary 帧格式与 POD 大小目录

本文件是 FsusBlog 错误码枚举、AEDS v2 二进制帧格式规格和 POD 类型大小的**完整参考**。

---

## 目录

- [错误码枚举](#错误码枚举)
- [负响应](#负响应)
- [生产就绪详情](#生产就绪详情)
- [AEDS v2 帧格式](#aeds-v2-帧格式)
- [AedsFrameType 枚举](#aedsframetype-枚举)
- [POD 大小目录](#pod-大小目录)
- [C++ POD 对齐规则](#c-pod-对齐规则)

---

## 生产就绪详情

公开 `GET /health/ready` 固定只返回 `status` 与 `checkedAt`。受保护的 `GET /api/ops/health/ready-detail` 需要 admin `audit.read` 权限；其 `checks.release` 是 JSON 运维检查，不是 AEDS frame，字段为 `status`、`releaseId`、`releaseSlot`、完整 `commitSha`、不可变 `imageRef=repository@sha256:...`、`imageDigest` 与可选 `error`。`checks.deployment` 额外返回 release/slot/mode/state/generation、`canReceiveTraffic`、`canClaimBackgroundWork` 和 drain snapshot；Draining 会绕过 readiness cache 立即把整体结果变为 `not_ready`。所有应用响应 header 另带 `X-Fsus-Release-Id`、`X-Fsus-Release-Slot`，仅用于网关核验实际 upstream，不改变 body 或 AEDS frame。生产环境缺少任一发布身份字段、使用可变 release/image 引用或 digest 不一致时，`checks.release.status=failed`、`error=release_identity_invalid`，整体 readiness 必须为 `not_ready`。

发布控制的 JSON schema 为：请求 `{releaseId:string,slot:string,generation:int64,timeoutSeconds?:int32}`；响应 `{accepted:boolean,idempotent:boolean,status:string,errorCode?:string,snapshot:DeploymentRuntimeSnapshot}`。status 直接返回 snapshot。只有 admin `system.config` + loopback source 可访问；错误 identity/generation/state 返回 409，`trusted_host_required` 返回 403。drain 超时的 snapshot 必须保持 `drained=false,timedOut=true` 并列出 `blockers`，禁止把硬终止改写为成功。notification stream 在 Candidate/Draining 分别返回 `deployment_not_active` / `deployment_draining` 和 503 可重试语义。

Active-release fence 的 ops JSON 只在 `/api/ops/deployment/fence/status|acquire|revoke` 使用，身份键为 `releaseId + slot + generation + imageDigest`；generation 必须正数且单调，CAS expected identity 不匹配时 409，不能把 Redis 断连当作本地成功。Notification restart 请求同样绑定 release/slot/generation，成功连接以 WebSocket close code `1012` 表示可识别服务重启，并通过 cursor replay 恢复。演练发布请求 `{releaseId,slot,generation,drillId,count,dryRun}` 的 `count` 为 1..32；生产配置默认关闭并返回 404，启用也不会绕过 admin `system.config`、loopback、active runtime 或 fence 校验。

Schema migration qualification 使用窄 JSON 负响应，不进入 AEDS `ApiError` 枚举：

| route | HTTP | JSON code | 语义 |
| --- | ---: | --- | --- |
| `POST /api/release-evidence/schema-bridge/write` | 400 | `schema_qualification_write_invalid` | operationId/sequence 不满足有界 tooling contract |
| `GET /api/release-evidence/schema-qualification/readiness` | 503 | `schema_incompatible` | 隔离资格场景已标记 missing Expand，candidate 不可继续 |

两条 route 只在 environment 精确为 `Test` 且
`SchemaMigration:QualificationEnabled=true` 时存在，注册后仍要求 admin
`system.config` + `fixed_ip`。响应携带 release ID/slot header 和 `no-store`；生产不
注册，因此不得把这些 code 当作公开 runtime compatibility fallback。

---

## 错误码枚举

### Public HTML 负响应

公共 HTML 不使用 AEDS `ApiError` body。搜索 query 超过 2048 字符、规范化后的 `q` 超过 128 字符或含非空白控制字符时返回 400；无效路径或不存在/不可公开实体返回 404；只有数据模型明确永久删除时才返回 410；provider、DB gate 或其它临时依赖故障返回 503 + `Retry-After: 5`。这些响应统一为独立 `noindex,follow` HTML，带 `Cache-Control: no-store`、`X-Robots-Tag: noindex, follow`、`X-Fsus-Public-Aot-Backfill: none`，不带 canonical、`og:url`、`BlogPosting`、SPA boot 或 hydration payload。

| HTTP | `X-Fsus-Public-Aot-State` | 重试语义 |
| ------ | --------------------------- | ---------- |
| 400 | `invalid-request` | 缩短/修正搜索 query；不得按成功搜索页缓存 |
| 404 | `not-found` | 修改 URL 或等待内容真正公开；不得缓存为成功页 |
| 410 | `gone` | 仅明确永久删除；当前文章删除模型未使用 |
| 503 | `transient-failure` | 可重试，读取 `Retry-After` |

GET 与 HEAD 返回相同状态和关键头；HEAD 保留与 GET 相同的 `Content-Length`，但 body 为空。除 `/` 外的尾斜杠不是负响应，而是 301 到无尾斜杠 canonical。

标签名称 URL 也不是成功响应：`/tag/{name}` 先按 Unicode NFC + invariant case lookup 解析当前名称或 `tag_url_alias`，成功时 301 到唯一 `/tag/{id}`；query 原样保留。无法解析或名称归一化后存在歧义时返回上述 404，不得返回首页、名称 self-canonical 或多跳 redirect。

搜索 query 的 canonical order 为 `q`、`sort`、`page`。空值、重复项、未知项、默认 `sort=relevance`、默认 `page=1`、非法 sort/page 通过 301 删除或规范化；无查询词统一到 `/search`。成功搜索 HTML 与上述 400 均为 `noindex,follow`，但只有 400 使用 `no-store` 独立状态页。

错误码以固定宽度 UTF-8 字段写入 AEDS `ApiError` frame，按模块分组。

消息内容校验错误使用 `ErrorCode.Validation`：`message_subject_empty`、
`message_body_empty`、`message_subject_scalar_limit_exceeded`、
`message_subject_grapheme_limit_exceeded`、`message_subject_utf8_limit_exceeded` 以及对应的
`message_body_*`。frame 超过共享 20 KiB 上限时由 binary binder 返回 Validation。错误响应不得
回显原始主题或正文，且任何超限失败都不得产生会话、消息、outbox 或 unread 变更。

### 通用错误

| 错误码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `InvalidRequest` | 400 | 请求参数格式无效 |
| `Conflict` | 409 | 当前请求与已提交状态冲突；`article_responsibility_version_conflict` 表示 stale `expectedVersion`，客户端须重读 `ArticleResponsibilityHistory(228)` 后人工合并；refresh 短竞争窗口内表示其他标签页已完成轮换，不撤销 session family |
| `NotFound` | 404 | 资源不存在 |
| `Unauthorized` | 401 | 未认证或令牌失效 |
| `Forbidden` | 403 | 权限不足 |
| `RateLimited` | 429 | 请求频率超限 |
| `InternalError` | 500 | 服务端内部错误 |

### 认证错误

| 错误码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `InvalidCredentials` | 401 | 用户名或密码错误 |
| `AccountBanned` | 403 | 账号已被封禁 |
| `AccountNotFound` | 404 | 账号不存在 |
| `UsernameAlreadyTaken` | 409 | 用户名已被占用 |
| `EmailAlreadyTaken` | 409 | 邮箱已被注册 |
| `TokenExpired` | 401 | 令牌已过期 |
| `TokenInvalid` | 401 | 令牌格式无效 |
| `RefreshTokenInvalid` | 401 | Refresh Token 无效、过期或超过短竞争窗口后重放；服务端继续按 family replay 策略 fail closed |
| `SessionNotFound` | 404 | 会话不存在或已过期 |

### PoW 错误

| 错误码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `PowChallengeNotFound` | 400 | 挑战令牌不存在或已过期 |
| `PowAnswerInvalid` | 400 | PoW 答案不满足难度要求 |
| `PowChallengeAlreadyUsed` | 400 | 挑战令牌已被使用（防重放） |

### MFA 错误

| 错误码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `MfaAlreadyEnabled` | 409 | MFA 已启用 |
| `MfaNotEnabled` | 400 | MFA 未启用 |
| `MfaCodeInvalid` | 400 | TOTP 码错误 |
| `MfaRecoveryCodeInvalid` | 400 | 恢复码无效 |
| `MfaRecoveryCodesExhausted` | 400 | 恢复码已全部使用 |
| `MfaChallengeTokenInvalid` | 401 | MFA 挑战令牌无效或过期 |

### Passkey 错误

| 错误码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `PasskeyCredentialLimitReached` | 409 | 已达到最大密钥数量（5 枚） |
| `PasskeyCredentialNotFound` | 404 | 指定密钥不存在 |
| `PasskeyAssertionFailed` | 401 | Passkey 断言验证失败 |
| `PasskeyRegistrationFailed` | 400 | Passkey 注册失败 |
| `PasskeyMfaProofRequired` | 403 | 注册新 Passkey 需提供 MFA 证明令牌 |

### 内容错误

| 错误码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `ArticleNotFound` | 404 | 文章不存在 |
| `CommentNotFound` | 404 | 评论不存在 |
| `CommentContentEmpty` | 400 | 评论内容为空 |
| `CommentContentTooLong` | 400 | 评论内容超出长度限制 |
| `CategoryNotFound` | 404 | 分类不存在 |
| `TagNotFound` | 404 | 标签不存在 |

评论创建幂等边界的固定失败语义：public 缺失/非法 `X-Fsus-Client-Mutation-Id` 返回
`400 comment_client_mutation_id_required` / `comment_client_mutation_id_invalid`；public 相同账号与 mutation id、
或 anonymous 相同 ticket 承诺携带不同规范化请求时返回 `409 comment_mutation_content_conflict`。
动态 fail-close 返回 `503 comment_mutation_idempotency_disabled`。

### 消息系统错误

| 错误码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `ConversationNotFound` | 404 | 对话不存在 |
| `ConversationClosed` | 400 | 对话已关闭，无法回复 |
| `MessageNotFound` | 404 | 消息不存在 |
| `MessageRevoked` | 400 | 消息已撤回 |

消息写入幂等边界的固定失败语义：缺失/非法 `X-Fsus-Client-Mutation-Id` 返回 `400`
`client_mutation_id_required` / `client_mutation_id_invalid`；相同 mutation id 携带不同规范化内容
返回 `409 client_mutation_content_conflict`。系统消息缺失/非法
`X-Fsus-Source-Event-Id` 返回 `400 source_event_id_required` / `source_event_id_invalid`，相同来源
坐标内容变化返回 `409 source_event_content_conflict`。动态 fail-close 返回
`503 message_mutation_idempotency_disabled`。

### Binary / 文件上传错误

| 错误码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `UploadNotFound` | 404 | 上传任务不存在 |
| `UploadExpired` | 400 | 上传任务已过期 |
| `UploadPartMissing` | 400 | 分片未完整上传 |
| `FileTooLarge` | 400 | 文件超出大小限制 |
| `FileTypeNotAllowed` | 400 | 文件类型不允许 |

### Notification Stream 握手失败码

Notification stream preflight 与 WebSocket 握手失败会在 `X-Fsus-Notification-Stream-Error-Code` 头、JSON preflight body 或 AEDS `ApiError` frame 中携带以下传输级失败码：

| 失败码 | HTTP 状态 | 含义 |
| -------- | ----------- | ------ |
| `websocket_required` | 426 | 正式通知通道不是 WebSocket upgrade |
| `protocol_mismatch` | 409 | 缺失或不接受 `fsus-aeds.v2` 子协议 |
| `auth_failed` | 401 | 携带认证头但认证失败 |
| `pow_failed` | 401/400 | 匿名连接提交了无效 legacy PoW |
| `risk_challenge_required` | 428 | 匿名 `notification.subscribe` 需要 completed aggregate RiskControl proof，且未提供 legacy `pow` 兼容 proof |
| `risk_challenge_rejected` | 428 | aggregate proof 缺失，envelope 未完成/失败/过期/撤销/重放，或 action/route/identity/envelope/ordered requiredKinds 绑定不匹配 |
| `risk_challenge_kind_mismatch` | 428 | 最后 member header kind 或 aggregate claims 的 ordered requiredKinds 与当前裁决要求不一致 |
| `risk_control_blocked` | 429 | 当前风险裁决阻断匿名订阅 |
| `risk_control_throttled` | 429 | 当前风险裁决要求限流 / 降速，通知订阅不进入业务通道 |
| `account_blocked` | 423 | Notification stream 握手期登录用户处于封禁状态 |
| `ACCOUNT_BANNED_WRITE_LOCKED` | 423 | 受限会话尝试普通业务写入，作为 Binary `ApiError.Details` 返回 |
| `account_deleted` | 401 | 登录用户不存在、已删除或已停用 |
| `notification_handshake_failed` | 500 | 未分类握手失败 |

---

RiskControl aggregate verify 的公开失败面保持有界：缺少 `envelopeId` 的旧 verify wire、非 UUIDv7 envelopeId 或结构无效在 decode/validation 阶段返回 `security_challenge_verify_request_invalid`；有效 envelope/member 但 envelopeId、ordinal、action、route、identity、policy 或 member binding 不符时，服务端内部可记录 `challenge_envelope_binding_mismatch`，对 binary caller 统一返回 HTTP 428 + `challenge_failed`，避免形成 binding oracle。member 失败、过期、撤销、重放、顺序错乱、Redis CAS/TTL miss、incomplete aggregate proof 与 requiredKinds mismatch 同样 fail closed，不新增公开 JSON fallback。capability catalog 的 `capability_unavailable` / `executor_unavailable` 等仍是签发/readiness 的内部受控 reason，不承诺新增 public 客户端版本错误码。

---

封禁类错误不得依赖 Redis 黑名单是否命中：服务端以 `sys_user.Status/BanReason` 为真源，`SecurityBlacklistUser` 只做无过期缓存；缓存 miss 会回查数据库并回填后再返回 `AccountBanned`、`account_blocked` 或写入锁 `ACCOUNT_BANNED_WRITE_LOCKED`。封禁账号可以持有受限会话完成登出、撤销会话、删除本人账号等安全收尾动作；普通业务写入统一由服务端返回 `423 Locked`，不能只依赖前端禁用按钮。

## 负响应

L0 artifact fast path 的负响应不写 AEDS frame body，固定 `Cache-Control: no-store`，避免缓存未就绪、方法不匹配或内容协商失败结果。`400` / `404` / `405` / `406` / `416` / `503` 的语义以 [design.md#l0-artifact-http-语义](design.md#l0-artifact-http-语义) 和 `PublicHotReadFastPath` 为准；active revocation tombstone 使用 `410 Gone`、`Cache-Control: no-store, no-cache, must-revalidate`、`X-Fsus-Generation: <decimal>` 与 `X-Fsus-Revoked: g<generation>`，不带 body、ETag 或 Content-Encoding。`503` 默认带 `Retry-After: 1`，`Range` 请求返回 `416` 并声明 `Accept-Ranges: none`。这些负响应必须带公开 HTML artifact 同款静态浏览器安全头，包括 `Content-Security-Policy`、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、COEP、COOP 和 CORP。

常规 AEDS binary 端点的业务失败使用 `AedsFrameType.ApiError = 251`；notification stream preflight / WebSocket 握手失败还会写 `X-Fsus-Notification-Stream-Error-Code` 与 `X-Fsus-Notification-Stream-Status-Code`。

强匿名 ticket / submit endpoint 的登录态污染失败使用 AEDS `ApiError`，HTTP status 为 `403`，`Code=Forbidden`，`Details=anonymous_identity_contaminated`；用户态 message 固定为“匿名发布请求不能携带登录态，请刷新后重试。”。

## AEDS v2 帧格式

权威规格：`src/core/Algorithms/AEDS_V2_PROTOCOL.md`（当前运行时只接受 v2 frame）

### 帧头布局（16 字节，小端序）

```text
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

```text
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

```text
[count/meta] [blobLength:int32 + blob] [fixed numeric records] [slice refs into blob]
```

- `ArticleList`：writer 先写 cursor envelope v2：`magic:int32=0x41535046`、`version:int32=2`、`hasMore:byte`、`total:int32`、`nextCursor:bytes`，再写 `count:int32`、`tagRecordCount:int32`、共享 blob、每篇当前 100B article record、每个 tag 12B record。cursor 是最大 64B 的 canonical base64url opaque token，`hasMore=true` 时必须非空；decoder 只读兼容 envelope v1 及 56B/76B article record。100B record 在旧 76B 生命周期字段后追加 `currentRevisionId:int64`、`revisionNo:int32`、`currentPublicationId:int64`、`publicationNo:int32`。
- `ArticleSearch`：当前 FAS4 payload 在计数前写 magic/version，并为每条 article 写入同一组 24B publication 坐标；无 magic/version 的旧 payload 仅保留读取兼容。离线 search shard/package/manifest 与 Wasm result 使用 version 4，doc metadata/result item 为 76B。
- `ArticleHot`：`count:int32`、共享 blob、每篇 16B record。
- `Category` / `Tag`：`count:int32`、共享 blob、每条 16B record。
- `AdminStats`：80B `SiteStatsPod`、共享 blob、popular 16B record、recent comment 56B author-snapshot record、region 12B record。阅读摘要字段为 `totalReads`、`humanVerifiedReads`、`uniqueViewerKeyEstimate`、`articleReads`、`siteReads`，不包含账号身份拆分。
- 写请求、认证、上传和少量复杂详情 frame 仍使用 v2 header 包裹的 POD + blob 结构；线格式只接受 v2。

当前兼容的 payload 字典化落点是 shared UTF-8 blob + `Utf8SliceRef`：ArticleList/ArticleSearch/Conversation records 不重复内嵌文本，category/tag/title/summary/body 均通过 slice 引用共享 blob。后续若新增 ArticleList category/tag dictionary layout，应以新版本 payload/golden fixture 登记，不复用未标记的旧 record layout。

---

## AedsFrameType 枚举

生成输入：`src/shared/Contracts/Validation/aeds-protocol.json`

生成产物：`src/core/Algorithms/AedsFrameType.cs`、`src/shared/AedsFrameHeader.cs`、`src/frontend/wasm/web/protocol/frame.ts`

已退休且不得复用的 AEDS 数值记录在 `retiredFrameValues`：`40` 为 legacy admin password reset slot，`43`/`44`/`45`/`46` 为 legacy username/password auth slots。这些数值不生成 frame 名、POD、codec 或 OpenAPI 契约；解码器收到对应 raw frame type 时按 retired frame 拒绝。

| 值 | 名称 | POD 类型 | 对应二进制端点 / 用途 |
| ---- | ------ | --------- | ---------------- |
| 0 | `Unknown` | — | — |
| 1 | `ArticleList` | `ArticleListPod` | `GET /api/binary/article/list/home/{page}/{size}.aeds`；分类/标签列表见 `quick-reference.md` |
| 2 | `ArticleDetail` | 当前 V5 detail/tag/rights records；只读兼容 V4/V3 | `GET /api/binary/article/{id}.aeds` |
| 3 | `ArticleHot` | `ArticleListPod` | `GET /api/binary/article/hot/{size}.aeds` |
| 4 | `ArticleSearch` | `ArticleListPod` | 搜索索引 / author cache 诊断，不暴露旧文本业务路径 |
| 5 | `CommentArticleCursor` | `CommentThreadItemPod` + item blob | `GET /api/binary/comment/{articleId}`；每个 item blob 在 content 后追加必备 `CommentAuthorView` payload 与可空 `replyToAuthor` payload |
| 6 | `CommentUserCursor` | `CommentPod` | `GET /api/binary/comment/me` 当前用户可归因评论记录；可选 `articleId` 仅用于认证私有 ownership overlay |
| 7 | `AdminStats` | `AdminStatsPod` | — |
| 8 | `CommentThreadReplyCursor` | `CommentReplyItemPod` + item blob | `GET /api/binary/comment/{articleId}/thread/{rootId}`；每个 reply item blob 在 content 后追加必备 `CommentAuthorView` payload 与可空 `replyToAuthor` payload |
| 9 | `CategoryList` | compact taxonomy records | `GET /api/binary/category.aeds` |
| 10 | `TagList` | compact taxonomy records | `GET /api/binary/tag.aeds` |
| 11 | `RecentCommentStats` | compact stats records | `GET /api/binary/stats/recent-comments` |
| 12 | `RegionStats` | compact stats records | `GET /api/binary/stats/regions` |
| 13 | `SeoConfig` | `SeoConfigPod` | `GET /api/binary/system/seo` |
| 14 | `PageContent` | `PageContentPod` | `GET /api/binary/system/page/{slug}` |
| 15 | `ArticleFeatured` | compact article records | `GET /api/binary/article/featured/{size}.aeds` |
| 16 | `TrashClearResponse` | `TrashClearResponsePod` | `DELETE /api/binary/admin/article/trash` |
| 17 | `AdminUserList` | compact anonymous account records | `GET /api/binary/admin/users` |
| 18 | `AuthLoginFlow` | auth flow；`AuthPhase=1 authenticated / 2 mfa_required / 3 enrollment_required` | anonymous bootstrap、enrollment status/complete、Passkey login complete |
| 19 | `CurrentUserSnapshot` | admin-only account status snapshot without username/role | admin-only accountId query / refresh-token compatibility |
| 20 | `UploadInit` | `UploadInitPod` | `POST /api/binary/upload/init` |
| 21 | `UploadStatus` | `UploadStatusPod` | `GET /api/binary/upload/{id}` |
| 22 | `UploadPartAck` | `UploadPartAckPod` | `PUT /api/binary/upload/{id}/part/{n}` |
| 23 | `UploadComplete` | `UploadCompletePod` | `POST /api/binary/upload/{id}/complete` |
| 24 | `UploadPartMap` | `UploadPartMapPod` | `GET /api/binary/upload/{id}/parts` |
| 25 | `AuthSessionList` | privacy-safe `UserSessionSummaryPod[count]` without credential id, fingerprint, token, raw user agent/IP, or user id | `GET /api/binary/auth/sessions` |
| 26 | `SiteComplianceConfig` | `SiteComplianceConfigPod` | `GET /api/binary/system/compliance` |
| 170 | `AdminSessionList` | `AdminSessionSummaryPod[count]` | `GET /api/binary/auth/admin/sessions` |
| 171 | `SecurityChallengeAssignment` | `SecurityChallengeAssignmentPod` | ordered envelope 中的单个 RiskControl member assignment |
| 172 | `SecurityChallengeEnvelope` | `SecurityChallengeEnvelopePod` + `SecurityChallengeAssignmentPod[]` | UUIDv7 envelope 与 1..8 个 ordered required members；单 challenge 同样使用 |
| 30 | `PowChallenge` | `PowChallengePod` | `GET /api/binary/auth/pow-challenge` |
| 31 | `UploadInitRequest` | `UploadInitRequestPod` | `POST /api/binary/upload/init` 请求体 |
| 32 | `UploadCompleteRequest` | `UploadCompleteRequestPod` | `POST /api/binary/upload/{id}/complete` 请求体 |
| 35 | `SeoConfigUpdateRequest` | `SeoConfigPod` | `PUT /api/binary/system/seo` 请求体 |
| 36 | `PageContentUpdateRequest` | `PageContentPod` | `PUT /api/binary/system/page` 请求体 |
| 63 | `PasskeyRegisterBegin` | `PasskeyRegisterBeginPod` | 普通注册与首枚 enrollment/admin bootstrap begin 复用；POD 字段使用 `accountHandle`/`accountName`/`accountDisplayName` |
| 64 | `PasskeyLoginBegin` | `PasskeyLoginBeginPod` | `POST /api/binary/auth/passkey/login/begin`；admin login begin 复用 |
| 65 | `PasskeyCredentialList` | `PasskeyCredentialSummaryPod[]` | `GET /api/binary/auth/passkey/credentials` |
| 66 | `PasskeyRegisterCompleteRequest` | `PasskeyRegisterCompleteRequestPod` | 普通注册、首枚 enrollment 与 admin bootstrap complete 请求体 |
| 67 | `PasskeyLoginCompleteRequest` | `PasskeyLoginCompleteRequestPod` | `POST /api/binary/auth/passkey/login/complete`；admin login complete 请求体 |
| 68 | `PasskeyCredentialFriendlyNameUpdateRequest` | `PasskeyCredentialFriendlyNameUpdateRequestPod` | `PUT /api/binary/auth/passkey/credentials/{id}/name` 请求体 |
| 212 | `PasskeySignalState` | `PasskeySignalStatePod` + `PasskeySignalCredentialPod[]` | Passkey 注册/删除响应与 `GET /api/binary/auth/passkey/signal-state`；含单调 revision 和服务端权威完整凭证集 |
| 214 | `AnonymousCommentCreateResult` | JSON-in-AEDS | 强匿名创建结果；首次成功附带 `managementSecret`，幂等 replay 为空；响应 `no-store` |
| 215 | `CommentManagementChallengeRequest` | JSON-in-AEDS | challenge purpose 与可选匿名 capability；敏感值只允许 request body |
| 216 | `CommentManagementChallengeResponse` | JSON-in-AEDS | 5 分钟一次性 challenge、过期时间与当前评论版本 |
| 217 | `CommentAuthorEditRequest` | JSON-in-AEDS | expectedVersion、正文、challenge；匿名请求额外携带 capability |
| 218 | `CommentAuthorMutationResult` | JSON-in-AEDS | edit/delete/appeal 的稳定结果码、当前版本与重新审核状态 |
| 219 | `CommentAuthorStatusRequest` | JSON-in-AEDS | delete/status challenge；匿名请求额外携带 capability |
| 220 | `CommentAuthorStatusResult` | JSON-in-AEDS | capability-scoped 当前审核/删除/编辑状态，不包含历史正文 |
| 221 | `CommentAuthorAppealRequest` | JSON-in-AEDS | 匿名申诉原因、challenge 与 capability |
| 222 | `CommentRevisionList` | JSON-in-AEDS | admin-only 修订内容、SHA-256、操作、时间与 actor mode |
| 223 | `CommentReportRequest` | JSON-in-AEDS | 固定 reason code、可选说明；匿名入口额外携带 comment-scoped credential |
| 224 | `CommentReportResult` | JSON-in-AEDS | report id、是否重复；不代表评论可见性变化 |
| 225 | `CommentModerationTimeline` | JSON-in-AEDS | admin-only append-only 事件、重建投影与一致性标记 |
| 226 | `CommentAppealDecisionRequest` | JSON-in-AEDS | granted/denied、复核理由；admin step-up |
| 227 | `CommentAppealDecisionResult` | JSON-in-AEDS | 申诉决定结果与 appeal id |
| 69 | `NotificationEvent` | binary notification value | `/api/notifications/stream` WebSocket 事件；`CommentAdded` payload 的 `comment` 字段使用 `author` / `replyToAuthor` 作者快照，不允许恢复 legacy identity fields |
| 70 | `NotificationHeartbeat` | `int64 timestampUnixMs` | `/api/notifications/stream` WebSocket 心跳 |
| 71 | `PublicAotBootstrap` | binary tagged value | Public AOT HTML bootstrap / hydration；`GET /api/public/navigation-snapshot.aeds?path=...` 的 `public-navigation-snapshot` envelope（含 schema/version/SHA-256 digest 的 `PublicSeoHeadModel`） |
| 72 | `SiteComplianceConfigUpdateRequest` | `SiteComplianceConfigPod` | `PUT /api/binary/system/compliance` 请求体 |
| 159 | `RecoveryKeyCreateResponse` | `RecoveryKeyCreateResponsePod` | `POST /api/binary/auth/recovery-key/create`、`/rotate` 响应 |
| 160 | `RecoveryKeyVerifyRequest` | `RecoveryKeyVerifyRequestPod` | `POST /api/binary/auth/recovery-key/verify` 请求体；不携带 account id，服务端从 Recovery Key lookup id 定位 |
| 161 | `RecoveryKeyVerifyResponse` | `RecoveryKeyVerifyResponsePod` | Recovery Key 验证成功响应；只返回 recovery session token 与过期时间 |
| 162 | `RecoveryKeySessionRequest` | `StringMutationRequestPod` | Recovery session token 请求体；用于 Passkey recovery begin |
| 163 | `IdentityAccountSnapshot` | `IdentityAccountSnapshotPod` | `GET /api/binary/auth/me`；匿名身份 account id、identity kind、public handle、Passkey/Recovery/TOTP/anonymous credential 和状态字段；不暴露 internalUserId；access 到期时间只通过 `X-Fsus-Access-Expires-At-Utc` HTTP header 传递，不占 POD |
| 164 | `CommentPolicySnapshot` | `CommentPolicySnapshotPod` | 评论 composer 渲染前策略：anonymous/public/ZK 开关、完整 ZK-Prod 原始位与受控 unavailable reason、默认 author mode、语言列表、策略 snapshot hash；前端 41-byte layout 映射 client contract v3，旧/损坏 layout 一律 `contract_invalid` |
| 165 | `CommentPolicyUpdateRequest` | `CommentPolicyUpdateRequestPod` | admin 匿名评论策略 patch 请求体 |
| 166 | `CommentCreateV2Request` | `CommentCreateV2RequestPod` | 登录态 public 新评论；必须 explicit opt-in。旧 `anonymous` 返回 `anonymous_author_mode_retired` 且零业务写，`zk_anonymous` 返回 `anonymous_ticket_required`；legacy scope/proof 槽只保留 wire layout |
| 167 | `CommentAuthorView` | `CommentAuthorViewPod` | 评论作者展示投影；评论 cursor 必须显式携带，客户端不得从 legacy identity string 伪造匿名/公开显示名 |
| 177 | `AnonymousCredentialIssueRequest` | `AnonymousCredentialIssueRequestPod` | 已撤销的 circuit-native 请求 frame；旧 endpoint 固定 410 |
| 178 | `AnonymousCredentialIssueResponse` | `AnonymousCredentialIssueResponsePod` | 已撤销的 circuit-native 响应 frame；运行时不得返回 |
| 179 | `AnonymousCredentialRootSnapshot` | `AnonymousCredentialRootSnapshotPod` | 匿名凭证 root/verifying-key snapshot；包含 issuer public key hash、credential/revocation root；`GET /api/binary/anonymous-credential/root` 与 `/circuit` 响应 |
| 180 | retired | — | 旧精确属性 ticket request；必须按未知/退休 frame fail closed |
| 181 | retired | — | 旧精确属性 ticket response；必须按未知/退休 frame fail closed |
| 198 | `AnonymousCommentTicketRequest` | `AnonymousCommentTicketRequestPod` | v5/layout 6 最小资格谓词、root hashes、proof 与 canonical public inputs；不携带精确属性 |
| 199 | `AnonymousCommentTicketResponse` | `AnonymousCommentTicketResponsePod` | expiry、`common` / `unknown` rate class、审核谓词、opaque ticket 与 moderation subject hash |
| 200 | `SecurityChallengeCancelRequest` | `SecurityChallengeCancelRequestPod` + shared blob | 撤销 action/route/device/policy 绑定的 aggregate challenge envelope；响应为 `EmptySuccess` |
| 205 | `CommentCreateResult` | `CommentCreateResultPod` | 40-byte 完整创建结果：comment/root/parent ID、createdAt、moderation/visibility、公开可见与 idempotency replay 标记 |
| 201 | `ConversationReadRequest` | `ConversationReadRequestPod` | 账号 mark-read 显式 `readThroughMessageId` |
| 202 | `AccountConversationReplyRequest` | `AccountConversationReplyRequestPod` + shared blob | 账号回复正文与显式读取位置；admin 回复继续使用 frame 60 |
| 203 | `ConversationDetailV2` | `ConversationDetailV2Pod` + message records/blob | 对话详情与可见 `readSnapshotMessageId` |
| 204 | `ConversationDetailV3` | `ConversationDetailV3Pod` + message records/blob | 固定消息页、`previousCursor`、`hasOlder` 与读取快照 |
| 206 | `AdminConversationList` | `AdminConversationListItemPod` + shared blob | admin-only 列表；原列表记录 + 最小对方 account id/status |
| 207 | `AdminConversationDetail` | `AdminConversationDetailPod` + message records/blob | admin-only 详情；V3 header + 最小对方 account id/status |
| 208 | `CommentTreeRootCursor` | cursor envelope + `CommentTreeNodePod` records | 根节点 keyset 页；每根仅内联直接子节点预览 |
| 209 | `CommentChildCursor` | `CommentChildCursorPod` + `CommentTreeNodePod` records | 指定父节点的直接子节点 keyset 页 |
| 210 | `CommentPermalinkContext` | `CommentPermalinkContextPod` + node records | 永久链接祖先、目标与兄弟窗口；不可见目标统一 `unavailable` |
| 211 | `ConversationStatusMutationResult` | `ConversationStatusMutationResultPod` | 状态 CAS 结果；previous/current status + `changed`/`no_change` outcome |
| 213 | `ArticleRevisionRollbackRequest` | AEDS JSON `{baseRevisionId,targetStatus,reason}` | admin revision rollback 请求；目标仅 Draft/Published/Archived，创建新 revision/release，不复用历史行 |

`ConversationList(56)` 与 `ConversationDetailV3(204)` 的 wire layout 不因 admin queue state
新增字段。相同 `unreadCount` 字段按 viewer 使用不同事实源：账号读取 participant state，
admin 读取 `msg_admin_queue_state`；公共/账号 frame 不暴露 admin queue version、admin session
或管理主体标识。admin queue 动态关闭时使用 `ApiError(251)` details
`message_admin_queue_projection_disabled`。

`AdminConversationList(206)` / `AdminConversationDetail(207)` 只允许 admin 路由发送；增加的
`counterpartyAccountId:int64` 和 `counterpartyAccountStatus:int32` 不得进入账号端
`ConversationList(56)` / `ConversationDetailV3(204)`。status 仅接受 `0..3`，account id 为 0 时
status 必须为 `3=missing`。动态关闭 admin account projection 时返回 `ApiError(251)` details
`message_admin_account_projection_disabled`，不得复用账号 frame 作为回退。

账号与 admin 回复在同一事务屏障内锁定会话、校验 status、插入消息、更新 activity/unread，
并且只在提交成功后发布 delivery event。会话不存在返回 `404`；closed 或锁后状态冲突返回
`409`；事务基础设施失败返回 `503`。动态关闭 `Messages:ReplyWritesEnabled` 时两个 reply
端点固定返回 `503` + `message_reply_writes_disabled`，读取和显式重开仍可使用。

状态更新请求必须携带 1..256 字符审计原因；缺失或超限返回 `400` +
`conversation_status_reason_invalid`。不允许的状态机边返回 `409` +
`conversation_status_transition_invalid`；CAS 后发现其它目标状态返回 `409`。相同目标状态返回
frame 208 的 `no_change`，不属于错误。动态关闭 `Messages:StatusMutationsEnabled` 时返回
`503` + `message_status_mutations_disabled`，不得降级为无审计或直接实时发布。

系统消息目标错误固定区分：目标不存在为 `404 system_message_target_not_found`，已注销为
`404 system_message_target_deleted`，普通消息投递到受限账号为
`403 system_message_target_restricted`，未知账户状态为
`403 system_message_target_status_invalid`。目标锁定/校验热关闭时，新 source event 返回
`503 system_message_target_validation_disabled`；已提交的同摘要 replay 不受影响。

`msg_participant_state.unreadcount` 与 `msg_admin_queue_state.unreadcount` 必须 `>= 0`。两表的
`lastreadmessageid` 非空时必须引用同一 conversation 的非 internal `msg_message`，普通事务中
不得从已有值后退或清空。受控 unread repair transaction 可把历史无效游标重置为 null 后重算；
维护开关关闭时不执行修复，不放宽这些数据库约束。
| 182 | `AnonymousCommentCreateRequest` | `AnonymousCommentCreateRequestPod` | `POST /api/binary/comment/anonymous` 请求体；不包含 user id、username、Authorization token 或 public handle |
| 183 | `AnonymousPrivacyStateSnapshot` | `AnonymousPrivacyStateSnapshotPod` | 前端匿名隐私状态快照 |
| 184 | `PerceptionSealedChallengeV2` | `PerceptionSealedChallengeV2Pod` | `fsu.challenge/perception-sealed@v2` issue payload；覆盖 Character、Localization、MicroInteraction 三类 perception task |
| 185 | `PerceptionSealedResultV2` | `PerceptionSealedResultV2Pod` | `fsu.challenge/perception-sealed@v2` verify payload；支持 character、coordinates、steps response payload |
| 186 | `RetiredCredentialSpecificRevocationRequest` | 无 | 永久 retired；不得复用或解析 body |
| 187 | `RetiredCredentialSpecificRevocationResponse` | 无 | 永久 retired；服务端不发送 |
| 196 | `AnonymousCredentialRevocationSnapshot` | `AnonymousCredentialRevocationArtifactPod` | 公共 full revoked-set snapshot |
| 197 | `AnonymousCredentialRevocationDelta` | `AnonymousCredentialRevocationArtifactPod` | 公共 append-only delta |
| 193 | `BlindCredentialIssuerMetadata` | `BlindCredentialIssuerMetadataPod` | `GET /api/binary/anonymous-credential/blind-issuer`；RFC 9474 profile 与 3072-bit RSA DER SPKI |
| 194 | `BlindCredentialIssueRequest` | `BlindCredentialIssueRequestPod` | `POST /api/binary/anonymous-credential/blind-issue`；384B blinded representative |
| 195 | `BlindCredentialIssueResponse` | `BlindCredentialIssueResponsePod` | 384B blind signature；浏览器本地 unblind/verify |
| 189 | `AuthAnonymousBootstrapRequest` | `AuthAnonymousBootstrapRequestPod` | `POST /api/binary/auth/anonymous/bootstrap` 请求体；只含规范确认和可选 public handle，不含旧注册密码字段 |
| 190 | `AuthUpdatePublicHandleRequest` | `StringMutationRequestPod` | `PUT /api/binary/auth/public-handle` 请求体；保存或清空当前账号 public handle |
| 240 | `EmptySuccess` | `EmptySuccessPod` | 通用空成功响应 |
| 241 | `MutationId` | `MutationIdPod` / `ArticleMutationResponsePod` | 通用变更 ID 响应；文章 create/update 使用 28B 扩展，携带 article/revision 与 rights snapshot 坐标 |
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
| ------ | -------- |
| `Utf8Fixed32` | 32 |
| `Utf8Fixed64` | 64 |
| `Utf8Fixed128` | 128 |
| `Utf8Fixed256` | 256 |
| `Utf8Fixed512` | 512 |
| `Utf8SliceRef` | 8（int32 Offset + int32 Length） |

### 信封

| 类型 | 字节数 |
| ------ | -------- |
| `PodEnvelopeHeader` | 16 |
| `PageEnvelope` | 8 |
| `CursorEnvelope` | 16 |
| `PagedPodEnvelope` | 24 |
| `CursorPodEnvelope` | 32 |

### 通用响应 POD

| 类型 | 字节数 |
| ------ | -------- |
| `EmptySuccessPod` | 4 |
| `CommentCreateResultPod` | 40 |
| `MutationIdPod` | 8 |
| `ApiErrorPod` | 584 |

### 文章 POD

| 类型 | 字节数 |
| ------ | -------- |
| `ArticleListPod` | ~512（含 Title/Summary 字段） |
| `ArticleDetailPod` | legacy；公开运行时不再接受 |
| `ArticleDetailV3HeaderPod` | 44 |
| `ArticleDetailV3RecordPod` | 84 |
| `ArticleDetailV4HeaderPod` | 44 |
| `ArticleDetailV4RecordPod` | 92 |
| `ArticleDetailV5RecordPod` | 116 |
| `ArticleDetailTagV3RecordPod` | 12 |
| `ArticleRightsV3RecordPod` | 112 |
| `ArticleMutationResponsePod` | 28 |
| `ArticleWriteRequestPod` | 40（固定前缀；后接 tags/blob/lifecycle/rights 段） |
| `ArticleRightsWriteRequestPod` | 40 |

`ArticleWriteRequest` 当前写入版本为 V5。在 V4 rights 段和 rights blob 后追加 `baseRevisionId:int64`；create 写 `0`，update 必须写正数。既有 `status:int32`、`scheduledPublishAtUnixMs:int64` 后写入
`version=5` 与 `rightsMutation:int32`：`0=preserve`、`1=replace`、`2=reset`。`replace` 必须携带完整 rights
payload；`reset` 不得同时携带 replacement payload。V3 rights payload 只读兼容为 `replace`；rights 功能加入前、
仅含文章主体和 lifecycle tail 的旧 payload 只读兼容为 `preserve`。文章 create/update 的 frame type 仍为
`MutationId(241)`，但 payload 使用 `ArticleMutationResponsePod`：`id:int32`、`revisionId:int64`、`revisionNo:int32`、`rightsSnapshotId:int64`、`rightsRevisionNo:int32`；其他通用 mutation 继续使用 8B `MutationIdPod`。`article_revision_conflict` 使用 HTTP 409 `ApiError`，details 为当前 revision 坐标、status 和 updatedAt；不暴露 `xmin`。

### 评论 POD

| 类型 | 字节数 |
| ------ | -------- |
| `CommentPod` | ~256 |
| `CommentPolicySnapshotPod` | 41 |
| `CommentPolicyUpdateRequestPod` | 26 |
| `CommentCreateV2RequestPod` | 80 |
| `CommentAuthorViewPod` | 36 |
| `CommentTreeNodePod` | 60 |
| `CommentChildCursorPod` | 32 |
| `CommentPermalinkContextPod` | 32 |
| `AnonymousCredentialIssueRequestPod` | 48 |
| `AnonymousCredentialIssueResponsePod` | 56 |
| `BlindCredentialIssuerMetadataPod` | 72 |
| `BlindCredentialIssueRequestPod` | 56 |
| `BlindCredentialIssueResponsePod` | 64 |
| `AnonymousCredentialRootSnapshotPod` | 80 |
| `AnonymousCredentialRevocationArtifactPod` | 88 |
| `AnonymousCommentTicketRequestPod` | 120 |
| `AnonymousCommentTicketResponsePod` | 36 |
| `AnonymousCommentCreateRequestPod` | 72 |
| `AnonymousPrivacyStateSnapshotPod` | 66 |

### 评论 cursor item blob

递归树的 `CommentTreeNodePod` 固定保存 `id/parentId/rootId/replyToCommentId/depth/childCount/isDeleted/hasMoreChildren/createTime/content`；节点后跟 content 与 `CommentAuthorView` blob。root frame 在每个根节点后写入 `uint8 previewCount + 3 reserved zero bytes`，再写该数量的直接子节点；child frame 只写平级直接子节点；permalink frame 依次写 ancestors、可选 target、siblings。所有 reserved 字段必须为零，所有 ID 必须保持完整 64-bit 十进制值。

`CommentThreadItemPod`、`CommentReplyPreviewItemPod` 与 `CommentReplyItemPod` 的固定 POD 中仍只保存 content 的 slice ref；对应 blob 的布局为：

```text
content bytes
authorLength:int32
authorPayload:CommentAuthorViewPod + blobLength:int32 + blob
replyToAuthorLength:int32
replyToAuthorPayload?:CommentAuthorViewPod + blobLength:int32 + blob
```

`authorLength` 必须大于 0。`replyToAuthorLength` 为 0 表示没有回复目标作者；非 0 时必须是完整 `CommentAuthorView` payload。前端 adapter 对缺失 author、长度越界或尾部多余 bytes 返回协议错误，不能回退到旧 identity display。

### 评论作者存储投影

`comment.user_id` 允许为 `NULL`，匿名默认评论不再依赖真实用户外键展示作者；强匿名回复同样写入 `reply_to_user_id = NULL`，只通过 `reply_to_comment_id` 读取被回复评论的作者快照。`comment.user_id` 与 `comment.reply_to_user_id` 只作为显式 public/可归因评论和 legacy 回复兼容字段保留，不得用于默认匿名评论查询；admin 审核归因使用 `moderated_by_admin_principal_id`，不得继续写 `moderated_by_user_id`。账号侧 `CommentUserCursor` 只返回显式 public/可归因评论，不作为强匿名评论找回入口。新增作者投影列包括 `author_mode`、`public_handle`、`anonymous_handle`、`anonymous_display_name`、`anonymous_display_language`、`anonymous_nullifier_hash`、`anonymous_scope`、`moderation_subject_hash`、`credential_level`、`reputation_bucket` 和 `account_age_bucket`。公开读取端优先输出 `anonymous_display_name` / `public_handle`，再兼容 legacy `sys_user.username`。旧 `idx_comment_user_id_desc` 不再是最终态索引；可归因账号侧读取只使用 partial index `idx_comment_attributable_public_user_id_desc`，谓词固定为 `author_mode = 'public' AND user_id IS NOT NULL`。

### 消息 POD

| 类型 | 字节数 |
| ------ | -------- |
| `MessagePod` | ~512 |
| `ConversationListItemPod` | 76 |
| `ConversationDetailV2Pod` | 44 |
| `ConversationDetailV3Pod` | 52 |
| `AdminConversationListItemPod` | 92 |
| `AdminConversationDetailPod` | 68 |
| `ConversationReadRequestPod` | 8 |
| `AccountConversationReplyRequestPod` | 16 |

`ConversationList(56)` 有后续页时在 legacy `total + count` 前增加 17B cursor envelope：
`magic:int32=0x4D534743`、`version:int32=1`、`hasMore:byte`、
`nextCursor:Utf8SliceRef`。无后续页仍可使用 legacy layout；decoder 必须把 legacy layout
归一化为 `nextCursor=null / hasMore=false`，并拒绝未知版本或缺失 cursor 的分页 frame。

### 用户 / 认证 POD

| 类型 | 字节数 |
| ------ | -------- |
| `UserPod` | ~256 |
| `AuthLoginFlowPod` | 168 |
| `CurrentUserSnapshotPod` | 372 |
| `IdentityAccountSnapshotPod` | 72 |
| `UserSessionSummaryPod` | 500 |
| `AdminSessionSummaryPod` | 356 |
| `MfaChallengeResultPod` | 296 |

### 系统 POD

| 类型 | 字节数 |
| ------ | -------- |
| `SystemPod` | ~128 |
| `SeoConfigPod` | 5000 |
| `SiteComplianceConfigPod` | 1709 |

### 统计 POD

| 类型 | 字节数 |
| ------ | -------- |
| `AdminStatsPod` | ~64 |

### 文件 / PoW POD

| 类型 | 字节数 |
| ------ | -------- |
| `FileUploadOutputPod` | 640 |
| `UploadInitPod` | 568 |
| `UploadStatusPod` | 136 |
| `UploadPartMapPod` | 72 |
| `UploadPartRangePod` | 8 |
| `UploadPartAckPod` | 92 |
| `UploadCompletePod` | 648 |
| `UploadInitRequestPod` | 428 |
| `UploadCompleteRequestPod` | 64 |
| `PowChallengePod` | 204 |

### 安全挑战 POD

| 类型 | 字节数 |
| ------ | -------- |
| `SecurityChallengeAssignmentPod` | 664 |
| `SecurityChallengeEnvelopePod` | 132 |
| `SecurityChallengeVerifyRequestPod` | 44 |
| `SecurityChallengeVerifyResponsePod` | 232 |
| `SecurityChallengeCancelRequestPod` | 40 |
| `PerceptionSealedChallengeV2Pod` | 916 |
| `PerceptionSealedResultV2Pod` | 892 |

> 精确值以 `PodSizeCatalog.cs` 为准；`PodContractValidation.AreAllPodModelsReferenceFree()` 在测试和启动时校验。

---

## C++ POD 对齐规则

源码：`src/shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md`

### 类型映射

| C# 类型 | C++ 类型 | 大小 |
| --------- | --------- | ------ |
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
| ------ | ------------ |
| 匿名账号 public handle | `Utf8Fixed64` |
| identity kind / anonymous credential status / level | `Utf8Fixed32` |
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
- `src/core/Algorithms/AEDS_V2_PROTOCOL.md` — 完整协议规格
- `src/shared/Contracts/Validation/aeds-protocol.json` — 帧类型与 AEDS header 的生成输入
- `tools/frontend/generate-aeds-protocol.mjs` — 生成并校验三端协议常量
- `src/shared/Contracts/Validation/PodSizeCatalog.cs` — POD 大小权威源码

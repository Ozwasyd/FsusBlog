# 普通账号会话撤销一致性

本文定义普通账号 `sys_user_session` 与已签发 access token 的运行时一致性边界。目标是：数据库中的会话一旦被撤销，旧 JWT 在下一次受保护请求中立即失效，不等待 JWT `exp`；同时不把公开匿名读取变成数据库热路径。

## 安全不变量

1. JWT 签名、issuer、audience、`nbf`、`exp` 通过，只说明 token 由本站签发且仍在密码学有效期内，不说明 `sid` 仍 active。
2. 普通账号 principal 必须同时满足：`identity_kind=anonymous_account`、有效 account id、有效 `sid`、会话未撤销、idle/absolute 未过期、账号未注销、session owner 与 token account id 一致。
3. admin principal 使用独立的 `admin_session` 与 `IAdminSessionValidationService`，普通会话校验不得读取或清理 admin session/Cookie。
4. 公开匿名请求没有已认证普通 principal，不执行普通 session cache 或 PostgreSQL 查询。

## 请求路径

`JwtBearerEvents.OnTokenValidated` 在 JWT 的密码学校验之后分流：

- `identity_kind=admin_principal`：保持既有 admin access-token hash 与 admin session 校验。
- 普通账号：调用 `IUserSessionValidationService.ValidateAsync`。校验失败时只删除普通 access/refresh/session Cookie，并用 `context.Fail(reason)` 拒绝认证。

默认普通账号校验顺序如下：

1. 直接读取 Redis L2 `SecurityUserSessionValidation` key，刻意绕过进程 L1，避免其他实例已经撤销而本实例继续命中旧内存快照。
2. L2 hit 时验证 account id、revoked/expiry、账号注销状态与 identity kind，不访问数据库。
3. L2 miss 时按 `sys_user_session.sessionid = @SessionId` 做单行主键查询，并 join `sys_user` 取得账号状态。没有全表扫描、session 列表读取或每请求无界 fan-out。
4. 回源结果带 `sys_user_session.xmin::text`，通过版本化 Redis Lua 写入；若写入因并发版本冲突失败，重新读取胜出的 L2 快照并据此裁决。

缓存 payload 固定为 `v1|rowVersion|accountId|revokedTicks|idleTicks|absoluteTicks|accountStatus|deletedTicks|identityKind`，默认 L2 TTL 为 2 分钟、L1 TTL 为 0。TTL 只控制 active snapshot 的回源频率；撤销不等待 TTL，而是主动覆盖 revoked snapshot。

## 撤销写路径

以下写路径都必须使用 `UPDATE ... RETURNING` 取得更新后的 `xmin`，并在同一显式数据库事务回调的最后一步发布 revoked snapshot；Redis fence 可见后才允许 commit：

| 路径 | `revokereason` | 保留项 |
| --- | --- | --- |
| logout / refresh token revoke | `logout` | 无 |
| 单会话撤销 | 调用方规范化 reason | 其他 session |
| 撤销其他会话 | `revoke_others` | 当前 `sid` |
| 新登录替换 | `login_replaced` | 新创建 session |
| refresh token replay | `refresh_token_reuse` | 无 |
| Recovery Key verify | `recovery_key_verified` | 由请求撤销选项决定 |
| 账号注销 | `account_deleted` | 无 |

撤销发布使用 overwrite；cache-miss active 回填不允许 overwrite。典型竞态是：请求 A 从数据库读到 active row version 7，撤销请求 B 在事务中把行更新为 version 8 并发布 revoked snapshot，随后 A 尝试写 version 7。版本 Lua 必须拒绝 A，A 再读取 version 8 并返回 `user_session_revoked`，因此旧 active 状态不能复活。

Redis 发布失败会让事务回调失败并回滚数据库更新，调用方不得把该操作报告为成功。批量并行发布可能出现部分 key 已成功、另一个 key 失败，因此只要开始发布且事务最终失败，就对整批 session identity 执行 `InvalidateManyAsync`。数据库 commit 在 Redis 发布之后失败时也执行相同补偿。删除补偿失败时保留 revoked snapshot：这可能暂时拒绝一个数据库已回滚为 active 的 session，但不会让已撤销 session 获得授权，下一次 key 清理、TTL 到期或 DB-only 切换会恢复数据库真相。不得用进程内 fence 代替该跨实例顺序。

## 性能边界

- 正常稳定流量：每个普通账号受保护请求一次 Redis GET；不会查询 PostgreSQL。
- Redis miss/驱逐/TTL 到期：只做一次按 session 主键的 PostgreSQL 单行查询，再回填短 TTL snapshot。
- 公开文章、公开 AOT、公开评论等匿名 hot-read：不携带认证 principal 时不进入本服务，新增数据库查询数为 0。
- 批量撤销：数据库使用单条 `UPDATE ... RETURNING`，缓存发布并行执行，不按 session 串行做数据库更新。
- 撤销事务会在 commit 前等待一次并行 Redis 发布；这是跨实例立即失效所需的提交屏障，不得移到 post-commit fire-and-forget。

## 故障与无重启回退

默认模式下 Redis 读取失败、payload 损坏或版本写冲突无法解析时认证 fail closed，不回退为“只相信 JWT”。

若需要隔离新 Redis 快路径本身，可通过支持热重载的 configuration provider 设置：

```text
Security:UserSessionValidation:DistributedCacheEnabled=false
```

现有服务实例会在下一次调用读取新值并进入 DB-only 安全模式：跳过 session Redis 读写与 pre-commit Redis publish，每个已签名普通 token 仍按 session 主键查询 PostgreSQL，数据库 commit 成为撤销可见边界，所以撤销语义保持不变。补偿清理不受该 toggle 限制，仍可删除切换前可能提前发布的 key。该模式只用于短期诊断/回退，因为会增加受保护请求数据库负载；恢复 `true` 后由当前数据库状态重新回填。不要用关闭 session 校验、延长 JWT 或 fail-open 代替该回退。环境变量 provider 不支持运行时 reload 时，需要常规滚动发布，不能宣称无重启切换。

## 风险与控制

- Redis 故障会拒绝普通账号认证：这是有意的 fail-closed 选择；使用上面的 DB-only 模式可保持安全语义并临时移除 Redis 依赖。
- DB-only 模式提高 PostgreSQL QPS：只做主键精确查询，必须限时使用并观察连接池/查询延迟。
- Redis 发布失败：事务回滚且调用失败；任何部分发布的 revoked snapshot 都进入批量删除补偿，不会出现“数据库已撤销但 Redis 仍保留旧 active snapshot”的成功状态。
- Redis 已发布但数据库 commit 失败：批量删除可能提前发布的 key；删除失败时保留 revoked snapshot 并 fail closed，不能降级为旧 active 值。
- Redis 整体不可用：默认认证读取与撤销发布都 fail closed；恢复前可通过可热重载配置切 DB-only，由 PostgreSQL 主键读取和 commit 保持撤销语义。
- 普通/admin Cookie 混用：普通校验失败只调用 `ClearUserSessionCookies`，admin Cookie 与 admin validator 保持不变。

## 验收场景与测试代码

| 场景 | 预期 | 覆盖位置 |
| --- | --- | --- |
| 匿名请求 | 不读 session cache/DB | `UserSessionRevocationIntegrationTests.UnauthenticatedPrincipal_DoesNotReadSessionCacheOrDatabase` |
| 登录普通账号 | active snapshot 允许，cache hit 不读 DB | `UserSessionValidationServiceTests.CachedActiveSession_AllowsRequestWithoutDatabaseRead` |
| 单会话撤销 | warmed old principal 下一请求被拒绝 | `UserSessionRevocationIntegrationTests.RevokeSession_RejectsPreviouslyIssuedPrincipalAfterCacheWasWarm` |
| 撤销其他会话 | 其他 session 被拒绝，当前 session 保持 active | `UserSessionRevocationIntegrationTests.RevokeOtherSessions_InvalidatesOthersAndKeepsCurrentSessionValid` |
| refresh replay | 旧 access principal 立即被拒绝 | `UserSessionRevocationIntegrationTests.RefreshReplay_RevokesSessionAndImmediatelyRejectsOldPrincipal` |
| 并发 cache miss + revoke | 旧 active snapshot 不能覆盖 revoked snapshot | `UserSessionRevocationIntegrationTests.ConcurrentCacheMissAndRevoke_DoesNotResurrectStaleActiveSnapshot` |
| admin 请求 | 继续走独立 admin validator/Cookie 清理 | `UserSessionJwtAuthenticationTests.AdminEndpoint_KeepsIndependentAdminSessionValidationPath` 与既有 `AdminSessionValidationServiceTests` |
| notification stream | 失效普通 principal 不产生 account user id，不进入 admission/backlog；匿名 public stream 仍走既有 handshake 风控 | `UserSessionMappedBoundaryTests.MappedNotificationStreamPreflight_RevokedOrdinaryJwtRejectsBeforeAdmissionAndClearsUserCookies` 从真实 revoked JWT/Cookie 进入 mapped preflight，返回 AEDS `auth_failed` 且不调用 admission/risk 分支 |
| binary 受保护端点 | JWT authentication 失败后授权层返回 401 且不进入 handler；session revoke 端点只接受普通账号 principal | `UserSessionMappedBoundaryTests.MappedProtectedBinarySessions_RevokedOrdinaryJwtRejectsBeforeHandlerAndClearsUserCookies` 调用 mapped `/api/binary/auth/sessions`，断言 AEDS Unauthorized、业务 facade 零调用和仅普通 Cookie 清理 |
| 无重启回退 | 动态配置关闭 Redis 后跳过 Redis 读写但保留 DB 校验 | `UserSessionValidationServiceTests.DistributedCacheToggle_CanEnterDbOnlyModeWithoutRestartOrRedisWrites` |
| 发布失败 | Redis 发布异常导致数据库回滚，并清理可能部分发布的 key | `UserServiceValidationTests.RevokeSessionAsync_PublicationFailureRollsBackAndInvalidatesPossiblePartialSnapshot` 与 `RecoveryKeyServiceBehaviorTests.VerifyAsync_RevocationPublicationFailureRollsBackDatabaseAndCleansPossiblePartialFence` |
| commit 失败 | 已发布的 pre-commit fence 被批量清理；清理失败仍保持安全方向拒绝 | `UserServiceValidationTests.CompleteLoginAsync_CommitFailureInvalidatesPreCommitRevocationFence` |
| 成功顺序 | logout、revoke-others、登录替换、删号与 Recovery Key 在 commit 前发布 | `UserServiceValidationTests.RevocationProducers_PublishDistributedFenceBeforeTransactionCommit`、`CompleteLoginAsync_UsesPostgresLockBulkRevocationAndInsertInOneTransaction`、`DeleteAccountAsync_ExecutesAnonymousTombstoneAndAssetRevocationInsideTransaction` 与 `RecoveryKeyServiceBehaviorTests.VerifyAsync_WithOnlyRecoveryKey_CreatesPendingSessionWithoutPrematurePasskeyRevocation` |

本轮没有改变 endpoint、AEDS frame、错误码或任何请求/响应字段，因此无需修改 API 字段契约；变化只发生在撤销事务的提交顺序和失败语义。notification-stream preflight 与受保护 binary sessions 现已有真实 mapped TestServer 测试代码，但尚未执行，不能把已落测试投影表述为已通过。

本轮只补测试代码时，不得把“存在测试代码”表述成“测试已通过”；通过状态必须以统一验证阶段的真实执行结果为准。

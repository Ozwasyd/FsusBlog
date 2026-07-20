# 普通账号会话撤销一致性

本文定义普通账号 `sys_user_session` 与已签发 access token 的运行时一致性边界。目标是：数据库中的会话一旦被撤销，旧 JWT 在下一次受保护请求中立即失效，不等待 JWT `exp`；同时不把公开匿名读取变成数据库热路径。

## 安全不变量

1. JWT 签名、issuer、audience、`nbf`、`exp` 通过，只说明 token 由本站签发且仍在密码学有效期内，不说明 `sid` 仍 active。
2. 普通账号 principal 必须同时满足：`identity_kind=anonymous_account`、有效 account id、有效 `sid`、会话未撤销、idle/absolute 未过期、账号未注销、session owner 与 token account id 一致。
3. admin principal 使用独立的 `admin_session` 与 `IAdminSessionValidationService`，普通会话校验不得读取或清理 admin session/Cookie。
4. 公开匿名请求没有已认证普通 principal，不执行普通 session cache 或 PostgreSQL 查询。
5. 账户与会话是 `Account 1 ── N UserSession`；正常登录不得以 `login_replaced` 撤销其他合法设备，active 数量由账号级 admission lock 和可配置上限约束。

## 请求路径

`JwtBearerEvents.OnTokenValidated` 在 JWT 的密码学校验之后分流：

- `identity_kind=admin_principal`：保持既有 admin access-token hash 与 admin session 校验。
- 普通账号：调用 `IUserSessionValidationService.ValidateAsync`。校验失败时只删除普通 access/refresh/session Cookie，并用 `context.Fail(reason)` 拒绝认证。

默认普通账号校验顺序如下：

1. 直接读取 Redis L2 `SecurityUserSessionValidation` key，刻意绕过进程 L1，避免其他实例已经撤销而本实例继续命中旧内存快照。
2. L2 hit 时验证 account id、revoked/expiry、账号注销状态与 identity kind，不访问数据库。
3. L2 miss 时按 `sys_user_session.sessionid = @SessionId` 做单行主键查询，并 join `sys_user` 取得账号状态。没有全表扫描、session 列表读取或每请求无界 fan-out。
4. Redis 读取异常或 payload 损坏与 miss 一样进入有界 PostgreSQL fallback；fallback 受独立并发预算和连续失败熔断保护，预算拒绝或数据库异常都 fail closed。
5. 回源结果带 session/account `xmin::text`、账号状态与 `session_mode`，先取得数据库真相，再通过数值版本单调 Redis Lua best-effort repair；普通写入错误不改变数据库裁决，但版本冲突表示并发更新已胜出，必须读取胜出的更高版本重新裁决，胜出值不可读时 fail closed。

缓存 payload v3 固定携带 `rowVersion/accountId/revokedTicks/idleTicks/absoluteTicks/accountStatus/deletedTicks/identityKind/authenticationContext/sessionMode/accountRowVersion`，并在滚动窗口内只读兼容 v2。默认 L2 TTL 为 2 分钟、L1 TTL 为 0。TTL 只控制回源频率；ban/revoke 不等待 TTL，而是主动发布 restricted/revoked snapshot。

## 会话模式与受限白名单

服务端持久化 `normal < restricted < revoked` 三态。JWT 的 `session_mode` claim 用于传递签发时模式，但不是授权权威；数据库/缓存模式与 claim 不一致时只取更严格值。ban 在同一事务把 active sessions 转 restricted，unban 转 normal，delete/revoke 转 revoked。因而旧 normal JWT 在 ban 后下一请求立即受限；旧 restricted JWT 在 unban 后不会静默恢复，必须 refresh 或重新签发。

restricted principal 只允许 endpoint 显式标记的：`GET /auth/me`（含封禁原因）、`GET /auth/sessions`、refresh、logout、单会话/其他会话撤销、本人账号删除、Passkey step-up begin/complete 与 MFA challenge start；refresh 是解除封禁后换取新 normal JWT 的显式路径。没有 metadata 的评论、消息、内容、身份、公开业务与 admin 路径默认 423 拒绝；notification stream 在 admission/backlog 之前返回 `restricted_session_not_allowed`。白名单不使用 path prefix 或“只禁写”推断。

## 撤销写路径

以下写路径都必须使用 `UPDATE ... RETURNING` 取得更新后的 `xmin`，并在同一显式数据库事务回调的最后一步发布 revoked snapshot；Redis fence 可见后才允许 commit：

| 路径 | `revokereason` | 保留项 |
| --- | --- | --- |
| logout / refresh token revoke | `logout` | 无 |
| 单会话撤销 | 调用方规范化 reason | 其他 session |
| 撤销其他会话 | `revoke_others` | 当前 `sid` |
| 登录清理过期项 | `session_expired` | 未过期 session 与新创建 session |
| 登录上限淘汰 | `active_session_limit` | 最近使用的 `MaxActiveSessions - 1` 个旧 session 与新创建 session |
| refresh token replay | `refresh_token_reuse` | 无 |
| Recovery Key verify | `recovery_key_verified` | 由请求撤销选项决定 |
| 账号注销 | `account_deleted` | 无 |

producer 发布与 cache repair 都可请求 overwrite，但版本 Lua 会比较数值 row version 并拒绝较旧版本。典型竞态是：请求 A 从数据库读到 active row version 7，撤销请求 B 在事务中把行更新为 version 8 并发布 revoked snapshot，随后 A 尝试 repair version 7。Lua 拒绝 A，A 读取胜出的 version 8 并按 revoked 拒绝；胜出值不可读时 fail closed。旧 active 状态不能在 revoke 后获得一次放行。数据库读取若已经是 revoked，则 repair 冲突同样保持拒绝。

login、revoke-others、账户注销和账户级 revoke-all 使用同一个 PostgreSQL transaction-scoped advisory lock。revoke-others 只处理该操作开始时已经存在的会话，避免等待锁期间刚创建且已成功签发的 session 被并发操作误撤销。登录 admission 在插入新行之前清理过期项并按 `COALESCE(lastseenat, createdat)` 淘汰最久未使用项，因此新 session 永远不进入本轮候选集；同一账号并发登录被锁串行化，最终 active 数不超过配置上限。

targeted revoke 的 notification 继续使用不含 session identity 的账号级 `SessionRevoked` payload。每个收到事件的 tab 强制回查 `/api/binary/auth/me`：自身 `sid` 失效才进入 `user-expired` 清理和跨 tab 广播；回查仍有效的设备保持会话与私有页面，网络未知结果不把 authenticated 状态误判为 guest。

Redis 发布失败会让事务回调失败并回滚数据库更新，调用方不得把该操作报告为成功。批量并行发布可能出现部分 key 已成功、另一个 key 失败，因此只要开始发布且事务最终失败，就对整批 session identity 执行 `InvalidateManyAsync`。数据库 commit 在 Redis 发布之后失败时也执行相同补偿。删除补偿失败时保留 revoked snapshot：这可能暂时拒绝一个数据库已回滚为 active 的 session，但不会让已撤销 session 获得授权，下一次 key 清理、TTL 到期或 DB-only 切换会恢复数据库真相。不得用进程内 fence 代替该跨实例顺序。

## 性能边界

- 正常稳定流量：每个普通账号受保护请求一次 Redis GET；不会查询 PostgreSQL。
- Redis miss/驱逐/TTL 到期：只做一次按 session 主键的 PostgreSQL 单行查询，再回填短 TTL snapshot。
- Redis error/payload corrupt：在 fallback 并发预算内做相同单行查询，并记录故障附加 DB QPS；超过并发预算或熔断打开时立即拒绝。
- 公开文章、公开 AOT、公开评论等匿名 hot-read：不携带认证 principal 时不进入本服务，新增数据库查询数为 0。
- 批量撤销：数据库使用单条 `UPDATE ... RETURNING`，缓存发布并行执行，不按 session 串行做数据库更新。
- 撤销事务会在 commit 前等待一次并行 Redis 发布；这是跨实例立即失效所需的提交屏障，不得移到 post-commit fire-and-forget。

## 故障与无重启回退

默认模式下 Redis 读取失败或 payload 损坏会回源 PostgreSQL；只有数据库成功返回的权威状态才可放行。数据库异常、fallback 预算拒绝或熔断打开时认证 fail closed，不回退为“只相信 JWT”。repair 写入失败不把已成功取得的数据库裁决改成认证失败。

fallback 预算配置为 `Security:UserSessionValidation:DbFallback:MaxConcurrent`、`FailureThreshold` 与 `BreakSeconds`；默认分别为 32、5、5。应结合 PostgreSQL pool 留量设置，不允许无限等待或无界排队。

若需要隔离新 Redis 快路径本身，可通过支持热重载的 configuration provider 设置：

```text
Security:UserSessionValidation:DistributedCacheEnabled=false
```

现有服务实例会在下一次调用读取新值并进入 DB-only 安全模式：跳过 session Redis 读写与 pre-commit Redis publish，每个已签名普通 token 仍按 session 主键查询 PostgreSQL，数据库 commit 成为撤销可见边界，所以撤销语义保持不变。补偿清理不受该 toggle 限制，仍可删除切换前可能提前发布的 key。该模式只用于短期诊断/回退，因为会增加受保护请求数据库负载；恢复 `true` 后由当前数据库状态重新回填。不要用关闭 session 校验、延长 JWT 或 fail-open 代替该回退。环境变量 provider 不支持运行时 reload 时，需要常规滚动发布，不能宣称无重启切换。

若需要无需重启地回退多设备 admission 行为，可将 `Security:UserSessions:MaxActiveSessions` 热更新为 `1`。后续登录会在同一锁内淘汰现有其他 active session，恢复单会话效果；该操作不恢复已移除的 unique index，也不改变主动单条/其他/全部撤销和 refresh-family 语义。恢复更高上限后只影响后续 admission，不会自动创建或复活历史 session。

## 风险与控制

- Redis 故障由 PostgreSQL 权威 fallback 承接；只有预算/熔断拒绝或 PostgreSQL 同时失败时才拒绝认证。使用上面的 DB-only 模式可保持安全语义并临时移除 Redis 依赖。
- DB-only 模式提高 PostgreSQL QPS：只做主键精确查询，必须限时使用并观察连接池/查询延迟。
- Redis 发布失败：事务回滚且调用失败；任何部分发布的 revoked snapshot 都进入批量删除补偿，不会出现“数据库已撤销但 Redis 仍保留旧 active snapshot”的成功状态。
- Redis 已发布但数据库 commit 失败：批量删除可能提前发布的 key；删除失败时保留 revoked snapshot 并 fail closed，不能降级为旧 active 值。
- Redis 整体不可用：认证读取在预算内回源 PostgreSQL；撤销 producer 发布仍 fail closed。恢复前可通过可热重载配置切 DB-only，由 PostgreSQL 主键读取和 commit 保持撤销语义。
- 观测：`fsus.auth.session_validation.*` instruments 必须持续输出 cache hit/miss/error、DB fallback success/rejected/error、repair outcome、验证 latency、fallback concurrency 与 Redis 故障附加 DB QPS；告警优先降载或切 DB-only，不能放宽认证。
- 普通/admin Cookie 混用：普通校验失败只调用 `ClearUserSessionCookies`，admin Cookie 与 admin validator 保持不变。

## 验收场景与测试代码

| 场景 | 预期 | 覆盖位置 |
| --- | --- | --- |
| 匿名请求 | 不读 session cache/DB | `UserSessionRevocationIntegrationTests.UnauthenticatedPrincipal_DoesNotReadSessionCacheOrDatabase` |
| 两设备登录 | 两个成功响应的 `sid` 均对应 active row | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_TwoDeviceLoginsRemainActive` 与 `CompleteLoginAsync_ConcurrentDevicesUnderLimitReturnActiveSessions` |
| 同设备双击登录 | 设备指纹不作为授权键，两个成功响应获得独立 active `sid` | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ConcurrentSameDeviceCreatesIndependentSessions` |
| 上限淘汰 | 只淘汰最久未使用旧会话，新 session 保持 active | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ActiveSessionLimitEvictsLeastRecentlyUsedSession` |
| 并发上限 | 三个并发 admission 在上限 2 时最终只有两个 active row | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ConcurrentAdmissionsNeverExceedActiveSessionLimit` |
| 登录与 revoke-others | 操作开始后新创建 session 不被误撤销 | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ConcurrentRevokeOthersDoesNotRevokeNewSession` |
| 登录与账户注销 | 注销完成后账户无 active session | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ConcurrentAccountDeletionLeavesNoActiveSession` |
| 登录普通账号 | active snapshot 允许，cache hit 不读 DB | `UserSessionValidationServiceTests.CachedActiveSession_AllowsRequestWithoutDatabaseRead` |
| Redis error / payload 损坏 | DB 成功则按权威结果放行/拒绝并尝试 repair；DB/预算失败则 fail closed | `UserSessionValidationServiceTests.CacheError_FallsBackToPostgresAndRepairsCache`、`CacheError_PostgresFailureFailsClosed`、`DbFallbackGate_RejectsExcessConcurrencyAndOpensCircuit` |
| repair 与撤销竞态 | repair conflict 不覆盖 DB revoked 裁决 | `UserSessionValidationServiceTests.CacheRepairConflict_CannotOverrideAuthoritativeDatabaseRevocation` |
| ban / unban JWT 模式差异 | 始终使用 DB 与 JWT 中更严格的 mode | `UserSessionValidationServiceTests.SessionModeMismatch_UsesTheStricterServerEffectiveMode` |
| 单会话撤销 | warmed old principal 下一请求被拒绝 | `UserSessionRevocationIntegrationTests.RevokeSession_RejectsPreviouslyIssuedPrincipalAfterCacheWasWarm` |
| 撤销其他会话 | 其他 session 被拒绝，当前 session 保持 active | `UserSessionRevocationIntegrationTests.RevokeOtherSessions_InvalidatesOthersAndKeepsCurrentSessionValid` |
| refresh replay | 旧 access principal 立即被拒绝 | `UserSessionRevocationIntegrationTests.RefreshReplay_RevokesSessionAndImmediatelyRejectsOldPrincipal` |
| 并发 cache miss + revoke | 旧 active snapshot 不能覆盖 revoked snapshot | `UserSessionRevocationIntegrationTests.ConcurrentCacheMissAndRevoke_DoesNotResurrectStaleActiveSnapshot` |
| admin 请求 | 继续走独立 admin validator/Cookie 清理 | `UserSessionJwtAuthenticationTests.AdminEndpoint_KeepsIndependentAdminSessionValidationPath` 与既有 `AdminSessionValidationServiceTests` |
| notification stream | revoked principal 认证失败；restricted principal 在 admission/backlog 前返回 423；匿名 public stream 仍走既有握手风控 | `UserSessionMappedBoundaryTests.MappedNotificationStreamPreflight_RevokedOrdinaryJwtRejectsBeforeAdmissionAndClearsUserCookies`、`NotificationStreamBoundaryTests.RestrictedAuthenticatedSession_IsRejectedBeforeAdmission` |
| binary 受保护端点 | JWT authentication 失败后授权层返回 401 且不进入 handler；session revoke 端点只接受普通账号 principal | `UserSessionMappedBoundaryTests.MappedProtectedBinarySessions_RevokedOrdinaryJwtRejectsBeforeHandlerAndClearsUserCookies` 调用 mapped `/api/binary/auth/sessions`，断言 AEDS Unauthorized、业务 facade 零调用和仅普通 Cookie 清理 |
| 无重启回退 | 动态配置关闭 Redis 后跳过 Redis 读写但保留 DB 校验 | `UserSessionValidationServiceTests.DistributedCacheToggle_CanEnterDbOnlyModeWithoutRestartOrRedisWrites` |
| 发布失败 | Redis 发布异常导致数据库回滚，并清理可能部分发布的 key | `UserServiceValidationTests.RevokeSessionAsync_PublicationFailureRollsBackAndInvalidatesPossiblePartialSnapshot` 与 `RecoveryKeyServiceBehaviorTests.VerifyAsync_RevocationPublicationFailureRollsBackDatabaseAndCleansPossiblePartialFence` |
| commit 失败 | 已发布的 pre-commit fence 被批量清理；清理失败仍保持安全方向拒绝 | `UserServiceValidationTests.CompleteLoginAsync_CommitFailureInvalidatesPreCommitRevocationFence` |
| 成功顺序 | logout、revoke-others、登录 admission 淘汰、删号与 Recovery Key 在 commit 前发布 | `UserServiceValidationTests.RevocationProducers_PublishDistributedFenceBeforeTransactionCommit`、`CompleteLoginAsync_UsesPostgresLockBoundedAdmissionAndInsertInOneTransaction`、`DeleteAccountAsync_ExecutesAnonymousTombstoneAndAssetRevocationInsideTransaction` 与 `RecoveryKeyServiceBehaviorTests.VerifyAsync_WithOnlyRecoveryKey_CreatesPendingSessionWithoutPrematurePasskeyRevocation` |

本轮没有改变成功 response POD 或 AEDS frame 编号；新增的是 JWT 内部 `session_mode` claim、restricted notification handshake 失败细分和服务端 admission 语义，契约同步见 `docs/api/contracts.md`。

本轮只补测试代码时，不得把“存在测试代码”表述成“测试已通过”；通过状态必须以统一验证阶段的真实执行结果为准。

# Recovery Passkey 完成一致性

本文定义 Recovery Key 已经一次性验证后，短期 recovery session 如何安全完成 Passkey 重绑。它补充 [security.md](security.md) 与 [API 设计哲学](api/design.md)，不新增端点、AEDS frame 或文本 fallback。

## 状态与持久化边界

recovery session 在统一缓存中保存以下状态：

| 状态 | 含义 | 允许的后续动作 |
|------|------|----------------|
| `pending` | 尚未开始完成，或上次尝试已安全失败 | 原子认领为 `completing` |
| `completing` | 某个规范化请求 hash 持有 90 秒短租约 | 相同/不同并发请求均返回明确 conflict；租约过期后可恢复 `pending` |
| `completed` | 数据库已完成逻辑提交 | 只接受数据库 durable marker 确认后的同请求幂等成功 |

状态转换使用 `IUnifiedCache.TrySetStringIfValueAsync` compare-and-set，不执行先读后写的非原子覆盖。旧四字段 recovery session payload 仍按 `pending` 读取，使滚动发布期间已签发的短期会话可以继续完成；新 payload 使用带版本的状态信封。

原始 recovery session token 只在请求内存在。数据库仅保存其完整 SHA-256 `recovery_session_hash`，并通过唯一索引保证一个恢复会话最多产生一次逻辑完成；同时保存对 `PasskeyRegisterCompleteRequest` 规范化 AEDS bytes 的 SHA-256 `recovery_request_hash`。同一 token 加同一请求可返回幂等成功，同一 token 加不同请求返回 `RECOVERY_PASSKEY_ALREADY_COMPLETED_WITH_DIFFERENT_REQUEST`。

## 提交顺序

1. 在数据库查询 durable marker；命中同请求时补做 cache 清理并返回幂等成功，命中不同请求时拒绝。
2. 通过 compare-and-set 把有效 `pending` 会话认领为带 request hash、lease id 和 expiry 的 `completing`。
3. 读取注册 challenge 并执行 WebAuthn authenticator 校验；失败时把精确租约恢复为 `pending`。
4. 在单个数据库事务内插入带 durable marker 的新 credential、按 recovery session 选项撤销旧 credentials，并把非删除账号的 `PasskeyEnabled` 设为 `true`。
5. 事务提交后推进 `AccountSnapshotVersion`，再删除 Passkey 注册 challenge，最后尝试把缓存会话标成 `completed`。

步骤 4 任一写入失败都会整体回滚。步骤 5 失败不会复制 credential：当前请求返回可重试结果并释放 recovery session；下一次同请求先命中 durable marker，再重复幂等的版本推进和 challenge 删除。版本多推进一次只会让旧快照更快失效，不会恢复旧账号状态。

## 并发、失败与响应丢失

| 场景 | 服务端结果 | 可重试性 |
|------|------------|----------|
| authenticator 验证失败 | 不写 credential、不删除 challenge，恢复 `pending` | 可用同一 recovery session 重新完成 |
| 数据库异常/事务回滚 | credential、旧 credential 撤销、Passkey flag 都不提交，恢复 `pending` | 可用同一 recovery session 重试 |
| 同一会话双提交 | 只有 compare-and-set 胜者进入写入；数据库唯一索引是第二道守门 | 最多一个逻辑完成 |
| DB 已提交但 HTTP 响应丢失 | 重试从 durable marker 识别同请求 | 返回幂等成功，不重复写入 |
| 已完成后提交不同请求 | durable request hash 不匹配 | 返回明确 conflict |
| worker 在 `completing` 中止 | 短租约到期后恢复 `pending` | 无需重新使用 Recovery Key |

## 迁移与回退

`20260711-post-recovery-passkey-completion-idempotency` 为 `passkey_credential` 增加 nullable `recovery_session_hash`、`recovery_request_hash`，以及非空 recovery session hash 的唯一索引。nullable 列允许旧 credential 保持原样，迁移可重复执行。

该语义没有运行时降级开关，因为关闭 durable marker 会重新引入重复绑定。需要无需重启地止血时，先通过仓库外部、已具备动态路由能力的网关暂停新的 `/api/binary/auth/recovery-key/verify`，避免继续消费 Recovery Key，同时保留 complete 入口让已签发的短期 session 排空；本仓库本身不提供该热切换。若 complete 入口本身必须隔离，则在排空窗口后同时拒绝 verify/complete，但保留 Redis session 和数据库 marker。恢复入口后，同请求可继续重放。代码回退必须保留新增列和唯一索引，等所有短期 recovery session 到期后再滚动回退应用；不得删除 marker 或改回“写入前消费会话”。

## 验收覆盖

本变更的定向测试代码覆盖 authenticator failure、数据库 provider exception、事务回滚、response loss、double-submit、successful replay、different-request conflict、过期 pending、过期 `completing` lease 恢复后成功重试，以及旧信封兼容。映射后的 binary complete endpoint 直接执行 `RouteEndpoint.RequestDelegate` 并解码成功 `EmptySuccess`、并发 conflict 与 retryable failure 的 `ApiError`；PostgreSQL integration 从 raw recovery token 进入 `RecoveryKeyService`，独立计算 SHA-256 session marker 与 canonical AEDS request hash，并与 durable credential 行逐字比对。统一验证阶段仍须实际执行这些测试，当前阶段不声明已运行：

| 入口 | 期望 |
|------|------|
| 匿名 recovery binary begin/complete | recovery session 可用，成功响应仍为 AEDS `EmptySuccess`，错误仍为 AEDS `ApiError` |
| 普通登录请求 | 原有 Passkey register/login 与 step-up 语义不变 |
| admin 请求 | independent admin principal 与 admin Passkey 流程不进入 recovery session 状态机 |
| notification stream | 无 frame、认证或会话协议变化；账号快照失效不改变 stream 契约 |
| binary contract | 复用现有 `PasskeyRegisterCompleteRequest` 和 `EmptySuccess`，不新增或重排字段 |

上述三项原静态缺口现均有直接测试代码：
`ExpiredCompletingLease_RecoversPendingAndCompletesSameRequestRetry`、
`RecoveryPasskeyCompletionEndpointTests` 的 mapped endpoint frame 矩阵，以及
`RawRecoveryToken_FlowsThroughCompletionAsSha256AndCanonicalRequestHashOnly`。
这些是已落地但尚未执行的验收投影，只有统一验证产生真实成功结果后才能标记为通过。

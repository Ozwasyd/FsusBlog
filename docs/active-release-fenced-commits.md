# Active release fenced database commits

本文定义 active-singleton worker 的 PostgreSQL 提交边界。普通 `IActiveReleaseCommitGuard` 的事务外读取只适合提前取消工作，不能证明读取完成后到数据库 commit 之间 fence 没有变化。所有 active-singleton PostgreSQL mutation 必须通过 `IActiveReleaseTransactionalCommitGuard` 在业务事务内登记。

## 原子边界

`ActiveReleaseFencedTransaction.ExecuteAsync` 在同一个 SqlSugar/PostgreSQL 事务内依次执行：

1. 执行业务 mutation；
2. 从 execution context 取得 `releaseId + slot + generation + imageDigest + processInstanceId`；
3. 取得与 fence mutation 相同 key 的 `pg_advisory_xact_lock_shared`，再对 `sys_deployment_fence` 的精确 active owner 执行 `SELECT ... FOR SHARE`；
4. 用同一条 CTE 把 token 写入 `sys_fenced_commit`；
5. commit 业务 mutation 与 token 行。

如果 owner 不匹配，CTE 不产生 token 行，guard 抛出 `ActiveReleaseFenceLostException`，整个业务事务回滚。shared advisory lock 与 `FOR SHARE` 行锁一直持有到业务 commit；acquire/revoke 使用同 key exclusive advisory lock + `FOR UPDATE`，因此 fence 变更只能发生在旧事务 commit 之后，且 singleton row 尚不存在时也没有 gap-lock 空窗。若 fence 先完成撤销或换代，旧事务在 enlist 时看不到匹配 active owner，只能回滚。这同时覆盖 pre-check 后撤销、长 GC pause 恢复和 Redis partition；事务判定只读取 #1118 引入的 PostgreSQL durable witness，不读取 stale Redis snapshot。

`sys_fenced_commit` 保存 commit token、operation scope、mutation key、release/slot/generation/digest、process instance 与 enlist 时间。回滚事务不会留下 token 行，因此可见 token 等价于对应业务事务已成功提交。operation scope 和 mutation key 不能包含用户输入或秘密。

当前接线：

- scheduled publish 的 article 状态与 outbox insert；
- article mutation outbox 的 claim、heartbeat、edge、retry 与 complete transition；
- article view projection 与 watermark transaction；
- log cleanup 的 visit/RUM/audit/pseudonym/fenced-token delete chunk。

`sys_fenced_commit` 保留 30 天，由同样经过 fenced transaction 的 cleanup chunk 清理；每个 cleanup transaction 会留下自身的新 token，因此 ledger 不会被清空成不可审计状态。

文件、对象存储和进程内 mutation 仍保留原 `IActiveReleaseCommitGuard` 与 worker lease；它们不伪装成 PostgreSQL 原子事务。

## 周期审计与告警

`ActiveReleaseFencedCommitAuditWorker` 周期读取最近 token，并按 durable fence 的 generation 与激活/撤销时间检测：

- token generation 高于 durable fence；
- 同 generation 但 identity/digest 不同；
- 同 generation 已 revoked，且 token 时间不早于 revoke；
- 旧 generation token 时间不早于新 generation activation。

违规记录使用 Critical 日志，并增加：

- `fsus.active_release_fenced_commit.enlistments{result,operation_scope}`
- `fsus.active_release_fenced_commit.audits{result}`
- `fsus.active_release_fenced_commit.violations{result}`

审计是检测与告警，不承担事后“自动回滚”未知业务副作用；真正的阻断边界是事务内 row lock + token insert。

## 无重启回退

若新 guard、表容量或审计出现异常，把支持 reload 的配置 `ActiveReleaseFencedCommit:MutationEnabled=false`。它不会回到不安全的事务外检查，而会让所有已接线 PostgreSQL mutation 在 commit 前抛出 `ActiveReleaseFencedCommitPausedException` 并回滚；读请求、notification stream、binary 公开读取和现有 pending outbox 保持可用。排查完成后恢复为 `true`，先验证 durable fence 与 audit 为 clean，再恢复 worker mutation。

`ActiveReleaseFencedCommitAudit:Enabled=false` 只暂停周期扫描，不能关闭事务 guard。interval、recent window 和 batch size 每轮从配置读取，无需重启。

## API 与安全边界

本改动不增加公共、登录、admin、notification stream 或 binary endpoint，也不改变 DTO/AEDS frame。admin fence endpoint 仍保持 loopback + `system.config`；匿名与登录请求不接触 commit token 表。token 不进入响应、日志标签或客户端证据。

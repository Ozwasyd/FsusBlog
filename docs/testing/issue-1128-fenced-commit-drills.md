# Issue #1128 fenced commit drills

## 聚焦自动验证

最低聚焦集合覆盖：

- guard 拒绝无业务事务的调用；
- reloadable mutation pause fail closed；
- SQL 同时包含 durable fence `FOR SHARE` 和 token insert；
- scheduled publish、article outbox、article view projection 接入 transactional guard；
- migration 为 non-destructive online Expand；
- auditor 识别 post-revoke、post-switch、identity divergence 与未来 generation；
- Redis total loss/partition 时判定仍来自 PostgreSQL durable witness；
- 既有 admin/notification、匿名、登录和 binary contract 不变。

`tests/backend/Integration/ActiveReleaseFencedCommitIntegrationTests.cs` 使用真实 PostgreSQL 连接与两个并发事务验证两条关键时间线：已 enlist 的业务事务持有 shared advisory/row lock 时，revoke 必须等待业务 commit；旧 generation 在 mutation 后暂停、durable witness 已切换再恢复时，业务行与 token 必须一起回滚。该测试刻意不注册 Redis 客户端，证明事务最终判定不依赖 Redis 可用性或缓存快照。

## GC pause 演练

1. generation 41 worker 捕获 execution ticket 后，在业务 transaction enlist 前暂停；
2. 用控制面 revoke 41，并 acquire generation 42；
3. 恢复旧 worker；
4. 旧事务的 `matching_fence` 必须返回零行，业务 mutation 与 token insert 同时回滚；
5. 断言 `fsus.active_release_fenced_commit.enlistments{result="rejected"}` 增加，`sys_fenced_commit` 不存在旧 token。

## in-flight commit 与撤销传播

1. generation 41 事务完成 mutation 与 enlist，保持事务未 commit；
2. 并行发起 revoke 41；
3. revoke 的 `FOR UPDATE` 必须等待旧事务持有的 `FOR SHARE`；
4. 旧事务 commit 后 revoke 才能成功；
5. 后续任一 generation 41 事务必须回滚。

该顺序证明不存在“revoke 已成功但旧事务随后 commit”的窗口。若旧事务主动回滚，token 行也必须消失。

## Redis partition / 双 active 演练

1. 保持 PostgreSQL 可用，阻断 worker 到 Redis；
2. 旧 worker 即使持有缓存 ticket，也只能用 `sys_deployment_fence` enlist；
3. 在 SQL durable witness 切换到新 generation 后恢复旧 worker，旧 transaction 必须回滚；
4. 并行提交两个 release 的 transaction，只有与 durable row 完全匹配的一方能写 token；
5. 运行 auditor，期望 violation count 为 0。

Redis 不可达可能使 worker lease renew 失败并提前取消，但不能让 guard 回退到 stale snapshot。

## 失败注入真实性

演练证据至少保存 transaction A/B 的时间线、SQL generation、commit/rollback 结果、token 行数和 auditor 结果。不得仅用 sleep 后的 mock boolean 代替 PostgreSQL row-lock 竞争；若环境没有 PostgreSQL，只能把源码/单元验证报告为 focused contract，不能声称 GC/partition integration 已通过。

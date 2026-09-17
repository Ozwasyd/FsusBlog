# Issue #1040：并发与状态机行为测试替换

本次改动移除 `ConcurrencyRaceHardeningContractTests` 与
`BusinessLogicHardeningContractTests` 的跨文件源码字符串断言，改由真实服务边界、真实
PostgreSQL 事务和可观察副作用验证约束。运行时代码与公开 API 契约没有变化。

## 行为覆盖

| 领域 | 可观察约束 | 并发控制 |
| --- | --- | --- |
| 匿名 nullifier | 同 scope 只允许策略上限内的评论；`use_count`、首末评论关联一致；失败不留下评论或 nullifier 半状态 | 多客户端 `Barrier` 同时消费；事务内故障注入 |
| 文章破坏性操作 | 删除、恢复为草稿、永久删除和清空回收站遵循单向状态机；活动文章不可被永久删除 | 持有行锁制造 stale row version；两个写者同时删除 |
| 评论写入与审核 | 不可见文章/父评论拒绝写入；删除或审核只产生一次数据库变更和一次缓存失效；数据库错误不产生外部副作用 | 独立客户端并发删除；持有行锁后释放 CAS 审核 |
| 账号状态 | 注销账号不能被封禁、解禁或批量审核路径复活；陈旧版本不写黑名单 | 删除事务持锁期间启动后台状态变更 |
| refresh 与 MFA | 同一 refresh token 竞态只有一次旋转，并将重放会话终止；同一恢复码只持久化一次 | 持有 session/profile 行锁，使两个调用者读取同一旧状态后竞争 CAS |
| challenge | `verified`、`revoked`、`expired` 为终态；所有并发尝试仍保留审计行 | 八个独立数据库客户端经 `Barrier` 同时写入不同 outcome |

旧测试 ID 与新行为测试 ID 的完整一一映射位于
`tests/backend/issue-1040-retention-replacements.json`。共享 coverage、matrix、requirements、
PostgreSQL collection 目录和 static-governance 更新由中央合并者统一落地，避免多个 issue
同时修改治理文件。

## 运行与诊断

这些用例标记为 `Dependency=Docker`，数据库并发用例还标记为
`Category=Concurrency`。行锁等待和 `Barrier` 均有有限超时；超时时应保留失败，而不是将
用例降级为源码断言或跳过。测试失败时优先检查最终数据库行、调用返回值和记录到的缓存
失效/实时通知次数，它们是本组测试的权威证据。

本 issue 代码阶段按任务要求未执行测试、构建、lint 或语法检查；验证状态必须由后续统一
验证阶段据实填写。

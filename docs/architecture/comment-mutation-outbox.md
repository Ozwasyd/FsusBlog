# Comment mutation outbox

评论命令的数据库事务只提交权威状态与最小 Outbox 标识。模型调用、缓存版本推进、notification stream、站内信和审计投影不再决定请求事务能否提交；worker 在提交后可靠恢复这些副作用。

## 事务与事件

同一事务写入 `comment` / `comment_region_compliance` 与下列事件：

- `CommentCreated`
- `CommentModerationChanged`
- `CommentDeleted`
- `CommentEdited`
- `CommentReplyNotificationRequested`
- `CommentVisibilityChanged`

事件仅保存 event/comment/article/root/parent/account/reply-target/admin actor、前后审核状态和时间。`payload_json` 由 writer 强制重写为 `{}`，数据库约束也拒绝其他值；评论正文、IP hash、匿名证明、nullifier、ticket 与 credential 不进入 Outbox。

## 交付状态机

```text
pending/failed -> processing -> processed
      ^               |
      +-- backoff <---+
                      +-- attempt >= 10 -> poison

expired processing lease -> processing
```

每个 processing event 都有独立的 `claim_token`、`claimed_by`、`lease_generation`、`claimed_at`、`lease_expires_at` 和 `last_heartbeat_at`。worker 从 reloadable `CommentMutationOutbox:ClaimLeaseSeconds`（默认 60，范围 30..300）与 `HeartbeatSeconds`（严格小于 lease 的三分之一）读取策略；只有后台 heartbeat 按 event 的 id、token、worker 与 generation 续租且必须影响恰好一行，并在同一成功点累计 `renewed` 与 `heartbeat`。consumer 开始前、外部调用返回后、checkpoint 写入前和 outbox 完成前的 ownership check 也检查同一 guard 的 affected row，但不延长 lease、不更新 `last_heartbeat_at`，也不计作 renewal。0 行、过期或短时 heartbeat 失败会把该 event 标为 lost，停止其后续副作用，旧 owner 不得写 checkpoint、failed 或 processed 覆盖新 owner。

每个 `event id + consumer name` 在 `comment_mutation_outbox_delivery` 只有一行。consumer 完成后写 `completed`；重复投递先检查 checkpoint。外部交付还使用稳定键：notification stream 使用 `comment-outbox:{eventId}:realtime`，站内信使用已有的 deterministic source-event id。模型和人工状态变化继续使用数据库 CAS，重复事件不能重复状态转换。

worker 总是按 `occurred_at_utc, id` claim，但不依赖绝对有序：实时发布前重新读取当前评论。旧的 approve 事件看到当前行已隐藏/删除时不发送 `CommentAdded`；旧的 hide 事件看到当前行已重新 approve 时不发送 `CommentRemoved`。缓存失效允许重复执行且采用当前 aggregate scope。

## 故障注入覆盖

- 权威事务提交前中断：comment 与 Outbox 一起回滚。
- 提交后、模型调用前中断：pending `CommentCreated` 被重启后的 worker reclaim。
- cache、realtime 或 notification 前中断：已完成 consumer checkpoint 保留，其余 consumer 重试。
- consumer 暂时不可用：事件进入 `failed`，按指数退避重试，十次后进入 `poison`。
- 重复投递：completed checkpoint 跳过；实时流与站内信再由稳定幂等键兜底。
- 删除/审核并发或乱序：consumer 读取当前 authoritative state，禁止旧事件重新公开。

## 可观测性与回退

`/api/ops/health/ready-detail` 的 `runtime.commentMutationOutbox` 返回 backlog、failed、poison、oldest age、processed、last completed、last error、owned、renewed、lost、reclaimed 和 oldest lease age。`fsus.comment_outbox.processed.count`、`failed.count`、`claim_lost.count`、`heartbeat.count`、`backlog`、`oldest_age_seconds`、`poison` 提供对应指标；poison 非零使 runtime readiness degraded。

无需重启的 fail-closed 回退：把 reloadable `CommentMutationOutbox:Enabled` 设为 `false`，worker 停止 claim，权威评论事务仍持续写 pending。排查 PostgreSQL、模型、Redis/notification stream 或 message delivery 后恢复为 `true`，积压会自动继续。不要删除事件、checkpoint，或把未知副作用手工改为 completed。

## 风险边界

暂停 worker 会延迟公开缓存、实时流和通知，但不会丢失权威评论状态。恢复时可能产生短时积压压力；按 backlog age 与 failed/poison 观察并逐批释放。此设计不引入外部消息系统，单进程开发使用内置 hosted worker；多实例仍复用 `IBackgroundWorkerLease` leader election。

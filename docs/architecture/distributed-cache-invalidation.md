# Distributed cache invalidation

本文档是跨节点缓存失效运行时契约的唯一事实源。相关 issue 只记录于 `config/development/document-lifecycle.json` 的追踪 metadata，不构成文档身份或运行时 authority。

## Runtime modes and transport scope

- `single` 只注册 `SingleNodeDistributedInvalidationPublisher`。本地失效完成后返回 `LocalOnly`，不创建 Redis subscriber，也不启动总线后台服务。
- `static-role` 与 `adaptive` 注册 Redis Pub/Sub transport 和 `DistributedInvalidationBus`。channel 经 `IRuntimeKeyScope` 隔离，默认逻辑名为 `fsus:distributed-invalidation:v1`。

多节点模式还必须在 `Runtime:DistributedInvalidation:Topology:SubscriberNodeIds` 提供当前部署的 machine-readable subscriber manifest。它是 publish delivery expectation 的唯一 authority，包含来源节点自身（若该节点订阅此 channel），并与逻辑 channel 一起 canonicalize 为 SHA-256 topology digest。缺失 manifest、重复/空节点 ID，或 publisher node 不在 manifest 中，都会在启动注册阶段 fail closed；不得由当前进程数、环境变量或 Redis publish ACK 推测 topology。

节点 ID 默认是 `machine:process-id`，也可由 `FSUSBLOG_NODE_ID` 或 `Runtime:DistributedInvalidation:NodeId` 显式配置。多节点部署必须给每个节点提供稳定且唯一的 ID；runtime scope、channel 和 node identity 必须同时匹配当前部署拓扑。

## Publish and apply ordering

写节点先完成原有本地与共享缓存失效，再形成 durable source outbox，最后发布分布式事件。outbox 固定保存 canonical payload/digest、runtime scope、kind、topology digest、required/acked node set、attempt 和 `pending|partially-acked|complete|terminal-failed` 状态；没有 outbox 的事件不得进入 transport。transport receipt 固定保存 `channel`、Redis 返回的 `subscriberCount`、manifest 的 `expectedMinimumSubscribers`、`publisherNodeSubscribed`、`observedAt` 和 `transportStatus`（`delivered`、`under-delivered` 或 `transport-failed`）。只有 `subscriberCount >= expectedMinimumSubscribers` 才记录 `Published`；零、null、负 count 与不足 count 都是 `under-delivered`，Redis exception 是 `transport-failed`。因此 `count > 0` 从不构成远端交付证明：来源节点自己订阅时也必须计入 topology expectation，source completion 仍只由 durable per-node ACK 决定。

每次 publish receipt 的 channel/count/expected/topology digest 都进入 `DistributedInvalidationRuntimeSnapshot`；非 delivered receipt 同时进入 cache runtime 的 degraded detail。Redis 异常或 delivery 不足不能把已成功的业务 mutation 改写成失败，但 publisher 必须返回 `Degraded`，不能把它记为 `Published` 或降级为 debug 日志。

接收节点按以下顺序收敛本地派生状态：

1. 清空进程内 L1 索引与缓存项；
2. 清空 Public AOT 内存与文件 metadata 视图，但不删除共享或本地磁盘 artifact；
3. 标记 Public AOT 全量失效并清除 route quarantine；
4. 退休当前 PublicHotRead snapshot，使请求回到权威读路径；
5. 排队一次 PublicHotRead 全量重建，取得本次 apply generation；
6. 在 target inbox 持久化 `applied` 和 generation，并把 target ACK 原子写回 source outbox。

这些动作只负责让节点本地视图收敛；L1、Public AOT 和 PublicHotRead 各自的存储、版本与重建契约仍由对应领域文档拥有，不在其他 cache/AOT 文档复制总线协议。

## Replay, retry, and loop prevention

总线以 `runtimeScope:eventId` 作为 replay identity。来源节点忽略自己的消息；接收侧直接调用 local applier，不再次进入 dispatcher 或 publish 路径，因此不会产生发布回环。target 先按 `(runtimeScope,eventId,targetNodeId)` durable upsert inbox，再以数据库条件更新从 `pending|retryable-failed` 原子 claim 为 `applying`；进程内集合不参与正确性判定。重复 payload 只有在 durable inbox 已为 `applied` 时才算完成重复；同 event ID 的不同 payload digest 会在同一事务内把 inbox 与 source outbox 标记为 `terminal-failed`。

local applier 返回结构化结果，明确记录 memory invalidation、AOT memory invalidation、AOT generation mark、HotRead snapshot retirement、rebuild obligation（`durable`、`queued`、`rejected` 或 `failed`）和 local apply terminal status。只有前四个阶段全部成功且 rebuild obligation 为 `durable`（携带 obligation ID 与 generation）或 `queued` 时，总线才记录 `applied`；`rejected`、unknown/null/incomplete result 在有界进程内重试耗尽后写 `retryable-failed`，后续 durable replay 可再次 claim。明确 terminal result 写 `terminal-failed`，不会反复 apply。进程中断遗留的 `applying` 在该节点启动恢复时先转为 `retryable-failed`。runtime snapshot 分别计数 `received`、`local-invalidated`、`rebuild-obligated` 和 `applied`，不以日志 detail 代替这些阶段字段。

## Degraded operation and recovery

`DistributedInvalidationConvergenceObligationStore` 是唯一 delivery ledger owner。source outbox 以 `(runtimeScope,eventId)` 唯一，target inbox 以 `(runtimeScope,eventId,targetNodeId)` 唯一。source node 在 prepare 时只 ACK 已完成的本地 mutation；其他 required nodes 使用 PostgreSQL 单条原子 ACK-set 更新，两个 target 并发 ACK 不会读改写覆盖。source 只有在 current required set 全部 ACK 后才成为 `complete`；Redis subscriber count、等待时长和 publish 成功都不能完成它。旧 dispatcher `UpsertAsync` 只兼容记录同一 transport receipt，并通过 `observedAt` 幂等，不创建缺 payload 的第二条事实。

hosted service 的 subscription 与 recovery poll 并行运行。启动时数据库暂不可用、Redis 订阅失败或 Pub/Sub 消息丢失都不会永久结束 worker；recovery poll 按 `RecoveryReplayIntervalMilliseconds` 有界重试当前 scope 对本节点尚未 ACK 的 outbox，并服从 host cancellation。显式 topology retirement 先在同一 PostgreSQL 事务写 retirement ledger，再从未完成 outbox 的 required set 移除节点并重算状态；没有 timeout completion。

full reconcile 压缩需要 `(runtimeScope,targetNodeId,kind)` coverage row 的 generation 达到 watermark，并且每个 required target inbox 已 `applied`。调用方数字或单个 event 的 applied generation 不能替代 scope/kind coverage proof。retention 只清除满足上述证明的 `complete` payload；`pending`、`partially-acked` 和 `terminal-failed` 永不被压缩。

pending、terminal、oldest age、ACK gap 和 ledger availability 进入 `distributedConvergence` readiness，并进入 deployment drain/release snapshot。任一 pending、terminal、ACK gap 或 ledger unavailable 都 fail closed。`single` mode 返回 `LocalOnly` 且不创建远端 ledger row。

Redis 暂时不可用时，节点继续完成本地失效，并让读请求回退到数据库或其他权威读路径；订阅循环持续重试。恢复 Redis 后不需要重启，后续事件和 PublicHotRead 重建会继续收敛。不得通过重新发布接收到的事件、跳过本地优先顺序或把 mutation 改成失败来制造表面一致性。

若要完全关闭多节点协调，必须把 `Runtime:Mode` 切回 `single` 并按正常编排滚动重启，因为 hosted-service 的 DI 组合在启动时确定。该模式切换不是 Redis 短时故障的恢复前置条件。

## Verification ownership

`DistributedInvalidationBusTests` 使用两个独立总线实例验证对端 L1、Public AOT 与 PublicHotRead 收敛、自源过滤、重复投递幂等、无发布回环、apply 重试、启动 ledger 暂不可用持续重试，以及 Redis 不可用时的本地优先行为。`DistributedInvalidationDeliveryLedgerIntegrationTests` 使用真实 PostgreSQL 与 Redis 双节点 fixture，分别验证离线/丢 Pub/Sub、断线/重连、apply failure 后重启、duplicate exactly once、digest mismatch、partial/concurrent ACK、retirement、scope/kind generation coverage、retention 和 terminal readiness。测试必须从 durable rows 断言结果，不能以 mock、日志或进程内计数替代 ledger 证据。

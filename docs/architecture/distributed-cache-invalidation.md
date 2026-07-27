# Distributed cache invalidation

本文档是跨节点缓存失效运行时契约的唯一事实源。相关 issue 只记录于 `config/development/document-lifecycle.json` 的追踪 metadata，不构成文档身份或运行时 authority。

## Runtime modes and transport scope

- `single` 只注册 `SingleNodeDistributedInvalidationPublisher`。本地失效完成后返回 `LocalOnly`，不创建 Redis subscriber，也不启动总线后台服务。
- `static-role` 与 `adaptive` 注册 Redis Pub/Sub transport 和 `DistributedInvalidationBus`。channel 经 `IRuntimeKeyScope` 隔离，默认逻辑名为 `fsus:distributed-invalidation:v1`。

多节点模式还必须在 `Runtime:DistributedInvalidation:Topology:SubscriberNodeIds` 提供当前部署的 machine-readable subscriber manifest。它是 publish delivery expectation 的唯一 authority，包含来源节点自身（若该节点订阅此 channel），并与逻辑 channel 一起 canonicalize 为 SHA-256 topology digest。缺失 manifest、重复/空节点 ID，或 publisher node 不在 manifest 中，都会在启动注册阶段 fail closed；不得由当前进程数、环境变量或 Redis publish ACK 推测 topology。

节点 ID 默认是 `machine:process-id`，也可由 `FSUSBLOG_NODE_ID` 或 `Runtime:DistributedInvalidation:NodeId` 显式配置。多节点部署必须给每个节点提供稳定且唯一的 ID；runtime scope、channel 和 node identity 必须同时匹配当前部署拓扑。

## Publish and apply ordering

写节点先完成原有本地与共享缓存失效，再发布分布式事件。transport receipt 固定保存 `channel`、Redis 返回的 `subscriberCount`、manifest 的 `expectedMinimumSubscribers`、`publisherNodeSubscribed`、`observedAt` 和 `transportStatus`（`delivered`、`under-delivered` 或 `transport-failed`）。只有 `subscriberCount >= expectedMinimumSubscribers` 才记录 `Published`；零、null、负 count 与不足 count 都是 `under-delivered`，Redis exception 是 `transport-failed`。因此 `count > 0` 从不构成远端交付证明：来源节点自己订阅时也必须计入 topology expectation。

每次 publish receipt 的 channel/count/expected/topology digest 都进入 `DistributedInvalidationRuntimeSnapshot`；非 delivered receipt 同时进入 cache runtime 的 degraded detail。Redis 异常或 delivery 不足不能把已成功的业务 mutation 改写成失败，但 publisher 必须返回 `Degraded`，不能把它记为 `Published` 或降级为 debug 日志。

接收节点按以下顺序收敛本地派生状态：

1. 清空进程内 L1 索引与缓存项；
2. 清空 Public AOT 内存与文件 metadata 视图，但不删除共享或本地磁盘 artifact；
3. 标记 Public AOT 全量失效并清除 route quarantine；
4. 退休当前 PublicHotRead snapshot，使请求回到权威读路径；
5. 排队一次 PublicHotRead 全量重建，补偿 Redis Pub/Sub 不提供 ACK 的版本窗口。

这些动作只负责让节点本地视图收敛；L1、Public AOT 和 PublicHotRead 各自的存储、版本与重建契约仍由对应领域文档拥有，不在其他 cache/AOT 文档复制总线协议。

## Replay, retry, and loop prevention

总线以 `runtimeScope:eventId` 作为 replay identity。来源节点忽略自己的消息；接收侧直接调用 local applier，不再次进入 dispatcher 或 publish 路径，因此不会产生发布回环。重复事件只 apply 一次。

局部 apply 失败按 `ApplyRetryCount` 重试。最终失败会释放 replay identity，使同一事件后续重投仍能重新收敛；成功或已处理事件保持幂等。日志与 runtime state 对 publish、receive、duplicate、self-ignore、retry 和 degraded 使用同一 `eventId`、`kind`、`sourceNodeId`、`traceId` 关联。

## Degraded operation and recovery

Redis 暂时不可用时，节点继续完成本地失效，并让读请求回退到数据库或其他权威读路径；订阅循环持续重试。恢复 Redis 后不需要重启，后续事件和 PublicHotRead 重建会继续收敛。不得通过重新发布接收到的事件、跳过本地优先顺序或把 mutation 改成失败来制造表面一致性。

若要完全关闭多节点协调，必须把 `Runtime:Mode` 切回 `single` 并按正常编排滚动重启，因为 hosted-service 的 DI 组合在启动时确定。该模式切换不是 Redis 短时故障的恢复前置条件。

## Verification ownership

`DistributedInvalidationBusTests` 使用两个独立总线实例验证对端 L1、Public AOT 与 PublicHotRead 收敛、自源过滤、重复投递幂等、无发布回环、apply 重试，以及 Redis 不可用时的本地优先行为。它还固定验证 expected=2/actual=2 才发布、expected=2/actual=1（仅来源 subscriber）为 degraded、零/null/负 count fail closed，及 distributed mode 缺 topology manifest 启动失败。该测试属于 `distributed-contract-fast`，不依赖真实网络或双进程 fixture。

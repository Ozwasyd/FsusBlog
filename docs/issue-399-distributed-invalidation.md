# Issue #399 节点间缓存失效总线

## 运行模式

- `single`：只注册 `SingleNodeDistributedInvalidationPublisher`。本地失效完成后返回 `LocalOnly`，不创建 Redis subscriber，也不启动总线后台服务。
- `static-role` / `adaptive`：注册 Redis Pub/Sub transport 与 `DistributedInvalidationBus`。channel 会经过 `IRuntimeKeyScope` 隔离，默认逻辑名为 `fsus:distributed-invalidation:v1`。

节点 ID 默认使用 `machine:process-id`，可通过 `FSUSBLOG_NODE_ID` 或 `Runtime:DistributedInvalidation:NodeId` 明确配置。多节点部署必须给每个节点配置稳定且唯一的 ID。

## 收敛与故障语义

写节点始终先完成原有本地/共享缓存失效，再发布分布式事件。Redis 发布失败不会把已成功的业务 mutation 变成失败；publisher 返回 `Degraded`，并同时写入结构化日志、`DistributedInvalidationRuntimeState` 与现有 `CacheInvalidationRuntimeState.LastKind/LastDetail`。

接收节点执行以下本地收敛动作：

1. 清空进程内 L1 索引和缓存项；
2. 清空 Public AOT 内存与文件元数据视图，但不删除共享/本地磁盘产物；
3. 标记 Public AOT 全量失效并清除 route quarantine；
4. 退休当前 PublicHotRead 快照，使请求回退到权威读路径；
5. 排队一次 PublicHotRead 全量重建，作为 Redis Pub/Sub 无 ACK 时的版本修复路径。

总线按 `runtimeScope:eventId` 幂等。来源节点忽略自己的消息；接收侧直接调用本地 applier，不会再次进入 dispatcher 或 publish 路径，因此不会形成消息环。局部 apply 失败按 `ApplyRetryCount` 重试；最终失败会释放 replay identity，允许后续重投重新收敛。

## 可观测性与排障

发布、接收、重复、self-ignore 与 degraded 状态都保留 `eventId`、`kind`、`sourceNodeId`、`traceId`。管理缓存诊断的 `LastKind`/`LastDetail` 可直接看到最近的分布式事件来源和 trace；日志事件名使用 `distributed-invalidation-*` 前缀。

Redis 临时不可用时无需重启：节点继续完成本地失效并回退到权威数据路径，订阅循环持续重试。若要完全关闭多节点协调，则需把 `Runtime:Mode` 切回 `single` 并重启，因为 hosted service 的 DI 组合在启动时确定。

## 验证边界

`DistributedInvalidationBusTests` 使用两个独立总线实例验证对端 L1/AOT/PublicHotRead 收敛、自源过滤、重复投递幂等、无发布回环、apply 重试及 Redis 不可用时的本地优先行为。该测试纳入 `distributed-contract-fast`，不依赖真实网络或双进程 fixture。

共享的 `docs/architecture.md` 当前由另一任务占用，因此本 issue 仅新增本独立交接文档，未修改该文件。

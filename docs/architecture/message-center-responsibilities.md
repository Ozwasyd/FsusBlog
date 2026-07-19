# MessageCenter 内部职责边界

`MessageCenterService` 仍是单体进程内的应用 façade，并继续实现现有 query、command、realtime、maintenance 与 outbox delivery ports。拆分只改变源码职责边界，不新增部署单元、外部依赖或 wire contract。

## 责任文件

| 文件 | 责任 |
| --- | --- |
| `MessageCenterService.ConversationQuery.cs` | 账户/admin 列表、详情、delta 与查询组装 |
| `MessageCenterService.MessageCommand.cs` | 创建、账户/admin 回复、状态变更与系统通知 |
| `MessageCenterService.ReadState.cs` | 账户/admin read cursor、unread 投影检查与修复 |
| `MessageCenterService.DeliveryOutbox.cs` | mutation outbox 入队、投递和 realtime transport |
| `MessageCenterService.Projection.cs` | DTO/viewer projection、fanout payload 与 unread cache refresh |
| `MessageCenterService.ContentPolicy.cs` | 内容校验错误映射、mutation identity 与稳定 hash |
| `MessageCenterService.cs` | 构造依赖、共享类型和受 named-reader 治理约束的 SQL reader kernel |

账户回复与管理员回复都必须进入同一个 `WriteReplyAsync` 事务写入内核。请求线程只写 mutation outbox，不直接发布消息事件。读取端口显式接收 `CancellationToken`，binary GET endpoints 传入 request cancellation；现有路由、AEDS frame 和 DTO 保持不变。

## 查询计划证据

`MessageCenterQueryPlanIntegrationTests` 在本地 PostgreSQL fixture 中创建固定的 128 个 conversation、每个 8 条 message，并对以下生产等价查询执行 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`：

- conversation list；
- conversation detail page；
- account unread total；
- batched last-message projection。

fixture 校验 execution/planning time、actual rows 与 shared buffer 指标确实存在。该固定数据集用于阻止查询形状失去可执行计划，不代表生产流量规模，因此本次没有据此新增或修改索引。

## 回退

本次没有 schema migration、配置开关或外部存储变更。回退时可直接 revert 对应提交；进程重启后恢复原单文件实现，数据库与 AEDS artifact 无需迁移。

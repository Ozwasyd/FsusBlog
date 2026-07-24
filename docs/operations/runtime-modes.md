# Runtime mode gates

FsusBlog v1.3.0 继续使用同一个仓库、同一个 Server 项目和同一个应用发布物。运行模式只决定进程启动哪些运行时职责，不生成固定业务服务、sidecar 或第二套部署包。

## 配置

默认不需要配置：

```json
{
  "RuntimeMode": {
    "Mode": "single"
  }
}
```

支持的 `Mode`：

- `single`：默认模式。完整业务能力在本进程执行，调用保持 local in-process；不启动 cluster foundation，不启用 adaptive scheduler，也不订阅跨节点 Public AOT invalidation。
- `static-role`：同一程序按 `StaticRoles` 启动固定后台职责，不进行自动迁移。可选角色为 `web`、`content`、`security`、`audit`、`maintenance`；至少配置一个角色。
- `adaptive`：同一程序启动 cluster foundation、Redis membership heartbeat 和 distributed-invalidation gate。动态调度算法和职责迁移由后续独立实现接入。

静态角色示例：

```json
{
  "RuntimeMode": {
    "Mode": "static-role",
    "StaticRoles": ["web", "audit"]
  }
}
```

`static-role` 默认从角色推导稳定 capability；也可以为 `static-role` 或 `adaptive` 显式配置：

```json
{
  "RuntimeMode": {
    "Mode": "adaptive"
  },
  "Runtime": {
    "Cluster": {
      "NodeId": "fsusblog-node-001",
      "Capabilities": ["web.api", "comment.api", "search.query"],
      "HeartbeatSeconds": 10,
      "SuspectAfterSeconds": 30,
      "DeadAfterSeconds": 90
    }
  }
}
```

capability 只接受 catalog 中的稳定值；adaptive 未声明 capability 会 fail closed。`NodeId` 可省略并使用当前 host/process identity；每次进程启动仍生成新的 `instanceId`，用于拒绝上一进程的迟到 heartbeat 或 draining 写入。

环境变量可使用 `RuntimeMode__Mode` 与 `RuntimeMode__StaticRoles__0` 等标准 ASP.NET Core 键。未知 mode、未知 role 或空的 `static-role` 集合会在 `builder.Build()` 前失败，避免以不明确职责启动。

## 启动与健康语义

`RuntimeModeRuntimeState.Capture()` 是运行模式健康快照的权威来源，包含 mode、静态角色、cluster/membership/scheduler/distributed-invalidation gate、local invocation 边界以及 cluster foundation 是否已启动。启动日志输出同一份计划；`single` 会明确记录相关分布式能力为 `disabled`。

`single` 仅移除跨节点 invalidation subscriber 且不启动 membership heartbeat，本机 worker 和本地失效路径继续工作。`static-role` 只裁剪归属已登记角色的后台 worker；生命周期、启动校验和未知的核心 hosted service 保持启用，避免因新增 worker 未登记而静默停机。`adaptive` 不改变 HTTP 入口或发布物，也不在业务层引入节点位置依赖。

多节点 membership 视图位于 runtime-scoped Redis hash。heartbeat 超时按 `Alive -> Suspect -> Dead` 收敛；`Draining` 与 `Maintenance` 由运维显式控制，failure detector 不覆盖。受保护的 `GET /api/ops/cluster/nodes` 只允许 independent admin principal + `system.config` + `fixed_ip`，用于后台或诊断查看节点、capability、低敏资源提示与 active responsibility。

## 有状态职责协议

`static-role` 和 `adaptive` 中的有状态职责不能只依赖 membership 判断 owner，必须取得 `responsibility + resource` lease。lease TTL 到期后才允许另一节点接管；每次新 acquire 产生单调递增 fencing token，renew/release 只接受原 `leaseId + token`。因此旧节点即使从长暂停恢复，也不能覆盖新 owner 已写入的状态。

后台任务默认采用：

```text
scheduling: at-least-once
side effect: effectively-once by taskType + objectId + operationId
critical write: single writer + fencing token
long task: compare-version checkpoint
terminal failure: dead letter or explicit compensation-required
```

任务接管流程固定为：

1. 新节点在旧 TTL 到期后取得更大的 fencing token；
2. 用同一 idempotency key 读取 task record；
3. 从最后成功 checkpoint version 恢复；
4. 每次 checkpoint、complete 或 failure transition 都复核当前 lease；
5. 达到最大重试次数后进入 dead letter；已登记补偿的任务进入 `CompensationRequired`，不自动伪造成功。

当前 cluster failure detector 已使用 `cluster:failure-detector` lease，避免每个节点同时写 membership 状态转换。后续 search index、media、moderation、notification 与 scheduler worker 接入时必须按各自资源或 partition 建 key，不能共用一个全局锁，也不能绕过 idempotency record。

## 风险与回退

运行模式在 DI 容器构建前固定，不支持进程内热切换。配置错误会 fail closed。Redis state-control 不可用或 lease renew 丢失时，worker 必须停止新的 checkpoint/critical write；不得降级为进程内多写者。无需重启的局部降级是把节点标记为 `Draining` 或 `Maintenance` 并移除 active responsibility，等待 lease TTL 后由健康节点接管；公开读取、登录、admin、binary 与 notification stream 继续工作。若静态角色或 adaptive 基础组件整体异常，把 `RuntimeMode:Mode` 恢复为 `single` 并启动下一进程代际；不需要迁移数据、切换镜像或部署另一类服务。回退不得通过添加固定业务 sidecar、清空 fencing counter、删除 idempotency record 或让 single hot path 经过跨节点协议完成。

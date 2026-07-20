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
- `adaptive`：同一程序启动 cluster foundation，并打开 membership、scheduler 与 distributed-invalidation gate。当前 issue 只建立装配和健康状态边界；membership、调度算法和职责迁移由后续独立实现接入。

静态角色示例：

```json
{
  "RuntimeMode": {
    "Mode": "static-role",
    "StaticRoles": ["web", "audit"]
  }
}
```

环境变量可使用 `RuntimeMode__Mode` 与 `RuntimeMode__StaticRoles__0` 等标准 ASP.NET Core 键。未知 mode、未知 role 或空的 `static-role` 集合会在 `builder.Build()` 前失败，避免以不明确职责启动。

## 启动与健康语义

`RuntimeModeRuntimeState.Capture()` 是运行模式健康快照的权威来源，包含 mode、静态角色、cluster/membership/scheduler/distributed-invalidation gate、local invocation 边界以及 cluster foundation 是否已启动。启动日志输出同一份计划；`single` 会明确记录相关分布式能力为 `disabled`。

`single` 仅移除跨节点 invalidation subscriber，本机 worker 和本地失效路径继续工作。`static-role` 只裁剪归属已登记角色的后台 worker；生命周期、启动校验和未知的核心 hosted service 保持启用，避免因新增 worker 未登记而静默停机。`adaptive` 不改变 HTTP 入口或发布物，也不在业务层引入节点位置依赖。

## 风险与回退

运行模式在 DI 容器构建前固定，不支持进程内热切换。配置错误会 fail closed。若静态角色或 adaptive 基础组件异常，把 `RuntimeMode:Mode` 恢复为 `single` 并重启同一应用发布物；不需要迁移数据、切换镜像或部署另一类服务。回退不得通过添加固定业务 sidecar 或让 single hot path 经过跨节点协议完成。

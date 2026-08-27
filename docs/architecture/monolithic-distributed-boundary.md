# 单体分布式架构边界

FsusBlog 的架构定义是**单体分布式**（Homogeneous Binary, Heterogeneous Runtime）：仓库、构建和部署始终产出同一套 FsusBlog 程序，`FsusBlog.Server` 是唯一业务入口。多节点只改变同一程序实例承担的运行时职责，不把内容、评论、搜索等模块固化成独立业务服务。

## 不变量

- 一个仓库、一个主应用项目、一个应用 Dockerfile 和一个前后端整合的生产发布物。
- PostgreSQL、Redis 和可选网关属于基础设施或部署层，不是拆出的业务 sidecar。
- 单机是默认路径；扩展到多节点时，每个节点仍运行相同二进制和相同模块集合。
- 领域模块只表达业务能力，不感知节点位置、HTTP/gRPC 客户端或 Redis transport。
- 跨节点执行只能通过窄 port / adapter 边界进入 remote invocation；调用方先走本地能力，运行时才决定是否转交远端 adapter。

## 运行模式

<!-- fsus-doc-claim
claimId: deployment.runtime-role-contract
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: deployment.runtime-role-contract
render: key-value-table
-->
<!-- FSUSBLOG-GENERATED:BEGIN deployment.runtime-role-contract -->
| Key | Value |
| --- | --- |
| applicationOwner | src/backend/FsusBlog.Server.csproj |
| architecture | homogeneous-monolith |
| coResidency | application-capabilities-share-one-program |
| declaredRoles | ["application","gateway","infrastructure"] |
| defaultMode | single |
| publicationUnit | ops/docker/FsusBlog.Server.Dockerfile |
| separation | infrastructure-and-gateway-are-external-roles |
| supportedModes | ["adaptive","single","static-role"] |
| unsupportedCombinations | ["fixed-business-microservices","single-mode-remote-invocation-required"] |
<!-- FSUSBLOG-GENERATED:END deployment.runtime-role-contract -->

三种模式使用同一套 FsusBlog 程序和同一发布物。远端依赖临时异常时，节点保留本地失效与权威数据回退，transport 自行重试，不需要切换业务发布物；若要完全关闭集群组件，必须把 `Runtime:Mode` 改回 `single` 并滚动重启，因为 hosted service 的 DI 组合在启动时确定。`single` 模式的本地 publisher 必须先于 Redis transport 注册分支，保证无远程热路径。

## 项目与部署拓扑守卫

静态守卫以 `src/backend/FsusBlog.Server.csproj`、`ops/docker/FsusBlog.Server.Dockerfile` 和 Compose 服务清单为权威：

- `src/` 只能有一个 Web/Exe 业务入口项目；Core/Shared 继续是库。
- `FsusBlog.Server.csproj` 必须把 frontend dist 复制进自身 `wwwroot`，禁止形成独立前端生产发布物。
- Compose 只能声明已分类的 application、gateway 或 infrastructure 服务；新增必需业务 sidecar 会直接失败。
- 领域根不得导入 HTTP、gRPC、Redis、socket 或节点定位实现。
- remote invocation 标识只能出现在 Interfaces、Contracts 或 Infrastructure 的 port/adapter 根。

本地检查：

```bash
node tools/governance/check-monolithic-distributed-architecture.mjs
node --test tests/tools/monolithic-distributed-architecture.test.mjs
node tools/run-test-matrix.mjs validate
```

若守卫误报，先保持现有单应用发布物并回退新增 Compose/project 入口。若远端 adapter 运行异常，现有本地失效与权威数据回退可在不重启的情况下继续服务；完全关闭集群能力则按上文切回 `single` 并滚动重启，不改变 API 契约或发布物形态。

## Distributed Runtime 议题边界

以下议题共同扩展同一应用，而不是定义固定服务拆分：

- #110 单体分布式支持：同构全能力节点与动态职责调度
- #111 节点能力注册与集群成员治理
- #112 动态职责调度与自适应负载均衡
- #113 分布式状态控制
- #114 本地 / 远程调用透明切换与模块边界约束
- #115 多节点部署、观测与故障治理

因此 capability 注册、职责调度、状态协调、透明调用和故障治理可以分别演进，但都必须服从一个程序、一个发布物、一个业务入口的边界。

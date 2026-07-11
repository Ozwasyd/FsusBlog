# Issue #1038：端点安全契约改为 EndpointDataSource 与 TestServer

本 issue 把 `EndpointPolicyContractTests`、`AuthRiskControlEndpointContractTests`、
`AdminPrincipalSecurityContractTests` 和 `BackendApiIntegrationContractTests` 中的生产源码字符串
断言改为最终端点元数据、真实中间件/过滤器执行结果和结构化协议目录。改动不新增、删除或重命名
公开 API，也不改变认证、PoW、RiskControl 或 step-up 的线上语义。

## 权威边界

`EndpointContractApplication` 从真实 `MapBinaryEndpoints`、`MapAuthoringEndpoints` 和
`MapSecurityEndpoints` 构造 `WebApplication`，并从 `IEndpointRouteBuilder.DataSources` 按稳定的
route pattern 与 HTTP method 找到唯一 `RouteEndpoint`。断言读取最终 `AuthorizationPolicy`、
claim requirement、rate-limit policy、`IAllowAnonymous`、restricted-account、no-store、risk action、
endpoint filter 和 admin-sensitive step-up 元数据，不再读取端点 `.cs` 文件。

`AddEndpointFilterWithMetadata<TFilter>` 是生产扩展：它先附加可枚举的
`EndpointFilterBoundaryMetadata`，再调用真实 `AddEndpointFilter<TFilter>`。因此元数据不是测试替身，
也不会绕过过滤器。`AdminSensitiveStepUpMetadata` 只描述 handler 已经执行的
`X-Fsus-Mfa-Proof` / `admin-sensitive` 边界。

| 契约域 | 可执行证据 |
| --- | --- |
| 匿名与登录 | passkey/recovery 最终 risk/rate/no-store 元数据；缺 proof 的 passkey 被 RiskControl 截断；合法 proof 到达 passkey handler，且不虚构 PoW 要求 |
| 普通账号 | banned 写入返回稳定 `423` AEDS error；logout/delete/session revoke 等 restricted action 由显式元数据放行 |
| admin | 未登录、账号 principal、缺 permission、缺 PoW、缺 step-up、无效/过期/错 scope proof 均在 mutation 前失败；合法 permission/proof 只执行一次 mutation |
| RiskControl/PoW/rate | recovery/comment 中 RiskControl 先于 PoW；第二个 fixed-IP 请求在 RiskControl 前返回稳定 `429` AEDS error |
| binary/protocol | AEDS generated enum、`AedsProtocolMetadata` 与 golden catalog 对齐；human-read 不兼容 Accept 返回稳定 `406` AEDS error |
| notification stream | 本 issue 不改 notification stream；其认证、封禁和 admission 行为继续由现有 `NotificationStreamBoundaryTests` 所有，不复制源码断言 |

评论删除同时服务普通账号所有者与 admin moderator。该端点的 step-up 元数据显式设置
`AdminPrincipalBranchOnly=true`；普通账号所有者分支的实际 handler 行为不因此改变。

## 源码断言迁移

- `EndpointPolicyContractTests` 只枚举最终端点元数据。
- `AuthRiskControlEndpointContractTests` 使用最终元数据与真实 TestServer pipeline。
- `AdminPrincipalSecurityContractTests` 只保留 Development + explicit flag 的 fixture 注册、最终 admin
  authorization metadata 驱动的 cookie 选择，以及 `HttpContext.Items` 决策缓存行为；secret/loopback
  由现有 `DisclosureBoundaryTests` 的实际 status endpoint 请求承担。
- `BackendApiIntegrationContractTests` 使用 generated protocol metadata、golden catalog、结构化 backend
  requirements、最终端点元数据和 TestServer；不再 regex 扫描端点文件中的 `AedsFrameType`。
- 删除的 40 个 baseline test ID 逐项记录在
  `tests/backend/issue-1038-retention-replacements.json`，能原位升级为行为证据的旧 ID 保持不变。

`BinaryEndpoints.Auth.cs` 的六个实际 filter registration 已使用
`AddEndpointFilterWithMetadata<T>`，并保持原顺序和真实 filter registration 不变；其中 recovery
verify 同一路由保留 RiskControl 后接 PoW 的两段顺序。中央 coverage、matrix、backend requirements
与 retention 接线也已存在，当前只缺统一验证。

## 风险与回退

- 元数据缺失会使契约测试失败，但不会禁用真实 authorization/filter；运行时仍 fail closed。
- wrapper 出现兼容问题时，可在下一次部署中只把调用点退回 `AddEndpointFilter<T>`；handler 内的
  permission、PoW、RiskControl 和 step-up 行为不需要恢复或迁移数据。
- TestServer 使用生产 middleware/filter 类型与可控的服务边界，不连接 Redis/PostgreSQL，也移除 hosted
  services；替身只控制 proof、risk score、domain mutation 和审计可观察点。
- 不新增 per-issue regex checker。源码锁、matrix、coverage 与 backend requirements 由中央治理文件统一所有。

## 文档与证据清单

- 本文：设计、行为矩阵、风险与回退。
- `tests/backend/issue-1038-endpoint-security-evidence.json`：机器可读实现与 mutation 计划。
- `tests/backend/issue-1038-retention-replacements.json`：逐 test ID 替换关系。
- `tests/backend/issue-1038-governance-handoff.json`：Auth 冲突文件与四个中央治理文件交接。

公开路由、请求/响应字段和错误语义没有变化，因此 `docs/api/design.md`、`docs/api/contracts.md`、
`docs/api/quick-reference.md` 与 `docs/api/schemas-and-errors.md` 不需要为本 issue 修改。

## 验证状态

按当前实施阶段指令，本 issue 未运行测试、构建、restore、lint、语法检查、治理 checker、runtime 或
mutation。实施中误执行过一次只读 `git diff --check` whitespace inspection；它没有功能验证效力，也不能
计为通过。证据状态仍为 `implementation-only-not-verified`；统一验证阶段必须填写真实 run ID、通过/失败
结果和 surviving mutants，才能将 #1038 标记完成。

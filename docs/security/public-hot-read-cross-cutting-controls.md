# PublicHotRead 横切控制与回退手册

## 目的

PublicHotRead 在 routing/endpoint pipeline 之前返回预生成公开 bytes。`PublicHotReadCrossCuttingControlCatalog` 是这条 early branch 与常规 endpoint branch 的控制覆盖真源；route allowlist 仍以 `PublicHotReadRouteSecurityCatalog` 为准。新增或移动横切控制时，两份 catalog、运行时 stage、synthetic endpoint metadata、focused 行为测试和 CI checker 必须在同一变更内更新。

## 覆盖模式

| 模式 | 当前控制 | 约束 |
|------|----------|------|
| `global-before-branch` | release/security headers、deployment tracking、Shield/exception/binary boundary、trace correlation | 在 classifier 前恰好执行一次，fast 与 canonical 自动共享 |
| `early-replayed` | `public_read` limiter、轻量 request audit context | early 与 endpoint 两端都必须登记；request execution state 防止 miss fallback 重复 lease/context |
| `endpoint-only/not-applicable` | CORS、antiforgery/CSRF、anonymous gateway header guard、authentication、banned-user、authorization | 必须绑定 executable constraint：精确 allowlist、匿名无凭据、不含 gateway guard 会拒绝的 `X-Fsus-*` header、无 `Origin`、仅 `GET`/`HEAD`；不允许只有文字豁免 |

request audit context 只推入 trace/path/method 与已存在 actor 字段的日志上下文，不执行持久审计写入、数据库/Redis 查询或 actor lookup。高价值审计仍只由原 endpoint/service 语义触发。

`ApplicationPipelineStages` 与 `EndpointPipelineStages` 的每个 stage 都必须显式标记为 `Infrastructure`、`BranchMechanic`、`EndpointFunctional` 或 `CrossCuttingControl`。只有 `CrossCuttingControl` 可以声明 control id，且该 id/stage 必须与本 catalog 双向一一匹配；forwarded headers、test-session validation、routing、endpoint metadata headers、WebSocket、compression/output cache 等非 catalog stage 也不能省略分类。这样未来新增 security stage 时，若只改 pipeline 而未登记 catalog，启动校验与 CI self-test 会同时 fail closed。

## 修改流程

1. 在 `PublicHotReadCrossCuttingControlCatalog` 登记稳定 control id、覆盖模式和 stage；replayed control 必须提供唯一 double-execution guard。
2. 若控制对 L0 不适用，先把可执行 predicate 和 route-policy/endpoint metadata evidence 落到 classifier/catalog；不能先写 `NotApplicableEvidenceId` 再靠说明兜底。
3. 更新 `ApplicationPipelineStages` 与/或 `EndpointPipelineStages`，为新 stage 显式选择 classification；security/cross-cutting stage 还必须填写与 catalog 相同的 control id。启动校验必须继续在注册任何 stage 前执行。
4. 更新请求级测试：匿名 fast hit、登录 credential bypass、admin/author、notification stream、dynamic binary、Origin/unsafe method、真实 miss fallback。输出相关改动还要与 production mapped canonical endpoint 比较 raw bytes。
5. 更新 visibility 测试：only-Published admission 必须逐项拒绝 `Draft`、`Scheduled`、`Archived`、`Deleted`、`IsDeleted=true`、future `PublishedAt` 和 future `ScheduledPublishAt`。
6. 运行：

   ```bash
   node tools/check-public-hot-read-cross-cutting-controls.mjs --self-test
   bash tools/check-public-hot-read-fastpath.sh
   dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter FullyQualifiedName~PublicHotReadCrossCuttingControlTests
   ```

## Fail-closed 与回退

- catalog、stage、guard、route policy、metadata 或 executable probe 漂移时，应用启动失败；保留当前 active release，不得删除校验或临时把控制标为不适用。
- 运行中出现 classifier/bypass 异常、byte parity 失败、visibility evidence invalid 或未知 route 时，在 reload-capable 配置源设置 `PublicHotRead:Enabled=false`。下一请求停止附加 early feature，所有请求回常规 routing/CORS/authentication/banned-user/authorization/audit 链，无需重启。
- 该回退不关闭 public artifact revocation、release/security headers、Shield、PoW/RiskControl、常规 rate limit 或 notification stream。active tombstone 仍先返回 410。
- 回退后检查 `/api/ops/health/ready-detail` 的 `runtime.publicHotRead`、credential/sensitive bypass counters 和 canonical endpoint 状态。修复后先运行上述 checker/tests，确认 snapshot evidence 为 `visibilityPolicy=published-visible-at-cutoff-v1`、`sourceVisibility=public`、source version 与 candidate 一致，再热更新 `PublicHotRead:Enabled=true`。

## 不能声明的保证

本控制 catalog 证明进程内两条 HTTP 管线的结构与请求行为，不替代 CDN purge receipt、跨节点 snapshot convergence、Redis Pub/Sub subscriber ACK 或外部发布验证。

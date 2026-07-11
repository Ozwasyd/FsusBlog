# Issue #1031：零停机发布端到端演练编排交接

> 状态：代码与中央编排接线已落地、待统一验证；尚未运行任何测试、构建、lint、语法检查、profile 或治理检查，本文不得作为“已验收”证据。

## 唯一演练入口

`tools/deployment/zero-downtime-rehearsal.sh --plan <private-local-plan> --mode <mode>` 是本机 Test 拓扑的演练入口。计划模板位于 `tests/fixtures/deployment/zero-downtime-rehearsal-plan.template.json`，计划解析、路径约束、持久状态判断和证据封存由 `tools/deployment/zero-downtime-rehearsal-plan.mjs` 提供。

支持的模式：

- `normal`：独立 destructive worker qualification 完全 teardown 后，以 fresh Blue -> Green 正常发布作为控制组。
- `explicit-rollback`：fresh Blue -> Green 成功后，使用独立 manifest 执行真实 `--rollback` Green -> Blue。
- `post-switch-rollback`：执行完整 13 项 fault matrix，强制校验 `active-fence-failure` 与 `public-probe-failure` 的自动回滚状态，同时保留 fresh 正常发布控制组。
- `sigkill-resume`：先完成独立、无中断的 fresh control，再分别在 `source-drain`、`source-stop`、`release-evidence` 三个晚期点用独立 session/process group 对发布进程发出真实 `SIGKILL`；每点使用独立 topology/state/rolloutId，读取持久 state、显式标记孤儿 running stage，再以原 rollout identity 执行 `--resume`。
- `all`：顺序执行全部模式；单个模式失败不会阻止后续模式收集问题，最终统一聚合为非零退出。

每次必须使用全新的 `run-id`；已有目录会被拒绝，禁止复用历史 state、ledger 或 pass 结果。每种模式分别隔离 topology runtime、slot state、rollout state、asset store、secrets copy、command logs 和 evidence。

## Worker 双证据链

worker 证据不得把强杀演练混入正常发布：

1. qualification 子运行调用 `release-worker-drill.mjs`，使用 `file-handshake` 的 `armed -> terminate-source -> source-terminated` 协议；只允许 `process-signal/SIGKILL` 的受限 source worker，禁止在成功控制组中杀 source application container。
2. qualification 产出真实 9-kind ledger、target-health 与 qualification control 后立即 teardown，不得被当作正常 ledger。
3. fresh normal 发布并发启动独立的 `release-worker-normal-observer.mjs` loopback producer。producer 调真实 observer/action endpoint，先驱动并观察 8-kind durable pending，等 `source-drain-gate.json` 通过后再观察 target exactly-once/stale-generation/audit/projection 结果，输出 `mode=normal` ledger；不接受静态 JSON 或 qualification ledger。
4. `release-rollout.sh` 在 source-drain 后调用：

   ```text
   release-worker-reconciliation.mjs --mode normal \
     --rollout-state <fresh-state> --ledger <normal-ledger> \
     --source-drain <source-drain-gate> --target-health <target-health> \
     --out <normal-worker-evidence>
   ```

5. fresh normal 完成后，再调用 qualification v2 verifier，并传 `--normal-rollout-state <fresh-state>`。最终 qualification evidence hash-bind qualification control、9-kind ledger、resource policy、v2 reconciliation 和 distinct fresh normal state；两条 state 的 rolloutId 必须不同，target release/digest 必须相同。

正常 observer 计划使用 `fsusblog.release-worker-normal-observer-plan.v1`：只允许显式 loopback HTTP origin、三个互不相同的安全路径和精确 8-kind 顺序。admin header 仅通过 0400/0600 regular non-symlink 文件以 `Authorization: Bearer ...` 或 `Cookie: ...` 传递；响应必须显式声明 `destructive:false`，绑定 runId、rolloutId、source/target release/digest/slot/generation，并为 armed/final 事件携带完整 observation bindings。缺字段、超时、状态漂移、早于 drain 的 final observation 或 drain 失败均非零退出。

## 发布、探针与故障矩阵接线

编排直接调用仓库真实入口：

- `zero-downtime-topology.sh`
- `release-rollout.sh`
- `zero-downtime-fault-matrix.mjs`
- `release-asset-compatibility-probe.mjs`（由 rollout 生命周期启动）
- `release-notification-probe.mjs`（由 rollout 生命周期启动）
- `release-resource-probe.mjs`（由 rollout 生命周期启动）
- `release-worker-normal-observer.mjs`（fresh normal 与 fault case 的真实 8-kind observer producer）
- `release-worker-drill.mjs` 与 `release-worker-reconciliation.mjs`

fresh normal 每 phase 暴露/传递：

- `--worker-ledger <evidence/worker-normal-ledger.json>`
- `FSUSBLOG_ROLLOUT_WORKER_EVENT_LEDGER`
- `FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER`
- `FSUSBLOG_ROLLOUT_NORMAL_WORKER_TARGET_HEALTH`
- `FSUSBLOG_ROLLOUT_NORMAL_WORKER_RECONCILIATION`
- `FSUSBLOG_ROLLOUT_NOTIFICATION_RESYNC_SCENARIO`（`fsusblog.release-notification-resync-scenario.v1`，normal 与 resume 均复用同一只读场景绑定）

fault matrix 的每个 case 必须拥有独立 topology/state/evidence，并由编排器生成 setup/rollout/teardown，不得依赖人工预置通过材料。无论 case 中途如何失败，teardown 都必须执行；13 项结果全部聚合，任何未执行 case 都不能成为 pass。

## 密钥、路径与回退边界

- 仅允许 `ASPNETCORE_ENVIRONMENT=Test`、loopback public/control/observer URL、隔离的 `global-postgres`/`global-redis` alias 和 `fsusblog-zdt-*` volume。
- Postgres、Redis、OpenResty 镜像必须是 repository `@sha256` immutable digest。
- env、admin header、Playwright auth storage state、traffic HMAC key 与 asset-browser HMAC key 必须为 0400/0600 regular non-symlink file；两个 HMAC key 还必须各自为 32..4096 bytes，彼此及 admin/session secret 分离，命令行和证据不记录 secret value。
- work root 必须位于仓库 `.tmp` 的专用子目录；既有 run 目录、路径逃逸、symlink traversal、未解析模板 token 均 fail closed。
- 正常失败时保留 active source；post-switch gate 失败通过持久 recovery 自动回滚；host SIGKILL 只作用于独立发布 process group，随后根据 durable state 恢复，不猜测已完成阶段。
- `source-drain` 尚未封存 worker 证据时允许重新启动 observer；若 worker/traffic/notification/resource final artifacts 已完成绑定（包括 `source-stop` 与 `release-evidence` 中断），resume 必须复用这些 artifacts，禁止重启对应 probes。三个中断点最终封存为同一 matrix，rolloutId 不得复用。
- 所有 topology 最终执行 `down`；若 teardown 自身失败，会写入总错误并保持非零退出，不能被模式 pass 覆盖。

## Plan 强证据字段与 migration qualification

private operator plan 必须显式提供：

```text
evidenceInputs.trafficBindingKey
evidenceInputs.assetBrowserBindingKey
target.migrationServerDll
migrationQualification.scenarioTemplate
migrationQualification.timeoutSeconds
migrationQualification.expandMigrationId
migrationQualification.backfillMigrationId
migrationQualification.contractMigrationId
```

plan resolver 对两个 key 做 private-file、mode、symlink、32..4096-byte 检查；每个 case
复制到自己隔离的 `runtime/secrets`，并分别传给 rollout 的
`--traffic-binding-key-file` 与 `--asset-browser-binding-key-file`。traffic final report
与 controlled-browser asset evidence 使用独立 HMAC canonical binding，resume 只有在持
同一 key 的 verifier 读回通过时才可复用 artifact。

migration qualification 使用固定十场景：旧 Active + Expand、双槽并发读写、Backfill
pause/checkpoint/resume、missing Expand 503、回滚窗口拒绝 Contract、Contract 后不可回滚
marker、advisory-lock timeout、数据库断连、partial failure/resume、history checksum +
unknown record。`REPLACE_QUALIFICATION_ADAPTER` 已绑定仓库脚本
`rehearsal-schema-qualification-probe.mjs`；Blue/Green 写桥与 readiness 使用应用真实
Test-only routes。routes 仅在环境精确为 `Test` 且
`SchemaMigration:QualificationEnabled=true` 时映射，并继续要求 admin
`system.config` + `fixed_ip`；生产永不映射。

迁移资格失败时不切流、保留 source Active 并 teardown candidate topology；Expand/
Backfill 可暂停 durable checkpoint 后继续兼容服务，无需重启 active source。Contract
仍在回滚窗口时必须被拒绝；一旦成功并写出 `rollbackCompatible=false`，不得把旧 image
回切描述为安全回退，只能隔离写路径并走 verified backup/forward repair。

## 中央治理 readback

以下 owner 已登记到中央治理：

- 测试：`tests/tools/zero-downtime-rehearsal.test.mjs`
- normal observer 直接测试：`tests/tools/release-worker-normal-observer.test.mjs`
- 计划模板：`tests/fixtures/deployment/zero-downtime-rehearsal-plan.template.json`
- normal observer 计划模板：`tests/fixtures/deployment/release-worker-normal-observer-plan.template.json`
- notification resync 计划模板：`tests/fixtures/deployment/release-notification-resync-scenario.template.json`
- coverage ID：`zero-downtime-release-rehearsal`
- 归属：tools/deployment、release/runtime、fault injection、worker qualification、host interruption recovery

`zero-downtime-release-rehearsal` coverage、matrix、backend requirements 与 static
governance 当前均包含上述测试、计划、observer、migration、notification、asset、traffic
与 resume/fault owners；没有遗留的中央登记动作。

记录型测试夹具会真实启动临时脚本子进程，但不会调用真实 Docker/网络：它验证 topology/rollout/probe 命令顺序、显式 `--rollback`、三个晚期点的真实 process-group `SIGKILL`、durable orphan adoption、`--resume`、final artifact 复用、normal/qualification hash binding、13-case 自动回滚语义和跨模式失败聚合。

## 待统一验证

本文件落地时未执行任何验证。进入统一验证阶段后至少需要：

1. Node 记录型单元/子进程测试；
2. shell 语法与静态治理；
3. normal、explicit rollback、post-switch rollback、SIGKILL/resume 四种真实本机演练；
4. 最终 summary、rollout evidence、normal worker v2、qualification v2、fault matrix、asset/notification/resource/traffic 六类 artifact 的 hash/readback；
5. 匿名、登录、admin、notification stream、binary 全场景无 5xx/连接丢失/重复副作用；
6. 所有临时 runtime/evidence 保留在 `.tmp`，不得提交动态结果。

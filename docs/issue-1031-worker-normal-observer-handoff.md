# Issue #1031：正常 worker observer producer 交接

> 状态：代码已落地但未运行测试、构建、lint、语法检查或治理检查；本文件不是验收通过证明。

## 作用与边界

`tools/deployment/release-worker-normal-observer.mjs` 是 fresh 正常 Blue -> Green 发布的 8-kind worker 账本 producer。它不生成静态通过材料，也不复用 destructive qualification 的 9-kind ledger；它通过 loopback observer 的真实 `start/status/finalize` 响应，在 `source-drain` 前后分别绑定 durable pending 与 target exactly-once 观测，最终独占写出 `fsusblog.release-worker-event-ledger.v1`、`mode=normal` 的 ledger。

producer 不是 observer 服务本身。仓库提供的
`tools/deployment/release-worker-observer-service.mjs` 是唯一由彩排入口启动的
loopback service owner：它从真实 PostgreSQL attempt view、Redis active fence、
容器 identity label 与受保护的 admin runtime endpoint 派生结果。部署侧必须通过
`workers.<phase>.observerServicePlan` 和私密 `workers.observerEnvFile` 提供隔离 Test
拓扑的真实连接信息；fixture server 或预制 JSON 只能用于直接单元测试，不能作为
本机演练证据。

service 只在 `ASPNETCORE_ENVIRONMENT=Test`、`FSUSBLOG_ROLLOUT_REHEARSAL=1` 与
`FSUSBLOG_WORKER_OBSERVER_ENABLED=1` 同时成立时启动，且只监听 loopback。env 与 admin
header 必须是 0400/0600 regular non-symlink file，运行状态目录为 0700、journal 为
0600；缺少行、重复 attempt、陈旧 generation 或外部状态不可读均 fail closed。

## CLI

```text
node tools/deployment/release-worker-normal-observer.mjs \
  --plan <fsusblog.release-worker-normal-observer-plan.v1> \
  --rollout-state <release-rollout-state.json> \
  --source-drain <source-drain-gate.json> \
  --admin-header-file <0400-or-0600-file> \
  --out <normal-worker-ledger.json> \
  --run-id <unique-run-id> \
  --start-stage <candidate-start..public-verify> \
  --timeout-ms <10000..900000>
```

计划模板是 `tests/fixtures/deployment/release-worker-normal-observer-plan.template.json`。`baseUrl` 只接受精确 loopback HTTP(S) origin；`startPath`、`statusPath`、`finalizePath` 必须是互不相同的安全 origin-relative path；`requiredKinds` 必须严格按以下顺序且不得出现 `forced-source-recovery`：

1. `scheduled-publish`
2. `article-mutation-outbox`
3. `audit-writer`
4. `visit-view-projection`
5. `public-hot-aot`
6. `upload-cleanup`
7. `active-singleton-control`
8. `multi-consumer-safe-control`

admin header 文件只允许一行 `Authorization: Bearer ...` 或 `Cookie: ...`，并且必须是 0400/0600 的 regular non-symlink 文件。secret 不写入命令输出或 ledger。

## Observer 协议

`startPath` 接收 POST `fsusblog.release-worker-normal-observer-command.v1`，包含唯一 `runId`、`rolloutId`、完整 source/target releaseId/imageDigest/slot/generation、`destructive=false`、精确 `requiredKinds` 与 `action=start-normal-worker-observation`。它应驱动或选择真实正常业务事件，并返回 `accepted` 或 `armed`。

`statusPath` 接收 GET query `runId` 与 `rolloutId`，用于轮询 `accepted -> armed -> running -> pass/fail`。`finalizePath` 在 source drain gate 已通过后接收 POST，包含同一 identity、`destructive=false`、`action=finalize-after-graceful-drain` 与 drain artifact 的 path/bytes/sha256。

每个响应必须是 `fsusblog.release-worker-normal-observer.v1`，显式带 `destructive=false`、完整且一致的 source/target identity、合法 UTC `observedAtUtc`、无错误以及相应的 8 个有序事件。任何 HTTP、schema、identity、顺序、时间、drain、observer fail 或超时错误都会保留到失败输出；没有最大错误数截断。

armed 事件必须证明：

- 唯一 `logicalEventId`；
- `pendingCountAtDrain >= 1`；
- durable replay 来源是 `postgres-outbox`、`postgres-row-lock`、`redis-stream` 或 `durable-upload-session`；
- source release/generation 与 rollout state 一致；
- 每个字段有 `{probe,pointer,observedAtUtc,valueSha256}` 绑定。

final 事件必须证明：

- 同一个 `logicalEventId`，正数 `attemptCount`，唯一 `finalEffectKey`，`finalEffectCount=1`；
- final release/generation 精确等于 target，`staleGenerationCommitCount=0`；
- `audit-writer` 的 expected/actual audit count 相等；
- `visit-view-projection` 的 expected/actual projection count 相等；
- 观测来自 `postgres`、`redis` 或 `runtime-control`，所有 final binding 时间不早于 drain 完成时间，字段哈希一致；
- 不存在 `forcedSourceTermination`、`recoveredByTarget` 或第 9 个 destructive kind。

## 当前彩排接线

`zero-downtime-rehearsal.sh` 已在 fresh normal rollout 启动时，以独立进程组并发
启动此 CLI；producer 等待配置的起始 stage，不会等到 `source-drain` 后才启动。
rollout 产出通过的 source drain gate 后，producer finalize 并独占写 ledger；彩排
等待 producer 退出，再把该 ledger 传给
`release-worker-reconciliation.mjs --mode normal`。qualification 先完全 teardown，
fresh normal 使用不同 rolloutId，且两者 target release/digest 必须一致。

彩排会先按 phase 的 service plan 以独立进程组启动仓库 observer service，再启动
normal producer；qualification、SIGKILL/resume 与 fault injection 也使用相同的显式
start/stop 生命周期，任何成功或失败路径都会终止对应进程组。service plan 的 listen
origin 必须与 normal plan 的 `baseUrl` 完全一致，并被 drill plan 的
`allowedHttpOrigins` 明确允许。真实观测仍必须来自 PostgreSQL、Redis、容器和 runtime
control；停止前还会把 pid 重新绑定到仓库 service script 与本次 0700 state directory，
避免 PID 重用误杀无关进程。统一验证前不得把 404、静态 pass JSON 或缺失 observer
改写为成功。

## 文件与治理登记

- producer：`tools/deployment/release-worker-normal-observer.mjs`
- 直接测试：`tests/tools/release-worker-normal-observer.test.mjs`
- 计划模板：`tests/fixtures/deployment/release-worker-normal-observer-plan.template.json`
- observer service：`tools/deployment/release-worker-observer-service.mjs`
- service 直接测试：`tests/tools/release-worker-observer-service.test.mjs`
- service 计划模板：`tests/fixtures/deployment/release-worker-observer-service-plan.template.json`
- 本交接：`docs/issue-1031-worker-normal-observer-handoff.md`

当前中央 readback 已确认 normal observer producer/service、直接测试与计划模板登记在
`zero-downtime-release-rehearsal` coverage、相关 matrix/requirements owners 和 static
governance 中；没有遗留的中央测试登记动作。本文件落地时未执行任何验证，真实 Test
拓扑的私密 env 与 phase-specific service plan 仍必须由演练调用方提供。

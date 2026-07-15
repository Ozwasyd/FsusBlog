# #1080 Resident Resource Lease 与跨 Bundle Handoff

## 问题与边界

`runtime-browser` 的 bootstrap shell 会结束，但它启动的 backend、debug frontend、release preview、PostgreSQL 和 Redis 会继续服务后续 browser/integration/performance step。过去 scheduler 只统计 active bundle/step，bootstrap settle 后会把这些服务已经占用的 CPU、RSS 和 cgroup/OCI 容量再次授予普通 work。

本变更只修正本地 Production 的资源所有权与证据，不减少 runtime/browser/performance test ID，不关闭权威服务，也不把 OOM 或 cgroup throttling 当作正常调度策略。#1071 仍负责利用率证据，#1072 仍负责 OS hard limit；本账本把两者与 scheduler reservation 绑定起来。

## Inventory 与身份

`tools/bootstrap-acceptance-env.sh` 在五类服务全部 ready 后调用 `resident-resource-leases-cli.mjs publish`，原子写入：

```text
.tmp/test-runs/<run-id>/resident-resource-leases.json
```

每项包含稳定 service ID、port、namespace、owner bundle、generation、readiness 时间、初始 RSS，以及以下不可复用身份之一：

- process：PID + `/proc/<pid>/stat` start time；
- container：完整 container ID + Docker Created time。

v2 inventory 绑定 run ID、namespace、owner、producer 实际 `resourceGrant`、generation 与 canonical SHA-256 digest。production scheduler 还要求 service roster 必须精确等于上述五类服务；旧 v1 inventory fail closed，不在 resume 时继承缺少 grant 绑定的 reservation。修改字段、删减服务、复制到其他 run/namespace、PID 复用或 container recreation 都不能静默通过。PID start time 必须是 `/proc` 数字 tick，container identity 必须是完整 64 位 OCI ID 和可解析 created timestamp。

## 动态 reservation 与 admission

reservation 从当前 live step grant、服务数量与 readiness 后实测 RSS 派生，不保存某台机器的 CPU/GiB 常量：

- CPU 为 resident steady-state slice，同时保留至少一个可执行 CPU unit（小于两个 CPU unit 时保留 grant 的一半）；
- memory 按各服务 RSS 权重分配，使用服务数量派生 safety factor，并为 downstream 保留服务数量派生的 envelope slice；
- 每个 live service 的 CPU 和 memory reservation 都严格大于零。

validator 会按 inventory 保存的原始 grant 与实测 RSS 重新计算每项 reservation，并由 scheduler 对照 producer 当时的实际 grant。即使调用者重新计算 digest，也不能通过伪造较小 grant/reservation 来释放并不存在的容量。

scheduler 的 peak、admission、dynamic expansion、wait reason 和 `resource-grants.json` 使用：

```text
active executable usage + retained resident reservation
```

而不是只统计 active executable。runtime cgroup scope 在 bootstrap settle 后同步收缩到 resident reservation；后续 bundle 只得到剩余 grant。grant 收缩先停止新 child admission，不通过杀死 runtime 伪造释放。

## Handoff、restart 与回收

producer 成功且五类身份仍 live 时写入：

```text
.tmp/test-runs/<run-id>/resident-resource-handoff.json
```

receipt 绑定 run ID、namespace、inventory generation/digest、全部 service readiness，以及 from/to owner。`performance-evidence` 在执行性能 step 前通过跨进程 exclusive lock 原子消费 receipt；两个并发 consumer 只能有一个成功，消费后的 receipt 再次消费会失败，dead consumer 遗留的过期 lock 可由后续尝试回收。

scheduler 周期性和每次 settle/admission 边界重新观察 RSS、CPU ticks 与身份：

- `live`：继续保留 reservation；
- `exited`：仅该服务容量返回 pending admission；
- `identity-changed` / `unknown`：fail closed 保留 reservation，不把未知进程当作释放；
- bootstrap 原子发布新 digest/generation：先重新核验 owner、原始 grant、service roster、process cgroup 与全部 OCI hard-limit evidence，再刷新 scheduler enforcer 的 process reservation，最后记录 restart 并替换旧 generation；已经消费的旧 generation handoff 仍作为唯一 ownership transfer 证据保留，不产生第二次 grant。

最终 `cleanupLocalRuntime` 先终止 run-bound process/container，再重新核验 inventory。只有所有身份确认 `exited` 才把 checkpoint 标记为 `released` 并删除 pid/env/runtime/fixture/data handle；仍可见或不可确认时写 `cleanup-pending-live-services` 和剩余 reservation，并保留这些 handle，让 stale cleanup 能按同一 namespace 重试，禁止提前释放或形成不可恢复的 ownerless service。

## 证据与故障路径

`checkpoint.json.residentResourceLeases` 可还原：

- inventory/handoff 路径、owner、producer resource grant、generation、digest；
- 每服务 reservation、RSS/CPU ticks history、restart count、release time；
- acquire、generation replace、handoff publish/consume、partial、cleanup/release event；
- 当前 retained CPU/memory 与 cleanup result。

producer failure/cancel 若已产生合法 inventory，会保留 `partial` lease 并继续扣除 live reservation，但不会发布 handoff。inventory 缺失、损坏、foreign/stale identity 或 handoff 错配会使 producer/consumer fail closed。回退不要求重启：停止当前 fresh run并执行同 namespace cleanup；下一次 fresh run使用新 run ID、namespace、inventory 和 handoff，不复用旧账本。

## 聚焦验证

```bash
node --test tests/tools/resident-resource-leases.test.mjs
node --test --test-name-pattern='resident leases stay|failed resident producer' tests/tools/test-matrix-scheduler.test.mjs
node --test tests/tools/local-runtime-cleanup.test.mjs
node --check tools/test-matrix/resident-resource-leases.mjs
node --check tools/test-matrix/resident-resource-leases-cli.mjs
node --check tools/test/bundles/run-bundle.mjs
node --check tools/test-matrix/scheduler.mjs
bash -n tools/bootstrap-acceptance-env.sh
```

最终关闭还要求相同 SHA、相同机器至少三次 fresh before/after，报告 overcommit gap、peak RSS、OOM/throttle、CPU efficiency 与 wall-clock；聚焦单测不能替代该运行证据。

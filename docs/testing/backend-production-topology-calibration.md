# Backend Production topology calibration

`tools/test/run-backend-production-shards.mjs` 将并发 testhost、每个 testhost 的 processor 配额和 rolling partition 数视为三个独立维度。默认规划器使用实时 admitted CPU/内存、discovered class/affinity planning unit、cold application/testhost startup penalty、class startup penalty、Docker/PostgreSQL weighted dependency、独立 governance postlude 和最多 12 个 testhost 的硬上限。CPU allocation 必须精确等于本轮 grant，内存按 testhost 均分且每个 testhost 至少 1 GiB；affinity class 仍是不可拆 planning unit，governance postlude 始终最后独立执行。

## 可重复诊断

完整 sweep：

```bash
node tools/test/calibrate-backend-production-topology.mjs --fresh
```

先运行一个候选，适合确认环境和成本：

```bash
node tools/test/calibrate-backend-production-topology.mjs \
  --fresh \
  --candidate h4-p2-uniform \
  --repeat 3 \
  --max-candidates 1
```

候选 id 使用 `h<testhost>-p<partitionMultiplier>-<uniform|weighted>`。默认矩阵为 testhost `2/4/6/8/12`、partition multiplier `1.5/2/3`、processor allocation `uniform/weighted`，再由本机 CPU、实时 free memory、每 host 1 GiB 下限和 planning unit 数裁剪。每个候选至少执行三次 Fresh；`--repeat 1/2` 会在启动前拒绝。显式 `--cpu-budget` 不得超过进程可见 CPU，`--memory-gib` 不得超过宿主总内存；这些参数只允许收窄诊断矩阵，不能扩张真实机器容量或让 scheduler 越权授予资源。

每个 sample 都执行完整 `./tools/test.sh production --fresh`。runner 在下一 sample 前删除该 sample 的 production checkpoint、backend TRX/coverage 与 release evidence；校准输出不得成为 logical tier projection、coverage threshold 或 release evidence 的输入。选出候选后必须另跑一次普通 fresh production，才能产生可交付 evidence。

## Evidence contract

默认报告为 `.tmp/diagnostics/backend-topology-calibration.json`，schema 是 `fsusblog.backend-topology-calibration.v1`。报告绑定完整 source commit、完整 SHA-256 clean-worktree fingerprint、平台/架构和机器 CPU/内存；执行期间 source identity 变化会 fail closed。每个候选保存至少三次 sample、wall-clock median/p25/p75/mean/variance/standard deviation、discovery summary、实际 topology、逐 partition duration、最慢 partition、exact-once 状态，以及 GNU `time -v` 可获得的 child-tree user/system CPU、peak RSS、context switch 与 filesystem I/O。

Linux 优先使用 `/usr/bin/time -v`。testhost process start 由 runner 记录，first-test-start 与 test execution span 来自对应 TRX 的 `startTime` / `endTime`；无法解析时必须写成 `status=unavailable` / `null`，不能伪造为 `0`。当前 PostgreSQL wait 明确标记 unavailable，后续 canonical resource-utilization evidence 才负责进程树采样和等待分类。报告只在所有 sample 成功时为 `success`，但失败候选仍保留全部已收集 sample，便于一次暴露多项失败。

## Override 与回退

- `FSUSBLOG_BACKEND_PRODUCTION_SHARDS`：诊断 testhost 数；必须满足 CPU、内存、planning unit 与 12-host 上限。
- `FSUSBLOG_BACKEND_PARTITION_MULTIPLIER`：rolling partition 倍数，必须至少为 `1`。
- `FSUSBLOG_BACKEND_PROCESSOR_ALLOCATION_MODE`：`uniform` 或 `weighted`；两者都必须精确守恒 CPU grant。
- `FSUSBLOG_BACKEND_SHARD_PROCESSORS`：legacy uniform exact override；总和不等于 CPU grant 时拒绝执行。

这些变量都不是 production 常量。清除变量即可在不改代码、不复用测试结果的情况下回退到 machine/workload automatic planner。动态 grant 只允许新增不超过最新剩余 CPU/内存的 testhost；若 grant 收缩到 active slot allocation 以下，runner 失败而不是让子进程继续越权。

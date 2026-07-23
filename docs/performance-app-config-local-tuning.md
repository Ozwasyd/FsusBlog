# 应用配置局部敏感度与安全步进

本页是应用级性能配置实验的操作说明。唯一 machine-readable authority 是
[`config/performance/app-config-knob-catalog.v1.json`](../config/performance/app-config-knob-catalog.v1.json)。
该 catalog 只描述实验可行域，不覆盖 `appsettings.Production.json`，runner 也不写入任何运行中实例。

## 范围与边界

第一阶段覆盖：

- `PublicAot` 的 SSR worker、backfill concurrency/queue，以及 timeout、circuit、route quarantine 的两个 interaction group；
- `PublicHotRead` 的 article admission、compression savings 和 resident variant client-share interaction group；
- notification stream 仅有 `SyntheticNotification:*` fixture。`#1451` 的 delivery、loss、ordering 与 lane policy
  未成为明确合同前，catalog 会拒绝任何 real evidence notification candidate。

CLR、libc、R2R、PGO、GC、ThreadPool 与容器发布 profile 仍属于 `#1064`。PublicHotRead resident
bytes、snapshot overlap 与 artifact count 仍以现有硬预算为准，调参器无权放宽。性能容量结论继续消费
performance saturation authority；synthetic surface 只能验证算法与约束，不能成为生产吞吐声明。

catalog 中每个 knob 必须有 stable ID、真实配置 key、owner、correctness/security owner、类型、range/step、
lifecycle、baseline、rollback、最大归一化步长、observables、guardrails 和 interaction group。未知 key、缺 owner、
缺 guardrail、非法 lifecycle/range/step、缺配置、派生约束冲突均 fail closed。当前运行时对这些 PublicAot 和
PublicHotRead 构建参数在服务构造/快照构建边界读取，因此 catalog 保守标记为 `restart-required`，不会把
`IOptions` 注册误当作安全热更新。

## 本地实验

固定 synthetic fixture 可复现两组 baseline/candidate：

```bash
node tools/perf/run-app-config-local-experiment.mjs \
  --fixture tests/performance/fixtures/app-config-local-surfaces.v1.json \
  --out .tmp/perf/app-config-local-evidence.json
```

单独选择 interaction group：

```bash
node tools/perf/run-app-config-local-experiment.mjs \
  --group public-hotread-residency \
  --out .tmp/perf/public-hotread-local-evidence.json
```

设计绑定 source commit/worktree、build artifact、fixture、toolchain、security policy 和 container budget digest。
每个 repeat 使用确定性的平衡顺序；每轮必须记录 cleanup/cooldown，不能复用上一轮动态 outcome。失败候选
保留在 raw measurements，不会从模型证据中静默删除。中心、单轴正负点和 pairwise 四角点比三档完整笛卡尔
网格使用更少 physical samples，且 runner 只执行被选中的 interaction group。

真实本地 Kestrel/TestServer 或现有 open-loop runner 接入时必须保留同一 design 和 evidence schema，并满足：

1. 同 source、同 build artifact、同 fixture/数据规模、安全策略、容器预算与 toolchain；
2. 至少两次 repeat，记录 p50/p95/p99/p99.9、safe throughput/saturation knee、错误/timeout/cancellation、
   CPU/RSS/heap/LOH/GC、queue depth/bytes/oldest age、cache stale/fallback/rebuild、AOT backfill/drop/quarantine/
   publish latency，以及适用的 Redis/PostgreSQL wait；
3. 每轮 cleanup/cooldown，失败也写入 evidence；
4. correctness/security 失败直接拒绝，不进入 profile adoption。

## 模型与 trust region

catalog/constraint 校验位于 `app-config-catalog.mjs`，局部设计位于 `app-config-local-tuner.mjs`，
模型拟合与 proposal/rollback 位于 `app-config-local-model.mjs`，避免把 authority、实验编排和数值/决策
责任堆进单一模块。局部模型使用归一化 knob 的
一阶项、平方项和主要 pairwise interaction。输出包含 Jacobian、pairwise coefficient、
曲率、残差、repeat coefficient of variation、direction conflict 和 capacity cliff 标记。它不追求全局最优，
也不会把一次 timing 波动解释为梯度。

- 样本不足、矩阵退化、repeat variance 或 residual 超阈值时结论为 `insufficient-evidence`，不输出候选 profile。
- 候选逐 knob 和 group 同时受最大归一化步长限制，并在生成后重新通过 range、step、hard constraint 校验。
- 预测 guardrail 越界时不执行候选，半径缩小。
- 实测方向与预测一致、repeatable benefit 且 correctness/security/resource guardrails 全部通过时，才标记
  `accepted` 并小幅扩大半径。
- 预测失真、实测 guardrail 或 correctness/security 失败时标记 `rejected`，半径缩小并输出 rollback profile。

高条件数的代理信号包括退化设计、相对残差、曲率显著大于一阶方向、相邻候选失败和方向冲突。出现这些信号
应缩小局部区域或回到具体子系统诊断，不得用更大队列或更宽阈值掩盖 blocking、ordering、cache consistency
或安全缺陷。

## Evidence 与 profile adoption

每份 evidence 保存完整 config/config digest、catalog/design digest、原始 measurement、模型与残差、
predicted-vs-actual delta、guardrail、trust-region 变化原因、结论、named profile 和 rollback profile。
仓库 fixture evidence 位于
[`tests/performance/app-config-local-evidence.v1.json`](../tests/performance/app-config-local-evidence.v1.json)，
它明确标记为 `synthetic`，只证明算法能够恢复方向/交互、识别 cliff 并遵守可行域。

`accepted` 只表示“可提交建议”，不表示配置已采用。成为默认值仍需：

1. 显式提交 profile/config 变更并正常 code review；
2. 运行现有 correctness、security、performance saturation 和 release gates；
3. 对实际部署 lifecycle 执行受控重启，不能由 runner 自修改生产；
4. 保留 catalog rollback value 与完整 rollback profile。

回退不依赖调参服务：不要提交候选，或显式恢复 rollback profile。若实验运行中触发 guardrail，停止该
candidate、清理本地 runtime/fixture，并缩小 radius；线上实例从未被 runner 写入，因此不需要撤销自动变更。

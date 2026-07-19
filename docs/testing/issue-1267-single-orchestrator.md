# #1267 单一测试编排器

## 权威边界

- `tests/matrix.yml` 是唯一 lane、依赖、资源和 cadence 清单。
- `tools/test.sh` 是唯一公开 shell 入口，所有公开 tier 都交给 `tools/run-test-matrix.mjs`。
- `tools/test/lanes/*.sh` 只实现 matrix 已声明的叶节点；`_suite-support.sh` 和 `_lane-collect-support.sh` 只能被 source，不提供 tier CLI，也不拥有跨 lane DAG。
- production bundle 是 matrix 的物理投影。security 与 cross-stack 的 static/runtime step 复用相同叶节点，不能调用嵌套 matrix runner。

## 已移除兼容面

旧总 shell runner、旧 collect helper、frontend full-regression wrapper，以及 frontend package 中的 deprecated acceptance/full-regression aliases 均已删除。调用者应使用 `./tools/test.sh <tier>`；只验证一个叶节点时使用 `./tools/test.sh ci-tier <tier> --no-deps`。

性能策略、饱和度 schema 与 backend hot-path budgets 统一位于 `tests/performance/`。治理拒绝重新创建旧短名双根。

## 浏览器测试语义

`browser-contract` 只证明 release correctness 所需的最小浏览器边界，并产生 contract receipt。`browser-diagnostics` 保存视觉、UX、跨浏览器、几何/动效、a11y、renderer performance 和 resilience 的 scheduled/manual 诊断证据。两类目录、artifact 与结论保持分离，任何一方都不能替代另一方。

## 验证与回退

`validate`、`preflight`、dry-run、scheduler failure aggregation、cancellation、deadline 与 resource admission 测试共同保护唯一 DAG。回退只允许恢复某个叶节点实现；不得恢复旧入口、deprecated alias 或第二份 lane manifest。若叶节点迁移失败，matrix 会在 preflight 或执行时 fail closed，不需要重启服务。

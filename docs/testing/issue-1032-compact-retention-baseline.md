# Issue #1032：紧凑且无源码的删测前基线

`tests/test-retention-before.json` 使用
`fsusblog.test-retention-baseline.v3`。它绑定删测前的 commit 与 worktree fingerprint，
但不提交测试源码、断言文本、测试名称、文件内容、生成时间或逐次动态结果。

## 对照语义

- test ID、assertion target 与 path 先做 SHA-256，再保留 128 bit，并以固定宽度
  base64url 索引保存。每个索引另带完整 SHA-256 set digest；生成时检测截断碰撞。
- `assertionIndex.owners` 只保存整数索引，仍能证明某个已声明删除的 test ID 原先
  拥有哪些 assertion target，而不会泄露断言或源码文本。
- framework、risk tag、tier、coverage、production DAG、requirement 与 release artifact
  继续作为结构化治理维度保留；路径/ID 的历史全集通过索引和 source digest 绑定。
- timing、tier invocation 与 failure history 只保留总数和确定性 digest，不保存
  `generatedAt`、`lastFailureAt` 或单次运行日志。
- backend、frontend、merged coverage 的权威数值仍由
  `tests/test-optimization-coverage-baseline.json` 所有；before baseline 保存该文件在
  source commit 中的 digest、三个 scope 和摘要 digest，避免复制动态结果。
- mutation critical slice 保存 scope IDs 与哈希后的 test ID index。

`tools/test-retention/audit.mjs` 负责生成和验证 v3；
`tools/check-test-retention.mjs` 校验 source commit 中 matrix、coverage registry、backend
requirement catalog 和 optimization baseline 的完整 SHA-256；
`tools/test/optimization-report.mjs` 在比较当前 raw after audit 时把当前 test/assertion ID
按相同算法归一化，因此仍能阻断 undeclared deletion、undeclared assertion loss、catalog
loss、coverage regression 和 mutation-slice drift。

## 风险与回退

- v3 不可反推出原测试名或断言；诊断只报告稳定 hash。需要定位时，应从当前 after
  audit 或 replacement manifest 查找对应声明，不能把 raw before snapshot 重新提交。
- 若发生截断 hash collision，生成器 fail closed；不得扩大 allowlist 或忽略冲突。
- v3 内容带 `contentDigest`，任何手工改写都会使 authority validation 失败。需要重建
  基线时必须先建立新的、明确批准的删测周期，不能覆盖当前 source binding。

## 验证状态

本轮按统一实施指令只落地 schema、checker 兼容和直接测试源码，没有运行测试、构建、
lint、syntax check、治理 checker、coverage、mutation 或 production fresh。统一验证阶段须
生成 source-bound after audit，再由 optimization/convergence authority 给出最终结论。


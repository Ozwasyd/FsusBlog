# Backend Production build authority

Production fresh 的 backend 编译权威是 `backend-tests` physical bundle。它按同一 run、source commit、worktree fingerprint 和 isolated build layout 生成 Release server/test artifact；`backend-tests-ready.json` 绑定 build-layout manifest、test DLL path、artifact ref 和 content digest。backend exact-union 将该 receipt 再投影到 `summary.json.buildBinding`，所有需要 backend 结果的专项矩阵只消费 summary、TRX 或 producer receipt 的 digest。

`tests/governance/backend-production-build-consumers.json` 是 build request/consumer inventory。`tools/test/check-backend-production-build-authority.mjs` 会拒绝以下回归：Production bundle 中的 Debug/filtered compatibility build、额外 backend/test build 请求、独立 governance postlude、丢失 test DLL receipt digest，以及 Rights/Integrity/Privacy/Cross-stack 绕开 canonical projection。

`BackendTestGovernanceTests.Issue40Requirements_HaveEvidenceAndRiskTraceability` 的测试 ID、静态 requirement/risk/evidence 断言和 exact-once 对账保持不变。它现在由普通 coverage shard 执行；失败仍是 backend union 的真实失败，但不会在 union 完成后再次启动 testhost 或数据库 namespace。

## 同机 fresh 校准

`tests/performance/backend-production-build-authority-before-after.json` 保留迁移前后各三轮完整样本。六轮均先删除已知 backend/test/analyzer `bin`、`obj`、Production TRX 与 coverage 输出，再执行 locked restore、Release server build、Release test build 和完整 backend union；两侧在同一台 8 CPU / 16 GiB 主机上串行运行，避免资源竞争污染结果。focused harness 记录 server/test 两个 build request；consumer inventory 中独立声明的 Release benchmark build 不属于该 test-union harness，不能据此误报为缺失或额外请求。

迁移前后三轮均稳定执行 4862 cases / 3705 methods，且 `exactOnce=true`、`allPassed=true`。testhost 从每轮 2 个降为 1 个，execution mode 从 `single-testhost-with-governance-postlude` 变为 `single-testhost-exact-union`。证据同时原样保留 build/union CPU seconds、bin/obj bytes 和 wall time；这些连续数值存在正常抖动和实现体积差异，本 issue 只把执行集合不变与结构性 testhost 去重作为验收不变量，不把单轮或中位数波动重新包装为性能门禁。

`tools/test/measure-backend-production-build-authority.mjs --fresh` 生成原始样本；其 comparison validator 会拒绝少于三轮、机器不一致、执行集合漂移、非 exact-once、断言失败、postlude 回归或 execution mode 不符。仓库保留的是六轮可复核摘要和原始 evidence digest，不提交体积较大的临时日志、TRX 与 coverage 输出。

回退只允许在不改变 Production authority 的前提下收缩并发：使用现有 diagnostic topology overrides 降低 testhost/partition 数。不得通过恢复 Debug compatibility build 或 postlude 绕过失败；若 canonical receipt 或 artifact digest 不一致，应停止 consumer 并重新执行 fresh producer。

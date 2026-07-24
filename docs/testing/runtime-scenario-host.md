# Runtime Scenario Host

Production fresh 的 `integration`、`security` 与 `resilience` 仍保留原有
browserless runtime 场景、身份、故障阶段与 assertion。重复 HTTP/AEDS/Auth
CLI 现在由一个 source/run-bound Node host 执行，共享 Node 模块缓存、全局
`fetch` keep-alive client、AEDS contract、URL/config、fixture helper 与
metrics writer。Playwright 和 browser diagnostics 不进入该 host。

## 权威 catalog

`config/testing/runtime-scenario-catalog.json` 是 runtime scenario 的权威清单。
25 个条目覆盖：

- integration 9 个场景；
- security 9 个场景；
- resilience 7 个场景，其中明确保留 mutation 后的 notification contract、
  notification live、binary smoke 与 binary contract 二次验证。

迁移前清单是 23 个场景；当前 25 个条目没有删除其中任何一个，并新增真实
post-resilience notification live recheck 与 reset pollution 负向 fixture。

每个条目必须独立声明 `id`、`phase`、`identity`、`fixture`、
`requiredPreconditions`、`resetBarrier`、`expectedAssertions`、`coverageIds`
与 `evidencePath`。`resident` 条目还声明可导入 module/export；
`retained-cli` 条目保留一次性或非 Node 边界，例如 SW search、AOT cache、
local exposure 与 ZAP。catalog 的 baseline 同时锁定 scenario 数和负向能力，
不得用删除场景、合并身份或把日志 grep 当结果的方式提速。

## 执行与证据

三个 runtime lane 分别调用：

```bash
node tools/test/run-runtime-scenario-host.mjs --phase integration
node tools/test/run-runtime-scenario-host.mjs --phase security
node tools/test/run-runtime-scenario-host.mjs --phase resilience
```

默认 evidence 位于
`.tmp/runtime-scenario-host/<run-id>/<phase>/`。每个 resident scenario 都写
独立 result，包含 source commit、worktree fingerprint、run ID、identity、
fixture、assertion 集、coverage IDs、status、failure diagnostics 与 timing。
`summary.json` 只在整组成功时生成；failure/cancel 只保留 `partial.json`，
后续成功不得覆盖先前失败。

host 在 identity/fault 阶段边界调用既有
`tools/test/lanes/reset-security-runtime-state.sh`，并生成结构化 reset receipt。
receipt 非 pass、仍有 active identity 或发现 pollution 时对应场景 fail closed。
`tests/tools/fixtures/runtime-scenario-host/polluted-identity.json` 和
`tests/tools/runtime-scenario-host.test.mjs` 证明污染不能被后续成功覆盖。

`SIGINT` / `SIGTERM` 表示用户显式取消：host 停止新 admission，把未执行场景
标为 cancelled，保留 partial evidence，并以非零状态退出。没有基于分钟数、
wall time 或 scenario duration 的 correctness blocked/failure 条件。

## 性能指标与三轮验收

summary 的 `performance` 记录：

- `wallTimeMs`；
- `cpuSeconds`；
- `nodeProcessCount`；
- 由 Node `undici:client:connected` 事件计数的 `connectionSetupCount`。

这些字段只用于同机 before/after 优化评估，始终声明
`affectsCorrectness=false`。最终验收必须在同一 source SHA、同一机器的三轮
Production fresh 中比较 runtime bundle 的这些指标；任一轮的 assertion、
reset、identity 或 host 失败仍按 correctness 失败处理，较快或较慢都不能改变
结论。局部测试不得冒充这三轮最终证据。

六份成功 summary 可由 `tools/test/runtime-scenario-benchmark.mjs` 收口：

```bash
node tools/test/runtime-scenario-benchmark.mjs \
  --before <before-1.json> --before <before-2.json> --before <before-3.json> \
  --after <after-1.json> --after <after-2.json> --after <after-3.json> \
  --output .tmp/runtime-scenario-host/before-after.json
```

比较器拒绝少于三轮、非 success、错 source/run 或跨机器输入；它会报告性能
上升或下降，但不会把性能方向转换成 correctness 结论。

同 SHA 的 before 轮使用保留的 per-CLI 路径并显式开启进程观察：

```bash
FSUSBLOG_RUNTIME_SCENARIO_HOST=0 \
FSUSBLOG_RUNTIME_SCENARIO_COMPARE_VARIANT=before \
./tools/test.sh integration
```

`runtime-scenario-process-observer.mjs` 由 `NODE_OPTIONS=--import` 注入每个真实
Node CLI/npm 进程，记录该进程 CPU seconds 与真实
`undici:client:connected` 次数；lane 随后生成
`<phase>/before-summary.json`。未设置 `FSUSBLOG_RUNTIME_SCENARIO_COMPARE_VARIANT`
时，回退路径不注入观察器。after 轮使用默认 host summary。observer 与
comparator 都只写 diagnostics，不增加 wall-time correctness gate。

## 风险与即时回退

主要风险是原 CLI 被转成 module runner 后，top-level config 或 identity 在同一
Node 进程中意外复用。host 因此为每个 security scenario 派生独立用户名、
admin 用户名与 device fingerprint，在 reset barrier 前拒绝 active identity，
并由 catalog 锁定 phase/fixture。

无需重启 backend/frontend 即可回退：

```bash
FSUSBLOG_RUNTIME_SCENARIO_HOST=0 ./tools/test.sh integration
FSUSBLOG_RUNTIME_SCENARIO_HOST=0 ./tools/test.sh security
FSUSBLOG_RUNTIME_SCENARIO_HOST=0 ./tools/test.sh resilience
```

该开关只让下一次 lane 使用保留的 per-CLI 路径，不修改服务状态、scenario
assertion 或发布物。它是诊断/降级路径，不得把 host 失败改写为成功。

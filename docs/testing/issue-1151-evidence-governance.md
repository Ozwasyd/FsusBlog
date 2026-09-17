# #1151 轻量测试 Evidence 治理

本页定义 #1145–#1150 之后的权威测试证据边界。普通 PR 与 `production-correctness` 均为零浏览器 correctness；`release-final` 只追加一个 Browser Contract；完整浏览器诊断只在 nightly/manual 运行。任何聚合器都不得用 diagnostics、浏览器重试或最后一次 attempt 覆盖这三个边界。

## Evidence 与失败分类

| Evidence class | 执行边界 | 是否改变普通 correctness | 必需结论 |
| --- | --- | ---: | --- |
| `correctness` | unit/component/model/contract/integration、普通 PR、`production-correctness` | 是 | browser launch 为 0，Playwright browser install 为 false |
| `browser-contract` | `release-final` 的单 Chromium 串行探针 | 否；只改变 release-final | 固定 source/build identity、scenario IDs、launch/context 数与 failure class |
| `diagnostic` | nightly/manual visual、UX、cross-browser、geometry、performance、a11y、resilience | 否 | planned/executed/skipped 与每次 attempt 均可审计，缺失只能是 skipped/incomplete |

`infra-failure` 是失败分类，不是可通过的 evidence class。它覆盖 browser launch/install/crash/disconnect、runner OOM/PID/FD exhaustion，以及 fixture/bootstrap infrastructure failure。产品断言、URL/data/visual mismatch 和契约不一致必须保持 `product`/`contract`，不能改写成 infra 以取得重试资格。

`tests/matrix.yml` 对所有真实浏览器 tier 显式声明 `evidenceClass`。除 `browser-contract` 外，任何 `requiresPlaywright != none` 的 tier 都必须是 `diagnostic`；`production-correctness` 与 `release-final` 必须是 `correctness`。matrix validator 会拒绝重新标记或把 diagnostics 接回 correctness 依赖闭包。

## Retry 与 attempt 规则

Browser Contract 的 retry 永远为 0。crash/disconnect 直接产生 infra failure，不允许 `passed-after-retry`，也不经过通用 flaky wrapper。

Diagnostics 只有在明确识别到 browser process crash 时才允许有限 crash retry。每次 attempt 独立保存：

- attempt number、test IDs 与执行拓扑；
- failure class、失败测试集合和 artifact；
- browser/viewport/theme/lane 与 trigger；
- planned/executed/skipped 计数及 incomplete reason。

重试后通过只能记为 `diagnostic-passed-after-infra-retry`，`affectsCorrectness` 仍为 false。多个 attempt 在不同测试上失败时必须标记 `unstable-topology`，不能只保留最后一次错误。普通 correctness、Browser Contract、assertion mismatch 和 benchmark noise 均无权使用该 crash retry。

## 三类 receipt

Browserless correctness receipt 绑定 source commit/worktree fingerprint、#1078 immutable build receipt、精确 tier/test IDs、fixture schema 计数、browser launch count 0 与 Playwright installation false。任一字段缺失、source/build 漂移或发现浏览器进程都 fail closed。

Browser Contract receipt 绑定同一 source/build identity，并记录 Playwright/Chromium revision、一次 launch、逐场景 context、精确 scenario IDs、fixture namespace、console/page/request diagnostics、failure class、wall clock 与 artifact 相对路径。receipt 不内联会话、trace 或 screenshot 内容。

Diagnostics receipt 记录 cadence/trigger、browser/viewport/theme/lane、planned/executed/skipped、incomplete reason、crash retry count，以及 screenshot/trace/perf artifact。缺失诊断证据只能成为 skipped/incomplete；不能合成 success，也不能阻断或放行普通 correctness。

`release-final` 必须同时拿到成功的 browserless correctness receipt 与 Browser Contract receipt，并验证两者的 source/build fingerprint、receipt digest 与当前 release identity 一致。Browser Contract receipt 缺失、失败、stale 或 identity 漂移均 fail closed；diagnostics receipt 不属于 release-final required correctness 集合。

## Coverage migration manifest

`tests/governance/browser-test-migration.json` 是旧 browser test 到轻量替代层的权威映射。每条记录保存 source file/test ID、assertion category、replacement layer/test ID、browser-only risk route、状态，以及确有删除时的理由和批准。

冻结基线同时覆盖 `tests/frontend/e2e` 与 #1150 删除的两个 browser resource/elastic-pool 编排测试文件；tracked fallback 保存完整旧 ID 集，而不是只保存整文件删除列表。因此同一存续 spec 内删除单个 test、删除旧编排测试或 shallow clone 缺少历史 commit，都必须经过同一 ID 级映射检查。checker 还会解析当前 replacement 文件、精确 test ID、Browser Contract scenario 与 diagnostics category，目标漂移时 fail closed。

治理检查遵循以下规则：

- 旧 browser test 删除或迁移前必须有 manifest 条目；
- `replacement: none` 只有同时存在明确删除理由和批准者时才合法；
- browser-only risk 必须进入 Browser Contract 或 diagnostics，不能声称 happy-dom 等价；
- replacement test ID、目标文件和风险 route 必须仍存在，不能用文档占位替代测试。

## 聚合、保留与排障顺序

Production Summary 只读取 correctness job summary 和 browserless receipt，不依赖 Browser Contract 或 diagnostics。普通 PR receipt 绑定当前 `pr-smart-gate` plan，把完整政策闭包分为实际执行与 policy-skipped 两组；只有 plan 明确跳过的 job/tier 才可 skipped，且不得伪造 `tier:*` 执行成功。Release Final 在此基础上增加且仅增加 Browser Contract。Browser Diagnostics 使用独立 workflow、receipt 与 retention；其缺失在 diagnostics summary 中显式记录，不进入普通 required-job completeness。

排障顺序为：

1. 先核对 receipt 的 `evidenceClass`、source/build identity 和 digest；
2. `correctness` 失败按 tier/test ID 修复，不启用浏览器；
3. `browser-contract` 按 `product`、`contract`、`infra-failure` 定位，仍不重试；
4. `diagnostic` 先看每个 attempt 与 `unstable-topology`，只允许明确 crash retry；
5. identity 或 receipt 缺失时重新生成当前 run 的证据，不复制上一轮 artifact。

回退不需要重启服务：可以暂停 release-final 或 diagnostics 调度，同时保留普通 browserless correctness；不得恢复旧 Acceptance 聚合、共享浏览器 session、通用 suite retry，或把 diagnostics 重新接到 Production Summary。

# #1150 Browserless correctness 与单 Browser Contract 交接

默认 correctness 已与真实浏览器风险解耦。`production-correctness` 只聚合静态治理、前后端 unit/property/model、SSR/AOT/HTTP contract、API/DB/cache integration、resilience、load 与 release evidence；其完整 dependency closure 不安装 Playwright browser、不启动 Chromium，也不准备 Playwright session schema。

## 权威入口

```bash
./tools/test.sh production-correctness
./tools/test.sh browser-contract
./tools/test.sh browser-diagnostics
./tools/test.sh release-final
```

- `production-correctness` 是 browserless production authority；历史 `production` 只作为同一 tier 的兼容别名。
- `browser-contract` 是 release correctness 唯一真实浏览器入口。它消费同 commit/worktree fingerprint 的 immutable production build receipt，自建一个 sealed database/Redis/runtime namespace，固定一个 managed Chromium、一个 controller、一个 session/concurrency、零 shard、零 retry，并在 10 分钟 job deadline 内完成。
- `browser-diagnostics` 是 scheduled/manual 入口。旧 Acceptance、visual、UX viewport、cross-browser、renderer pressure、browser resilience、permission/search/PoW/zero-auth browser probes 只在 diagnostics 边界运行，其失败保持独立且不能被写成 correctness pass。
- `release-final` 聚合 `production-correctness`、单个 `browser-contract` 与 strict release evidence；聚合 tier 本身不安装或启动 Playwright。

## CI 与 smart gate

普通非 browser-boundary PR 的选中 tier 全部为 `requiresPlaywright: none`。`quality-gate.yml` 不再定义 Acceptance shard 或 frontend render-pressure browser job；`production-summary` 与 `release-evidence` 都不等待 `browser-contract`。

唯一 Browser Contract job 只在以下情况被选择：

- `master` / `main` push；
- `workflow_dispatch` / release-final；
- PR 修改 bootstrap、public renderer、router、worker、Service Worker/PWA 或 Browser Contract 自身边界。auth/passkey 使用窄文件清单覆盖真实 WebAuthn ceremony（API、binary adapter、login/management composable、register modal、auth copy 与 session store），不会把无关 component/composable/API 修改升级为浏览器 PR。

该 job 必须通过 `production-build-artifacts` receipt 校验 commit、worktree fingerprint 与 receipt digest；不得重新 build、采用系统 Chrome、扩成 shard matrix 或经过 flaky retry wrapper。

## 可见拓扑变化

| 口径 | 迁移前 | 迁移后 |
| --- | ---: | ---: |
| Browserless authority dependency closure | 旧 `production`：72 tiers，含 `acceptance` | `production-correctness`：71 tiers，0 Playwright tier、0 browser resource tier |
| Release-final dependency closure | 96 tiers，10 个 Playwright 声明 | 93 tiers，仅 `browser-contract` 一个 Playwright/browser tier |
| Quality Gate job 定义 | 29，含 Acceptance shard 与 render pressure | 当前 25；删除旧 browser jobs，唯一 browser job 为单 `browser-contract` |
| 显式 shared bootstrap step | 3 | 2；Browser Contract 使用自己的 sealed lifecycle |
| 普通非边界 PR browser install / session fixture | 至多一个动态 Acceptance shard matrix | 0 job、0 browser、0 Playwright session schema |

这些计数来自 matrix/workflow 结构，不把未来遥测百分比作为验收，也不把 diagnostics skip 当作 correctness evidence。

## Fail-closed 治理

`tools/run-test-matrix.mjs validate` 强制：

- 任一 `requiresPlaywright != none` tier 必须声明 `resourceClass: browser`；
- `production-correctness` 的传递闭包不得包含 browser tier；
- `browser-contract` 必须固定 Chromium、不可并行、10 分钟、自举 runtime，并且只依赖 immutable build producer；
- `release-final` 自身 browserless，传递闭包中唯一 browser tier 必须是 `browser-contract`。

`tools/check-workflow-matrix-sync.mjs` 同时校验唯一 Chromium install/cache、固定 worker 1、immutable build consumer 与零 retry。`tests/tools/issue-1150-browserless-ci-topology.test.mjs` 额外沿 shell/npm 间接调用检查 production 不会重新带回 search、PoW、permission 或 zero-auth Chromium probe。

直接执行 `production-correctness`、兼容别名 `production` 或 `release-final` 时，browserless correctness tier 只观测实际时长，不再把矩阵中的 CI timeout 元数据变成进程截杀预算；因此慢 tier 会自然完成并一次性暴露错误。唯一例外是 Browser Contract 自身仍保留 issue 规定的 10 分钟 fail-closed deadline。CI job 的外层 `timeout-minutes` 不受影响。

Logical correctness 中四个 Release benchmark consumer 先通过同 namespace/key 的 run-once producer 构建一次 `FsusBlog.Core.Benchmarks`，产物同时绑定 DLL、deps 与 runtimeconfig digest；perception、privacy 与 native P99 的 .NET reader 也统一消费 Debug/Release run-once producer并使用 `--no-build --no-restore`。scheduler 运行时 producer 指纹绑定 source commit + worktree fingerprint，不把测试产生的 `src/backend/Logs`、`runtime-cache` 等忽略目录重新视为源代码变化。producer 与 immutable production artifact 的 Release restore/build 共享 run-bound `flock`，只串行化会写相同 `bin/obj` 的编译临界区。

真实测量不能与编译器或另一组性能测量共享 CPU：logical `backend-perf`、`backend-benchmark-regression`、`privacy-zk-comment-matrix` 都持有 `benchmark-window` 且以不可并行 tier 运行；各 lane 的非测量准备仍在自己的窗口前并行完成。benchmark runner 按 `STEP > TIER > BUNDLE > host` 消费实时 CPU/内存 grant，禁止 logical tier 只获 4 CPU 时仍 `taskset` 覆盖 8 CPU。性能阈值保持不变，调度污染不得通过放宽预算掩盖。

Matrix validate/preflight/evidence-plan 由一个 run-bound physical producer 执行。每个 logical consumer 发布 `fsusblog.physical-execution-consumer-evidence.v2` 前，必须从本 run 的受控目录重新打开 projection 与 receipt，重验 contract/receipt/test ID/output digest，并把完整已验证文档嵌入 stable evidence；Quality Gate 同时保留原始 receipt、projection 与四份 digest-bound 输出，离开 runner 后仍可交叉验证。resume 只接受 source/worktree 未变化的 authoritative fresh checkpoint；projection finalizer 前后都会重验 source，不能把旧 source 的成功物理执行改写为当前 success。producer 被取消后，记录 PID 已死亡的 run-once lock 经 token 二次确认立即回收；存活或身份不完整的 owner 仍 fail closed。

## 回退边界

出现 Browser Contract 基础设施故障时，可以暂停 release-final 并保留 browserless correctness 结果；不得把旧 Acceptance shard 加回 production、把 diagnostics failure 改写成 pass，或绕过 build/fixture identity。若 correctness coverage 本身回归，应回退具体 lightweight/API/model contract，而不是恢复默认浏览器矩阵。

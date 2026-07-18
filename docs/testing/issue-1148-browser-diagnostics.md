# #1148 Browser diagnostics 交接

浏览器特有风险由 `tests/browser-diagnostics/catalog.mjs` 统一登记，并通过 `tests/browser-diagnostics/run.mjs` 在独立 scheduled/manual workflow 中执行。该执行面只产生 `diagnostic` evidence：visual、UX full/risk、cross-browser、geometry/motion/focus、browser performance 与 browser runtime resilience 均已退出普通 PR 和 Production correctness。普通路径仍可保留与业务正确性直接相关的窄 browser acceptance；“diagnostics 独立”不等于删除所有浏览器功能契约。

## 风险分层

| 类别 | 真实浏览器保留内容 | 默认 correctness 的轻量替代 |
| --- | --- | --- |
| visual | 像素、字体、主题和真实布局截图 | component、view-contract、token/static governance |
| ux | viewport、overflow、hit target 与边界布局 | Router/component 与 source constraint |
| cross-browser | Chromium/Firefox/WebKit 引擎差异 | HTTP/AOT、browser-environment model、passkey contract |
| geometry-motion-focus | sticky/hash geometry、computed transition、reduced motion、Escape/focus | sticky composable unit、FsusUI ownership/static motion contract |
| accessibility | 渲染后可见性、accessible name、focus | a11y/static governance 与 component ARIA state |
| performance | layout/heap/long-task/render-ready、AEDS engine selection/fallback | DOM depth、Markdown structure、decoder budget 与 renderer model |
| resilience | 浏览器 runtime recovery | HTTP/cache/telemetry/notification state-machine tests |

权威迁移映射位于 `tests/issue-1148-browser-diagnostics-migration.json`。映射区分轻量等价断言和仍需真实浏览器的风险，不把 geometry、像素、引擎差异或真实 renderer timing 伪装成 happy-dom/Node 等价覆盖。

## 执行拓扑与 evidence

Nightly 执行完整 7 类、14 个 probe；manual 默认也执行完整目录，可用 `--category` 选择一类：

```bash
bash tools/test/lanes/browser-diagnostics.sh nightly --workers 1
bash tools/test/lanes/browser-diagnostics.sh manual --category geometry-motion-focus --workers 1
```

runner 固定一个显式外层 browser worker、串行 category/probe admission，且没有 dynamic inner browser pool。默认 crash retry 为 0；只有 #1151 receipt 治理显式启用时，才允许对明确 browser process crash 做一次有限 retry。各 lane 必须继续把 Playwright/Vitest 等内层 worker 固定为 1，不能读取 live CPU、free memory 或 load 扩张。runner 按 `run/category/probe/attempt` 隔离 namespace、日志、Playwright output 和 artifact snapshot；执行每个 probe 前先删除它在 catalog 声明的 canonical artifact，成功退出后要求每个声明文件非空、声明目录非空，再复制到当前 probe 的 `artifacts/`。缺失、空文件、空目录或 symlink 都按 `infra-failure` fail closed，因此旧 canonical artifact 不能被当前 receipt 接受。每类生成独立 summary，最终 receipt 记录 cadence/trigger、browser/viewport/theme/lane、planned/executed/skipped、incomplete reason、crash retry count、每次 attempt 的 test IDs/failure class/artifact、immutable build/source identity、clean/pinned FsusUI source/theme digest。某个 probe 失败不阻止后续独立 probe 收集 evidence，最终统一返回失败。

`.github/workflows/browser-diagnostics.yml` 只有 `schedule` 与 `workflow_dispatch` 触发。它先生产并验证 immutable Production build，再用显式跨私有仓库只读 token checkout 固定 FsusUI commit 到 run-local 路径、安装其 lockfile 依赖并执行本地 `build:theme`，随后校验 clean HEAD 与 source/theme digest，再安装 FsusBlog lockfile 对应的 Chromium/Firefox/WebKit 并运行 diagnostics。该流程不发布 FsusUI、不修改 package version、registry 或 FsusBlog lockfile；FsusBlog 只通过 `FSUSBLOG_LOCAL_FSUSUI_ROOT` alias 消费这份 source/dist。

## Geometry、motion 与 focus

`browser-geometry-motion-diagnostics.sh` 明确包含两个不同隔离级别，不能把整条 lane 统称为完全 isolated：

1. `public-mobile-menu-harness.spec.ts` 在最小 Vite component harness 中直接挂载本地 FsusUI `ElPublicShell` 和本地构建的 public-shell critical CSS。它不依赖 FsusBlog backend、PostgreSQL、Redis 或 release preview，验证 computed enter/leave transition、reduced-motion、Escape 和 focus restoration。
2. `archive-sticky-geometry.spec.ts` 仍是 release-preview integration，验证真实 archive sticky/hash geometry 与 hydration 后布局。

canonical `.tmp/browser-diagnostics-runtime/geometry-motion-focus/geometry-motion-focus-summary.json` 分别记录 `isolated-component-harness` 与 `release-preview-integration`，并声明各自依赖；runner 会把本轮新写的 canonical summary 快照到当前 `run/category/probe/artifacts/`，而 harness log 与 Playwright output 始终直接写入该 probe 的 scoped output。任一部分都不能冒充另一部分的通过。详细边界见 [`browser-geometry-motion-focus.md`](browser-geometry-motion-focus.md)。

## Performance 与 correctness 边界

`frontend-render-pressure.sh` 只委托 browserless `frontend-render-structure.sh`，保留 DOM depth 与 Markdown structure correctness。真实 DOM budget、route render pressure、browser performance regression 和 AEDS browser engine/transfer/long-task evidence 只由 diagnostics 目录执行。

普通 `aeds-frame-cost` 仍执行 server frame cost 与真实 basic/speed decoder budget，但不启动浏览器。`performance-evidence-summary` 与 release manifest correctness status 不消费 browser performance 或 AEDS browser summary；diagnostic artifact 可被收集并显示，但缺失、unsupported 或失败不会把普通 correctness 改写为失败或通过。反过来，diagnostics clean pass 也不能替代结构、decoder、协议或业务 correctness。

\#1074 counted Chromium slot 已从 Production scheduler 退役；固定单 browser admission 只描述 diagnostics 外层，不能重新变成 Production counted resource。

## 失败分类与回退

assertion/URL/data/visual/threshold mismatch 归类为 `diagnostic`，browser install/launch/crash/OOM/disconnect 与 fixture/bootstrap failure 归类为 `infra-failure`；两类都使本次 diagnostics receipt 失败并保留 artifact，但 `affectsCorrectness=false`。只有明确 crash 可进入有限 retry；重试后通过必须标记 `diagnostic-passed-after-infra-retry`，多个 attempt 在不同测试失败时标记 `unstable-topology`。不得用降低 screenshot threshold、忽略 console/page errors、generic suite retry 或旧 summary 生成 clean pass。完整规则见 [`issue-1151-evidence-governance.md`](issue-1151-evidence-governance.md)。

回退无需重启应用服务：暂停 scheduled/manual diagnostics workflow，或选择单类手动复现即可。普通 correctness DAG 与其轻量 replacement 继续按自身证据给出结论。

# Issue #1084：persistent UX browser pool 退役边界

## 当前状态

\#1084 曾为 local Production UX risk matrix 引入 persistent/elastic browser pool。#1148 完成测试面分层后，该执行模型已退役：UX full、visual、boundaries 与 risk matrix 不再属于普通 PR、Production correctness 或 release correctness 路径，只能从 scheduled/manual browser diagnostics 目录进入。

`tools/ux/run-local-production-risk.mjs` 现在会拒绝缺少 `FSUSBLOG_BROWSER_DIAGNOSTICS=1` 的调用。权威入口是：

```bash
bash tools/test/lanes/browser-diagnostics.sh nightly --workers 1
bash tools/test/lanes/browser-diagnostics.sh manual --category ux --workers 1
```

不得从 `./tools/test.sh production`、物理 `runtime-browser` bundle 或普通 Quality Gate 重新接入旧 pool。回退也不是切回 pool；应暂停 diagnostics workflow，或只手动复现 `ux` 类别。

## 固定执行拓扑

UX risk diagnostics 使用一个外层 browser lane、一个 Playwright CLI、一个 managed Chromium、一个 worker 和一个 prepared fixture session，所有 route-theme group 在该 session 中按计划顺序执行。以下值是 diagnostics 的隔离合同，不根据 CPU、free memory 或 load 动态扩张：

- `FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS=1`
- `FSUSBLOG_PLAYWRIGHT_WORKERS=1`
- `FSUSBLOG_UX_VIEWPORT_WORKERS=1`
- `FSUSBLOG_PLAYWRIGHT_CONFIG=playwright.diagnostics.config.ts`
- `FSUSBLOG_PLAYWRIGHT_RETRIES=0`
- `FSUSBLOG_UX_VIEWPORT_RESUME=0`

runner 不再读取 `os.availableParallelism()`、live memory 或 counted `chromiumLane` 来增加 browser worker，不再启动 persistent worker，也没有 dynamic inner pool。一个 assertion failure 不会被 suite retry 掩盖；risk plan 内可继续执行的独立 case 仍全部收集，最终统一报告错误。

## Isolation 与 evidence

diagnostics runner 先验证 debug stack 与 release preview，再为本次 `run/category/probe` namespace 准备唯一 session。Cookie、storage、schema、Redis namespace、Playwright output 与截图都绑定该 run；禁止复用其他 run 的成功 progress 或 summary。

权威输出为：

- `.tmp/browser-diagnostics-runtime/ux-risk/summary.json`
- `.tmp/ux/viewport-boundaries.json`
- `.tmp/release-evidence/ux-viewport-summary.json`
- 对应 diagnostics probe 目录中的 stdout、stderr 与 Playwright failure artifact

UX risk summary 明确写入 `evidenceClass=diagnostic`、`affectsCorrectness=false`、固定 topology、完整模型与本次 risk selection。其失败会让本次 diagnostics workflow 失败，但不会改变普通 correctness 结论，也不能替代 Router/component/source constraint 等轻量 correctness 证据。

旧版 `fsusblog.local-production.ux-risk.v2` 的 process-count、elastic-worker lifetime 和三轮 before/after 要求只属于已退役 pool 的历史性能评估，不再是当前测试拓扑或 issue 收口前置。

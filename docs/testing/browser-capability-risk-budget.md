# Browser capability-risk budget

跨浏览器诊断按 [`catalog.json`](../../tests/browser-capability-risk/catalog.json) 的版本化风险闭包选择，不以近期是否失败、宿主负载或远程浏览器结果删减引擎。selector 只读取 changed paths、catalog、Playwright projects 和 matrix 元数据，并输出 `fsusblog.browser-capability-risk-proof`；相同输入得到相同 engines、scenarios、risk IDs 与排除理由。

三个 profile 的职责互不替代：

- `browser-primary-correctness` 只在 Chromium 运行 canonical public-route correctness。通用 UI、状态与业务变更不在 Firefox/WebKit 重复该路径。
- `browser-capability-delta` 运行 Chromium 对照以及 Firefox/WebKit capability probe，覆盖 service worker、Cache Storage、worker runtime、hydration/dynamic import、passkey 和 conditional mediation 的引擎差异及 fallback。
- `browser-full-matrix` 运行全部声明 scenario 与其 required engines，是 nightly、release reliability、release-final 和本地显式 full 的 producer。`FSUSBLOG_BROWSER_PROFILE=browser-full-matrix ./tools/test.sh ci-tier cross-browser-smoke --no-deps` 是单一本地入口；默认 profile 同样是 full。

Firefox/WebKit 被省略的是已经由 `browser-test:primary-public-route-navigation` 证明的通用产品导航，不是 capability 行为。它们仍运行 `browser-test:capability-engine-delta`，且每个 risk 都引用 Chromium canonical evidence。新增 risk、scenario、engine、test ID 或 Playwright project 若未同步，static governance 会 fail closed。

changed-path proof 可独立生成，例如：

```bash
node tools/testing/browser-capability-risk.mjs select \
  --path src/frontend/src/workers/wasmDecode.worker.ts
```

catalog、selector、matrix 或 Playwright config 自身变化强制选择 `browser-full-matrix`。普通业务路径只选择 primary；worker/service-worker 路径选择所有风险要求的引擎。所有 proof 均列出未选 scenario 及原因，不能用“最近没有失败”作为排除理由。

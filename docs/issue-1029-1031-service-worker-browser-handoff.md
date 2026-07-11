# Issues #1029 / #1031：Service Worker 浏览器证据交接

> 状态：代码与测试已落地，但未运行浏览器、测试、构建、lint、语法或治理检查；本文不是验收通过证明。

## 交付

- `tools/deployment/release-asset-compatibility-probe.mjs`
- `tools/deployment/release-asset-browser-session.mjs`
- `tests/tools/release-asset-compatibility-probe.test.mjs`
- `tests/frontend/e2e/acceptance/release-asset-compatibility.spec.ts`
- `tests/fixtures/deployment/release-asset-browser-scenario.template.json`
- `docs/issue-1029-1031-service-worker-browser-handoff.md`

CLI 现在拒绝用 Node fetch 结果冒充 Service Worker 通过证据。生产 scenario 默认 `browser.required=true`，必须启动仓库 Playwright Chromium；`browser.required=false` 仅保留给注入 fake browser session 的 Node 合约测试，CLI 会直接拒绝。

## 浏览器生命周期

受控 Chromium 在 rollout 写出 `ready` 之前完成：

1. 真实打开 N-1 release-scoped index；
2. 在页面内读取并 SHA-256 校验 N-1 manifest；
3. 注册、更新并等待旧 Service Worker `activated`，必要时 reload 直到页面有 controller；
4. 通过真实页面 fetch 预热 manifest 指定的旧 cache；
5. 读取 SW script URL/state、registration scope、CacheStorage namespace 与 entry；
6. 从浏览器发起 manifest 内全部 JS/CSS/Wasm/font 请求，以唯一 hold token 卡在 route gate，确认四类请求均已进入 in-flight 后才允许 rollout 切流。

收到 drill-bound `switched` signal 后，route gate 释放请求。浏览器读取全部 response body，按旧 manifest hash 校验，并保留请求开始/释放时间。旧页面随后在页面 JavaScript 中请求新 backend；新 release index 真实加载后，在新页面 JavaScript 中请求旧 backend 回滚方向。两边都校验 HTTP、body hash、response header 与 `X-Fsus-Release-Id`，不再使用 Node fetch 代替前端。

收到 applied GC 与 `gc-complete` 后，探针阻断旧 release 的网络回源，再由旧受控页面：

- 读取 CacheStorage 中的旧 entry 并逐项 hash；
- 通过仍受旧 SW 控制的页面重新 fetch 旧资源；
- 验证旧 page identity、controller、cache namespace、JS/CSS/Wasm/font hash 均仍有效；
- 同时保留被阻断的网络尝试，防止把 200 网络回源误报成 cache 命中。

任何 console error、pageerror、非预期 requestfailed、404、hash mismatch、controller/cache 缺失或双向 backend identity 错误都会进入完整 `errors`，没有最大错误数或尾部截断。证据同时保留 console、network response/failure、`response.fromServiceWorker()`、page URL/title/body hash、SW controller、registration 和 cache namespace。

## Browser 与 artifact 防伪绑定

scenario 使用：

```json
{
  "browser": {
    "required": true,
    "bindingKeyFile": "/run/fsus/secrets/asset-browser-binding.key",
    "expectedCacheNamespace": "fsus-static-v4:<source-release>",
    "holdToken": "<unique-per-rollout>",
    "newIndexPath": "/release-assets/<target-release>/index.html"
  }
}
```

binding key 必须是 32..4096 bytes、0400/0600、regular non-symlink 文件；也可通过 `FSUSBLOG_ASSET_BROWSER_BINDING_KEY_FILE` 指定。Playwright module 默认使用 `src/frontend/node_modules/playwright/index.mjs`，可由 scenario 或 `FSUSBLOG_PLAYWRIGHT_MODULE` 覆盖。

最终 `fsusblog.release-asset-browser-binding.v1` 使用 canonical JSON + HMAC-SHA256，绑定：

- rolloutId、source/target release；
- Chromium name/version；
- 实际 browser executable path 与 binary SHA-256；
- scenario 原始文件 SHA-256；
- N-1 manifest HTTP body SHA-256；
- applied GC evidence 原始文件 SHA-256；
- 不含 binding 的完整 asset/browser evidence SHA-256。

任意修改 browser、console/network、SW/cache、manifest/GC、compatibility 或 rollout 字段都会使 payload hash/signature 不一致。key 原文不会进入 stdout、checkpoint 或 evidence。

## 验证边界

现有 Playwright acceptance fixture 已扩展为在切流前同时发起 JS、CSS、Wasm、font 四类请求，并在切流后统一释放；它继续验证旧页面、新旧 backend 双向、真实 SW cache、GC 后无网络 cache read，同时新增 browser version、console 与 request failure 断言。

当前 `release-rollout.sh`、`zero-downtime-rehearsal.sh` 与 plan resolver 已把
controlled-browser probe、`evidenceInputs.assetBrowserBindingKey`、
`--asset-browser-binding-key-file`、switch/GC signal 和 HMAC readback 串入 rollout。
统一验证阶段仍应使用新模板生成 private scenario 和独立随机 key，再运行 Node
合约测试及 Chromium acceptance；本轮没有执行任何浏览器或其他验证。

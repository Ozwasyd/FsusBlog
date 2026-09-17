# #1145 Public 合成矩阵轻量化交接

默认 `release` correctness 只运行生产 renderer、normalizer、view-contract 与 HTTP/AOT 合同，不安装或启动浏览器。真实浏览器风险由 #1147 的单 Chromium Browser Contract 承担。

| 原入口 | 原断言类别 | 当前替代层与 test ID | 保留的浏览器风险 |
| --- | --- | --- | --- |
| `check-public-dom-diff-hydration.mjs` | SSR/CSR normalized tree、attribute allowlist、deliberate mismatch canary | happy-dom + 生产 `renderPublicHydrationSnapshot`; `public-dom-diff:*` | `public-hydration-main` 检查真实 Vue hydration 与 shell identity |
| `check-public-clock-hydration-matrix.mjs` | 跨分钟/年份、时区、relative/full time、footer 年份 | 可注入 `Clock`/`LocaleContext` + 生产 renderer; `public-clock-contract:*` | Browser Contract 只验证真实 hydration 不受客户端时钟影响 |
| `check-public-payload-fixture-matrix.mjs` | empty/one/full/last-page、长文案、rich Markdown、null/missing、filter/archive/footer/logo | 生产 normalizer/view-contract/SSR renderer + happy-dom; `public-payload-contract:*` | 不保留重复 fixture 浏览器穷举 |
| `check-public-browser-env-hydration-matrix.mjs` | theme、storage、anonymous/user/admin、motion、stale state、route kind | 生产 `projectPublicBrowserEnvironment`; `public-environment-model:*` | `public-hydration-main` 保留一个真实环境 cell |
| `check:search-runtime` | 真实 SPA search takeover | 不属于 browserless 合成矩阵 | `public-hydration-main` 的 SPA takeover/navigation |
| `check:pwa-offline-smoke` | Service Worker / Cache Storage | 不可由 DOM 模型等价替代 | `service-worker-offline-reload` |

## 失败语义

- browserless evidence 使用 `contract mismatch`、`renderer drift`、`normalizer drift` 或 `model drift`；不产生 browser timeout。
- `browserLaunchCount` 必须为 `0`，`playwrightBrowserInstalled` 必须为 `false`。
- Browser Contract 的 hydration、history/reload、Service Worker、WebAuthn 与实际 focus 风险不得声称被 happy-dom 替代。

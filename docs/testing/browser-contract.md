# Release Browser Contract

`tests/browser-contract/run.mjs` 是 release-final 唯一的真实浏览器 correctness 探针。它直接使用 Playwright Library 启动 lockfile 对应的 managed Chromium，不经过 Playwright Test worker pool、shard 或 suite retry。

固定拓扑：

- 1 次 Chromium launch、最多 1 个并发 browser root；
- 5 个基线场景顺序执行；只有 immutable fixture 明确声明已具备 step-up 注册前提时，才加入第 6 个 WebAuthn 成功场景；每场景新建并关闭一个 BrowserContext；
- 0 worker pool、0 shard、0 retry；
- lane 默认 9 分钟超时，超时后先发送 `TERM`，15 秒后终止完整 process group；
- crash/disconnect 直接分类为 `infra`，不会重跑或升级为 clean pass。

## 场景目录与确定性选择

| ID | 浏览器独有风险 |
|---|---|
| `public-hydration-history-reload` | AOT article 直达、真实 Vue hydration、首次交互 takeover、public 导航、back、reload、head/body 与 app/shell identity |
| `account-deep-link-bootstrap` | 真实普通账号 cookie 打开受保护 deep link 并完成 account bootstrap |
| `admin-deep-link-expired-session` | 真实 admin cookie 完成权限 bootstrap；cookie 失效后保留 redirect 目标并呈现登录页 |
| `article-publish-persistence` | 管理 UI 发出真实 prepublish/create 请求，返回成功后 reload 仍能检索到文章；只执行一次写入 |
| `webauthn-virtual-authenticator` | 条件场景：fixture receipt 声明 `webAuthnRegistration=true` 时，Chromium CDP virtual authenticator 完成真实注册仪式，reload 后凭据仍存在 |
| `service-worker-offline-reload` | Service Worker 接管后离线 reload 遵守 private/no-store 503 策略，恢复网络后可重新加载 |

选择只读取本轮不可变 fixture 的 capability 声明，不读取宿主负载、live grant、上一轮 evidence 或浏览器探测结果，因此同一输入的 exact scenario IDs 保持确定。当前基线 fixture 没有可消费的 step-up proof，选择其余 5 个场景；#1149 的 producer 只有在生成可完成注册的账号会话后才可声明该能力。普通 Router、组件状态、API payload、权限、缓存与持久化 correctness 由 browserless tests 负责，不在这里重复 route/viewport/theme 矩阵。

## 输入与输出

runner 在启动 Chromium 前 fail closed 验证 #1078 的 immutable production build receipt，要求包含 `backend-runtime`、`frontend-dist`、`wasm` 和 `generated-contracts`。运行时数据只通过现有 fixture 文件适配器消费：一个 namespace、一个 user storage state、一个 admin storage state 和稳定 public article/category；场景代码不执行 SQL、Redis 或 Docker。#1149 将在不改变场景接口的前提下收敛 fixture producer 与清理 receipt。

单一输出为 `.tmp/browser-contract/receipt.json`，记录 source/build fingerprint、Playwright 版本、Chromium revision、精确 scenario IDs、fixture namespace、launch/context 数、wall clock、console/page/request issues、product/contract/infra 分类及 trace/screenshot 路径。每个场景无论成功失败都尝试写 trace；失败时额外保存当前 viewport screenshot。

## 运行

先准备并启动当前 commit 的 immutable production runtime 与单一 fixture namespace，再执行：

```bash
npm --prefix src/frontend run check:browser-contract
```

可通过 `FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT`、`FSUSBLOG_FIXTURE_ROOT`、`FSUSBLOG_TEST_NAMESPACE`、`PLAYWRIGHT_BASE_URL` 与 `FSUSBLOG_BASE_URL` 指向已验证的本轮输入。release-final 不允许跳过 build receipt、回退到系统 Chrome，或通过 retry 掩盖失败。

## 风险与回退

Browser Contract 失败时 release-final 保持阻断，并根据 receipt 的 `product`、`contract` 或 `infra` 分类定位；browserless production correctness 不会被改写成失败。紧急回退可以暂停 release-final 发布动作并保留 browserless gate，不能改用旧 Acceptance 矩阵、系统浏览器或自动重试生成 clean pass。Nightly/manual visual、cross-browser、geometry 和性能诊断由 #1148 独立承接。

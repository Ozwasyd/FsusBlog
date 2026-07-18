# Release Browser Contract

`tests/browser-contract/run.mjs` 是 release-final 唯一的真实浏览器 correctness 探针。它直接使用 Playwright Library 启动 lockfile 对应的 managed Chromium，不经过 Playwright Test worker pool、shard 或 suite retry。

在 evidence 治理中，它的 class 固定为 `browser-contract`，不是普通 `correctness` 或 `diagnostic`。Production Summary 不消费该 receipt；Release Final 缺少成功且 source/build/digest 绑定一致的 receipt 时 fail closed。三类 receipt、infra failure 与迁移 manifest 规则见 [`issue-1151-evidence-governance.md`](issue-1151-evidence-governance.md)。

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

runner 在读取旧 receipt 或启动 Chromium 前，fail closed 验证显式的 `FSUSBLOG_TEST_SOURCE_COMMIT` / `FSUSBLOG_TEST_SOURCE_FINGERPRINT` 与 #1078 immutable production build receipt 完全一致，并要求 receipt 包含 `backend-runtime`、`frontend-dist`、`wasm` 和 `generated-contracts`。`GITHUB_SHA` 不能代替这两项专用 source identity。

#1149 的 fixture producer 固定准备 `1 session / 1 concurrency`：一个 run-scoped 专用 PostgreSQL instance/schema、一个 Redis instance/namespace、一个普通 user、一个 admin 和一份 sealed auth/storage manifest。它不读取 live CPU/memory grant 或 PostgreSQL PID headroom，不按 worker clone schema，也不回退到共享 `public` schema。场景只消费 `createPublishedArticle()`、`createPendingComment()`、`createUserSession()`、`createAdminSession()` 和 `resetContractNamespace()` 形成的稳定 fixture view；浏览器场景不执行 SQL、Redis 或 Docker 命令。完整生命周期见 [`issue-1149-browser-contract-fixture.md`](issue-1149-browser-contract-fixture.md)。

固定可上传结果只有 `.tmp/browser-contract/receipt.json`；sealed fixture manifest 在 cleanup 前位于 `.tmp/browser-contract/fixtures/<namespace>/contract-fixture.json`，本机私有调试产物位于 `.tmp/browser-contract/runs/<namespace>/`。receipt 记录 source/build fingerprint、run/lane/preparation identity、database/Redis identity、稳定实体 ID、cleanup 分项证据、Playwright 版本、Chromium revision、精确 scenario IDs、launch/context 数、wall clock、console/page/request issues、product/contract/infra 分类及本地证据的相对路径，不内联原始 trace、screenshot 或会话材料。只有显式 `anonymous` 场景允许在本地私有目录保留 raw trace；`user`、`admin` 及任何未知/未来 role 都不启动 tracing。场景失败时可在本地私有目录保留 viewport screenshot，但 CI 无论成功或失败都不上传 `fixtures/**` 或 `runs/**`，只上传 receipt 与 job summary。

## 运行

先物化当前 source identity 的 immutable production build receipt，再执行：

```bash
npm --prefix src/frontend run check:browser-contract
```

调用者必须提供 `FSUSBLOG_TEST_SOURCE_COMMIT`、`FSUSBLOG_TEST_SOURCE_FINGERPRINT` 和 `FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT`。lane 默认使用仓内 `tests/browser-contract/default-fixture-provider.mjs`，也可显式指定符合同一 protocol 的 provider。runtime URL、fixture root 和 namespace 由当前 run identity/producer 产出，不应指向上一轮运行。release-final 不允许跳过 build receipt、回退到系统 Chrome、共享 fixture 或通过 retry 掩盖失败。

## 风险与回退

Browser Contract 失败时 release-final 保持阻断，并根据 receipt 的 `product`、`contract` 或 `infra` 分类定位；browserless production correctness 不会被改写成失败。无论成功、失败、取消或 timeout 都执行同一幂等 cleanup；cleanup failure 单独记录且不覆盖第一个产品/契约失败，并保留当前 identity 的私有 recovery state 供重试。无法证明 container/PID ownership 时必须 fail closed，禁止按名称强制删除。紧急回退可以暂停 release-final 发布动作并保留 browserless gate，不能改用旧 Acceptance 矩阵、系统浏览器、共享 `public` schema 或自动重试生成 clean pass。Nightly/manual visual、cross-browser、geometry 和性能诊断由 #1148 独立承接。

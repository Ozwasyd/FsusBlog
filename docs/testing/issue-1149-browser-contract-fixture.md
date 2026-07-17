# #1149 Browser Contract 单命名空间夹具

Release Browser Contract 使用一套 run-scoped、不可变的数据夹具，不再继承普通 Playwright 的多 worker session/schema 克隆平台。固定拓扑为 `1 session / 1 concurrency`：一次运行只拥有一个专用 PostgreSQL instance/schema、一个专用 Redis instance/namespace、一个普通 user、一个 admin，以及一份 auth/storage manifest。场景仍由 `tests/browser-contract/run.mjs` 串行执行，并且只消费正式 fixture API 返回的稳定实体 ID、URL 与 storage state。

## 身份与目录

run namespace 必须绑定 source commit、run identity 和 lane identity；同一 receipt 生命周期内不可改变，也不得与 diagnostics 共用。lane 与 direct runner 都要求显式提供完整 `FSUSBLOG_TEST_SOURCE_COMMIT` 和 `FSUSBLOG_TEST_SOURCE_FINGERPRINT`，并在读取 receipt、删除旧 evidence 或启动任何 runtime 前验证格式；`GITHUB_SHA` 不能作为隐式替代，receipt 的 commit/fingerprint 必须逐字段严格匹配。默认 Browser Contract 输出位于 `.tmp/browser-contract/`：运行期 sealed manifest 位于 `.tmp/browser-contract/fixtures/<namespace>/contract-fixture.json`，trace/screenshot 等运行产物进入 `.tmp/browser-contract/runs/<namespace>/`，最终 lifecycle/cleanup evidence 写入固定 `.tmp/browser-contract/receipt.json`；启动新一轮只替换该固定 receipt，不递归删除输出根或其他 run 的产物。cleanup 成功后删除本轮 namespace 的临时 fixture root；cleanup 失败时保留私有 provider state 与 recovery handle，待同一 identity 重试成功后再删除。PostgreSQL/Redis instance identity 与 Redis namespace 从同一 run identity 派生；PostgreSQL 可以在该专用 instance 内使用标准 `public` schema，但绝不允许回退到共享或仍会变化的 live `public` schema、默认 Redis keyspace、历史 fixture 或其他 lane 的目录。

Browser Contract producer 不读取 Playwright worker 数、`os.loadavg()`、`os.freemem()`、live scheduler grant 或 PostgreSQL PID headroom 来决定拓扑。调用者请求的 session 或 concurrency 不是 1 时必须 fail closed；prepare 失败也必须在启动 Chromium 前结束，不得继续使用未隔离数据。

## 正式 fixture API

浏览器场景只能通过 Browser Contract fixture facade 使用以下能力：

- `createPublishedArticle()`：返回固定 public article 的稳定 ID、标题与 URL；
- `createPendingComment()`：返回本 namespace 内待审核 comment 的稳定 ID 与关联实体；
- `createUserSession()`：返回普通 user ID 与可移植 storage state；
- `createAdminSession()`：返回 admin ID 与可移植 storage state；
- `resetContractNamespace()`：幂等清理当前 run 的 DB、Redis 与 fixture files。

实现可在 producer 边界内调用数据库或生产 API contract，但 `tests/browser-contract/scenarios.mjs` 及浏览器 callback 不得包含 SQL、Redis CLI、Docker 命令或表/key 细节。所有场景在 prepare 完成后读取同一不可变 snapshot；真实写入使用 namespace 专用实体，不能逐场景复制 live `public` schema。

## 生命周期与 receipt

prepare 成功后原子写入 sealed fixture manifest，再允许 Browser Contract runner 启动浏览器；最终 Browser Contract receipt 引用该 manifest view 并保留 lifecycle/cleanup。两份结构化 evidence 合计至少记录：

- source commit、worktree/build fingerprint 与 run/lane identity；
- database instance/schema、Redis instance/namespace 与 fixture root；
- public article、pending comment、user、admin 等稳定实体 ID；
- user/admin storage-state 路径及 producer schema version；
- `sessions=1`、`concurrency=1` 和 prepare 状态；
- cleanup 请求原因、开始/结束时间、尝试次数、错误、database/Redis/processes/files 分项 evidence 与最终 cleanup 状态。

成功、产品失败、contract/infra 失败、`SIGINT`/`SIGTERM` 取消和 lane timeout 都必须进入同一个幂等 cleanup 路径；provider 运行在独立 process group，超时或取消先发送 `TERM`，750 ms 后对仍存活的整组发送 `KILL`。bootstrap 启动的 detached backend/Vite 另以 `pid + start-time ticks + run-id + namespace + role` 私有 sidecar 绑定，cleanup 重新读取 `/proc` 校验同一进程组后执行 `TERM → bounded wait → KILL`，不得因 PID 重用误杀其他进程，也不得在进程仍存活时报告成功。容器必须同时匹配完整 ID、image 与 `run/bundle/step/namespace/preparation` labels；`docker rm` 失败或容器仍存在时 cleanup 必须失败，不能仅凭目标名称记录成功。成功 cleanup 的重复调用返回同一确定性结果；失败 cleanup 保留 provider state 并允许同一 identity 重试。cleanup failure 作为独立字段保留，不能覆盖第一个 product/contract/infra failure。sealed manifest 和最终 receipt 都原子写入并绑定本轮 run identity/freshness；陈旧、不完整或 identity 不匹配的 manifest/receipt 不能被当前 run 接受。

仓内默认 producer 为 `tests/browser-contract/default-fixture-provider.mjs`，lane 在调用方未覆盖时显式接线到该文件。producer 的 prepare runtime response 是 frontend/backend base URL 与 transport policy 的权威来源；专用 runtime 声明 `testSessionHeader=false` 时，Browser Contract context 不得发送 `X-Fsus-Test-Session`。

默认 producer 可在其私有 child process 内复用 `bootstrap-acceptance-env.sh` 的 seed adapter，但会先原子写入 preparation intent，再只面对具有当前 ownership labels 的专用 PostgreSQL/Redis。`FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1` 使 bootstrap worker/preparation slot 固定为 1，child admission 不读取 live grant、`os.freemem()`、CPU 或 PID headroom，Public AOT/SSR worker 也固定为 1；同时关闭 session isolation，并且不调用普通 `prepare-playwright-sessions.mjs` 多 session/schema clone。这个内部 seed 兼容层不改变外部 `browser-contract` protocol/session mode，也不是 legacy fixture、共享 `public` 或 test-session header fallback。

## Diagnostics 隔离

Nightly/manual diagnostics 使用 `FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-diagnostics`，并拥有 `browser-diagnostics-<lane>` namespace、probe-scoped fixture root、Playwright output 与 diagnostics receipt。其 session/worker/concurrency 上限固定且显式；资源不足只允许输出 `skipped`/`incomplete` evidence，不能静默缩小覆盖后写 clean pass。

Release Browser Contract 使用独立的 `browser-contract` session mode 和 `.tmp/browser-contract/**` 输出。两种模式不能复用 namespace、fixture root、receipt 或 cleanup 状态；legacy parallel session preparation 也不得成为 Browser Contract fallback。

## 聚焦验证

```bash
node --test tests/browser-contract/fixture-lifecycle.test.mjs
node --test tests/tools/browser-contract.test.mjs
node --test tests/tools/issue-1149-browser-contract-fixture.test.mjs
node --test tests/tools/issue-1149-session-isolation.test.mjs
node tools/check-test-matrix.mjs
node tools/docs/generate-testing-docs.mjs --check
```

真实 Browser Contract 仍通过 `npm --prefix src/frontend run check:browser-contract` 执行。fixture 生命周期测试使用注入式 adapter 和临时目录验证 prepare、fail closed、成功/失败/取消/timeout cleanup 与重复 cleanup，不要求启动浏览器、PostgreSQL、Redis 或 Docker。

## 风险与回退

若 producer 或 cleanup 失败，release-final 保持阻断并保留 receipt；先使用保留的 provider state 核对 container/process identity，再对同一 run namespace 重试 cleanup，成功后才创建新 run identity。无法证明 ownership 时必须保留 recovery state 并人工核对，禁止按名称强删、回退到多 worker schema clone、live `public` schema、共享 diagnostics fixture 或跳过 cleanup。该改动只收敛测试数据生命周期，不改变生产 API、鉴权或二进制协议。

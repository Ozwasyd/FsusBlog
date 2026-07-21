# Issue #1083：前端构建 live grant stage DAG

`src/frontend` 的 release build 不再在模块加载时固定一次 CPU / 内存容量。`tools/frontend/build.mjs` 现在把生成文件、Wasm、类型检查、SPA、SSR 和资产同步声明为显式 stage DAG，并由 `tools/frontend/build-stage-dag.mjs` 在每次准备接纳 stage 时重新读取 scheduler 的原子 resource grant。

## 调度与资源边界

- stage 声明 `dependsOn`、输入、独占输出、CPU / 内存权重和最低资源。
- 无依赖且输出域不冲突的 stage 可以并行；SSR、run-bound public assets 和后端 `wwwroot` 同步仍按数据依赖顺序执行。
- live grant 增长时，尚未开始的 ready stage 会在同一次构建中继续获得容量；grant 缩小时，已运行 stage 不被误杀，但新 stage 暂停接纳，直到当前占用重新落入 grant。
- 每个 child 只收到本次 admission 的精确 `FSUSBLOG_STEP_*` / `FSUSBLOG_BUNDLE_*` 份额；`FSUSBLOG_COMMAND_MANIFEST_WORKERS`、`FSUSBLOG_NODE_TEST_CONCURRENCY` 与 `UV_THREADPOOL_SIZE` 都由该 CPU 份额派生，不能沿用父级较大的并发值。
- scheduler grant 文件缺失时保留直接调用模式，并在 receipt 中明确记录 `direct-fallback`，不伪装为 live scheduler admission。
- grant schema、run id、tier 或资源值错误时 fail closed，不启动任何 stage。

## Receipt 与失败清理

默认 receipt 写入：

```text
${FSUSBLOG_PRODUCTION_BUILD_ROOT:-.tmp/frontend}/generated/frontend-build-stages.json
```

也可用 `FSUSBLOG_FRONTEND_BUILD_STAGE_RECEIPT` 指定绝对或相对路径。receipt schema 为 `fsusblog.frontend-build-stage-receipt.v1`，包含：

- scheduler run id、source commit / worktree fingerprint；
- grant 来源和构建期间的 grant 变化历史；
- 每个 stage 的命令、依赖、实际 CPU / 内存、嵌套并发、工具链、耗时和状态；
- 声明输出的文件或目录 SHA-256 摘要；
- blocked admission 记录以及失败后的 cleanup 结果。

启动新构建前会删除旧 receipt，最终通过同目录临时文件原子替换。成功写 `success` receipt；stage 失败、取消、deadline 到期或 grant 校验失败写 `partial` receipt。失败清理删除本次 `dist`，避免后续流程把半成品当作完整前端产物。

`build-static/sync-static-assets` 发布 `frontend-build-ready.json` 前会先 fail-closed 读取该 receipt，并要求 schema、`success` status、scheduler run ID、source commit 与 worktree fingerprint 全部等于当前 Production run。stage declaration 构造器显式接收 `src/frontend` root，不读取 verifier 的 cwd；真实 build、Production publisher、release-preview 与 privacy verifier 因此使用相同的 `node_modules/.bin` command 和 output 路径。validator 会把 receipt 的完整 stage roster 与当前 `createFrontendBuildStages()` 声明逐项比较：stage 顺序/ID、command、`dependsOn`、`ownedOutputs`、成功/允许跳过状态和 output roster 均不得自报；最终 dist entry、SSR shell、run-bound Wasm、稳定 `assets/fsus-spa-entry.js`、FsusUI markdown runtime、Wasm manifest 以及由该 DAG 直接拥有时的 backend wwwroot 会重新扫描并复算文件/目录 SHA-256。

Production 外层 `sync-static-assets` 生成的 run-bound backend wwwroot 与完整 final frontend dist tree 分别由 marker 的 artifact digest/ref 绑定。Production waiter、release-preview consumer 与 privacy-ZK performance input verifier 都会复算两棵完整目录，因此非 critical chunk、CSS、source map、Service Worker 或其他普通 asset 在 marker 发布后的任何变化也会 fail closed，而不只依赖 `index.html`。

marker 同时绑定 receipt 的仓库内精确 path、artifact digest/ref、原始文件 SHA-256 和规范化 identity；Production marker waiter、release preview readiness 与 privacy-ZK performance input verifier 都会重新读取 receipt，复算内容摘要、完整 DAG 语义和关键输出摘要。release-preview 的 expected source 只来自当前 scheduler 环境传入的 commit/worktree fingerprint，禁止从 marker 自己反推“期望值”。receipt 缺失、`partial`、错 run/source、stage 缺失/失败、命令或依赖伪造、output 缺失/摘要伪造、路径漂移、JSON 损坏或发布后内容改变都会拒绝 readiness；取消路径也只有在这份绑定仍然有效时才保留已成功的 marker。

## 取消与回退

`SIGINT`、`SIGTERM` 和共享 deadline 都通过同一个 `AbortSignal` 传入 DAG。外部命令以独立进程组运行，先发 `SIGTERM`，在短 grace period 后升级为 `SIGKILL`；原始失败原因保留到 partial receipt。生产运行时若需要无重启降级，可由 scheduler 缩小当前 grant，新的 stage 会停止接纳；已开始的 stage 按原 grant 完成。直接执行 `pnpm build:release` 则走明确记录的 host / inherited-step fallback。

## 聚焦验证

```bash
node --check tools/frontend/build-stage-dag.mjs
node --check tools/frontend/build.mjs
node --test tests/tools/frontend-build-stage-dag.test.mjs \
  tests/tools/frontend-build-resource-plan.test.mjs \
  tests/tools/frontend-build-ready-marker.test.mjs \
  tests/tools/release-preview-readiness.test.mjs \
  tests/tools/privacy-zk-performance-inputs.test.mjs
node --test --test-name-pattern='cold frontend static phases|runtime early start' \
  tests/tools/local-production-profile.test.mjs
```

专项用例覆盖 DAG 校验、grant `2 → 4` 扩容、`4 → 1` 缩容暂停、精确 child 环境、输出摘要、direct fallback、错误 run id fail-closed、partial receipt 与失败清理，以及 marker 对 stage receipt 的 schema/status/run/source/path/digest/identity、完整 stage semantics、关键 output digest 绑定、发布后篡改和 release-preview wrong-source 拒绝。

# #1418 frontend build readiness DAG

Frontend release build 以 `createFrontendBuildStages()` 返回值作为机器可读 inventory。每个 stage 必须声明
`consumedInputs`、`producedArtifacts`、`ownedOutputs` 和 `dependsOn`；receipt 同时封存 source identity、stage
状态、独占输出 digest 与逐 artifact digest。final readiness 逐项核对这些声明，因此任一 mandatory stage 未成功、
artifact 缺失、source 不一致或 digest 漂移都会 fail closed。

## 真实依赖

- `vue-tsc` 读取源码和生成的 public page manifest，不读取 `public/wasm`，因此不等待 `ensure-wasm`。
- run-bound client Vite build 读取源码与稳定的 `public`，只等待两个源码生成器；WASM preparation 写入独立
  run root 并与其并行，随后由 `sync-run-bound-public-assets` 装配 run-bound WASM。非 run-bound fallback
  仍从 `public/wasm` 读取，因此保留对 `ensure-wasm` 的真实依赖。
- public SSR build 读取 public renderer 源码、生成的 page manifest 与 emergency CSS，不读取 typecheck
  output 或 client `dist/assets`，因此可与 `vue-tsc` 并行。
- stable SPA entry 由 `vite-build` 在同一独占 `dist/assets` ownership 内生成；emergency CSS 由 SSR stage
  在同一独占 `dist/server` ownership 内装配。不得恢复 `dist/assets`/child 或 `dist/server`/child 的双 owner。
- run-bound build 在任何 stage admission 前只清理一次本次唯一 dist root；client Vite 固定使用
  `emptyOutDir=false`，禁止在 SSR 已开始后清空共享 root。非 run-bound direct fallback 保留 Vite 默认语义。
- backend wwwroot sync 是 final artifact join，等待 client、SSR、WASM 与 markdown runtime artifacts 全部完成。
- client、SSR 与 run-bound WASM 分别占用 `frontend-dist-client`、`frontend-dist-server` 和
  `frontend-dist-wasm`；共享 root 已由 admission 前置清理保护，不能再用粗粒度 `frontend-dist` 锁把互不覆盖的
  子树重新串行化。

## Readiness 与诊断

`frontend-build-stages.json` 的 `diagnostics` 记录本次真实 critical path、stage overlap、CPU/memory work、
produced artifact bytes 和 wait reasons。比较变更前后的 fresh receipt 即可形成 before/after evidence；运行时长
仅用于定位关键路径，不设置固定时间门禁。无依赖 stage 的 receipt 顺序变化不会导致 finalizer 失败。

2026-07-22 的本地 run-bound 验收使用同一 checkout、同一输出布局与 6 CPU direct grant。第一轮保留粗粒度
`frontend-dist` 锁，receipt 为 `success`，wall time 49,939 ms；client Vite 34,952 ms 完成后 SSR 才 admission，
两者 overlap 为 0 ms，调度记录明确给出 SSR 的 `exclusiveResources: [frontend-dist]` wait。分离资源所有权后的
第二轮同样为 `success`，wall time 34,610 ms，client/SSR overlap 17,542 ms；critical path 为
`generate-public-shell-emergency -> vite-build -> sync-run-bound-public-assets -> sync-backend-wwwroot`，34,587 ms，
produced artifact 为 1,239,695 bytes。第二轮 WASM 命中刚由第一轮生成的缓存，因此 49,939/34,610 ms 只作为
现场诊断，不能单独解释为 DAG 加速率；可归因的验收事实是同一 client/SSR 输入下从 0 ms overlap 变为
17,542 ms overlap，且两个 receipt 都完整成功。第二轮 wait observations 仅有生成器/容量等待，不再出现
`frontend-dist` 独占锁等待。

聚焦验收：

```bash
node --test tests/tools/frontend-build-stage-dag.test.mjs \
  tests/tools/frontend-build-ready-marker.test.mjs \
  tests/tools/release-preview-readiness.test.mjs \
  tests/tools/privacy-zk-performance-inputs.test.mjs
```

负例覆盖 parent/child shared output、未被 ownership 覆盖的 artifact、missing/forged artifact、错误 source/run、
提前发布的 partial receipt，以及 dependency/input 声明漂移。

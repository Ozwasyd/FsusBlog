# Issue #1063 AEDS Wasm throughput handoff

## Scope and current boundary

- 本文保留 `#1063 [Performance] AEDS Wasm 吞吐优先 tier：SIMD/LTO、arena 复用与跨栈预算` 的实现与验证交接，不声明 GitHub issue 的实时状态或当前分支基线。
- Owner comments 中的初始 ABI v3 已由后续提交演进为 `fsusblog.aeds.v4`；本交付按 v4 token/epoch contract 验证，不恢复 v3。
- 本交付不改变 AEDS v2 wire、FrameType、POD、HTTP endpoint、scalar fallback 或 Service Worker N/N-1 路径。

## Verified implementation boundary

当前源码已经具备以下真实实现，而不是仅有编译参数声明：

- `aeds_decoder_basic` 使用 scalar `-Oz`、16 MiB initial / 256 MiB bounded growth；`aeds_decoder_speed` 使用 `-O3 -flto -msimd128`、固定 64 MiB 和 strict Binaryen 123 `wasm-opt -O4 --enable-simd`。
- `reserve`、decode attempt 与 `clear` 都推进 `uint64` epoch；stale input/payload token 无法再取 pointer/length/frame type。
- Worker 接收 transferred network `ArrayBuffer`，arena 只在 high-water mark 提升时扩容；payload 从 arena 复制一次取得 JS ownership，敏感 frame 立即清零。
- SIMD 由 `WebAssembly.validate` 探测；候选顺序是 speed → basic，候选不并行，成功 speed 不下载 basic，同一 frame 不双解码。
- compiled module cache key 为 immutable Wasm URL、ABI 和 Wasm SHA-256。

本次 hardening 补齐四项审计缺口：

1. runtime manifest 在任何 JS module 执行前对实际 module bytes 校验 SHA-256，再校验 Wasm identity、basic/speed 精确 feature/memory profile、有界动态 worker policy 和完整 pinned toolchain identity；module import cache 也绑定内容 hash。
2. decode budget 实际执行 JS → arena 与 arena payload → owned JS 两次 copy，逐次观察每次 decode 后的 memory pages 以统计真实 grow transition，并记录 measured/expected bytes、arena reuse、敏感清零；不再使用硬编码 copy model 或首尾 pages 猜测增长次数。
3. release semantic checker 把 browserless decode budget 的 `commitSha` 绑定 release manifest，并 fail closed 校验 artifact、compile、copy、arena、clear 与 speed no-grow 预算；browser summary 改由 diagnostics receipt 绑定，不参与 correctness status。
4. transport active request 上限从 `navigator.hardwareConcurrency` 动态解析，process evidence 使用 `os.availableParallelism`；ordinary decoder 与 browser diagnostics 都记录实际逻辑处理器数、解析后的产品并发值和安全边界，但 diagnostics runner 自身仍固定单 worker。

coverage ID `aeds-wasm-tier-cross-stack` 与 tier ID `aeds-frame-cost` 继续由普通 browserless server/decoder budget 证据拥有。真实 engine selection、fallback、Worker transfer 与 long-task 已迁到 browser diagnostics；迁移不是删除覆盖，也不能把 browser evidence 伪装成 ordinary correctness。

## Focused verification

不要求 Production Fresh 的收口命令：

```bash
cd src/frontend
pnpm vitest run --config vitest.config.ts ../../tests/frontend/unit/aedsWasmTier.test.ts
pnpm run type-check

cd ../..
node tools/operations/check-release-evidence-manifest.mjs --self-test
node tests/frontend/checks/wasm/check-aeds-export-handle.mjs
node tests/frontend/checks/runtime/check-worker-contracts.mjs
node tests/frontend/checks/perf/check-aeds-decode-budget.mjs
```

`check-aeds-decode-budget.mjs` 要求当前源码构建出的 fresh AEDS Wasm artifacts；缺少 artifact 必须报告 blocked，不能复用旧 summary。以上 focused verification 不要求浏览器，也不宣称真实 browser tier/fallback 已验证。

## Browser diagnostics handoff

真实 browser tier/fallback/transfer/load/long-task 只从 scheduled/manual diagnostics 执行：

```bash
bash tools/test/lanes/browser-diagnostics.sh \
  manual --category performance --workers 1
```

该目录固定一个外层 browser worker、内层 worker 1、0 retry 且无 dynamic inner pool，并把 AEDS browser summary 绑定 diagnostics 的 immutable source/build receipt。browser `unsupported`、launch failure 或 assertion failure 必须在 diagnostics receipt 中如实报告，不能伪装为通过；但 diagnostics evidence 不阻断或放行普通 correctness/release manifest。反过来，ordinary decoder budget 通过也不能宣称 browser diagnostics 已执行。

如需比较吞吐优化，可在同一 clean SHA、同一机器上保留多轮 decoder 与 browser diagnostics 原始 summary；多轮数据只用于性能判断，不是 correctness 成立条件。总任务的 Production Fresh 与最终 release manifest 仍按各自 DAG 执行，本 handoff 不宣称它们已经完成。

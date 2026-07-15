# Issue #1063 AEDS Wasm throughput handoff

## Scope and live state

- Live issue: `#1063 [Performance] AEDS Wasm 吞吐优先 tier：SIMD/LTO、arena 复用与跨栈预算`，当前仍为 OPEN。
- 审计基线：`master@2f448172b15852e70771f7447944213e8142abcc`。
- Owner comments 中的初始 ABI v3 已由后续提交演进为 `fsusblog.aeds.v4`；本交付按 v4 token/epoch contract 验证，不恢复 v3。
- 本交付不改变 AEDS v2 wire、FrameType、POD、HTTP endpoint、scalar fallback 或 Service Worker N/N-1 路径。

## Verified implementation boundary

当前源码已经具备以下真实实现，而不是仅有编译参数声明：

- `aeds_decoder_basic` 使用 scalar `-Oz`、16 MiB initial / 256 MiB bounded growth；`aeds_decoder_speed` 使用 `-O3 -flto -msimd128`、固定 64 MiB 和 strict Binaryen 123 `wasm-opt -O4 --enable-simd`。
- `reserve`、decode attempt 与 `clear` 都推进 `uint64` epoch；stale input/payload token 无法再取 pointer/length/frame type。
- Worker 接收 transferred network `ArrayBuffer`，arena 只在 high-water mark 提升时扩容；payload 从 arena 复制一次取得 JS ownership，敏感 frame 立即清零。
- SIMD 由 `WebAssembly.validate` 探测；候选顺序是 speed → basic，候选不并行，成功 speed 不下载 basic，同一 frame 不双解码。
- compiled module cache key 为 immutable Wasm URL、ABI 和 Wasm SHA-256。

本次 hardening 补齐三项审计缺口：

1. runtime manifest 在任何 JS module 执行前对实际 module bytes 校验 SHA-256，再校验 Wasm identity、basic/speed 精确 feature/memory profile、有界动态 worker policy 和完整 pinned toolchain identity；module import cache 也绑定内容 hash。
2. decode budget 实际执行 JS → arena 与 arena payload → owned JS 两次 copy，逐次观察每次 decode 后的 memory pages 以统计真实 grow transition，并记录 measured/expected bytes、arena reuse、敏感清零；不再使用硬编码 copy model 或首尾 pages 猜测增长次数。
3. release semantic checker 把 decode/browser evidence 的 `commitSha` 绑定 release manifest，并 fail closed 校验 artifact、compile、copy、arena、clear 与 speed no-grow 预算。
4. transport active request 上限从 `navigator.hardwareConcurrency` 动态解析，process evidence 使用 `os.availableParallelism`；两类 evidence 都记录实际逻辑处理器数、解析后的并发值和安全边界。

现有 coverage ID `aeds-wasm-tier-cross-stack`、tier ID `aeds-frame-cost` 和六个 evidence path 均保留，没有删除、改名或降级为静态证据。

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
node tests/frontend/checks/wasm/check-aeds-tier-browser.mjs
```

最后两项要求当前源码构建出的 fresh AEDS Wasm artifacts 和本机已安装浏览器；缺少 artifact/browser 必须报告 unsupported 或 blocked，不能复用旧 summary。

## Remaining release-final evidence

代码与 focused contracts 通过后，issue 仍不能因为一次性能运行而关闭。最终验收还需要同一 clean commit SHA 的三轮真实预算与浏览器证据，并保留每轮原始 summary：

```bash
sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"

cd src/frontend
npm run build:wasm
node ../../tools/frontend/ensure-wasm.mjs status
cd ../..

for round in 1 2 3; do
  FSUSBLOG_EVIDENCE_COMMIT_SHA="$sha" node tests/frontend/checks/perf/check-aeds-decode-budget.mjs
  cp .tmp/frontend/aeds-decode-budget/summary.json ".tmp/frontend/aeds-decode-budget/round-${round}.json"
  cp .tmp/release-evidence/aeds-decode-budget-summary.json ".tmp/release-evidence/aeds-decode-budget-round-${round}.json"

  FSUSBLOG_EVIDENCE_COMMIT_SHA="$sha" node tests/frontend/checks/wasm/check-aeds-tier-browser.mjs
  cp .tmp/frontend/aeds-wasm-browser/summary.json ".tmp/frontend/aeds-wasm-browser/round-${round}.json"
  cp .tmp/release-evidence/aeds-wasm-browser-summary.json ".tmp/release-evidence/aeds-wasm-browser-round-${round}.json"
done
```

三轮必须各自 `status=ok`、`commitSha=$sha`，且不得把 browser `unsupported` 伪装为通过。总任务的 Production Fresh 与最终 release manifest 收集仍在所有目标 issue 完成后执行；本 handoff 不宣称它们已经完成。

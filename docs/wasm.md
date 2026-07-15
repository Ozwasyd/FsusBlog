# WebAssembly 开发与发布契约

本文记录 FsusBlog 浏览器 Wasm 的构建身份、AEDS decoder tier、内存边界、运行时选择、诊断和验证方式。AEDS wire 契约仍以 `src/shared/Contracts/Validation/aeds-protocol.json` 与 `src/core/Algorithms/AEDS_V2_PROTOCOL.md` 为准；本页描述实现与发布，不新增协议版本。

## 目录与职责

| 路径 | 职责 |
|---|---|
| `src/frontend/wasm/aeds/` | AEDS v2 C++ decoder、CRC16、POD validation 与 Emscripten exports |
| `src/frontend/wasm/aeds/CMakeLists.txt` | basic/speed 两套受控目标 |
| `src/frontend/wasm/build.sh` | 多 variant 并行构建、严格 Binaryen 优化、artifact 汇总 |
| `tools/frontend/ensure-wasm.mjs` | source/output hash、ABI、toolchain 与 runtime manifest |
| `tools/frontend/ensure-binaryen.sh` | Binaryen 123 的架构选择、下载、SHA-256 校验与缓存 |
| `src/frontend/wasm/web/aeds.ts` | SIMD 探测、tier 选择、arena bridge 与运行时诊断 |
| `src/frontend/wasm/web/runtime/emscripten.ts` | Wasm hash 校验、compiled module 单飞缓存与 load timing |
| `src/frontend/src/workers/wasmDecode.worker.ts` | Worker decode、transfer timing、错误分类 |
| `src/frontend/src/services/binaryTransport.ts` | 网络 `ArrayBuffer` transferable 边界与 telemetry |

## AEDS artifact 与固定 ABI

发布目录必须同时包含：

```text
wasm/aeds-runtime-manifest.json
wasm/aeds_decoder_basic.js
wasm/aeds_decoder_basic.wasm
wasm/aeds_decoder_speed.js
wasm/aeds_decoder_speed.wasm
```

当前 ABI 为 `fsusblog.aeds.v4`。`aeds-runtime-manifest.json` 绑定 basic/speed 的 JS/Wasm SHA-256、内存模型、feature identity 和完整 Wasm toolchain。上层 `wasm-manifest.aeds` 再绑定 runtime manifest 与所有输出 hash，release manifest 的 `wasmArtifactHash` 最终绑定整包；任一层 hash 漂移都必须重建，不能把旧 artifact 重命名为新 tier。v4 把 arena/payload raw pointer export 收口为 `uint64` token + token-validated getter，旧 v3 module 因 ABI identity 不符不能被新 runtime 加载。

| tier | 编译/优化 | 内存 | 用途 |
|---|---|---|---|
| `basic` | `-Oz`、scalar | 16 MiB initial，256 MiB bounded growth | 无 SIMD 浏览器兼容路径 |
| `speed` | `-O3 -flto -msimd128`，Binaryen 123 `wasm-opt -O4 --enable-simd` 严格校验 | 64 MiB fixed，禁止 growth | 现代浏览器吞吐路径 |

speed 的 `wasm-opt` 还显式启用 Emscripten 产物已经使用的 bulk-memory 与 nontrapping-float-to-int validator feature。优化器缺失、版本不是 123、输入 validation 失败或输出失败都会终止构建；不得静默保留未优化文件并标记 `wasmOptValidated=true`。

## 其他 Wasm 模块

本次 AEDS tier 不改变 PoW、Search、Comment Privacy 或 Image Codec 的 ABI 和选择策略。PoW 仍生成 `fsus_pow_basic`、`fsus_pow_simd`、`fsus_pow_relaxed`、`fsus_pow_threads`，能力顺序为 threads → relaxed SIMD → SIMD128 → basic；任一候选失败时在同一任务内降级，不改变 `X-Fsus-Pow-Proof` 或服务端验证语义。PoW 基准继续使用：

```bash
cd src/frontend
npm run build:wasm
npm run bench:pow-wasm
```

默认输出 `.tmp/perf/pow-wasm.json`。Search/Image/Privacy artifact 继续由同一个 `wasm/build.sh` 和 `wasm-manifest.*` 管理；AEDS 的 strict Binaryen failure 不能通过跳过或降级这些无关模块来掩盖，反之无关模块的可选性能优化失败也不能把未校验 AEDS speed 标成 optimized。

生产 Docker builder 固定为：

```text
emscripten/emsdk:4.0.13@sha256:520088b81877b610389dfd4cf7fb8c69f3ae41a611b0f80e222f57dafd930973
```

同时固定 CMake `4.3.3`、Binaryen `123` 与 vcpkg commit `eae1680538b86f962455c27abca2aad0dc304a4d`。禁止使用无 digest 的 `latest` 作为性能证据身份。本机构建可以使用另一受支持 compiler，但 manifest 必须记录实际 `emscriptenVersion`，不能冒充生产 builder。

## 内存与并发模型

服务端 binary request 的总上限是 8 MiB；公开 hot-read artifact 当前上限更低。前端 AEDS runtime 因此固定：

- `AEDS_MAX_FRAME_BYTES = 8 MiB`；超限 frame 在复制进 Wasm 前拒绝。
- 每个页面只保留一个 decode Worker；最多两个 active request，其余进入有界队列。
- speed 预留 64 MiB，容纳 8 MiB frame、128 KiB CRC pair table、Emscripten heap/stack 和 decode/render 临时空间，不允许 decode 中途 grow。
- basic 可以 bounded growth；运行时记录初始/峰值 pages 与 grow count。

C++ 使用一个可复用 I/O arena：

1. `_reserve_io_buffer(size)` 只在 high-water mark 提升时扩容并返回新的 `uint64` input token；常规 frame 不执行 `malloc/free`。
2. JS 以该 token 调 `_get_io_buffer_ptr(token)`，将网络 frame 复制一次到 arena；stale token 只返回空地址。
3. `_decode_io_buffer(token, size)` 原地校验并使 input token 失效；成功后通过新的 payload token 读取同一 arena slice，不再复制到第二个 C++ vector。
4. JS 只复制一次 payload 取得稳定所有权，随后 adapter 才解析 ViewModel。
5. 下一帧 reserve 前清零上次 active bytes并推进 handle epoch；旧 payload token 的 ptr/len/type getter 全部返回零，避免跨调用读取漂移内容。
6. auth/admin/private 等非公开 frame 返回 JS 副本后立即 `_clear_io_buffer(0)`；清零但保留 capacity。Worker 销毁时由 Wasm 实例整体释放。

arena diagnostics 包含 capacity、reallocation count 和 clear count。arena/payload 地址 export 使用 `uintptr_t`，`-sWASM_BIGINT=1` 保留 `uint64` token；`FSUSBLOG_AEDS_MEMORY64=ON` 可构建 memory64 验证产物，这两类地址不得经 `uint32` 截断。speed 正常 decode 的 memory pages 必须保持不变；任何 grow 都是 release evidence failure 候选。

## Tier 选择与回退

运行时通过一个最小合法 SIMD Wasm module 调用 `WebAssembly.validate`，不读取 User-Agent。选择顺序固定：

```text
SIMD supported: speed -> basic
SIMD unsupported: basic
```

候选按顺序加载，不并发预取 basic+speed。speed 的 JS import、manifest/hash、compile 或 instantiate 失败时才开始 basic；同一个 frame 只交给成功初始化的一个 tier 解码，不先 speed decode 再 basic decode。若 manifest/ABI/hash 无法验证，Worker fail closed，不请求旧文本 API。

`loadEmscriptenModule` 在 fetch 后校验 manifest SHA-256，并按以下 key 缓存 `Promise<WebAssembly.Module>`：

```text
immutable wasm URL | ABI | wasm SHA-256
```

相同 Worker 生命周期内初始化、takeover 或并发 caller 复用同一 compile promise。页面 bootstrap 不在 main realm 预编译 AEDS；小 frame 使用 TypeScript no-copy validator，大 frame 首次进入 singleton Worker 时才加载选定 tier，避免 main page 与 Worker 对同一 module 重复 compile。失败 promise 会从 cache 删除，允许后续受控重试。release asset URL 使用 `/release-assets/{buildId}/wasm/**`，Service Worker/cache 与 release storage 保留 N/N-1；不同 release、ABI 或 hash 不共享 compiled module。

## 跨栈 copy 与诊断

`binaryRequest()` 返回的 `ArrayBuffer` 通过：

```ts
worker.postMessage(request, [request.buffer])
```

转移所有权，不 structured-clone 整个 frame。当前可解释 copy 模型是：

- network/main → Worker：transferable，0 次完整 byte copy；
- Worker JS → Wasm arena：1 次，记录 `jsToWasmCopiedBytes`；
- Wasm arena payload → Worker JS owned payload：1 次，记录 `wasmToJsCopiedBytes`；
- adapter → ViewModel：按 POD/slice 语义解析，不重新复制完整 frame。

`getAedsRuntimeDiagnostics()` 暴露 selected tier、SIMD support、fallback reason/count、download/compile/instantiate timing、module-cache hit、decode count/bytes/time、frame bucket p50/p95/p99、copy bytes、memory pages/peak/grow、arena stats。Worker 额外记录 transferable 到达时间；`binaryTransport` 只在 tier/fallback signature 改变时发送一次 `aeds_wasm_tier` audit telemetry，避免失败风暴。持续 RUM 复用白名单 `wasm_decode_timing`。

`aeds-frame-cost` lane 串行执行服务端 frame cost、真实 basic/speed Wasm 预算和浏览器 tier 测试，避免并发 benchmark 噪声。浏览器 evidence 在 Chromium/Firefox/WebKit 的本机受支持集合中记录 download/compile/instantiate、Worker transfer、decode bucket、copy bytes、peak/grow pages、long task、selection rate 与 fallback rate；正常路径必须只取 speed，故障注入后必须只回退 basic。hydration takeover 使用同一个 release manifest 中的 `publicHydrationSidecarSummary` 真实页面证据，不能用 Node microbenchmark 或合成 DOM 代替。

release budget 固定为：basic raw/gzip/br 不超过 64/32/24 KiB、compile p95 不超过 50 ms、memory 不超过 4096 pages；speed raw/gzip/br 不超过 96/48/40 KiB、compile p95 不超过 75 ms、固定 1024 pages 且 grow=0。三个真实 frame bucket 至少两个 speed 更快，median speedup 不低于 1.05。budget 与浏览器 summary 都进入 release evidence semantic checker，缺失或不满足时 manifest 保持 `collected-blocked`。

## CRC 与 correctness 边界

wire CRC 仍是 payload 上的 CRC16/Modbus (`0xA001`)，没有改变 AEDS v2 header、flags、FrameType 或 payload。真实性能采样证明大 frame 的标量 CRC 是 dominant path 后，speed tier 使用运行时一次性生成的 65,536-entry pair table，每次处理 2 bytes；basic 保留逐 byte table。pair table 位于 BSS，不把 128 KiB 常量写入下载 artifact。

任何 CRC/parser 优化都必须通过 basic/speed 同种子差分 fuzz，并覆盖：short/truncated、magic/version/header length、payload length、CRC、frame type、unaligned、large frame 和 malformed ArticleDetail。禁止重新引入 AEDS v1 或文本 fallback。

## 构建与验证

```bash
cd src/frontend
npm run build:wasm
node ../../tools/frontend/ensure-wasm.mjs status
```

构建并发度由在线 CPU/可用内存和 scheduler grant 动态推导。Binaryen/CMake bootstrap 使用 `.tmp/dependency-cache`、文件锁和 SHA-256；fresh output cleanup 不删除受控 dependency cache。

定向验证：

```bash
# ABI/hash/toolchain/runtime artifact
cd src/frontend && node ../../tools/frontend/ensure-wasm.mjs status

# basic/speed 真实吞吐、artifact raw/gzip/br、compile、memory、copy/arena
cd ../.. && node tests/frontend/checks/perf/check-aeds-decode-budget.mjs

# 受支持真实浏览器的 tier/fallback/transfer/load/long-task evidence
node tests/frontend/checks/wasm/check-aeds-tier-browser.mjs

# basic/speed differential fuzz（release build 后）
FSUSBLOG_WASM_FUZZ_SEEDS_PER_CORPUS=256 node tools/security/run-wasm-fuzz.mjs

# exports handle epoch、native 64-bit pointer、ASAN/UBSAN 与 libFuzzer
npm run check:aeds-export-handle

# runtime selection/协议负矩阵
cd src/frontend
pnpm vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/aedsWasmTier.test.ts \
  ../../tests/frontend/unit/wasmReleaseAssets.test.ts \
  ../../tests/frontend/unit/protocol/aeds-contract.test.ts
```

性能 summary 写入 `.tmp/frontend/aeds-decode-budget/summary.json`，release 投影写入 `.tmp/release-evidence/aeds-decode-budget-summary.json`；浏览器对应写入 `.tmp/frontend/aeds-wasm-browser/summary.json` 与 `.tmp/release-evidence/aeds-wasm-browser-summary.json`。fuzz summary 必须标记 `executionSource=fresh-wasm-runtime`，同时列出 basic/speed SHA-256、非零 seeds、replay plan 和空 crash 集合。

## 风险与无需重启的回退

- speed load/compile/instantiate/hash failure：当前 Worker 顺序切到 basic，记录原因；服务端无需重启。
- speed runtime 指标回归：通过下一 frontend release 的 immutable manifest 将默认候选限制为 basic；N/N-1 asset 继续保留。
- basic/speed 都不可用：Worker 返回 `wasm_init_failed`，上层显示 binary transport failure；不得改走 JSON/text API。
- 敏感清理异常、stale handle、ABI/hash 漂移或 differential fuzz mismatch：release gate fail closed，不能用 feature flag 忽略 correctness。
- v4 客户端需要回退时，通过下一份 immutable v4 release manifest 把候选限制为 basic 或切回已验证的 v4 N-1 资产；服务端无需重启。不得为了回退混载/恢复不带 handle 校验的 v3 module，也不得改走 JSON/text API；没有安全 v4 资产时保持 binary transport fail closed。

## 相关契约

- `docs/api/contracts.md`：AEDS HTTP/POD 与浏览器 decode 边界
- `docs/api/schemas-and-errors.md`：POD size 与错误目录
- `src/core/Algorithms/AEDS_V2_PROTOCOL.md`：AEDS v2 wire 规格
- `src/shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md`：C++/C# 对齐清单
- `docs/testing.md`：fresh fuzz 与 release evidence 规则

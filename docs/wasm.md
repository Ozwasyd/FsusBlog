# WebAssembly 开发与发布契约

本文记录 FsusBlog 浏览器 Wasm 的构建身份、AEDS decoder tier、内存边界、运行时选择、诊断和验证方式。AEDS wire 契约仍以 `src/shared/Contracts/Validation/aeds-protocol.json` 与 `src/core/Algorithms/AEDS_V2_PROTOCOL.md` 为准；本页描述实现与发布，不新增协议版本。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `src/frontend/wasm/aeds/` | AEDS v2 C++ decoder、CRC16、POD validation 与 Emscripten exports |
| `src/frontend/wasm/aeds/CMakeLists.txt` | basic/speed 两套受控目标 |
| `src/frontend/wasm/build.sh` | 多 variant 并行构建、严格 Binaryen 优化、artifact 汇总 |
| `tools/frontend/ensure-wasm.mjs` | canonical producer：source/output hash、ABI、toolchain 与 runtime manifest |
| `tools/frontend/wasm-build-receipt.mjs` | source-bound build receipt、immutable identity 快速校验与 checksum 投影 |
| `tools/frontend/ensure-binaryen.sh` | Binaryen 123 的架构选择、下载、SHA-256 校验与缓存 |
| `src/frontend/wasm/web/aeds.ts` | SIMD 探测、tier 选择、arena bridge 与运行时诊断 |
| `src/frontend/wasm/web/runtime/emscripten.ts` | Wasm hash 校验、compiled module 单飞缓存与 load timing |
| `src/frontend/src/workers/wasmDecode.worker.ts` | Worker decode、transfer timing、错误分类 |
| `src/frontend/src/services/binaryTransport.ts` | 网络 `ArrayBuffer` transferable 边界与 telemetry |
| `build/artifacts/wasm-release/` | 每次 release/CI 临时生成的可搬运 package；被 Git 忽略，不是源码基线 |

## Artifact ownership：Option B

`build/artifacts/wasm-release/` 明确采用 **Option B：生成产物不进入 Git**。仓库只保存 Wasm 源码、`wasm/build.sh`、`ensure-wasm.mjs` 的 schema/ABI/output contract，以及 Dockerfile/工具脚本中的固定 toolchain identity。这样 ABI 或输出集合变化只有一个源码契约需要维护，不再依赖人工同时更新一组不可 review 的二进制文件。

受控链路如下：

1. `tools/build-wasm-artifact.sh` 用 pinned `wasm-builder` fresh 构建到临时目录，不读取仓库历史中的 Wasm binary。
2. 生成的 `wasm-manifest.aeds` 必须是 schema `3`、`aedsAbi=fsusblog.aeds.v4`，其 output set/hash、runtime manifest 与当前 `ensure-wasm` source hash 完全一致。
3. frontend build 的 `ensure-wasm` 是唯一 canonical producer：完成真实 build、完整 source/output hash 与 ownership 校验后，原子写入 `wasm-build-receipt.json`。receipt 绑定 worktree/source、toolchain、build args/features、input tree、output hash/size、manifest digest table、ownership policy、producer run ID 与 content digest。
4. 同一 Production fresh 内，production-build-artifacts、Browser Contract、visual 与 final-image host path 只执行 exact receipt/immutable identity 校验；该路径的 source traversal 与 output hash 均为 `0`。receipt 不存在、歧义、source/toolchain/args/policy/output identity 漂移时 fail closed，consumer 不得自行 build，只能回到 canonical producer。
5. `.dockerignore` 只为 Docker context 重新纳入这个已生成目录。跨 Docker COPY 的 inode 会变化，因此 producer 从 receipt 的既有 output digest 投影一次 `SHA256SUMS`（不重读 output）；BuildKit copy 后只执行一次 checksum transport 校验，再校验 receipt envelope，不再执行第二次 `ensure-wasm` 全树扫描。
6. Quality Gate 的 `wasm-build-artifacts` job 是该 workflow run 唯一的 Wasm package producer：它 fresh 构建 `build/artifacts/wasm-release/`，并把 manifest、receipt 与输出作为同名短期 Actions artifact 上传。frontend runtime contracts、frontend build 与 immutable production build 必须先依赖该 job，再从当前 commit、run、attempt 下载该 artifact；不得各自重建、复用历史 run、用仅有 receipt 的不完整 package，或以 skipped producer 继续。
7. Quality Gate 将 fresh `payload/wasm` 连同 immutable production-build receipt 上传为短期 Actions artifact。最终 OCI image 内的 `SHA256SUMS` hash 写入 release manifest 的 `wasmArtifactHash`，消费方绑定该 digest，而不是 Git 路径中的旧 binary。

`.gitignore` 必须持续忽略该目录，仓库中出现任何 tracked `build/artifacts/wasm-release/**` 都是治理错误。`FSUSBLOG_FINAL_SKIP_WASM=1` 只允许同一工作区断点续用已经生成且立即通过 exact receipt 与 ownership policy 复核的 package；它不能把缺失、stale、自报错误 toolchain 或被篡改的 package 变成可发布状态。

若 `wasm-build-artifacts` 未上传完整 package，或下游无法证明 artifact 来自当前 workflow run，相关主 Quality Gate job 必须 fail closed。绿色的本地构建、自报 manifest/receipt、其他 job 的临时重建或历史 artifact 都不能替代这项远端证据。

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

runtime 在 import tier 前会先读取实际 JS module bytes 并校验 `moduleSha256`，再校验 Wasm bytes；两套 artifact 的 hash identity、basic/speed feature 与精确内存 profile、有界动态 Worker 策略，以及 Emscripten/Binaryen/CMake/vcpkg/emsdk digest 任一不符都会 fail closed。JS import URL 绑定 module hash，缺失或篡改 `moduleSha256`、把 basic 伪装成 fixed/SIMD、把 speed 伪装成未增长或使用非 pinned Binaryen identity 都不能进入执行路径。

| tier | 编译/优化 | 内存 | 用途 |
| --- | --- | --- | --- |
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
emscripten/emsdk:6.0.0@sha256:9eed2e47b4206928b22f99d2917013ad5462d777bb24cb546a652729896badd8
```

同时固定 CMake `4.3.3`、Binaryen `123` 与 vcpkg commit `eae1680538b86f962455c27abca2aad0dc304a4d`。这些值与上述 emsdk image/digest 一起由 `ensure-wasm.mjs` 的单一权威 contract 导出；outer/runtime manifest 必须逐字段完全一致。其他 compiler 可用于本地实验，但不能生成通过 `ensure-wasm status` 的 release package，也不能冒充生产 builder。

## 内存与并发模型

服务端 binary request 的总上限是 8 MiB；公开 hot-read artifact 当前上限更低。前端 AEDS runtime 因此固定：

- `AEDS_MAX_FRAME_BYTES = 8 MiB`；超限 frame 在复制进 Wasm 前拒绝。
- 每个页面只保留一个 decode Worker；active request 上限按 `navigator.hardwareConcurrency` 动态解析，在 manifest 声明的 `1..8` 安全边界内每两个逻辑处理器分配一个，请求队列容量再随该上限缩放。
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

`loadEmscriptenModule` 在任何 JS 执行前校验实际 module bytes 的 manifest SHA-256，以 hash query 隔离动态 import cache；Wasm bytes 同样在 compile 前校验，并按以下 key 缓存 `Promise<WebAssembly.Module>`：

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

`getAedsRuntimeDiagnostics()` 暴露 selected tier、SIMD support、fallback reason/count、download/compile/instantiate timing、module-cache hit、decode count/bytes/time、frame bucket p50/p95/p99、copy bytes、memory pages/peak/grow、arena stats。Worker 额外记录 transferable 到达时间；`binaryTransport` 只在 tier/fallback signature 改变时发送一次 `aeds_wasm_tier` audit telemetry，避免失败风暴。持续 RUM 复用白名单 `wasm_decode_timing`。性能 lane 必须实际执行 arena input copy 与 owned payload copy，并让 measured/expected byte counters 完全相等；写死“每帧 1 次”但不执行 copy 不构成证据。

普通 `aeds-frame-cost` lane 串行执行服务端 frame cost 与真实 basic/speed Wasm decoder budget，避免并发 benchmark 噪声；它不启动浏览器。Chromium/Firefox/WebKit 的 download/compile/instantiate、Worker transfer、decode bucket、copy bytes、peak/grow pages、long task、selection rate 与 fallback rate 已迁到 scheduled/manual browser diagnostics。diagnostics 正常路径必须只取 speed，故障注入后必须只回退 basic；hydration takeover 仍引用同一 immutable build 的真实 sidecar evidence，不能用 Node microbenchmark 或合成 DOM 代替。

普通 decoder budget 固定为：basic raw/gzip/br 不超过 64/32/24 KiB、compile p95 不超过 50 ms、memory 不超过 4096 pages；speed raw/gzip/br 不超过 96/48/40 KiB、compile p95 不超过 75 ms、固定 1024 pages 且 grow=0。三个真实 frame bucket 至少两个 speed 更快，median speedup 不低于 1.05。该 browserless budget 进入 release evidence semantic checker，缺失或不满足时 manifest 保持 `collected-blocked`。browser diagnostics summary 可随 manifest 收集用于观察，但不会改变 correctness/manifest status。

`aeds-decode-budget-summary.json` 必须携带当前 40-hex `commitSha`，并与 release manifest 完全一致。semantic checker 复核 artifact/compile 上限、真实 copy byte equality、arena reallocation 少于 decode count、敏感清零和 speed 1024 pages/grow=0；旧 SHA、缺字段或硬编码 copy 声明都不能完成 release closeout。`aeds-wasm-browser-summary.json` 绑定 diagnostics 的 immutable source/build identity，但它是 `diagnostic` evidence，不是普通 correctness 前置。

ordinary evidence producer 会先确认 `FSUSBLOG_EVIDENCE_COMMIT_SHA` / `GITHUB_SHA`（若提供）与当前 `HEAD` 相同，并拒绝 tracked worktree dirty 状态。未提交源码上的开发测量不能写成当前 commit decoder budget evidence；必须先提交、确认 clean，再运行 ordinary budget lane。browser diagnostics 通过自己的 immutable build receipt 与 run/category/probe receipt 绑定身份，不能复用旧 summary。

## CRC 与 correctness 边界

wire CRC 仍是 payload 上的 CRC16/Modbus (`0xA001`)，没有改变 AEDS v2 header、flags、FrameType 或 payload。真实性能采样证明大 frame 的标量 CRC 是 dominant path 后，speed tier 使用运行时一次性生成的 65,536-entry pair table，每次处理 2 bytes；basic 保留逐 byte table。pair table 位于 BSS，不把 128 KiB 常量写入下载 artifact。

任何 CRC/parser 优化都必须通过 basic/speed 同种子差分 fuzz，并覆盖：short/truncated、magic/version/header length、payload length、CRC、frame type、unaligned、large frame 和 malformed ArticleDetail。禁止重新引入 AEDS v1 或文本 fallback。

## 构建与验证

```bash
cd src/frontend
npm run build:wasm
node ../../tools/frontend/ensure-wasm.mjs status
```

构建并发度由在线 CPU/可用内存和 scheduler grant 动态推导。Binaryen/CMake bootstrap 使用 `.tmp/dependency-cache`、文件锁和 SHA-256；fresh output cleanup 不删除受控 dependency cache。Canonical WASM Docker producer 将 BuildKit cache mount 与真实读写目录逐项严格对齐（`/.tmp/dependency-cache`、`/.cache/emscripten`、`/.cache/vcpkg/downloads`、`/.cache/vcpkg/archives`）。四类 mount 共用由 pinned emsdk/CMake/Binaryen、vcpkg commit、`wasm32-emscripten` triplet 与 image-codec dependency feature 约束的 cache identity，因此源码层失效时可复用已验证的工具链与第三方依赖缓存；损坏的受控工具缓存必须在锁内重建。Cache 仍不作为 artifact correctness authority。

定向验证：

```bash
# ownership（默认不要求本地已有生成包）
node tools/check-wasm-artifact-ownership.mjs

# ABI/hash/toolchain/runtime artifact
(cd src/frontend && node ../../tools/frontend/ensure-wasm.mjs status)

# release package 已生成后，复核完整 package 与当前 source contract
node tools/frontend/wasm-build-receipt.mjs verify \
  --root . --client-root src/frontend --artifact-dir build/artifacts/wasm-release

# basic/speed 真实吞吐、artifact raw/gzip/br、compile、memory、copy/arena
cd ../.. && node tests/frontend/checks/perf/check-aeds-decode-budget.mjs

# 受支持真实浏览器的 tier/fallback/transfer/load/long-task diagnostics
bash tools/test/lanes/browser-diagnostics.sh manual --category performance --workers 1

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

普通性能 summary 写入 `.tmp/frontend/aeds-decode-budget/summary.json`，release correctness 投影写入 `.tmp/release-evidence/aeds-decode-budget-summary.json`。browser diagnostics 另写 `.tmp/frontend/aeds-wasm-browser/summary.json` 与 `.tmp/release-evidence/aeds-wasm-browser-summary.json`，并由 browser diagnostics receipt 归档；这些 browser 文件的缺失、unsupported 或失败不会阻断普通 correctness，也不能替代 decoder budget。fuzz summary 必须标记 `executionSource=fresh-wasm-runtime`，同时列出 basic/speed SHA-256、非零 seeds、replay plan 和空 crash 集合。

## 风险与无需重启的回退

- 生成 package 缺失、stale、hash/toolchain 不一致：release 构建在装入 image 前终止；修复后从 `wasm-artifact` checkpoint 重建，不需要服务端重启，也不得恢复已删除的 tracked binary。
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

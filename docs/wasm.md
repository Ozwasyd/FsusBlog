# WebAssembly Development and Release Contract

This document defines browser-Wasm build identity, AEDS decoder tiers, memory boundaries, runtime selection, diagnostics, and verification. The AEDS wire contract remains [`src/shared/Contracts/Validation/aeds-protocol.json`](../src/shared/Contracts/Validation/aeds-protocol.json) and [`src/core/Algorithms/AEDS_V2_PROTOCOL.md`](../src/core/Algorithms/AEDS_V2_PROTOCOL.md); this page describes implementation/release and adds no protocol version.

## Paths and responsibilities

| Path | Responsibility |
| --- | --- |
| `src/frontend/wasm/aeds/` | AEDS v2 C++ decoder, CRC16, POD validation, Emscripten exports |
| `src/frontend/wasm/aeds/CMakeLists.txt` | Controlled `basic`/`speed` targets |
| `src/frontend/wasm/build.sh` | Parallel variants, strict Binaryen optimization, artifact aggregation |
| `ops/docker/wasm-producer-inputs.json` | Canonical Docker producer's machine-checkable input/COPY closure |
| `tools/frontend/wasm-producer-inputs.mjs` | Projects that closure to manifest/receipt input-tree identity |
| `tools/frontend/ensure-wasm.mjs` | Canonical source/output hashes, ABI, toolchain, runtime manifest producer |
| `tools/frontend/wasm-build-receipt.mjs` | Source-bound receipt, immutable-identity check, checksum projection |
| `tools/frontend/ensure-binaryen.sh` | Binaryen 123 architecture selection, download, SHA-256 check, cache |
| `src/frontend/wasm/web/aeds.ts` | SIMD detection, tier selection, arena bridge, runtime diagnostics |
| `src/frontend/wasm/web/runtime/emscripten.ts` | Wasm hash check, single-flight compiled-module cache, load timing |
| `src/frontend/src/workers/wasmDecode.worker.ts` | Worker decode, transfer timing, error classification |
| `src/frontend/src/services/binaryTransport.ts` | Transferable network `ArrayBuffer` boundary and telemetry |
| `build/artifacts/wasm-release/` | Git-ignored release/CI package; generated, not a source baseline |

## Artifact ownership: Option B

`build/artifacts/wasm-release/` uses **Option B: generated artifacts stay out of Git**. The repository keeps Wasm source, `wasm/build.sh`, `ensure-wasm.mjs` schema/ABI/output contracts, and pinned toolchain identity in Dockerfiles/scripts; ABI or output-set changes therefore update one reviewable source contract, not hand-maintained binaries.

Controlled path:

1. `tools/build-wasm-artifact.sh` fresh-builds into a temporary directory with pinned `wasm-builder`; it never reads historical Wasm binaries.
2. `wasm-manifest.aeds` must be schema `3`, `aedsAbi=fsusblog.aeds.v4`, and exactly match the current `ensure-wasm` source hash, output set/hashes, and runtime manifest.
3. Frontend `ensure-wasm` is the sole canonical producer. After real build, full source/output hash, and ownership checks, it atomically writes `wasm-build-receipt.json`, binding worktree/source, toolchain, build args/features, input tree, output hash/size, manifest digest table, ownership policy, producer run ID, and content digest.
4. In one Production Fresh run, production-build-artifacts, Browser Contract, visual, and final-image hosts perform exact-receipt/immutable-identity checks only; their source traversal and output hash are `0`. Missing/ambiguous receipts or source/toolchain/args/policy/output drift fail closed; consumers cannot build and must return to the canonical producer.
5. `.dockerignore` re-includes only this generated directory in Docker context. Because Docker COPY changes inodes, the producer projects `SHA256SUMS` once from receipt output digests (without rereading output); after BuildKit copy, run one checksum transport check and receipt-envelope check, not a second `ensure-wasm` tree scan.
6. Quality Gate's `wasm-build-artifacts` is the workflow run's sole package producer. It fresh-builds `build/artifacts/wasm-release/` and uploads manifest, receipt, and output as a same-name short-lived Actions artifact. Frontend runtime contracts/build/immutable production build depend on it and download from the current commit/run/attempt; they must not rebuild, reuse a historical run, use a receipt-only package, or continue after a skipped producer.
7. Quality Gate uploads fresh `payload/wasm` with the immutable production-build receipt. The final OCI image's `SHA256SUMS` hash is written to release `wasmArtifactHash`; consumers bind that digest, not an old Git-path binary.

`.gitignore` must keep this directory ignored; any tracked `build/artifacts/wasm-release/**` is a governance error. `FSUSBLOG_FINAL_SKIP_WASM=1` may reuse only a package already generated in the same workspace and immediately passing exact-receipt/ownership checks; it cannot make a missing, stale, self-reported-toolchain, or modified package releasable.

If `wasm-build-artifacts` lacks a complete upload or downstream cannot prove the artifact came from the current workflow run, the owning Quality Gate job fails closed. Green local builds, self-reported manifests/receipts, another job's temporary rebuild, and historical artifacts cannot replace this remote evidence.

## AEDS artifact and fixed ABI

The release directory must contain all of:

```text
wasm/aeds-runtime-manifest.json
wasm/aeds_decoder_basic.js
wasm/aeds_decoder_basic.wasm
wasm/aeds_decoder_speed.js
wasm/aeds_decoder_speed.wasm
```

The ABI is `fsusblog.aeds.v4`. `aeds-runtime-manifest.json` binds basic/speed JS/Wasm SHA-256, memory model, feature identity, and the full toolchain; `wasm-manifest.aeds` binds that manifest and every output hash, and release `wasmArtifactHash` binds the package. Any hash drift requires a rebuild; an old artifact cannot be renamed as a new tier. v4 exposes arena/payload raw pointers only as `uint64` tokens with token-validated getters, so a v3 module's ABI identity prevents new-runtime loading.

Before importing a tier, runtime reads actual JS module bytes and checks `moduleSha256`, then checks Wasm bytes. Any mismatch in artifact hash identity, basic/speed features, exact memory profile, bounded dynamic-Worker policy, or Emscripten/Binaryen/CMake/vcpkg/emsdk digest fails closed. The JS import URL is bound to module hash; missing/tampered `moduleSha256`, basic masquerading as fixed/SIMD, speed masquerading as no-growth, or non-pinned Binaryen cannot run.

| Tier | Build/optimization | Memory | Use |
| --- | --- | --- | --- |
| `basic` | `-Oz`, scalar | 16 MiB initial, 256 MiB bounded growth | Browsers without SIMD |
| `speed` | `-O3 -flto -msimd128`, Binaryen 123 `wasm-opt -O4 --enable-simd`, strict validation | 64 MiB fixed, no growth | Modern-browser throughput |

Speed `wasm-opt` also explicitly enables the bulk-memory and nontrapping-float-to-int validator features used by Emscripten output. A missing optimizer, version other than 123, input-validation failure, or output failure terminates the build; never keep an unoptimized file while claiming `wasmOptValidated=true`.

## Other Wasm modules

AEDS tier changes do not alter PoW, Search, Comment Privacy, or Image Codec ABI or selection. PoW still emits `fsus_pow_basic`, `fsus_pow_simd`, `fsus_pow_relaxed`, and `fsus_pow_threads`, selected threads → relaxed SIMD → SIMD128 → basic; a failed candidate falls back within the same task without changing `X-Fsus-Pow-Proof` or server verification. Run PoW benchmarks with:

```bash
cd src/frontend
npm run build:wasm
npm run bench:pow-wasm
```

The default output is `.tmp/perf/pow-wasm.json`. Search/Image/Privacy artifacts remain managed by the same `wasm/build.sh` and `wasm-manifest.*`. A strict AEDS Binaryen failure cannot be hidden by skipping/degrading unrelated modules, and an optional optimization failure in those modules cannot mark unvalidated AEDS speed as optimized.

The production Docker builder is pinned to:

```text
emscripten/emsdk:6.0.0@sha256:9eed2e47b4206928b22f99d2917013ad5462d777bb24cb546a652729896badd8
```

CMake `4.3.3`, Binaryen `123`, and vcpkg commit `eae1680538b86f962455c27abca2aad0dc304a4d` are also fixed. `ensure-wasm.mjs` exports these values with the emsdk image/digest as one authority; outer and runtime manifests must match field-for-field. Other compilers are local-only experiments and cannot produce an `ensure-wasm status`-valid release package or represent the production builder.

## Memory and concurrency

The server binary-request ceiling is 8 MiB (the public hot-read artifact is currently lower). The frontend AEDS runtime therefore fixes:

- `AEDS_MAX_FRAME_BYTES = 8 MiB`; reject an oversized frame before copying it into Wasm.
- One decode Worker per page. Resolve the active-request cap from `navigator.hardwareConcurrency` within the manifest's safe `1..8` range, allocating one request per two logical processors; scale queue capacity with that cap.
- Speed reserves 64 MiB for an 8 MiB frame, 128 KiB CRC pair table, Emscripten heap/stack, and decode/render temporaries; it cannot grow during decode.
- Basic permits bounded growth and records initial/peak pages and grow count.

C++ uses one reusable I/O arena:

1. `_reserve_io_buffer(size)` grows only above the high-water mark and returns a new `uint64` input token; ordinary frames do not `malloc/free`.
2. JS calls `_get_io_buffer_ptr(token)` and copies the network frame once into the arena; a stale token returns a null address.
3. `_decode_io_buffer(token, size)` validates in place and invalidates the input token. Success returns a new payload token for the same arena slice, with no second C++ vector copy.
4. JS copies the payload once for stable ownership; the adapter then parses the ViewModel.
5. Before the next reserve, clear the prior active bytes and advance the handle epoch. Old payload-token ptr/len/type getters all return zero, preventing cross-call reads of stale content.
6. After returning JS copies for non-public auth/admin/private frames, call `_clear_io_buffer(0)` immediately; retain capacity after clearing. Worker destruction releases the Wasm instance.

Arena diagnostics include capacity, reallocation count, and clear count. Arena/payload address exports use `uintptr_t`; `-sWASM_BIGINT=1` preserves `uint64` tokens, and `FSUSBLOG_AEDS_MEMORY64=ON` builds a memory64 validation artifact. Neither address type may be truncated to `uint32`. Speed memory pages must remain constant during normal decode; any grow is a release-evidence failure candidate.

## Tier selection and fallback

Runtime calls `WebAssembly.validate` on a minimal valid SIMD Wasm module and does not read User-Agent. Selection is fixed:

```text
SIMD supported: speed -> basic
SIMD unsupported: basic
```

Load candidates in order; do not prefetch basic and speed concurrently. Start basic only after speed JS import, manifest/hash, compile, or instantiate fails; give a frame to only the successfully initialized tier, never speed-decode then basic-decode. If manifest/ABI/hash validation fails, the Worker fails closed and does not request a legacy text API.

Before any JS executes, `loadEmscriptenModule` hashes actual module bytes against the manifest SHA-256; a hash query isolates dynamic-import cache. Wasm bytes are also checked before compile, and `Promise<WebAssembly.Module>` is cached by:

```text
immutable wasm URL | ABI | wasm SHA-256
```

Within one Worker lifetime, initialization, takeover, and concurrent callers reuse one compile promise. Page bootstrap does not precompile AEDS in the main realm; small frames use the TypeScript no-copy validator, while a large frame loads the selected tier only on first entry to the singleton Worker, avoiding duplicate compile. Failed promises are removed for controlled retry. Release URLs use `/release-assets/{buildId}/wasm/**`; Service Worker/cache and release storage retain N/N-1, and different release, ABI, or hash identities never share a compiled module.

## Cross-stack copies and diagnostics

`binaryRequest()` returns an `ArrayBuffer` through:

```ts
worker.postMessage(request, [request.buffer])
```

This transfers ownership instead of structured-cloning the frame. The explained copy model is:

- network/main → Worker: transferable, zero full-byte copies;
- Worker JS → Wasm arena: one copy, recorded as `jsToWasmCopiedBytes`;
- Wasm arena payload → Worker-owned JS payload: one copy, recorded as `wasmToJsCopiedBytes`;
- adapter → ViewModel: POD/slice parsing, no full-frame copy.

`getAedsRuntimeDiagnostics()` exposes selected tier, SIMD support, fallback reason/count, download/compile/instantiate timing, module-cache hits, decode count/bytes/time, frame-bucket p50/p95/p99, copy bytes, memory pages/peak/grow, and arena stats. The Worker also records transferable arrival time; `binaryTransport` sends one `aeds_wasm_tier` audit telemetry event only when the tier/fallback signature changes, preventing failure storms. Continuous RUM uses allowlisted `wasm_decode_timing`. The performance lane must execute both arena input and owned-payload copies and make measured/expected byte counters equal; hard-coding “one copy per frame” without copying is not evidence.

The ordinary `aeds-frame-cost` lane serializes server frame cost and real basic/speed decoder budgets without launching a browser, avoiding benchmark noise. Chromium/Firefox/WebKit download/compile/instantiate, Worker transfer, decode buckets, copy bytes, peak/grow pages, long tasks, selection rate, and fallback rate belong to scheduled/manual browser diagnostics. Diagnostics must select only speed normally and only basic after injected failure. Hydration takeover still references real sidecar evidence from the same immutable build; Node microbenchmarks and synthetic DOM are not substitutes.

The decoder budget is fixed: basic raw/gzip/br ≤ `64/32/24 KiB`, compile p95 ≤ `50 ms`, memory ≤ `4096` pages; speed raw/gzip/br ≤ `96/48/40 KiB`, compile p95 ≤ `75 ms`, fixed `1024` pages, `grow=0`. Speed must be faster in at least two of three real frame buckets, with median speedup ≥ `1.05`. The browserless budget enters the release-evidence semantic checker; missing or failing data leaves the manifest `collected-blocked`. Browser diagnostics summaries may be collected for observation but do not change correctness/manifest status.

`aeds-decode-budget-summary.json` must carry the current 40-hex `commitSha` and match the release manifest. The semantic checker rechecks artifact/compile ceilings, real copy-byte equality, arena reallocations below decode count, sensitive clearing, and speed `1024` pages/`grow=0`; an old SHA, missing field, or hard-coded copy claim cannot close release. `aeds-wasm-browser-summary.json` binds diagnostics to immutable source/build identity but is `diagnostic` evidence, not an ordinary correctness prerequisite.

The ordinary evidence producer first checks that `FSUSBLOG_EVIDENCE_COMMIT_SHA` / `GITHUB_SHA` (when present) equals `HEAD` and rejects a tracked dirty worktree. Measurements from uncommitted source cannot become current-commit decoder-budget evidence: commit, verify clean, then run the ordinary lane. Browser diagnostics bind their own immutable build and run/category/probe receipts and cannot reuse an old summary.

## CRC and correctness boundary

Wire CRC remains CRC16/Modbus (`0xA001`) over the payload; AEDS v2 header, flags, FrameType, and payload are unchanged. After real performance sampling shows scalar CRC is dominant for large frames, speed uses a runtime-generated 65,536-entry pair table processing 2 bytes at a time; basic keeps its per-byte table. The pair table is in BSS, so a 128 KiB constant is not downloaded.

Every CRC/parser optimization must pass same-seed basic/speed differential fuzz covering short/truncated, magic/version/header length, payload length, CRC, frame type, unaligned, large-frame, and malformed ArticleDetail inputs. Never restore AEDS v1 or a text fallback.

## Build and verification

```bash
cd src/frontend
npm run build:wasm
node ../../tools/frontend/ensure-wasm.mjs status
```

Build concurrency derives from online CPU/available memory and scheduler grant. Binaryen/CMake bootstrap uses `.tmp/dependency-cache`, file locks, and SHA-256; fresh-output cleanup never deletes the controlled dependency cache. The canonical WASM Docker producer aligns BuildKit cache mounts with real paths: `/.tmp/dependency-cache`, `/.cache/emscripten`, `/.cache/vcpkg/downloads`, and `/.cache/vcpkg/archives`. Their shared cache identity is constrained by pinned emsdk/CMake/Binaryen, vcpkg commit, `wasm32-emscripten` triplet, and image-codec dependency feature, allowing verified toolchain/dependency reuse after source cache misses; rebuild a damaged controlled cache under its lock. Cache is never the artifact-correctness authority.

Docker compile-layer inputs are exactly the inventory in `ops/docker/wasm-producer-inputs.json`: `src/frontend/wasm/**`, Wasm build/helper scripts, vcpkg overlay, production-ZK contract/config, and generated inputs resolved from the trusted-setup manifest when enabled. `tools/check-wasm-artifact-ownership.mjs` compares every `wasm-builder` `COPY` in both directions, rejecting omitted reads, extra inputs, broad `src/frontend/`/`tools/frontend/` copies, and missing conditional inputs. `ensure-wasm` hashes the same inventory, so each registered source/helper/overlay/ security change changes both Docker cache key and receipt input identity. Ordinary Vue/TS/CSS, frontend tests, and docs are outside the closure.

Focused verification:

```bash
# ownership (does not require a local generated package by default)
node tools/check-wasm-artifact-ownership.mjs

# ABI/hash/toolchain/runtime artifact
(cd src/frontend && node ../../tools/frontend/ensure-wasm.mjs status)

# after generating a release package, verify package and current source contract
node tools/frontend/wasm-build-receipt.mjs verify \
  --root . --client-root src/frontend --artifact-dir build/artifacts/wasm-release

# basic/speed throughput, artifact raw/gzip/br, compile, memory, copy/arena
cd ../.. && node tests/frontend/checks/perf/check-aeds-decode-budget.mjs

# supported real-browser tier/fallback/transfer/load/long-task diagnostics
bash tools/test/lanes/browser-diagnostics.sh manual --category performance --workers 1

# basic/speed differential fuzz (after release build)
FSUSBLOG_WASM_FUZZ_SEEDS_PER_CORPUS=256 node tools/security/run-wasm-fuzz.mjs

# handle epoch, native 64-bit pointers, ASAN/UBSAN, and libFuzzer exports
npm run check:aeds-export-handle

# runtime selection/protocol-negative matrix
cd src/frontend
pnpm vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/aedsWasmTier.test.ts \
  ../../tests/frontend/unit/wasmReleaseAssets.test.ts \
  ../../tests/frontend/unit/protocol/aeds-contract.test.ts
```

Ordinary performance writes `.tmp/frontend/aeds-decode-budget/summary.json` and projects release correctness to `.tmp/release-evidence/aeds-decode-budget-summary.json`. Browser diagnostics separately write `.tmp/frontend/aeds-wasm-browser/summary.json` and `.tmp/release-evidence/aeds-wasm-browser-summary.json`, archived by their receipt. Missing, unsupported, or failed browser files do not block ordinary correctness and cannot replace decoder budget. Fuzz summary must mark `executionSource=fresh-wasm-runtime`, list basic/speed SHA-256 and nonzero seeds, include a replay plan, and have an empty crash set.

## Risks and no-restart fallback

- Missing/stale package or hash/toolchain mismatch stops release build before image load. Rebuild from the `wasm-artifact` checkpoint without a server restart; never restore a deleted tracked binary.
- On speed load/compile/instantiate/hash failure, the Worker records the reason and falls back in order to basic; no server restart is needed.
- On speed metric regression, the next immutable frontend-release manifest can restrict the default candidate to basic; retain N/N-1 assets.
- If both tiers fail, the Worker returns `wasm_init_failed` and the upper layer reports binary transport failure; never use a JSON/text API.
- Sensitive-clear failure, stale handle, ABI/hash drift, or differential-fuzz mismatch fails the release gate; a feature flag cannot suppress correctness.
- For a v4 client rollback, the next immutable v4 manifest restricts candidates to basic or a verified v4 N-1 asset without server restart. Never mix-load or restore an unchecked v3 module, use JSON/text, or leave the binary path open without a safe v4 asset; fail closed instead.

## Related contracts

- [`docs/api/contracts.md`](api/contracts.md): AEDS HTTP/POD and browser decode boundary
- [`docs/api/schemas-and-errors.md`](api/schemas-and-errors.md): POD sizes and error catalog
- [`src/core/Algorithms/AEDS_V2_PROTOCOL.md`](../src/core/Algorithms/AEDS_V2_PROTOCOL.md): AEDS v2 wire specification
- [`src/shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md`](../src/shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md): C++/C# alignment checklist
- [`docs/testing.md`](testing.md): fresh fuzz and release-evidence rules

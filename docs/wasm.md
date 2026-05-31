# WebAssembly 开发指南

本文件说明 FsusBlog Wasm 模块的工具链配置、构建流程、C++/TypeScript 接口边界和调试策略。

---

## 总览

FsusBlog 使用 C++23（Freestanding 模式）编写 Wasm 解码器，主要职责：

1. **AEDS v2 解码**：读取 16 字节帧头，校验 Magic/Version/HeaderLength/CRC16，按 FrameType 解析 compact POD 载荷
2. **CRC16 校验**：Modbus 多项式 `0xA001`，只校验 payload；header 不再带独立 CRC
3. **POD → ViewModel 转换**：定长 POD 结构体 → TypeScript 可用的对象模型
4. **内存安全**：Freestanding 模式禁止 STL 堆分配，全部使用栈内存或预分配缓冲区

解码器在 Web Worker 中运行，与主线程完全隔离，不阻塞 UI。

---

## 代码组织

```
src/frontend/src/wasm/
├── include/               # C++ 头文件
│   ├── aeds_decoder.h     # 解码器主接口
│   ├── aeds_frame.h       # 帧头结构体定义
│   ├── pod_types.h        # 所有 POD 类型定义（与 C# Shared 对齐）
│   ├── aeds_crc32.hpp     # CRC16 实现（文件名沿用历史路径）
│   └── utf8_fixed.h       # Utf8Fixed32/64/128/256/512 工具
├── src/                   # C++ 实现文件
│   ├── aeds_decoder.cpp   # 解码主逻辑
│   ├── aeds_crc32.cpp     # CRC16 计算
│   └── utf8_fixed.cpp     # 固定宽度字符串工具
├── aeds.ts                # C++/TS 胶水层（Emscripten 绑定）
├── CMakeLists.txt         # CMake 构建配置
└── build.sh               # 本地构建脚本（封装 emcmake + emmake）

src/frontend/src/workers/
├── wasmDecode.worker.ts   # Wasm 解码 Web Worker
└── ...                    # 其他 Worker

src/frontend/wasm/      # 编译产物（不入 git，通过 ensure:wasm 拉取）
├── aeds_decoder.wasm      # Wasm 模块
└── aeds_decoder.js        # Emscripten 胶水 JS
```

---

## 工具链要求

### Emscripten SDK

```bash
# 安装 emsdk
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh      # 每个新终端需要 source

# 验证
emcc --version             # 应输出 3.x.x
```

### CMake + Ninja

```bash
# Linux / macOS
sudo apt install cmake ninja-build   # Debian/Ubuntu
brew install cmake ninja             # macOS

# 验证
cmake --version && ninja --version
```

### Emscripten ports cache

`src/frontend/wasm/build.sh` 默认将 Emscripten cache 指向仓库内的 `.tmp/emscripten-cache`，并覆盖部分发行版 Emscripten 配置中的 `FROZEN_CACHE=True`。这是为了保持 Wasm image codec 的完整 JPEG 能力：当没有外部 `libjpeg`/vcpkg 依赖时，构建会通过 Emscripten `USE_LIBJPEG=1` 拉取并编译官方 `libjpeg` port。

可用环境变量覆盖：

```bash
FSUSBLOG_EM_CACHE=/path/to/writable/emscripten-cache npm run ensure:wasm
```

不要通过关闭 `FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG` 来绕过 cache 问题；这会让 Wasm image codec 缺失 JPEG 编码能力，只能退回浏览器 canvas fallback。

---

## 构建流程

### 快速构建（推荐）

```bash
cd src/frontend
npm run build:wasm
```

内部执行 `wasm/build.sh`，步骤：
1. `emcmake cmake` 配置 CMake（注入 Emscripten 工具链）
2. `emmake ninja` 编译 C++ 源码
3. 将产物复制到 `wasm/` 目录

### 手动构建（调试用）

```bash
cd src/frontend/src/wasm
source /path/to/emsdk/emsdk_env.sh

# 配置（Release 模式）
emcmake cmake -S . -B ../../../build/wasm-release \
  -DCMAKE_BUILD_TYPE=Release \
  -G Ninja

# 编译
cd ../../../build/wasm-release
emmake ninja

# 查看产物
ls artifacts/wasm-release/
```

### 拉取预构建产物（无需 Emscripten）

```bash
cd src/frontend
npm run ensure:wasm
```

从 CI 产物存储拉取对应版本的 `.wasm` 文件，开发时通常使用此方式。

### PoW Wasm 分层与基准

PoW 求解器位于 `src/frontend/wasm/pow`，仍然使用 `salt:nonce:browserFp` 的 SHA-256 工作量证明格式。优化只改变客户端搜索速度，不改变服务端 `difficulty`、`X-Fsus-Pow-Proof` 或 Redis/HMAC 验证语义。

`npm run build:wasm` 会生成以下 PoW 资产：

| 资产 | 编译选项 | 运行时用途 |
|------|----------|------------|
| `fsus_pow_basic.*` | scalar C++23 | 旧浏览器/无 SIMD fallback |
| `fsus_pow_simd.*` | `-msimd128` | 默认现代单 worker 快路径 |
| `fsus_pow_relaxed.*` | `-msimd128 -mrelaxed-simd` | 浏览器支持 relaxed SIMD 时的候选快路径 |
| `fsus_pow_threads.*` | worker-sharded SIMD tier | `crossOriginIsolated + SharedArrayBuffer + atomics` 可用时由 `pow.worker.ts` 分片搜索 |

运行时选择顺序为 `threads -> relaxed SIMD -> SIMD128 -> basic`。任一资产加载失败或求解失败会在同一次任务内降级，不需要服务端重启或 API 变更。

PoW 性能基准：

```bash
cd src/frontend
npm run build:wasm
npm run bench:pow-wasm
```

默认基准输出 `.tmp/perf/pow-wasm.json`，记录每个资产的 `p50Ms`、`p95Ms`、`hashesPerSecond` 和 range solver smoke。默认只跑 difficulty `4,5` 以避免本地开发被高难度样本拖住；需要完整压力样本时可显式指定：

```bash
FSUSBLOG_POW_BENCH_DIFFICULTIES=4,5,6,7 FSUSBLOG_POW_BENCH_SAMPLES=1 npm run bench:pow-wasm
```

### CMake 关键配置

```cmake
# CMakeLists.txt 关键选项
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Emscripten 优化选项
set(EMSCRIPTEN_FLAGS
  -O3                        # 发布模式优化
  -s WASM=1
  -s MODULARIZE=1
  -s EXPORT_NAME='AedsDecoder'
  -s NO_EXIT_RUNTIME=1
  -s FILESYSTEM=0            # 禁用 FS（Freestanding）
  -s ALLOW_MEMORY_GROWTH=0   # 固定内存大小
  -s INITIAL_MEMORY=2097152  # 2MB
  -s STACK_SIZE=65536        # 64KB 栈
  --no-entry                 # 无 main 函数
)
```

---

## C++ / TypeScript 接口边界

### 从 C++ 导出给 JavaScript

通过 Emscripten `EXPORTED_FUNCTIONS` 暴露的 C 风格接口：

```cpp
// include/aeds_decoder.h（对外接口）
extern "C" {
  // 解码 AEDS v2 帧，返回二进制 payload 视图指针（在 Wasm 内存中）
  // buf：帧字节数据指针，len：字节数
  // 返回：解码后的 POD payload，失败返回 nullptr
  const char* aeds_decode(const uint8_t* buf, size_t len);

  // 释放上次 decode 分配的缓冲区
  void aeds_free();

  // 返回解码器版本字符串
  const char* aeds_version();
}
```

### TypeScript 胶水层（`aeds.ts`）

```typescript
// src/frontend/src/wasm/aeds.ts（简化示意）

import type { AedsDecoder } from './types';

let wasmModule: AedsDecoder | null = null;

export async function loadWasm(): Promise<void> {
  const mod = await import('../../../wasm/aeds_decoder.js');
  wasmModule = await mod.default();
}

export function decodeFrame(buffer: ArrayBuffer): unknown | null {
  if (!wasmModule) throw new Error('Wasm not loaded');

  const bytes = new Uint8Array(buffer);
  const ptr = wasmModule._malloc(bytes.length);
  wasmModule.HEAPU8.set(bytes, ptr);

  const resultPtr = wasmModule._aeds_decode(ptr, bytes.length);
  wasmModule._free(ptr);

  if (!resultPtr) return null;

  const payload = wasmModule.readPayload(resultPtr);
  wasmModule._aeds_free();

  return decodeKnownFramePayload(payload);
}
```

### Worker 通信协议（`wasmDecode.worker.ts`）

Worker 通过 `postMessage` 与主线程通信，使用以下消息格式：

**请求（主线程 → Worker）**：

```typescript
interface DecodeReq {
  id: string;           // 请求 ID（用于关联响应）
  frameType: number;   // 期望的 AedsFrameType
  buffer: ArrayBuffer; // AEDS 帧完整字节数据
}
```

**响应（Worker → 主线程）**：

```typescript
interface DecodeResp {
  id: string;          // 对应请求 ID
  ok: boolean;         // 解码是否成功
  data?: unknown;      // 解码结果（ok=true 时）
  error?: string;      // 错误描述（ok=false 时）
  fallback?: boolean;  // true 表示触发本地降级，不会重发文本 API
}
```

`ArrayBuffer` 通过 `Transferable` 零拷贝传递。

---

## 解码失败策略

Wasm 解码失败时，客户端暴露协议错误并由上层决定是否展示重试或本地降级。运行时不得重发文本 API 请求。触发条件：

| 条件 | 触发回退 |
|------|---------|
| Wasm 模块加载失败 | ✅ |
| 帧头 Magic 不匹配 | ✅ |
| CRC16 payload 校验失败 | ✅ |
| FrameType 未知（值不在枚举表中） | ✅ |
| PayloadLength 超出安全上限 | ✅ |
| Worker 响应超时（默认 5000ms） | ✅ |
| `DecodeResp.ok = false` | ✅ |

失败后，相同请求仍只能走 AEDS Binary；错误响应也必须是 `ApiError` frame。

### 回退阈值配置

```typescript
// src/frontend/src/workers/wasmDecode.worker.ts
const DECODE_TIMEOUT_MS = 5000;   // Worker 响应超时
const MAX_CONSECUTIVE_FAILURES = 3; // 连续失败 N 次后停止尝试 Binary 链
```

连续失败超过阈值后，该会话内后续请求可跳过 Wasm 加速路径，改用 TypeScript binary decoder；不得切到文本 API。

---

## 调试 Wasm

### 开发模式调试构建

```bash
cd src/frontend/src/wasm

emcmake cmake -S . -B ../../../build/wasm-debug \
  -DCMAKE_BUILD_TYPE=Debug \
  -G Ninja

cd ../../../build/wasm-debug && emmake ninja
```

Debug 构建包含：
- `-g`：调试信息（DWARF）
- `-s ASSERTIONS=2`：运行时断言
- `-s SAFE_HEAP=1`：堆访问越界检测
- Source Map 支持（Chrome DevTools 可显示 C++ 源码）

### Worker 调试模式

在 `wasmDecode.worker.ts` 中启用调试日志：

```typescript
// 开发时设置为 true
const DEBUG_MODE = import.meta.env.DEV;

if (DEBUG_MODE) {
  console.log('[WasmWorker] Decode request:', req.id, 'FrameType:', req.frameType);
}
```

### 直接测试解码器

```typescript
// 在浏览器控制台或 Node.js 中
import { loadWasm, decodeFrame } from './src/wasm/aeds';

await loadWasm();
const buffer = await fetch('/api/binary/article').then(r => r.arrayBuffer());
const result = decodeFrame(buffer);
console.log(result);
```

### C++ 单元测试（不通过 Wasm）

C++ 解码器核心逻辑也在 C# 侧通过 `FsusBlog.Core` 有对等实现，可通过 C# 单元测试验证协议逻辑。

---

## ABI 稳定性约束

C++ POD 类型必须与 C# `src/shared/Contracts/Models/` 中的对应类型保持**字节级兼容**。

修改任一 POD 类型时：
1. 同时修改 C# 和 C++ 两侧
2. 更新 `PodSizeCatalog.cs` 中对应的字节数常量
3. C++ 侧新增 `static_assert(sizeof(T) == PodSizeCatalog::XxxPod)`
4. 运行 `PodContractValidation.AreAllPodModelsReferenceFree()` 断言
5. 重新构建 Wasm：`npm run build:wasm`
6. 更新 `docs/api/schemas-and-errors.md` 中的 POD 大小目录

详细类型映射规则见 [docs/api/schemas-and-errors.md](api/schemas-and-errors.md#c-pod-对齐规则)。

---

## CI 产物管理

Wasm 产物不入 git，通过 CI 构建并存储到产物仓库：

```bash
# 构建并上传（仅在 CI 中执行）
./tools/build-wasm-artifact.sh

# 本地拉取最新产物
cd src/frontend
npm run ensure:wasm
```

`build-wasm-artifact.sh` 流程：
1. source emsdk 环境
2. `cmake + ninja` Release 构建
3. 压缩 `.wasm` + 胶水 JS 为 artifact 包
4. 上传到 artifact 存储（GitHub Releases 或 S3）

---

## 参见

- [development.md](development.md) — 本地环境搭建（含 Wasm 依赖安装）
- [docs/api/schemas-and-errors.md](api/schemas-and-errors.md) — POD 大小目录与 C++ 对齐规则
- `src/core/Algorithms/AEDS_V1_PROTOCOL.md` — 完整帧协议规格
- `src/shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md` — C++/C# 类型对齐检查清单
- `src/frontend/src/wasm/CMakeLists.txt` — CMake 构建配置

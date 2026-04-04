# Codex Tasks Plan: FsusBlog 极速架构执行路线

## 一、初始化（Setup）

### Task 1.1: 定义 AEDS Frame 跨端对齐契约
- [x] 已完成
- 产出：
  - `FsusBlog.Shared/AedsFrameHeader.cs`
  - `FsusBlog.Client/src/wasm/include/aeds_frame.hpp`
  - `FsusBlog.Client/src/wasm/types.ts`
- 验收证据：
  - `dotnet run --project /tmp/aeds-size-check/aeds-size-check.csproj -v quiet` 输出 `24`
  - `g++ -std=c++23 -O2 /tmp/aeds_size.cpp -o /tmp/aeds_size && /tmp/aeds_size` 输出 `24`

### Task 1.2: 建立 API Client 基础网络层
- [x] 已完成
- 产出：
  - `FsusBlog.Client/src/api/jsonApiClient.ts`
  - `FsusBlog.Client/src/api/binaryApiClient.ts`
- 验收证据：
  - `cd FsusBlog.Client && npm run build` 通过（含 TS 编译）

## 二、核心功能（Core Features）

### Task 2.1: 实现 C# 文章详情零分配二进制端点
- [x] 已完成
- 产出：
  - `FsusBlog.Server/Infrastructure/Binary/AedsBinaryWriter.cs`
  - `FsusBlog.Server/Modules/Endpoints/Binary/BinaryEndpoints.cs`（Article 二进制路由使用 writer，`application/octet-stream`）
- 验收证据：
  - `dotnet build FsusBlog.slnx -v minimal` 通过

### Task 2.2: 编写 C++23 载荷解析器与 C-ABI 导出
- [x] 已完成
- 产出：
  - `FsusBlog.Client/src/wasm/include/pod_views.hpp`
  - `FsusBlog.Client/src/wasm/src/pod_parse_article.cpp`
  - `FsusBlog.Client/src/wasm/src/aeds_decode.cpp`
  - `FsusBlog.Client/src/wasm/src/aeds_crc32.cpp`
  - `FsusBlog.Client/src/wasm/src/exports.cpp`
  - `FsusBlog.Client/src/wasm/CMakeLists.txt`
- 验收证据：
  - `cd FsusBlog.Client/src/wasm && emcc ... -o dist/aeds_decoder.js` 通过
  - `rg -n "decode_aeds|get_last_payload_ptr|get_last_payload_len|get_last_error_ptr|alloc_buffer|free_buffer" FsusBlog.Client/src/wasm/dist/aeds_decoder.js` 命中导出符号

### Task 2.3: 封装 TS/Wasm 内存胶水层
- [x] 已完成
- 产出：
  - `FsusBlog.Client/src/wasm/aeds.ts`（Wasm init、decode、payload view 提取）
- 验收证据：
  - `cd FsusBlog.Client && npm run build` 通过

### Task 2.4: 串联 Vue Pinia 状态机与业务模型
- [x] 已完成
- 产出：
  - `FsusBlog.Client/src/adapters/binaryToViewModel.ts`
  - `FsusBlog.Client/src/store/article.ts`
  - `FsusBlog.Client/src/views/ArticleDetail.vue`（切换到二进制优先）
- 验收证据：
  - `cd FsusBlog.Client && npm run build` 通过

## 三、安全与性能（Security & Performance）

### Task 3.1: 抽离 Wasm 解码管线至 Web Worker
- [x] 已完成
- 产出：
  - `FsusBlog.Client/src/workers/wasmDecode.worker.ts`
  - `FsusBlog.Client/src/store/article.ts`（buffer 通过 `postMessage(..., [buffer])` 转移）
- 验收证据：
  - `cd FsusBlog.Client && npm run build` 产物包含 `dist/assets/wasmDecode.worker-*.js`

### Task 3.2: 植入 CRC32 强校验与越界保护
- [x] 已完成
- 产出：
  - `FsusBlog.Client/src/wasm/src/aeds_crc32.cpp`
  - `FsusBlog.Client/src/wasm/src/aeds_decode.cpp`（Header/Payload CRC 校验）
  - `FsusBlog.Client/src/store/article.ts`（解码失败自动 `useBinary=false` 并回退 JSON）
  - Server 侧沿用 `AedsEncoder` 的 `HeaderCrc32/PayloadCrc32`
- 验收证据：
  - `dotnet build FsusBlog.slnx -v minimal` 通过
  - `cd FsusBlog.Client && npm run build` 通过

## 四、重构（Refactoring）

### Task 4.1: Headless 交互委托
- [x] 已完成
- 产出：
  - `FsusBlog.Client/src/main.ts`（移除 ElementPlus 图标注册逻辑）
  - `FsusBlog.Client/src/App.vue`（根节点 `data-aot-action` 事件委托并转发到 store）
- 验收证据：
  - `cd FsusBlog.Client && npm run build` 通过

## 全量构建结论
- `dotnet build FsusBlog.slnx -v minimal`：通过（保留既有 7 个 warning，非本轮新增）
- `cd FsusBlog.Client && npm run build`：通过
- `cd FsusBlog.Client/src/wasm && emcc ...`：通过并生成 `dist/aeds_decoder.js/.wasm`

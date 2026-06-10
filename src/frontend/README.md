# FsusBlog Client

Vue 3 SPA 前端，集成 WebAssembly 解码引擎、Service Worker 离线搜索和公开页静态 hydration。

## 项目定位

- **SPA + 公开页 hydration**：未登录访问走 AOT 预渲染 HTML shell，登录后 hydration 接管。
- **Binary 协议**：应用 API 走 AEDS v2 Binary 帧，小载荷主线程 TypeScript 解码，大载荷交给 Wasm Web Worker。
- **本地搜索**：Service Worker 缓存静态索引，Wasm 引擎在浏览器内本地排序，无服务端在线检索。
- **类型安全**：TypeScript strict mode，Pinia 状态机，Vue Router 类型化路由。

## 目录结构

```text
src/frontend/
├── src/
│   ├── api/                # AEDS binary client + 各域 API 函数
│   ├── adapters/           # Binary → ViewModel 数据映射（binaryToViewModel.ts）
│   ├── composables/        # 业务组合函数（usePasskeyLogin, usePasskeyManagement 等）
│   ├── store/              # Pinia 状态机（article, comment, auth 等）
│   ├── views/              # 页面组件（auth/, user/, public/ 等）
│   ├── components/         # 可复用 UI 组件
│   ├── workers/            # Web Worker（wasmDecode.worker.ts）
│   ├── router/             # Vue Router 路由定义
│   ├── layouts/            # 页面布局框架
│   ├── helpers/            # 工具函数
│   ├── services/           # 业务服务层
│   ├── public-renderers/   # 公开页 hydration 渲染器
│   └── bootstrap/          # 应用启动逻辑
├── wasm/                   # C++23 Wasm 解码器源码
│   ├── aeds/               # AEDS v2 解码器
│   ├── CMakeLists.txt      # CMake 构建配置
│   └── build.sh            # Emscripten 构建脚本
├── tests/
│   ├── checks/             # Node.js 检查脚本（static/security/runtime/wasm/public）
│   ├── e2e/                # Playwright E2E 用例
│   ├── fixtures/           # 测试夹具与账号准备脚本
│   └── support/            # 共享 HTTP/auth/binary/Playwright 辅助工具
├── scripts/                # 构建、Wasm、公开页生成、本地工具脚本
├── public/                 # 静态公开资源
├── package.json
├── vite.config.ts
├── tsconfig.json
└── playwright.config.ts
```

## 环境要求

- Node.js 20+，npm 10+
- `GITHUB_PACKAGES_TOKEN` 环境变量（FsusUI 私有包授权）
- Emscripten SDK（可选，仅需本地重新构建 Wasm 时）
- 后端服务运行在 `http://127.0.0.1:5000`（`npm run dev:debug` 会自动代理）

## 安装

```bash
export GITHUB_PACKAGES_TOKEN=your_github_packages_token
npm ci
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev:debug` | 启动开发服务器（端口 3000，HMR，代理到 5000） |
| `npm run build` | 生产 Release 构建（等同 `build:release`） |
| `npm run preview` | 本地预览 Release 构建产物（端口 8080） |
| `npm run build:wasm` | 重新编译 C++23 Wasm 解码器（需 Emscripten） |

## 测试

前端测试通过 `npm run check:*` 脚本和 `../tools/test.sh <tier>` 分级运行。

**静态检查**（无需运行服务）：

```bash
npm run check:modern-standards        # 现代 API 约束
npm run check:result-boundaries       # Result<T> 边界规范
npm run check:security-consistency    # 安全配置一致性
npm run check:error-code-alignment    # 错误码对齐
npm run check:views-constraints       # 视图层约束
npm run check:server-try-catch        # try-catch 规范
```

**Wasm 检查**（需构建产物）：

```bash
npm run check:aot                     # AOT / Wasm 完整性
npm run check:image-codec-wasm        # 图片编解码 Wasm 检查
```

**运行时检查**（需启动完整调试栈 3000/5000）：

```bash
npm run check:notification-stream-runtime             # notification stream 连接弹性
npm run check:notification-stream-live                # notification stream 协议握手 / 重连冒烟
npm run check:api-contracts           # 统一 API 响应契约矩阵
npm run check:binary-contract-smoke      # Binary 状态与帧类型对齐
npm run check:search-runtime          # 搜索功能冒烟
npm run check:sw-search-runtime       # Service Worker 搜索
npm run check:public-hydration        # 公开页 hydration 一致性
```

**E2E（需完整调试栈）**：

```bash
npx playwright test                   # 全量 E2E
npx playwright test tests/e2e/acceptance/
```

测试布局详见 [tests/README.md](tests/README.md)。

## Wasm 解码器

`wasm/` 目录包含 C++23 Freestanding 实现的 AEDS v2 解码器：

- 无 STL 容器，无堆分配，无异常传播
- `alloc_buffer` / `free_buffer`：浏览器侧分配
- `decode_aeds`：16-byte 帧头验证 + CRC16 payload 校验 + compact POD 解码
- 解码逻辑运行在独立 Web Worker（`workers/wasmDecode.worker.ts`），不阻塞主线程

本地重新构建 Wasm：

```bash
# 需要 Emscripten SDK 已激活
npm run build:wasm
```

协议规格见 [../core/Algorithms/AEDS_V1_PROTOCOL.md](../core/Algorithms/AEDS_V1_PROTOCOL.md)。

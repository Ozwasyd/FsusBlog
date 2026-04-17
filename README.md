# Fsu's Blog

一个面向真实部署的高性能个人内容系统。  
它不是“演示型博客模板”，而是把公开首屏、Binary 传输、AOT 输出、本地搜索、浏览器边缘缓存、安全链路和后台治理一起做进主链的单体全栈工程。

## 项目定位

FsusBlog 以 `SEO 首访速度 + 运行时一致性 + 工程可维护性` 为核心约束：

- 公开页优先：首页、归档、分类、标签、文章详情优先保障首屏和可索引性。
- 统一契约：同一业务对象在 JSON、Binary、AOT 三条读链保持同一语义。
- 单体优先：减少跨服务跳转，把复杂度压在工程内部而不是部署拓扑上。
- 安全前置：PoW、JWT、多会话、MFA、风控、注销、缓存治理都按基础设施能力建设。
- 前端性能优先：浏览器本地搜索、Service Worker 边缘缓存、Wasm 渲染与解码进入正式主链。

## 架构概览

### 技术栈

- 前端：Vue 3、Vite、Pinia、Vue Router、Tailwind CSS、FsusUI
- 后端：ASP.NET Core、SqlSugar、PostgreSQL、Redis
- 共享契约：`FsusBlog.Shared`
- 核心映射与二进制编码：`FsusBlog.Core`
- 公开页能力：AOT shell、public hydration、Binary/POD 读链
- 搜索：Lucene.NET 离线索引 + 客户端 Wasm 本地检索
- 实时：SSE 增量事件流
- 边缘缓存：Service Worker + 搜索索引增量更新

### 当前主链

- 公开文章、列表、评论等高频读取链优先走 Binary/POD。
- 管理端写接口、认证接口和部分通用业务接口继续走 JSON。
- 搜索不再依赖服务端在线检索，客户端加载静态索引并本地排序。
- 公开页首访优先走 AOT 命中；未命中则回到 SPA index，再由 hydration 接管。

### 仓库结构

```text
/FsusBlog
├── FsusBlog.Client/      # Vue 前端、Wasm、Service Worker、公开页 hydration
├── FsusBlog.Server/      # ASP.NET Core API、AOT、SSE、缓存、安全链路
├── FsusBlog.Shared/      # 前后端共享契约与二进制协议模型
├── FsusBlog.Core/        # Core 映射、POD 编解码、共享投影逻辑
├── docker-compose.dev.yml
└── README.md
```

## 本地开发

### 环境要求

- .NET SDK 10
- Node.js 20+
- npm 10+
- Docker / Docker Compose
- PostgreSQL 与 Redis 通过 `docker-compose.dev.yml` 启动
- 若需完整 Wasm 构建，需本机可用 Emscripten

### FsusUI 依赖

客户端组件库通过 GitHub Packages 分发，不再依赖仓库外本地路径。

在安装前准备环境变量：

```bash
export GITHUB_PACKAGES_TOKEN=your_github_packages_token
```

客户端 `.npmrc` 已固定使用：

- `@ozwasyd:registry=https://npm.pkg.github.com`
- `//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}`

### 启动方式

1. 启动后端依赖与服务

```bash
docker compose -f docker-compose.dev.yml up -d
```

2. 安装前端依赖并启动前端

```bash
cd FsusBlog.Client
npm ci
npm run dev:debug
```

3. 常用地址

- 前端开发壳：`http://127.0.0.1:3000`
- 后端 API / 公开壳：`http://127.0.0.1:5000`

### Visual Studio 调试

- 默认共享启动配置：`Debug / Client + Docker`
- 次级共享启动配置：`Debug / Client + NativeServer`
- 默认 `F5` 浏览器入口统一为 `http://127.0.0.1:3000`
- `5000` 只承担后端 API、public AOT 与 C# 调试，不作为默认浏览器首页
- `8080` 只属于 release 容器入口，不参与 Debug

Visual Studio 调试建议：

- `Client + Docker`：最接近真实开发主链，宿主机 Vite 提供 HMR，Docker 内后端固定监听 `5000`
- `Client + NativeServer`：更适合本机 C# 断点和快速迭代，前端仍固定走 `3000`
- 两套 Debug 启动都统一复用 `npm run dev:debug`，因此会先执行 `ensure:wasm`，不会绕过 wasm 最新性检查

### 开发入口职责

- `3000` 默认用于 Vite 开发，并允许公开页直接命中后端 public AOT 主链。
- `5000` 固定为后端 API 与公开页实际服务入口。
- 默认开发模式下，`3000` 会代理 `/`、`/archive`、`/article/:id`、`/about`、`/category/:id`、`/tag/:id` 这些公开页 HTML。
- 如需强制纯 SPA 调试，可显式关闭：

```bash
VITE_PUBLIC_SHELL_PROXY=0 npm run dev -- --host 0.0.0.0 --port 3000
```

- 该开关只改变 dev HTML 入口，不改变 `/api`、`/hubs`、`/search/index*` 的代理主链。

## 构建与验收

### 最小构建

```bash
dotnet build FsusBlog.slnx -c Debug -warnaserror -v minimal
cd FsusBlog.Client && npm run build:release
```

### 原生 Release 单文件发布

```bash
./tools/build-native.sh
```

默认产物目录：

```text
build/native/linux-musl-x64/release
```

发布目录同时包含：

- `FsusBlog.Server` 单执行文件
- `wwwroot/` 前端 release 产物
- `FsusBlog.ClientRuntime/` Node SSR worker 运行时

### Visual Studio Release Publish

Visual Studio 默认发布入口应选择：

- `Folder Publish`
- Profile：`NativeReleaseLinuxMusl`

该 profile 会：

- 以 `linux-musl-x64` 执行 self-contained single-file publish
- 在发布前自动执行 `cd FsusBlog.Client && npm run build:release`
- 自动把 `dist/` 复制到发布目录 `wwwroot/`
- 自动把 SSR worker 所需的客户端运行时复制到 `FsusBlog.ClientRuntime/`

默认输出目录固定为：

```text
build/native/linux-musl-x64/release
```

### Docker Release 构建

```bash
docker compose build fsusblog.server
```

### 推荐回归

```bash
cd FsusBlog.Client && npm run check:aot
cd FsusBlog.Client && npm run check:public-hydration
cd FsusBlog.Client && npm run check:public-seo-smoke
cd FsusBlog.Client && npm run check:binary-smoke
cd FsusBlog.Client && npm run check:binary-smoke:auth
```

若只想单独跑 SPA 路由巡检，需要另起一个前端 dev 实例给 Playwright 使用：

```bash
cd FsusBlog.Client && npm run ensure:wasm
cd FsusBlog.Client && npm run dev -- --host 127.0.0.1 --port 3100
cd FsusBlog.Client && PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 npm run check:spa:routes
```

该巡检现在会校验：

- public 页面允许返回 `server-ssr`、`admin-upload` 或 `spa-fallback`
- 非 public 页面必须返回普通 Vite SPA 开发壳
- 高频路由跳转不允许出现动态导入失败

### 完整客户端回归

```bash
cd FsusBlog.Client && npm run check:full-regression
```

`check:full-regression` 现在会自动：

- 启动本地后端依赖与 Development 后端
- 运行 AOT、Binary、Auth smoke
- 临时拉起一个 127.0.0.1:3100 的 Vite dev 实例
- 执行 Playwright SPA 路由巡检

## 部署与运行说明

- 原生 release 与 Docker release 都需要在构建阶段提供 `GITHUB_PACKAGES_TOKEN`。
- Release Docker 会在容器内重建 wasm，再执行前端 release build，避免宿主机旧 `public/wasm` 污染最终镜像。
- Redis 是唯一 L2 缓存后端，`IMemoryCache` 作为 L1。
- 搜索索引、AOT 缓存、SSE 控制面、Binary 读链都属于正式运行时能力，不是实验分支。
- 若启用完整 Wasm 能力，部署时需确保相应 `.wasm` 静态资源被正确发布并带上 `application/wasm`。

## 工程约定

- TypeScript 以当前**稳定 TS 主线**为准，不追逐未正式稳定的“TS6”表述。
- C# 语言版本显式锁定到 **C# 14**，`Nullable` 与现代分析器保持开启。
- Wasm 子模块统一使用 **C++23**；除明确的第三方边界外，默认走最小异常开销主链。
- 业务失败优先走 **Result / ErrorCode** 语义，不依赖异常字符串驱动分支。
- 异常只保留给 truly exceptional 场景：启动无法继续、第三方库不可恢复失败、编程错误与 invariant 被破坏。
- 前端 `src/api`、`src/adapters`、`src/services`、`wasm/web` 的低层边界默认只允许 `AppError` 或 `Result<T>`，不再新增裸 `throw new Error(...)`。
- 前端上层 composable / helper 可以继续 `try/catch`，但只能消费 `AppError` 或经 `toAppError()` 归一化后的错误。
- C# 启动必要配置缺失仍属于允许异常；`MessageCenter` 这类运行期业务失败必须走 `Result/ErrorDetail`，不得再依赖异常分流。
- Wasm 对 JS 暴露的兼容 ABI 可以继续保留 `get_last_error_ptr/get_last_error_len`，但内部错误语义必须优先以结构化 `ErrorCode` 驱动。

- 不保留长期双栈兼容入口；历史 DTO、Legacy Gateway、旧 fallback 分支按主链切换后直接清理。
- 页面消费层不应感知 JSON 和 Binary 的业务语义差异，只应感知传输格式差异。
- 新读接口优先先定义 ReadModel，再分别投影到 JSON Response 和 POD Binary。
- 新缓存逻辑必须进入统一 L1/L2 治理，不允许服务层散写裸 Redis key。

FsusBlog 的目标不是“把博客跑起来”，而是把一套可维护、可验证、可持续演进的内容系统跑在更短、更稳、更一致的链路上。

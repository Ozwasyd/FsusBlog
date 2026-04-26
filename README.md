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
- 搜索：自研 UTF-8 离线索引编译链 + 客户端 Wasm 本地检索
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
- 前端 Release Preview：`http://127.0.0.1:8080`

### Visual Studio 调试

- 默认共享启动配置：`Debug / Client + Docker`
- 次级共享启动配置：`Debug / Client + NativeServer`
- 默认 `F5` 浏览器入口统一为 `http://127.0.0.1:3000`
- `5000` 只承担后端 API、public AOT 与 C# 调试，不作为默认浏览器首页
- `8080` 只用于本地 release preview / 上线前验收，不参与 Debug

Visual Studio 调试建议：

- `Client + Docker`：最接近真实开发主链，宿主机 Vite 提供 HMR，Docker 内后端固定监听 `5000`
- `Client + NativeServer`：更适合本机 C# 断点和快速迭代，前端仍固定走 `3000`
- 两套 Debug 启动都统一复用 `npm run dev:debug`，因此会先执行 `ensure:wasm`，不会绕过 wasm 最新性检查

### 开发入口职责

- `3000` 默认用于 Vite 开发，并允许公开页直接命中后端 public AOT 主链。
- `5000` 固定为后端 API 与公开页实际服务入口。
- `8080` 固定为前端 release preview / 本地上线前验收入口。
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

### 本地 Release Preview

```bash
cd FsusBlog.Client
npm run build
npm run preview
```

默认入口固定为：

```text
http://127.0.0.1:8080
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

### 测试标准

```bash
./tools/test.sh fast
./tools/test.sh integration
./tools/test.sh ci
./tools/test.sh release
./tools/test.sh acceptance
./tools/test.sh visual
./tools/test.sh security
./tools/test.sh resilience
./tools/test.sh load
./tools/test.sh production
```

工业级门禁固定为：

- `fast`
  - 不依赖运行中的服务
  - 覆盖 `.NET build/test`、`vue-tsc`、前端构建、静态 contract/guard 检查
  - `FsusBlog.Server.Tests` 中带 `Category=Integration` 的测试默认排除，不属于本地快检
  - 用于本地最小自检和提交前快检
- `integration`
  - 依赖 Debug 环境
  - 固定要求：前端 `3000`，后端 `5000`
  - 先执行 `FsusBlog.Server.Tests` 中的 `Category=Integration` 测试，再执行认证会话、binary、SSE、Playwright 路由巡检
- `ci`
  - 标准主门禁
  - 固定为 `fast + integration`
- `release`
  - 依赖 Release Preview
  - 固定要求：`8080`
  - 覆盖 public hydration、SEO、AOT/rebuild 等 release preview 验收
- `acceptance`
  - 自动拉起 `3000 / 5000 / 8080`
  - 覆盖公开页、用户台、管理台的 Playwright 全量 acceptance
  - 固定要求：应用侧 `console error/warn/pageerror/requestfailed` 归零
- `visual`
  - 自动拉起 `3000 / 5000 / 8080`
  - 覆盖暗黑模式、移动端 DOM 布局和关键页面截图基线
  - 固定要求：关键页面 dark mode 可读、移动端无横向溢出、截图基线稳定
- `security`
  - 覆盖认证 / 会话 / MFA / PoW / 权限矩阵 / a11y 基线
  - 重点验证“谁能进、谁不能进”和缺失 PoW/角色时的失败语义
- `resilience`
  - 覆盖运行时零噪音、上传恢复、搜索/SSE 重入与重复初始化
  - 重点验证主写入成功优先、后置同步失败降级为 warning 的回归语义
- `load`
  - 轻量并发压测
  - 覆盖公开页热点、SEO、PoW、binary 列表/热榜/评论热点接口
- `production`
  - 发布前硬门禁
  - 固定为 `fast + integration + release + acceptance + visual + security + resilience + load`
  - 任一层失败都阻断发布

若从前端目录调用，也可以使用薄别名：

```bash
cd FsusBlog.Client
npm run test:fast
npm run test:integration
npm run test:ci
npm run test:release
npm run test:acceptance
npm run test:visual
npm run test:production
```

说明：

- `check:*` 现在只保留给静态守卫和内部实现脚本，不再作为对外主入口。
- 前端测试文件统一放在 `FsusBlog.Client/tests`：`checks` 存放分层门禁脚本，`e2e` 存放 Playwright 用例和截图基线，`fixtures` 存放验收数据准备，`support` 存放共享 helper。
- `FsusBlog.Client/scripts` 只保留构建、Wasm、public hydration 生成和本地工具脚本；新增测试不得再放回 scripts 根目录。
- `FsusBlog.Client/scripts/full-regression.sh` 已降级为 deprecated shim，只转发到 `./tools/test.sh ci`。
- Playwright 路由巡检默认属于 `integration`，继续固定命中 `3000`。
- public hydration / SEO / rebuild 类验收默认属于 `release`，继续固定命中 `8080`。
- 暗黑模式与移动端视觉问题现在属于发布阻断项，默认由 `visual` 与 `production` 两层硬门禁覆盖。
- 关键截图基线只覆盖壳层和主模块；组件库升级或页面几何发生预期变化时，必须更新基线并重新跑 `visual`。
- 安全、鲁棒性、轻量负载门禁默认作为发布前强阻断，而不是 nightly 报告。
- `8081` 不再是标准测试端口，只保留在历史 local-proxy 文件中。

## 部署与运行说明

- 原生 release 与 Docker release 都需要在构建阶段提供 `GITHUB_PACKAGES_TOKEN`。
- Release Docker 会在容器内重建 wasm，再执行前端 release build，避免宿主机旧 `public/wasm` 污染最终镜像。
- Redis 是唯一 L2 缓存后端，`IMemoryCache` 作为 L1。
- 搜索索引、AOT 缓存、SSE 控制面、Binary 读链都属于正式运行时能力，不是实验分支。
- 若启用完整 Wasm 能力，部署时需确保相应 `.wasm` 静态资源被正确发布并带上 `application/wasm`。

### Docker VPS 生产主线

生产部署固定为单应用容器 + 外部 PostgreSQL/Redis + 宿主机 Nginx/OpenResty 网关。应用容器监听 `8080`，网关负责 TLS、HTTP/2、上传大小限制与 SSE 禁缓冲。

```bash
cp .env.production-template .env.production
# 编辑 .env.production，替换所有 CHANGE_ME 值
export GITHUB_PACKAGES_TOKEN=...
./tools/build-final-image.sh
docker compose --env-file .env.production config
docker compose --env-file .env.production up -d
```

健康检查：

- `/health/live`：只检查进程和 Kestrel 存活，供 Docker healthcheck 使用。
- `/health/ready`：检查生产配置、PostgreSQL、Redis、静态资源、IP2LOCATION、DB gate 与 SSE 运行态摘要，供上线切流前使用。

发布前硬门禁：

```bash
./tools/test.sh production
curl -fsS http://127.0.0.1:8080/health/ready
```

更多生产部署与运维细节见：

- `docs/production.md`
- `docs/operations.md`

## 工程约定

- TypeScript 以当前**稳定 TS 主线**为准，不追逐未正式稳定的“TS6”表述。
- C# 语言版本显式锁定到 **C# 14**，`Nullable` 与现代分析器保持开启。
- Wasm 子模块统一使用 **C++23**；除明确的第三方边界外，默认走最小异常开销主链。
- 业务失败优先走 **Result / ErrorCode** 语义，不依赖异常字符串驱动分支。
- 异常只保留给 truly exceptional 场景：启动无法继续、第三方库不可恢复失败、编程错误与 invariant 被破坏。
- 前端 `src/api`、`src/adapters`、`src/services`、`wasm/web` 的低层边界默认只允许 `AppError` 或 `Result<T>`，不再新增裸 `throw new Error(...)`。
- 前端上层 composable / helper 可以继续 `try/catch`，但只能消费 `AppError` 或经 `toAppError()` 归一化后的错误。
- 前端认证、静默续签、SSE 运行期逻辑不得再依赖异常消息字符串分流；关键路径统一基于 `AppErrorCode` 或已归一化的 failure code。
- Binary transport、认证会话、SSE、上传/压缩、Markdown/Search/Image codec 运行期不得再通过 `message.includes(...)` 之类字符串判错驱动核心逻辑。
- `src/api`、`src/services`、`src/composables`、`src/workers` 的运行期关键路径不得再通过异常消息文本做分流；此规则由 `check:no-runtime-message-branching` 守卫固定。
- C# 启动必要配置缺失仍属于允许异常；`MessageCenter` 这类运行期业务失败必须走 `Result/ErrorDetail`，不得再依赖异常分流。
- C# 可恢复基础设施失败不得再通过异常表达；仅启动必要配置缺失、进程无法继续、invariant 破坏与不可下沉的第三方边界允许保留异常。
- Wasm 对 JS 暴露的兼容 ABI 可以继续保留 `get_last_error_ptr/get_last_error_len`，但内部错误语义必须优先以结构化 `ErrorCode` 驱动。
- 最终允许保留裸 `throw new Error(...)` 的前端白名单固定只剩 `src/bootstrap/fullApp.ts` 与 `src/public-renderers/hydrationIdentityGuard.ts`；新增例外必须同时修改守卫与文档。
- `FsusBlog.Client/scripts/**` 与 `FsusBlog.Client/tests/**` 不属于运行期 Result 约束范围，允许继续使用脚本式 fail-fast `throw`；`src/**`、`wasm/web/**`、运行期 worker/transport/helper 必须继续遵守 typed error 主链。
- SSE 运行期 canonical 入口固定为 `sseRuntime`；`notificationService` 这类 compat alias 不再作为长期主链保留。
- 最小运行期 smoke 固定为 `check:runtime-regression`，覆盖认证会话、SSE、Binary 与 public hydration 回归；它不替代更重的全量回归，但属于主线硬化基线。

- 不保留长期双栈兼容入口；历史 DTO、Legacy Gateway、旧 fallback 分支按主链切换后直接清理。
- 页面消费层不应感知 JSON 和 Binary 的业务语义差异，只应感知传输格式差异。
- 新读接口优先先定义 ReadModel，再分别投影到 JSON Response 和 POD Binary。
- 新缓存逻辑必须进入统一 L1/L2 治理，不允许服务层散写裸 Redis key。

FsusBlog 的目标不是“把博客跑起来”，而是把一套可维护、可验证、可持续演进的内容系统跑在更短、更稳、更一致的链路上。

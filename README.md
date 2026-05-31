# Fsu's Blog

一个面向真实部署的高性能个人内容系统。
它不是"演示型博客模板"，而是把公开首屏、Binary 传输、AOT 输出、本地搜索、浏览器边缘缓存、安全链路和后台治理一起做进主链的**单体全栈工程**。

> **v1.0.0** — 2026-04-27 · 后端 .NET 10 / C# 14 · 前端 Vue 3.5 · Wasm C++23

## 功能特性

| 功能 | 说明 |
|------|------|
| 公开内容页 | 首页、归档、分类、标签、文章详情，AOT 预渲染 + SPA hydration 双路保障首屏 |
| Binary 传输 | AEDS v2 二进制帧协议，C++23 Wasm / TypeScript 双解码，hot-path 池化写入且不构造第二份完整 frame，不回退旧文本 API |
| 本地搜索 | Service Worker 缓存静态索引 + 浏览器端 Wasm 排序，无服务端在线检索 |
| 认证与授权 | PoW 前置 + 注册/登录 + JWT Access Token（15 min）+ HttpOnly Cookie |
| 通行密钥 (Passkey) | WebAuthn / FIDO2 Discoverable Credential，无密码登录，最多 5 枚/用户 |
| 多因素认证 (MFA) | TOTP RFC 6238，独立恢复码，管理员重置 |
| 多会话管理 | 查看活跃会话，吊销单个或全部其他会话 |
| 实时通知 | SSE 增量事件流（`/api/notifications/stream`） |
| 站内消息 | 用户收发对话，管理员广播，对话状态管理 |
| 管理后台 | 用户管理、内容审核、站点统计（Binary 读链） |
| 多分层测试 | fast / integration / acceptance / visual / security / resilience / load / production 共 10 级 |

## 项目定位

FsusBlog 以 `SEO 首访速度 + 运行时一致性 + 工程可维护性` 为核心约束：

- **公开页优先**：首页、归档、分类、标签、文章详情优先保障首屏和可索引性。
- **统一契约**：同一业务对象在 AEDS Binary、Public AOT 与必要 JSON 运维/证明端点中保持同一语义。
- **单体优先**：减少跨服务跳转，把复杂度压在工程内部而不是部署拓扑上。
- **安全前置**：PoW、JWT、多会话、MFA、Passkey、风控、注销、缓存治理都按基础设施能力建设。
- **前端性能优先**：浏览器本地搜索、Service Worker 边缘缓存、Wasm 渲染与解码进入正式主链。

## 架构概览

### 技术栈

**后端**

| 技术 | 版本 | 用途 |
|------|------|------|
| .NET SDK / C# | 10 / 14 | 运行时与语言版本 |
| ASP.NET Core Kestrel | 10 | HTTP 服务器 |
| SqlSugar | 5.1.4.214 | PostgreSQL ORM，CodeFirst |
| Redis | — | L2 缓存 + SSE backing store |
| Fido2 | 4.0.1 | WebAuthn / Passkey |
| BCrypt.Net-Next | 4.1.0 | 密码哈希 |
| Serilog | 4.3.1 | 结构化日志，异步滚动文件 |
| IP2Location | — | 地理定位 |

**前端**

| 技术 | 版本 | 用途 |
|------|------|------|
| Vue | 3.5.32 | 渐进式框架 |
| Vite | 7.3.2 | 构建工具，HMR |
| TypeScript | ~5.9.3 | 静态类型 |
| Pinia | 3.0.4 | 状态管理 + 持久化 |
| Vue Router | 4.6.4 | 客户端路由 |
| Tailwind CSS | 4.2.2 | 原子化样式 |
| @simplewebauthn/browser | 13.3.0 | Passkey 浏览器 API |
| FsusUI | GitHub Packages | 项目专属组件库 |
| Playwright | 1.59.1 | E2E 测试 |

**WebAssembly / C++**

- C++23（Freestanding，无 STL 堆分配）
- Emscripten SDK，CMake + Ninja
- AEDS v2 解码、CRC 校验、Markdown 渲染

### 当前主链

- 运行时主 API 收敛到 `/api/binary/**` Binary/POD（`application/octet-stream`，AEDS v2 帧），公开读取、管理端写入、认证、MFA、Passkey 都走同一链路。
- 作者工作台 `/api/author/**`、真人阅读 proof、健康检查和少量运维端点保留 JSON；旧文本 `/api/**` 业务端点不作为客户端 fallback。
- 搜索不再依赖服务端在线检索，客户端加载静态索引并本地排序。
- 公开页首访优先走 AOT 命中；未命中则回到 SPA index，再由 hydration 接管。

### 仓库结构

```text
FsusBlog/
├── src/frontend/                         # Vue 3 SPA、Wasm、Service Worker、公开页 hydration
├── src/backend/          # ASP.NET Core 10 API、AOT、SSE、缓存、安全链路
├── src/shared/          # 前后端共享契约与二进制协议模型
├── src/core/            # 映射、POD 编解码、共享投影逻辑
├── tests/backend/   # xUnit 单元与集成测试
├── benchmarks/core/ # BenchmarkDotNet 性能基准
├── docs/                     # 深度文档
│   ├── architecture.md       # 系统架构与缓存分层
│   ├── api.md                # API 端点快速参考
│   ├── security.md           # 安全模型（PoW / JWT / MFA / Passkey）
│   ├── production.md         # 生产部署与环境变量
│   ├── operations.md         # 运维手册（发布门控、回滚、备份）
│   ├── development.md        # 本地开发指南
│   ├── testing.md            # 测试分层策略
│   ├── wasm.md               # WebAssembly 开发指南
│   └── api/                  # API 详细文档
│       ├── design.md         # API 设计哲学与约定
│       ├── contracts.md      # 请求 / 响应契约完整文档
│       ├── quick-reference.md # 路由速查表
│       └── schemas-and-errors.md # 错误码与二进制结构
├── tools/                    # 构建、测试、部署脚本
├── docker-compose.yml        # 生产编排
└── docker-compose.dev.yml    # 本地开发编排
```

## 本地开发

### 环境要求

- .NET SDK 10
- Node.js 20+，npm 10+
- Docker + Docker Compose（运行 PostgreSQL、Redis 和后端容器）
- Emscripten SDK（可选，仅在本地重新构建 Wasm 时需要）
- `GITHUB_PACKAGES_TOKEN` 环境变量（用于安装私有 FsusUI 组件库）

### FsusUI 依赖

客户端组件库通过 GitHub Packages 分发。安装前需设置：

```bash
export GITHUB_PACKAGES_TOKEN=your_github_packages_token
```

客户端 `.npmrc` 已固定：

- `@ozwasyd:registry=https://npm.pkg.github.com`
- `//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}`

### 启动方式

**第一步**：启动后端依赖与 API 服务

```bash
docker compose -f docker-compose.dev.yml up -d
```

**第二步**：安装前端依赖并启动开发服务器

```bash
cd src/frontend
npm ci
npm run dev:debug
```

**常用地址**

| 地址 | 用途 |
|------|------|
| `http://127.0.0.1:3000` | Vite 前端开发壳（HMR） |
| `http://127.0.0.1:5000` | ASP.NET Core API + 公开页（Debug） |
| `http://127.0.0.1:8080` | Release Preview（生产构建测试） |

### Visual Studio 调试

- 默认启动配置：`Debug / Client + Docker`（最接近生产）
- 次级启动配置：`Debug / Client + NativeServer`（更快的 C# 迭代）
- 默认 `F5` 浏览器入口统一为 `http://127.0.0.1:3000`

### 发布构建开关

Release publish 默认会检查 `src/frontend/node_modules`、执行 `npm run build:release`，并把 `src/frontend/dist` 与前端 runtime 文件复制进后端发布产物。后端-only 诊断或临时发布可显式传入：

```bash
dotnet publish src/backend/FsusBlog.Server.csproj -c Release /p:PublishClientAssets=false
```

该开关不会改变生产默认行为；只用于把后端发布链路从 Node/npm/GitHub Packages 临时解耦。

## 测试

测试通过 `./tools/test.sh <tier>` 按分级执行：

| 层级 | 用途 | 依赖 |
|------|------|------|
| `fast` | 纯单元测试，无外部依赖 | 无 |
| `integration` | 服务端集成测试 | Docker、3000/5000 |
| `ci` | fast + integration | 同上 |
| `release` | 公开页 hydration / AOT / SEO | 8080 |
| `acceptance` | 全量 Playwright E2E | 全部端口 |
| `visual` | 深色模式、移动端、截图基线 | 全部端口 |
| `security` | 认证/MFA/PoW/权限/Passkey 门控 | 全部端口 |
| `resilience` | 上传、搜索、SSE 弹性 | 全部端口 |
| `load` | 轻量并发压测 | 全部端口 |
| `production` | 全量发布门控（fast 后一次 bootstrap，再串行执行全部风险清单） | Docker、全部端口 |

单独运行快速单元测试：

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter "Category!=Integration" -v minimal
```

详细规则见 [tests/backend/TESTING.md](tests/backend/TESTING.md)。

`production` 是合并与发布前的权威质量门：要求 0 编译警告、0 类型错误、0 Vite build warning、0 测试失败、0 运行时 error/warning，并覆盖匿名/登录/admin、Binary API、作者工作台/read-proof/health JSON、SSE、AOT hydration、PoW/MFA/Passkey/session、视觉、弹性与轻量负载。GitHub Actions `Quality Gate` 会在 PR、`main` / `master` push 和手动触发时运行同一条 `./tools/test.sh production`；仓库 secret 需要配置 `GITHUB_PACKAGES_TOKEN`。

## 文档索引

| 文档 | 说明 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 系统架构、缓存分层、双读链、安全链路全景 |
| [docs/api.md](docs/api.md) | API 端点快速参考（路由 / 认证要求 / 速率限制） |
| [docs/api/design.md](docs/api/design.md) | API 设计哲学、响应格式约定、双链路决策 |
| [docs/api/contracts.md](docs/api/contracts.md) | 请求/响应 DTO 完整契约、SSE 信封、AOT 契约 |
| [docs/api/quick-reference.md](docs/api/quick-reference.md) | 所有端点路由速查表（含认证 / 限流 / Binary 对照） |
| [docs/api/schemas-and-errors.md](docs/api/schemas-and-errors.md) | 错误码枚举、AEDS v2 帧格式、POD 大小目录 |
| [docs/security.md](docs/security.md) | 安全模型：PoW、JWT、MFA、Passkey、RBAC、CORS |
| [docs/production.md](docs/production.md) | 生产部署、环境变量、健康检查 |
| [docs/operations.md](docs/operations.md) | 运维手册：发布门控、回滚、备份、事故处置 |
| [docs/development.md](docs/development.md) | 本地开发环境搭建、常用脚本说明 |
| [docs/testing.md](docs/testing.md) | 测试分层策略（10 级）与覆盖场景说明 |
| [docs/wasm.md](docs/wasm.md) | WebAssembly 工具链、构建、C++/TS 接口边界 |
| [tests/backend/TESTING.md](tests/backend/TESTING.md) | 测试分层规则与洁净性约定 |
| [src/core/Algorithms/AEDS_V1_PROTOCOL.md](src/core/Algorithms/AEDS_V1_PROTOCOL.md) | AEDS 二进制帧协议规格（当前运行时只接受 v2） |

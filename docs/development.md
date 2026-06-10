# 本地开发指南

本文件说明如何在本机搭建 FsusBlog 完整开发环境。

---

## 环境要求

| 工具 | 版本要求 | 用途 |
|------|---------|------|
| .NET SDK | 10.0+ | 后端编译与运行 |
| Node.js | 20 LTS+ | 前端依赖与构建 |
| npm | 10+ | 前端包管理 |
| Docker + Docker Compose | 最新稳定版 | PostgreSQL、Redis、后端容器 |
| Emscripten SDK | 最新稳定版 | 仅在本地重新构建 Wasm 时需要 |

验证安装：

```bash
dotnet --version          # 应输出 10.x.x
node --version            # 应输出 v20.x.x
npm --version             # 应输出 10.x.x
docker compose version    # 应输出 v2.x.x
```

---

## 首次配置

### 1. FsusUI 私有组件库

前端组件库通过 GitHub Packages 分发，安装前需设置个人访问令牌：

```bash
export GITHUB_PACKAGES_TOKEN=your_github_personal_access_token
```

建议将其写入 shell profile（`~/.bashrc` 或 `~/.zshrc`）以持久化。
令牌需要 `read:packages` 权限。

### 2. Wasm 预构建产物

仓库不内置预编译 Wasm。首次开发前，确保 `src/frontend/wasm/` 目录下有已构建的 `.wasm` 文件：

```bash
cd src/frontend
npm run ensure:wasm
```

若本地需重新构建 Wasm（需已安装 Emscripten SDK）：

```bash
npm run build:wasm
```

---

## 启动开发环境

### 第一步：启动后端依赖

```bash
# 启动 PostgreSQL + Redis（+ 可选的后端容器）
docker compose -f docker-compose.dev.yml up -d
```

`docker-compose.dev.yml` 会启动：
- PostgreSQL（5432 端口）
- Redis（6379 端口）
- 可选：后端 API 容器（调试 Release 构建用）

ASP.NET Core 后端也可在本地直接运行（更快的 C# 迭代）：

```bash
cd src/backend
dotnet run
# 或通过 Visual Studio / Rider 的 "Debug / NativeServer" 配置启动
```

### 第二步：启动前端开发服务器

```bash
cd src/frontend
npm ci                 # 首次或依赖变更后需执行
npm run dev:debug      # Vite HMR，监听 0.0.0.0:3000
```

### 常用访问地址

| 地址 | 用途 |
|------|------|
| `http://127.0.0.1:3000` | Vite 前端开发壳（HMR） |
| `http://127.0.0.1:5000` | ASP.NET Core API（Debug 本地运行） |
| `http://127.0.0.1:8080` | 生产构建预览（Release 容器） |

---

## 开发环境配置

### 后端配置（`appsettings.Development.json`）

开发环境会自动合并 `appsettings.Development.json`，通常**无需修改**。
默认值：

```json
{
  "RedisOptions": {
    "Configuration": "localhost:6379",
    "InstanceName": "MyBlog_"
  },
  "Jwt": {
    "SecretKey": "Were_I_you_I_would_get_high_like_some_airplanes",
    "AccessTokenExpiresMinutes": 15
  },
  "Fido2": {
    "ServerDomain": "localhost",
    "Origins": ["http://localhost:3000", "http://localhost:5173"]
  }
}
```

> **注意**：生产环境绝不使用上述默认密钥，`ProductionStartupValidator` 会在启动时强制检查。

### 前端代理配置

Vite 通过 `vite.config.ts` 中的 `proxy` 配置将 `/api/` 和 `/health/` 请求转发到后端：

```typescript
// vite.config.ts（示意）
proxy: {
  '/api': { target: 'http://127.0.0.1:5000', changeOrigin: true },
  '/health': { target: 'http://127.0.0.1:5000', changeOrigin: true },
}
```

前端代码中所有 API 调用使用相对路径，无需在开发/生产间切换 base URL。

---

## 常用 npm 脚本

### 开发

| 命令 | 说明 |
|------|------|
| `npm run generate:public-page-manifest` | 从 `src/shared/Contracts/Outputs/PublicPageContracts.cs` 生成前端 public page manifest |
| `npm run dev:debug` | 启动 Vite 开发服务器（HMR，host 0.0.0.0:3000） |
| `npm run build:release` | 生产构建（输出到 `dist/`） |

`dev`、`dev:debug`、`test:unit:*` 和 `build:release` 会自动先同步 public page manifest，避免前端 AOT 页面身份与 shared C# 契约漂移。

### Wasm

| 命令 | 说明 |
|------|------|
| `npm run ensure:wasm` | 检查并拉取 Wasm 预构建产物 |
| `npm run build:wasm` | 本地重新编译 Wasm（需 Emscripten） |
| `npm run deps:wasm-codec` | 更新 Wasm 相关依赖 |

### 静态检查

| 命令 | 说明 |
|------|------|
| `npm run check:modern-standards` | 验证现代 Web 标准兼容性 |
| `npm run check:error-code-alignment` | 验证前后端错误码一致性 |
| `npm run check:security-consistency` | 验证鉴权语义一致性 |

### AOT / SEO

| 命令 | 说明 |
|------|------|
| `npm run check:aot` | 验证 AOT 契约合规性 |
| `npm run check:public-seo-smoke` | 公开页 SEO 冒烟测试 |
| `npm run check:public-hydration` | 公开页 hydration 冒烟 |
| `npm run warm:public-aot` | 预热公开页 AOT 缓存 |

### 测试（分层）

| 命令 | 说明 |
|------|------|
| `npm run test:fast` | 纯单元测试，无外部依赖 |
| `npm run test:integration` | 集成测试（需 Docker） |
| `npm run test:ci` | fast + integration |
| `npm run test:acceptance` | 全量 Playwright E2E |
| `npm run test:visual` | 视觉回归测试 |
| `npm run test:production` | 全量发布门控 |

详细分层规则见 [testing.md](testing.md)。

---

## Visual Studio / Rider 调试

### 推荐启动配置

| 配置名 | 场景 |
|--------|------|
| `Debug / Client + Docker` | 最接近生产的调试（推荐） |
| `Debug / Client + NativeServer` | 更快的 C# 迭代 |

`FsusBlog.slnLaunch` 包含上述启动配置定义。
默认 F5 入口统一为 `http://127.0.0.1:3000`。

### 调试技巧

- **后端断点**：使用 `Debug / NativeServer` 配置，直接在 C# 代码打断点
- **Binary 解码调试**：在 `wasmDecode.worker.ts` 中设置 `debugMode = true`，Worker 会输出详细解码日志
- **Notification stream 调试**：访问 `http://127.0.0.1:5000/api/notifications/stream` 观察 AEDS WebSocket 事件流
- **缓存调试**：L1 缓存在进程内，重启即清空；L2 Redis 缓存可通过 `redis-cli FLUSHDB` 清空

---

## 常见问题

### `npm ci` 失败：`403 Forbidden from GitHub Packages`

```bash
# 确认令牌已设置
echo $GITHUB_PACKAGES_TOKEN
# 重新设置并重试
export GITHUB_PACKAGES_TOKEN=your_token
npm ci
```

### 后端启动失败：`Redis connection refused`

```bash
# 确认 Docker 容器已启动
docker compose -f docker-compose.dev.yml ps
# 重启 Redis
docker compose -f docker-compose.dev.yml restart redis
```

### Wasm 解码失败

运行时不会回退到文本 API。先检查 `wasm/` 目录是否有 `.wasm` 文件：

```bash
ls src/frontend/wasm/
# 若为空，执行：
cd src/frontend && npm run ensure:wasm
```

### 数据库迁移未执行

后端首次启动会自动执行 SqlSugar CodeFirst 迁移（`SchemaMigration`）。
若需手动触发，重启后端进程即可。

---

## 参见

- [testing.md](testing.md) — 完整测试分层策略
- [wasm.md](wasm.md) — WebAssembly 工具链与构建指南
- [production.md](production.md) — 生产部署配置
- [../README.md](../README.md) — 项目概述与快速开始

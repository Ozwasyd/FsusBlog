# 本地开发指南

本文件说明如何在本机搭建 FsusBlog 完整开发环境。

---

## 编码规范与权威文档门禁

跨语言代码风格统一见 [development/coding-conventions.md](development/coding-conventions.md)。该规范以 Microsoft .NET C# 约定为母规范，集中定义语言映射、外部契约例外和 generated/vendor/fixture 分类；`AGENTS.md` 只保留代理角色与操作边界。

修改开发文档中的路径、symbol、命令或规范入口后运行：

```bash
node tools/docs/check-authoritative-development-docs.mjs
```

门禁会聚合失效路径、退休 symbol、缺失命令、坏链接、style owner 漂移和未分类例外，全部修正后才成功。

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

### 一键启动（推荐）

```bash
./tools/dev/start.sh --seed-demo
```

该入口会启动：

- PostgreSQL（默认 `127.0.0.1:5432`）
- Redis（默认 `127.0.0.1:6379`）
- ASP.NET Core backend（`http://127.0.0.1:7568`）
- Vite frontend（`http://127.0.0.1:3000`）
- 可选 deterministic fictional demo data（`--seed-demo`）

清理本地开发容器和 volume：

```bash
./tools/dev/start.sh --cleanup
```

Demo seed 详情见 [development/demo-data.md](development/demo-data.md)。

### 手动启动后端依赖

一键入口不可用时，可先启动本地依赖：

```bash
docker compose -f ops/development/dependencies.compose.yml up -d postgres redis
```

随后启动 ASP.NET Core 后端：

```bash
dotnet run --project src/backend/FsusBlog.Server.csproj --urls http://127.0.0.1:7568
# 或通过 Visual Studio / Rider 的 "Debug / NativeServer" 配置启动
```

### 手动启动前端开发服务器

```bash
npm --prefix src/frontend ci                 # 首次或依赖变更后需执行
npm --prefix src/frontend run dev:debug      # Vite HMR，监听 0.0.0.0:3000
npm --prefix src/frontend run dev:ssr        # 仅调试后端 public shell SSR proxy
```

默认 `dev` / `dev:debug` 由 Vite 直接服务公开页入口与 `/src` 资源，适合编辑前端样式、公开页交互和本地 FsusUI HMR。不要在这类工作中启用后端 public shell SSR proxy。

`dev:ssr` 会通过 `VITE_PUBLIC_SHELL_PROXY=1` 把公开 SEO 路由代理到本地后端，只用于验证后端 SSR 壳、AOT 回填和预编译公开页输出。使用前需要确认后端正在 `http://127.0.0.1:7568` 运行。

dev 模式下，Vite 会通过 `transformIndexHtml` 注入 `public-shell-critical.css?direct` 与 `public-page.css?direct`，让公开页首屏 CSS 进入 Vite module graph，支持 source CSS HMR 并避免 hydration 后才补 link 的 FOUC。生产模式不使用 `?direct`，运行时只在没有可用样式表时启用 emergency fallback（`/public-shell-emergency.css`）。

`public/public-shell-emergency.css` 由 `npm run generate:public-shell-emergency` 从 `src/assets/public-page.css` 里的 `emergency:keep` 区块生成，并同步写入 `dist/server/public-shell-emergency.css`。贡献者只应编辑源 CSS 中 `/* emergency:keep-start */` 与 `/* emergency:keep-end */` 之间的最小首屏规则；未标记的普通公开页规则不会进入 emergency fallback。

### 常用访问地址

| 地址 | 用途 |
|------|------|
| `http://127.0.0.1:3000` | Vite 前端开发壳（HMR） |
| `http://127.0.0.1:7568` | ASP.NET Core API（Debug 本地运行） |
| `http://127.0.0.1:8080` | 生产构建预览（Release 容器） |

### 本地 Passkey 注入

当前 anonymous identity mode 下，旧 `sys_user` 密码登录和旧 `role=admin`
不再授予登录或后台权限。Demo seed 只创建匿名账号容器 `demo-reader` 和禁用的
mock admin principal `demo-admin` 用于归属展示；它们不是登录凭据。首次本地登录
应通过浏览器 Passkey ceremony 创建凭据；自动化或无物理认证器环境可以把
Passkey 注入到浏览器的 WebAuthn virtual authenticator，再走真实的注册 /
admin bootstrap 完成流程。

本地无 HTTPS 豁免只适用于 loopback origin：

- 推荐使用 `http://localhost:3000` 做 Passkey 注册、登录和 admin bootstrap。
- 如必须使用 `http://127.0.0.1:3000`，后端启动前把
  `Fido2__ServerDomain` 设为 `127.0.0.1`，并把 `Fido2__Origins__0`
  设为 `http://127.0.0.1:3000`。不要在同一枚凭据上混用 `localhost`
  与 `127.0.0.1`，WebAuthn 凭据按 RP ID 隔离。
- LAN IP、Docker bridge IP、自定义内网域名仍必须使用 HTTPS 和匹配的
  `Fido2:ServerDomain` / `Fido2:Origins`；本地豁免不得扩展到生产或共享环境。

Playwright / Chromium 注入示例：

```ts
const context = await browser.newContext({ baseURL: 'http://localhost:3000' })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)

await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true
  }
})

await page.goto('/login')
```

上面的注入只创建浏览器侧虚拟认证器。随后仍必须通过正常 UI 或二进制 API
执行 Passkey 注册、Recovery Key 绑定或
`/api/binary/auth/admin/bootstrap/passkey/begin|complete`。不要直接向
`passkey_credential` 或 `admin_passkey_credential` 插入固定私钥 / 公钥行；
这样会绕过 challenge 消费、origin 校验和审计链路，也无法证明浏览器实际持有凭据。

如果要创建本地 root admin principal，请在后端启动前提供一次性 bootstrap token：

```bash
export FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN=local-dev-bootstrap-token
/opt/homebrew/bin/bash ./tools/dev/start.sh --seed-demo
```

然后使用同一个 loopback origin 完成 admin bootstrap Passkey ceremony。root
admin 一旦存在，bootstrap 端点会固定拒绝再次初始化；需要重建本地身份时清理
dev PostgreSQL / Redis volume 后重新启动。

---

## 开发环境配置

### 后端配置 authority

`src/backend/appsettings.json` 是唯一共享 base。开发环境只在确有本机差异时创建被 Git 忽略的 overlay：

```bash
cp src/backend/appsettings.Development.example.json src/backend/appsettings.Development.json
```

该示例只包含 loopback PostgreSQL/Redis、local auth fixture、insecure local cookie、synthetic release fence 和 localhost browser origin 等 11 个有意覆盖的 leaf；不得把 base 全量复制进去。ASP.NET Core 会按 base < `appsettings.Development.json` < environment variable < command line 合并。

Production 使用已跟踪的 `appsettings.Production.json` 作为真实 fail-closed policy overlay，操作者从 `.env.production.example` 创建私有 `.env.production`。完整生产优先级为 base < Production overlay < `.env.production`/Compose environment < command line；真实 secret 继续由 environment、user-secrets 或 mounted file 提供，不能进入 tracked JSON/example。详见 [appsettings authority](configuration/appsettings-authority.md)。

### 前端代理配置

Vite 通过 `vite.config.ts` 中的 `proxy` 配置将 `/api/` 和 `/health/` 请求转发到后端：

```typescript
// vite.config.ts（示意）
proxy: {
  '/api': { target: 'http://127.0.0.1:7568', changeOrigin: true },
  '/health': { target: 'http://127.0.0.1:7568', changeOrigin: true },
}
```

前端代码中所有 API 调用使用相对路径，无需在开发/生产间切换 base URL。

---

## 常用 npm 脚本

### 开发

| 命令 | 说明 |
|------|------|
| `npm run generate:public-page-manifest` | 从 `src/shared/Contracts/Outputs/PublicPageContracts.cs` 生成前端 public page manifest |
| `npm run generate:public-shell-emergency` | 从 `src/assets/public-page.css` 的 `emergency:keep` 区块生成公开页 emergency CSS |
| `npm run dev` | 启动 Vite 开发服务器（源码入口，适合前端样式与本地 FsusUI HMR） |
| `npm run dev:debug` | 启动 Vite 开发服务器（源码入口，HMR，host 0.0.0.0:3000） |
| `npm run dev:ssr` | 设置 `VITE_PUBLIC_SHELL_PROXY=1` 后启动后端 public shell SSR proxy 调试模式 |
| `npm run build:release` | 生产构建（输出到 `dist/`） |

`dev`、`dev:debug`、`dev:ssr`、`test:unit:*` 和 `build:release` 会自动先同步 public page manifest，避免前端 AOT 页面身份与 shared C# 契约漂移。

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

Public AOT eligibility 由 `src/shared/Contracts/Outputs/PublicPageContracts.cs`
生成到 `src/frontend/src/public-renderers/generated/publicPageManifest.ts`，
并由 `tests/frontend/checks/public/public-hydration-matrix.registry.json`
记录 Search / Account 等非 AOT 路由策略。Home、ArticleDetail、Filter、
Archive、About、Privacy、Guidelines、Copyright 可以生成匿名 Public AOT shell。
`/search` 当前只允许 SPA fallback：搜索查询空间无界，直接写入 AOT 会造成
cache explosion、搜索索引陈旧和 hydration routeKey 漂移。`/user/profile`
以及 account/messages/auth-required 路由必须保持 runtime-only：这些页面依赖用户态，
不得写入公开 AOT cache，也不得输出 `fsus-aot-hydration-props` 或
`data-public-hydration-kind`。

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

`FsusBlog.slnLaunch` 包含上述启动配置定义，并仅引用 `FsusBlog.slnx` 中的真实项目路径。后端原生 profile 位于 `src/backend/Properties/launchSettings.json`，Compose profile 由 `ops/docker/docker-compose.dcproj` 所有并位于 `ops/docker/Properties/launchSettings.json`；完整所有权规则见 [configuration layout](configuration-layout.md)。
默认 F5 入口统一为 `http://127.0.0.1:3000`。

### 调试技巧

- **后端断点**：使用 `Debug / NativeServer` 配置，直接在 C# 代码打断点
- **Binary 解码调试**：在 `wasmDecode.worker.ts` 中设置 `debugMode = true`，Worker 会输出详细解码日志
- **Notification stream 调试**：访问 `http://127.0.0.1:7568/api/notifications/stream` 观察 AEDS WebSocket 事件流
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
docker compose -f ops/development/dependencies.compose.yml ps
# 重启 Redis
docker compose -f ops/development/dependencies.compose.yml restart redis
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

- [development/coding-conventions.md](development/coding-conventions.md) — 跨语言编码规范、命名映射与外部契约例外
- [testing.md](testing.md) — 完整测试分层策略
- [wasm.md](wasm.md) — WebAssembly 工具链与构建指南
- [production.md](production.md) — 生产部署配置
- [development/demo-data.md](development/demo-data.md) — 本地 demo seed data
- [troubleshooting.md](troubleshooting.md) — 常见开发环境故障排查
- [../README.md](../README.md) — 项目概述与快速开始

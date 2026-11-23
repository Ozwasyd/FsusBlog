# FsusBlog v2

FsusBlog v2 是一个面向自托管与可验证部署的模块化单体内容系统，基于 **.NET 10**（C# 14、ASP.NET Core Minimal APIs）、**PostgreSQL 18**（Npgsql）与 **Vue 3 / TypeScript** 构建，跨栈通信统一使用 **AEDS v2** 二进制线协议。

- 完整文档导航见 [文档总索引](docs/index.md)，当前发布范围与剩余阻断项见 [发布就绪矩阵](docs/releases/readiness.md)。
- 历史参考说明：FsusBlog v1 已归档退役，仓库不再维护 v1 迁移工具或历史采集底稿（历史记录可经 Git 提交历史追溯）。

## 核心特性

- **在线与离线严格分离**：`FsusBlog.V2.Server` 仅以 DML-only 数据库账号运行，启动时通过共享程序集 `FsusBlog.V2.Storage.dll` 只读校验 Schema（fail-closed）；建库初始化（`plan`/`apply`/`verify`）、密钥生成、管理员引导与高危维护集中在离线工具 `FsusBlog.V2.Cli`。
- **单机独占租约与热读零库访问**：由 PostgreSQL 独占 advisory lock 守卫不可变 `PublicSnapshot`，HTML、AEDS、Feed 与搜索分片共享同一公开代次，撤回后旧代次立即可拒绝。
- **跨栈 AEDS v2 协议**：业务接口统一承载二进制帧（`application/octet-stream`），无 JSON 业务回退；由 `src/Contracts/wire.schema.json` 自动生成 C#、TypeScript 与 C++ 构件。
- **纵深安全与统一单域名部署**：默认单域名 HTTPS 拓扑（支持可选拆分管理域名或纯公开只读模式），读者与管理员在数据库表、Passkey、Cookie 与会话接口上严格隔离，辅以严格 CSP、Passkey Step-Up、Scoped PoW 与双人申诉复核。
- **创作、搜索与内容完整性**：消费 `@ozwasyd/element-plus`（FsusUI）提供双栏工作区、属性筛选、万节点 Canvas、多格式导出、本地分片/宽语料/服务端 FAS4 三模式搜索，以及公开验证密钥、透明日志与每日 Merkle 检查点。

## 解决方案分层

| 目录 / 工程 | 职责 |
| --- | --- |
| `src/Contracts/` | AEDS v2 线协议定义、代码生成物与本地搜索格式契约 |
| `src/Core/` | 无 HTTP/存储/OS 依赖的纯领域模型、密码学与业务策略 |
| `src/Platform/` | POSIX/PInvoke、目录句柄安全 I/O 与 Linux Worker 边界（严格单向依赖 `Platform -> Core`） |
| `src/Storage/` | 共享只读 Schema 形态验证（`CurrentSchema`），供 `Server` 与 `Cli` 共同引用，不含 DDL |
| `src/Server/` | 在线 HTTP/AEDS 服务、公开快照、租约与身份权限执行 |
| `src/Cli/` | 离线运维 CLI（`FsusBlog.V2.Cli`）与最终建表 SQL（`src/Cli/Schema/01..04*.sql`） |
| `src/PluginWorker/` | Linux ARM64 专用离线签名纯 Markdown 插件隔离执行宿主 |
| `src/Web/` | Vue 3 / TypeScript 前端，通过 GitHub Packages 锁定消费 `@ozwasyd/element-plus` npm 发布包与内置原生 Wasm |

更完整的架构说明见 [系统架构总览](docs/architecture/overview.md)。

## 快速开始（本地开发）

日常开发推荐使用一键脚本 `tools/dev.sh`，自动拉起 `.dev-data/` 下的独立持久化 PostgreSQL 18、初始化 Schema 并并行启动后端（`dotnet watch`）与前端（Vite HMR）：

```sh
# 首次启动并灌入示例文章、分类标签、阅读计数、待审评论与支持工单
./tools/dev.sh --seed

# 清空本地开发库重建并重新灌入示例数据
./tools/dev.sh --reset --seed

# 仅拉起本地开发 PostgreSQL（配合 IDE F5 断点调试，见 launchSettings.json / .vscode/launch.json）
./tools/dev.sh --db-only
```

- 统一单源访问入口：`http://localhost:5173/`（公开站）与 `http://localhost:5173/login`（读者与管理员统一 Passkey 登录入口，按身份自动跳转至 `/user/identity/mfa` 或 `/admin/site`）。
- 浏览器 DevTools 控制台可执行 `__fsusDebug.aeds(true)` 开启开发态 AEDS v2 二进制帧与 `X-Fsus-*` 响应头实时日志（生产构建自动移除）。

## 构建与基础验证

依赖版本由 [`global.json`](global.json)（.NET SDK `10.0.404` / 运行库 `10.0.15`）、[`NuGet.Config`](NuGet.Config) 与 `src/Web/pnpm-lock.yaml` 锁定，开发与集成测试必须使用独立空 PostgreSQL 数据库，切勿操作生产库或 v1 数据库：

```sh
# 后端锁定恢复、Release 编译与单元/边界测试
dotnet restore FsusBlog.V2.slnx --configfile NuGet.Config --locked-mode
dotnet build FsusBlog.V2.slnx -c Release --no-restore
dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj -c Release --no-build
dotnet test tests/Platform/FsusBlog.V2.Platform.Tests.csproj -c Release --no-build

# AEDS v2 跨语言（C# / TypeScript / C++ / Wasm）固定向量校验
./tools/protocol-test.sh

# 前端严格类型检查与生产构建
pnpm --dir src/Web typecheck
pnpm --dir src/Web build

# 文档完整性与配置覆盖检查
python3 tools/check-docs.py
```

专用验收入口说明：

- **协议向量可执行程序**：`tests/Protocol/FsusBlog.V2.ProtocolTests.csproj` 为独立控制台程序，由 `./tools/protocol-test.sh` 统一调用，不通过 `dotnet test` 运行。
- **Linux ARM64 插件隔离宿主**：`src/PluginWorker/` 在解决方案中仅覆盖受管编译，真实封装与沙箱验收需在 Linux ARM64 上运行 `tools/stage-linux-plugin-worker.sh` 及 `tests/Integration/Migration/linux-managed-plugin-flow.py`（见 [离线平台插件执行](docs/product/platform-plugin-offline.md)）。
- **数据库与浏览器端到端套件**：见 [PostgreSQL 离线维护与备份恢复](docs/migration.md) 与 [Web 构建与端到端验证](docs/web-validation.md)。

## 发布构建与生产部署

发布包从干净的 `FsusBlog` 检出、锁定依赖（含 `@ozwasyd/element-plus` 内置原生 Wasm 与本仓内嵌 C++ 标题解析器）构建（可用 `DOTNET_BIN` 指定锁定的 SDK 命令），同时生成框架依赖的后端、CLI、Web 产物、完整可达 Git 历史 bundle 与摘要清单：

```sh
tools/build-release.sh artifacts/fsusblog-v2-release
cd artifacts/fsusblog-v2-release
shasum -a 256 -c SHA256SUMS
git bundle verify history.bundle
```

在目标运行目录解包 `fsusblog-v2.tar.gz`，执行 `shasum -a 256 -c /absolute/path/to/payload.sha256` 校验文件完整性；设置 `FSUSBLOG_WEB_DIST` 指向包内 `web/`，以最小环境变量启动 `server/FsusBlog.V2.Server.dll`：

```sh
dotnet /srv/fsusblog/server/FsusBlog.V2.Server.dll --urls http://127.0.0.1:5080
```

如需审计源码历史，可在空裸仓库执行 `git fetch /absolute/path/to/history.bundle HEAD:refs/heads/main` 与 `git fsck --full`。完整部署与配置详见：

- [单域名 TLS 反代部署（Nginx / Caddy）](deploy/README.md)
- [运行与部署配置参考](docs/reference/configuration.md)
- [PostgreSQL 离线维护与备份恢复](docs/migration.md)

## 文档导航

| 主题 | 入口 |
| --- | --- |
| 全部文档总目录 | [文档总索引](docs/index.md) |
| 系统架构与模块边界 | [系统架构总览](docs/architecture/overview.md)、[单机数据库租约与交接](docs/publication-lease.md) |
| 协议、配置与前端接入 | [AEDS v2 二进制协议](docs/protocol.md)、[运行与部署配置参考](docs/reference/configuration.md)、[FsusUI 接入与原生组件契约](docs/fsusui.md) |
| 发布状态与变更记录 | [发布就绪矩阵](docs/releases/readiness.md)、[变更日志](CHANGELOG.md) |
| 协作、安全与文档规范 | [贡献指南](CONTRIBUTING.md)、[安全策略](SECURITY.md)、[文档架构与写作规范](docs/development/documentation-policy.md) |

## 安全与许可证

- 安全漏洞请通过私有渠道披露，详情见 [SECURITY.md](SECURITY.md)。
- 本项目采用 [MIT License](LICENSE) 开源许可。

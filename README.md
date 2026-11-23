# FsusBlog v2

这是从空目录建立的新实现，以 v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 为静态参考。文档总导航见 [文档总索引](docs/index.md)，早期阶段性记录保留在 [执行状态归档](docs/archive/dev-logs/status.md)。实际协议、界面和数据库支持范围以对应证据为准。

- 后端和独立维护工具使用 .NET SDK `10.0.404`、运行库 `10.0.15`、C# 14、`net10.0` 和 ASP.NET Core Minimal APIs。纯领域模型与策略位于 `src/Core/`，POSIX/PInvoke、文件描述符、签名密钥与媒体目录 I/O、扩展磁盘存储及 Linux Worker 执行边界位于独立工程 `src/Platform/`（严格单向依赖 `Platform -> Core`）。
- 数据：PostgreSQL / Npgsql，服务启动只检查当前 schema。离线工具负责初始化和验证。
- 工程分层：`Contracts`、`Core` 之上是独立的 `src/Storage/FsusBlog.V2.Storage.csproj`，单独编译共享的 schema 形态校验与存储辅助代码，`Server` 与 `Cli` 均通过 `ProjectReference` 引用，发布目录各自携带 `FsusBlog.V2.Storage.dll`。Storage 类型保持 `internal`，只对 `Server`、`Cli` 和集成测试开放友元访问；它不含 DDL，Server 仍只做 DML 与只读准入，DDL 留在 `Cli`。
- 前端：Vue / TypeScript，通过 [本地源码 alias](docs/fsusui.md) 消费相邻 `FsusUI` checkout。不会安装 FsusUI 发布包。
- 跨栈协议：[AEDS v2](docs/protocol.md)，不提供 JSON 业务回退。

```sh
# PATH 上须为全局配置指定的 SDK；配置的 NuGet 源为空，依赖使用本机缓存。
dotnet restore FsusBlog.V2.slnx --configfile NuGet.Config --locked-mode
dotnet build FsusBlog.V2.slnx -c Release --no-restore
dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj -c Release --no-build
dotnet test tests/Platform/FsusBlog.V2.Platform.Tests.csproj -c Release --no-build
./tools/protocol-test.sh
```

`FsusBlog.V2.slnx` 覆盖 `src/`（`Contracts`、`Core`、`Platform`、`Storage`、`Server`、`Cli`、`PluginWorker`）与 `tests/`（`Core.Tests`、`Platform.Tests`、`Integration.Tests`、`ProtocolTests`）全部现有 .NET 工程，项目级构建入口仍保持有效。解决方案构建仅验证受管程序集编译通过，不代表全链路验收：

- 协议固定向量与跨栈校验：`tests/Protocol/FsusBlog.V2.ProtocolTests.csproj` 是独立控制台可执行程序，不由 `dotnet test` 运行；须执行 `./tools/protocol-test.sh` 实际运行 C#、TypeScript、本机 C++ 与 Wasm 固定向量。
- 离线插件工作进程：`src/PluginWorker/FsusBlog.V2.PluginWorker.csproj` 纳入解决方案仅覆盖受管编译，不改变其 Linux ARM64 目标平台限制；发布封装（`tools/stage-linux-plugin-worker.sh`）与真实沙箱验收（`tests/Integration/Migration/linux-managed-plugin-flow.py` 及隔离/cgroup 探针）仍为 Linux ARM64 专用入口，须与受管编译分别记账，见 [离线平台插件执行](docs/product/platform-plugin-offline.md)。
- 其余专用验收入口保持不变：前端构建与浏览器验收见 [Web] 与 [Web 验证](docs/web-validation.md)，CLI shell 迁移/恢复套件与实库集成见 [迁移说明](docs/migration.md)（`tests/Integration/Migration/` 与 `tests/Integration/`）。开发或集成必须使用独立空 PostgreSQL 数据库，切勿对 v1 或生产库执行初始化。

### 本地开发、热重载与调试

日常开发推荐使用一键脚本 `tools/dev.sh`，自动拉起 `.dev-data/` 下的独立持久化 PostgreSQL 18、初始化 Schema 并并行启动后端（`dotnet watch`）与前端（Vite HMR，支持联动修改 `../FsusUI` 源码实时热更新）：

```sh
# 首次启动并灌入示例文章、分类标签、阅读计数、待审评论与支持工单
./tools/dev.sh --seed

# 清空本地开发库重建并重新灌入示例数据
./tools/dev.sh --reset --seed

# 仅拉起本地开发 PostgreSQL（配合 IDE F5 断点调试后端，见 launchSettings.json / .vscode/launch.json）
./tools/dev.sh --db-only
```

- 统一单源热重载：`http://localhost:5173/`（公开站）与 `http://localhost:5173/login`（读者与管理员统一 Passkey 登录入口，按身份自动跳转至 `/user/identity/mfa` 或 `/admin/site`；底层表、Passkey、Cookie 与会话接口仍严格隔离）。
- 浏览器 DevTools 控制台可执行 `__fsusDebug.aeds(true)` 开启开发态 AEDS v2 二进制帧与 `X-Fsus-*` 响应头实时日志（生产构建自动 tree-shake 移除）。

若以构建后的静态产物直接运行后端，构建 Web 后从仓库根目录启动：

```sh
# FSUSBLOG_DB 为 v2 数据库 DSN，建议从环境注入。
dotnet run --project src/Server/FsusBlog.V2.Server.csproj --no-build -c Release -- --urls http://127.0.0.1:5080
```

[Web]: src/Web/

发布构建使用干净的 FsusBlogV2 和相邻 FsusUI 检出、已锁定的依赖以及 FsusUI 原生 Wasm。可用 `DOTNET_BIN` 指定锁定的 SDK 命令。发布入口生成框架依赖的后端、离线迁移工具和 Web 产物，以及同一提交的完整可达 Git 历史和摘要。

```sh
tools/build-release.sh artifacts/fsusblog-v2-release
cd artifacts/fsusblog-v2-release
shasum -a 256 -c SHA256SUMS
git bundle verify history.bundle
```

在运行目录解包 `fsusblog-v2.tar.gz`，再用 `shasum -a 256 -c /absolute/path/to/payload.sha256` 验证文件。部署时设置 `FSUSBLOG_WEB_DIST` 指向包内 `web`，用运行库启动 `server/FsusBlog.V2.Server.dll`。审核历史可在空裸仓库执行 `git fetch /absolute/path/to/history.bundle HEAD:refs/heads/main` 和 `git fsck --full`。部署说明见[单域名 TLS 反代部署（Nginx / Caddy）](deploy/README.md)和[数据库初始化与恢复](docs/migration.md)。

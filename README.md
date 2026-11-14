# FsusBlog v2

这是从空目录建立的新实现，以 v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 为静态参考。当前仓库仍在实施 [验收计划](docs/status.md)。实际协议、界面和数据库支持范围以对应证据为准。

- 后端和独立维护工具使用 .NET SDK `10.0.404`、运行库 `10.0.15`、C# 14、`net10.0` 和 ASP.NET Core Minimal APIs。
- 数据：PostgreSQL / Npgsql，服务启动只检查当前 schema。离线工具负责初始化和验证。
- 前端：Vue / TypeScript，通过 [本地源码 alias](docs/fsusui.md) 消费相邻 `FsusUI` checkout。不会安装 FsusUI 发布包。
- 跨栈协议：[AEDS v2](docs/protocol.md)，不提供 JSON 业务回退。

```sh
# PATH 上须为全局配置指定的 SDK；配置的 NuGet 源为空，依赖使用本机缓存。
dotnet restore FsusBlog.V2.slnx --locked-mode
dotnet build FsusBlog.V2.slnx -c Release --no-restore
dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj -c Release --no-build
tools/protocol-test.sh
```

前端构建及本地数据库初始化分别看 [Web] 和 [迁移说明](docs/migration.md)。开发或集成必须使用独立空 PostgreSQL 数据库，切勿对 v1 或生产库执行初始化。构建 Web 后，从仓库根目录启动：

```sh
# FSUSBLOG_DB 为 v2 数据库 DSN，建议从环境注入。
dotnet run --project src/Server/FsusBlog.V2.Server.csproj --no-build -c Release -- --urls http://127.0.0.1:5080
```

[Web]: src/Web/

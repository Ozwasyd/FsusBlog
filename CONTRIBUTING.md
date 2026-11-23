# 贡献指南

> **角色**：开发与协作指南
> **适用对象**：代码与文档贡献者
> **权威依据**：详细工程边界与 Agent 规则见 [`AGENTS.md`](AGENTS.md)；文档写作要求见 [文档架构与写作规范](docs/development/documentation-policy.md)。

欢迎参与 FsusBlog v2 开发。提交变更前，请先确认本地工具链、仓库边界与分级验证要求。

## 1. 本地环境前提

- **.NET SDK**：按 [`global.json`](global.json) 锁定版本（`10.0.404` / 运行库 `10.0.15`）；仓库配置 [`NuGet.Config`](NuGet.Config) 使用离线锁定依赖（`--locked-mode`）。
- **PostgreSQL**：本地开发与集成测试需要 PostgreSQL 18（仅面向独立临时数据库，切勿连接生产库或 v1 数据库）。
- **前端与 FsusUI 依赖**：Node 24 + pnpm 10；`src/Web/` 通过 GitHub Packages 锁定安装 `@ozwasyd/element-plus` npm 发布包及其内置原生 Wasm，后端章节标题解析器源码内嵌于 `src/Server/Authoring/FsusMarkdown/`，不要求相邻 `../FsusUI` 检出。详见 [FsusUI 接入与原生组件契约](docs/fsusui.md)。
- **可选本机工具**：跨栈协议测试需 Clang / `wasm-ld`（见 `./tools/protocol-test.sh`）；端到端浏览器测试需本机 Chromium/Chrome。

## 2. 日常本地开发

仓库提供一键开发环境脚本 `tools/dev.sh`，自动在 `.dev-data/` 拉起独立 PostgreSQL 18、初始化 Schema 并并行启动后端热重载与前端 Vite HMR：

```sh
# 首次启动并灌入示例文章、分类标签、阅读计数、待审评论与支持工单
./tools/dev.sh --seed

# 重置本地开发库并重新灌入示例数据
./tools/dev.sh --reset --seed

# 仅拉起本地开发 PostgreSQL（配合 IDE F5 断点调试）
./tools/dev.sh --db-only
```

## 3. 核心工程约定

- **Pre-release Schema 策略**：v2 处于预发布开发期，直接维护最终建表脚本 `src/Cli/Schema/01..04*.sql` 与 `src/Storage/`，通过 `FsusBlog.V2.Cli plan` / `apply` 重建开发库；不新增开发期单表增量补丁命令或 v1 数据迁移代码。
- **AEDS v2 线协议生成**：所有线协议变更必须修改 [`src/Contracts/wire.schema.json`](src/Contracts/wire.schema.json)，并运行 `node tools/protocol-generate.mjs` 同步生成 C#、TypeScript 与 C++ 代码，切勿手改生成文件。
- **模块单向依赖**：`src/Core/` 保持无 HTTP/存储/OS 依赖，`src/Platform/` 严格单向依赖 `src/Core/`（由 `CorePlatformBoundaryGuardTests` 守门）。
- **文档同步**：修改公共契约、环境变量、Schema、CLI 子命令或目录结构时，同步更新对应现行文档并通过 `python3 tools/check-docs.py` 检查；不要在文档中堆砌单次测试流水账或链接本地 `artifacts/` 目录。

## 4. 分级验证矩阵

按改动影响面运行对应验证，确认全部通过后再提交：

| 改动范围 | 必跑检查 |
| --- | --- |
| C# 后端 / Core / Platform | `dotnet build FsusBlog.V2.slnx -c Release --no-restore`（0 警告 0 错误）<br>`dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj -c Release --no-build`<br>`dotnet test tests/Platform/FsusBlog.V2.Platform.Tests.csproj -c Release --no-build` |
| 协议 / `src/Contracts/` | `node tools/protocol-generate.mjs --check`<br>`./tools/protocol-test.sh` |
| 前端 / `src/Web/` | `pnpm --dir src/Web typecheck && pnpm --dir src/Web build`<br>涉及可见 UI/交互变更时补做真实桌面 + 移动端（明暗主题）浏览器验收（见 [Web 验证](docs/web-validation.md)） |
| `src/Server/`、`src/Storage/`、`src/Cli/` | 运行受影响的 PostgreSQL 18 集成测试（`tests/Integration/`）及 CLI shell 套件（`tests/Integration/Migration/`） |
| 文档 / 配置 / 治理工具 | `python3 tools/check-docs.py` |

## 5. 提交规范

- 保持小步、原子化提交，仅暂存与当前任务直接相关的文件；每次提交均须构建通过并完成对应级别验证。
- 提交说明简洁清晰，准确描述变更意图与边界，不混入未验证的临时产物或 `.DS_Store` 等本地文件。

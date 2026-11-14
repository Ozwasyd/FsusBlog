# 离线依赖盘点（V2-002）

2026-11-14 在 macOS 27.0.1 / arm64 检查。下文区分现有文件、实际运行探针和仍待完整验收的构建。没有下载新依赖，也未启动 v1、Docker 或历史验收用的 Lima VM。

| 依赖 | 实际核验 | 使用边界或缺口 |
| --- | --- | --- |
| .NET | `/Volumes/FsusPRAcceptance/root-toolchains-20261025/dotnet-10.0.302/dotnet --info`：SDK `10.0.302`、MSBuild `18.6.11`、Host/Microsoft.NETCore.App/Microsoft.AspNetCore.App `10.0.10`，RID 为 `osx-arm64`；使用 PATH 中的 `dotnet` 将得到 SDK `10.0.301`、运行库 `10.0.9`。 | 用 10.0.302 的显式路径或本机 `PATH` 选择精确 SDK。这个 SDK 中没有额外工作负载：如最终选择 .NET 的浏览器 Wasm 工作负载，需要另行提供离线工件。这里未验证生产镜像或 Linux 运行库。 |
| NuGet / PostgreSQL 驱动 | 本机 `~/.nuget/packages` 有 `Npgsql 10.0.3`（含 `net10.0`）和 `SqlSugarCoreNoDrive 5.1.4.213`（`netstandard2.1`；包与 DLL 的 AssemblyVersion 不同）。用 238 个缓存 `.nupkg` 建立仅本地目录源和独立空 `NUGET_PACKAGES`，独立 `net10.0` 项目执行 `restore`、`restore --locked-mode`、`run --no-restore` 均返回 0，实际加载两种程序集。探针同时解析 `Fido2 4.0.1`、`Konscious.Security.Cryptography.Argon2 1.3.1`、`BCrypt.Net-Next 4.1.0`、`Microsoft.AspNetCore.TestHost 10.0.7`、`Microsoft.NET.Test.Sdk 18.5.1`、`xunit 2.9.3` 和 `xunit.runner.visualstudio 3.1.5`。 | 这是包兼容性探针，不等于已跑 ORM 查询或 v2 集成测试。`Npgsql` 是一条可用的持久层路径；是否引入 SqlSugar 取决于 v2 实际持久化工程，不能同时维护两套。`StackExchange.Redis 2.7.27` 已缓存，仅在实际需要 Redis 的场景锁定。 |
| PostgreSQL 运行环境 | `/opt/homebrew/opt/libpq/bin/psql --version` 返回 `18.4`，有 `pg_dump`、`pg_restore` 等客户端；未找到同目录 `postgres`，无本机 5432 监听器。历史 Lima 环境 `fsus-original-linux` 为 stopped；静态检查其文件系统及 apt 缓存没有 PostgreSQL 服务端。 | 需要提供批准的干净 PostgreSQL 验收实例，或与验收 OS/架构匹配、包含 `postgres`、`initdb`、数据目录初始化资源、客户端与依赖的离线包。仅凭 `libpq` 无法执行数据库事务、崩溃恢复、备份恢复和真实负载验收。 |
| Node / npm / pnpm | PATH 中 Node `v24.16.0`、npm `11.13.0`；Codex 本机自带 Node `v24.22.1`，未找到方案提到的 `v24.18.0`。FsusUI 清单指定 `pnpm@10.33.0`；用本机 Corepack 已缓存的 `~/.cache/node/corepack/v1/pnpm/10.33.0/bin/pnpm.cjs` 成功执行 `--version`。默认 `pnpm` 是另一版本（`12.18.0`）。 | 在实际构建证据中记录 Node 版本，不把本机版本当成计划版本。若强制指定 `v24.18.0`，需要匹配平台的 Node 离线发行工件。见 [FsusUI 接入与浏览器证据](fsusui.md) 了解现有 checkout 与新建依赖目录的区别。 |
| FsusUI / Vue | `../FsusUI` 干净提交 `f2d929a5d045439c35e93b4771f912ce50ec2337`，该提交 `pnpm-lock.yaml` SHA-256 为 `9160eda59f2ebd9e27701d9df9718ccb7b327ceb83d418310ef542b1651451d7`。本机已安装 Vue `3.5.32`、Vue Router `4.6.4`、Vite `7.3.1`、plugin-vue `6.0.5`、TypeScript `6.0.2`、Vue TSC `3.2.6` 和 Sass `1.99.0`。 | 直接消费相邻仓库源码，通过它现有模块可以运行已验证切片。首次从空目录执行 v2 `pnpm install --offline --ignore-scripts` 时在 `@types/node@25.5.2` 离线索引缺失处停止；这不说明余下依赖均已齐备。以最终 lockfile 在空目录实际试装来记录后续缺包。 |
| FsusUI / 原生 Wasm | 首轮盘点中 Apple clang++ `21.0.0`、CMake 和 Ninja 可用；PATH 无 `emcc`，`~/.cache/emsdk` 指向不存在的目录。FsusUI 原始 `vue/packages/wasm/dist/` 缺 `ep_wasm.mjs`、`ep_wasm.wasm`、`markdown_basic.js`、`markdown_basic.wasm`、`markdown_simd.js`、`markdown_simd.wasm`。 | 找到以下同源已编译产物；Web 切片已用匹配产物完成真实 Chrome Markdown 渲染探针。它与用户随后指定的 Emscripten 源码重建、v2 协议 Wasm 解码和跨语言验收分别记录；npm 发布包不参与。 |
| 浏览器 | Playwright `1.59.1` 用 `chromium.launch({headless:true, executablePath: ...})` 成功启动已安装 Chrome `157.0.8103.51` 并渲染 HTML 标题，退出码 0。默认 `~/Library/Caches/ms-playwright` 未找到匹配二进制。 | 可用真实 Chrome 做本机冒烟。若测试矩阵要求 Playwright 固定的 Chromium、Firefox 或 WebKit，需提供对应平台的离线浏览器包。 |
| 性能工具 | macOS / arm64，MacBookPro18,3，16 GiB RAM；有 `pgbench` 客户端。 | 没有生产代理/TLS、代表性数据集和固定负载试跑结果。P2/P6 应另立负载证据，不用主机识别代替性能结论。 |

NuGet 探针锁 SHA-256 为 `bb33835c9c591fea0695b147c2c8a19d68537e4e03c6b86630f39909d843a8cf`，验证的是所列组合而非仓库实际依赖闭包。复核方法：把缓存 `.nupkg` 链接至临时目录，为临时 `net10.0` 项目生成只含该目录且 `<clear />` 关闭远程源的 `NuGet.Config`，直接引用上表精确版本，使用单独的 `NUGET_PACKAGES`，依次 `dotnet restore --configfile NuGet.Config`、`dotnet restore --locked-mode --configfile NuGet.Config`、`dotnet run --no-restore`。测试报告另记录 v2 项目自己的锁和构建命令。NuGet 审计在离线探针中关闭，不是安全审计通过的证据。

历史 FsusUI 工作树中存在同版本本机产物。只读复核 `/Volumes/FsusPRAcceptance/agent-ui1065-performance-base-20261114` 的 HEAD 等于当前 FsusUI 提交；用当前 checkout 的 `scripts/test-artifact-cache.mjs` 对源码输入重算 native 和 bundle fingerprint，分别是 `d9ab11dbb005141eb3cee174624c0952412c858ab93b84c77d4f1b76e2d46c96` 和 `598047d6346003e6d33a1cc3c8d5ebac8c3e46014ab13e1df65ae24a804fe984`，与该目录 `vue/packages/wasm/dist/` 中的 `.native-artifact-fingerprint`、`.artifact-fingerprint` 一致。下面记录六个已有文件的 SHA-256，供离线核验；这些文件没有由盘点步骤复制进工作区。用户指定的源码编译以独立构建记录为准。

| 文件 | SHA-256 |
| --- | --- |
| `ep_wasm.mjs` | `6c1b79200b77ebb02a66b51780bb84df7a06fdc5400d0ed169604c99599ed295` |
| `ep_wasm.wasm` | `28d96e86ab15e187a44a71f93e78f89670e137216b22cd5ce652211d1112b68a` |
| `markdown_basic.js` | `3bdc57de918232d07af54451f31268d6233f934408de6d58a7102ae26069bdfd` |
| `markdown_basic.wasm` | `9b96f43c4248572cf375d826973aa9aeda06d8074d10cb404e1aaff508d2311d` |
| `markdown_simd.js` | `b9b84d6402b9fb69461bb4281d746b49ac5e02fad398304a1f89deed44ce56c8` |
| `markdown_simd.wasm` | `c25f2596c189efcec91ec71cdc355d5275725eae8bab64c8bf132d8c1230eca3` |

## 已验证候选的实际工具链

用户随后授权安装计划所需的工具。`e7d1117` 的独立构建使用 macOS ARM64 的 .NET SDK 10.0.404、运行库 10.0.15、Node 24.16.0、锁定的 pnpm 10.33.0 和本地 FsusUI 源码。FsusUI 的六份原生资源已用 Emscripten 5.0.4 从源码重建。发布流程复核依赖锁、资源指纹与摘要，并逐字节比较包内 Wasm。运行持久层采用 Npgsql 10.0.3 单路径。本机使用 PostgreSQL 18.7、Caddy 2.11.9 和 Chrome 157 验收。 [FSusUI 源码及重建](fsusui.md) · [候选构建日志](../artifacts/candidate-e7d1117/release/build.txt)

原生 Debian 13 ARM64 验收使用 Lima 2.3.0 的无宿主挂载测试虚拟机。安装的 Linux SDK 10.0.404 由 Microsoft 发布清单的 SHA-512 核对，实际使用运行库 10.0.15 和 PostgreSQL 17.12。`32880a1` 的运行包经 GNU tar 解包无警告，304 个文件摘要一致，并使用原生迁移工具、Kestrel 和 PostgreSQL 完成同代公开读取与重启。虚拟机完成后关停。本地未运行 Docker 测试。 [Linux 运行环境](../artifacts/linux-plugin-host/versions.txt) · [运行日志](../artifacts/linux-plugin-host/portable-linux-run.log)

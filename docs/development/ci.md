# CI 使用与维护

> **角色**：持续集成运维指南
> **适用对象**：仓库维护者与贡献者
> **权威依据**：工作流见 [ci.yml](../../.github/workflows/ci.yml)，执行入口见 [run.sh](../../tools/ci/run.sh)，结果判定见 [checks.py](../../tools/ci/checks.py)。

## 1. 触发与检查范围

`FsusBlog V2 CI` 在 PR、主线 push、合并队列和人工触发时运行，不按文件路径跳过。每周一 03:23 UTC 执行扩展浏览器检查；人工运行时可开启 `extended`。

| 检查 | 必须完成的内容 |
| --- | --- |
| `source` | 工作流 actionlint、文档一致性、CI 判定器负向测试、Shell 语法、协议生成一致性、Admin/Authoring/Protocol Node 单测、协议与容量工具 Python 单测、Go race 测试 |
| `native-stack` | 锁定 SDK、空源离线恢复、零警告 Release 编译、Core/Platform 单测、C#/TS/C++/Wasm 协议、真实 PostgreSQL 18 集成、Caddy TLS、CLI 初始化与备份回读、Web 类型检查与构建、真实 Chromium 浏览器流程 |
| `ci / required` | 始终执行；只有前两个检查都为 `success` 才通过，取消、跳过、缺失或失败均拒绝 |

浏览器必跑默认发布闭环、管理员 TLS 身份流程及站内信 TLS 流程，并要求 FsUI 原生 Wasm。扩展模式再运行私有媒体、公开媒体、工作区恢复和 Canvas 键盘流程。不同流程顺序运行，不共享并行写入的测试数据库。

合并后，由具备仓库管理权限的维护者将 `ci / required` 配置为分支规则的必需状态检查。工作流定义与分支保护是两件事：有绿色检查不代表仓库已禁止绕过它。启用合并队列时已包含 `merge_group` 触发。

## 2. 工具链与包权限

GitHub 托管的 `ubuntu-24.04` runner 为一次性执行环境，不接入生产网络或秘密，不使用长期自托管 runner。Actions 固定完整 commit SHA；检出不保留凭据。Node、Go 和 Caddy 固定版本，.NET 版本读取 `global.json`，pnpm 读取 `src/Web/package.json`。Caddy 下载先核验已锁定的校验清单摘要，再核验 Linux x64 二进制归档；PGDG 公钥核对固定指纹，PostgreSQL 严格要求主版本 18。

首次依赖获取允许联网，仅访问配置的公共注册表与官方分发源。NuGet 先从 nuget.org 按锁文件获取，再用原有空源 `NuGet.Config` 恢复；第二次离线恢复关闭在线审计查询，首次恢复不关闭默认 NuGet 审计。前端先按锁文件 fetch，再以 `--offline --frozen-lockfile --ignore-scripts` 安装。没有跨信任边界共享依赖缓存，也不修改锁文件以迁就环境。此流程不是“整个 runner 断网运行”的证明。

前端 `@ozwasyd/element-plus` 来自 GitHub Packages。工作流仅在包获取步骤提供短期 `GITHUB_TOKEN`，使用临时 npm 配置并在退出时删除；测试阶段不注入这个 Token。包管理者必须在该包的 **Manage Actions access** 中给 `Ozwasyd/FsusBlog` 读取权限。缺少权限时 fetch 会明确失败，不回退到其他包、不伪装成功。外部 fork PR 同样可能需要包访问配置或 GitHub 的首次运行审批；不要改为 `pull_request_target` 执行不可信代码，也不要为此注入长期 PAT。

PostgreSQL、Chromium 的补丁版本和 runner 镜像会更新，运行记录保留实际工具链信息。当前 CI 不是完全可复现的签名发布构建，不生成生产发布资格。

## 3. 实库与测试结果判定

[with-postgres.sh](../../tools/ci/with-postgres.sh) 用非 root 用户创建独立 PostgreSQL 18 集群，只开放权限为 0700 的 Unix socket，不监听 TCP。它覆盖外部数据库连接变量，保证 CLI 与集成测试都指向自身临时集群。正常退出、命令失败和中断均执行进程及数据库清理；清理失败会使检查失败。

Core/Platform 不接受跳过。Linux 集成层只允许 [checks.py](../../tools/ci/checks.py) 中逐方法列出的七项排除：五个 macOS PDF 用例、一个需操作员准备的 Linux ARM64 插件用例、一个独立 C11 大数据灌库用例。排除项单独写入摘要，绝不计入通过数。新增跳过、缺数据库/Caddy/CLI、零测试、全跳过、报告缺失、重复执行 ID 或计数不一致均失败。

这些排除项尚未由本工作流自动验收。macOS PDF、Linux ARM64 插件隔离、完整大数据、独立双机正式容量、发布包历史验签和生产回滚，仍按各自专用入口验收。CI 通过不等于发布就绪矩阵全部通过，不降低任何产品或性能门槛。

## 4. 本地复现与报告

先准备与工作流相同的工具链和锁定依赖，再执行：

```sh
bash tools/ci/run.sh source
bash tools/ci/run.sh backend
PG_TOOLS_DIR=/usr/lib/postgresql/18/bin \
FSUSBLOG_TEST_CADDY_BIN=/absolute/path/to/caddy \
  bash tools/ci/with-postgres.sh bash tools/ci/run.sh integration

# 已有生产 Web 构建、匹配的 Chromium，以及 Caddy 时：
FSUSBLOG_TEST_CHROME=/absolute/path/to/chromium CADDY_BIN=/absolute/path/to/caddy \
  bash tools/ci/with-postgres.sh bash tools/ci/run.sh browser
```

本地没有 GitHub runner 环境时不要运行自动安装脚本，手动准备所需工具即可。仅检查 CI 判定器可运行：

```sh
python3 -B -m unittest discover -s tests/CI -p '*_test.py' -v
```

GitHub 保留测试报告、覆盖排除摘要、工具链信息和成功浏览器运行凭据 14 天。只上传显式报告目录，不上传数据库、私钥、npm 配置、账号引导票据或浏览器会话存储。失败时先查看具体 job 的首次错误，不用重跑掩盖确定性失败，也不要放宽测试来消除环境阻塞。

该工作流仅做 CI，不自动部署、发布版本、合并 PR 或关闭 issue。

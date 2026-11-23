# 文档架构与写作规范

> **角色**：文档治理规范
> **适用对象**：维护者、贡献者与自动化 Agent
> **权威依据**：本规范约束全仓文档的分层、命名、语言与校验门禁；若具体行为描述与代码、Schema 或生成物冲突，以代码与 `src/Contracts/wire.schema.json` 为准。

每份文档只承担一种核心角色与生命周期。禁止把现行行为契约、单次测试过程日志和历史研究底稿混写在同一篇文档中。

## 1. 三层文档结构与权威优先级

按权威从高到低分为三层；下层可以解释或指引上层，但不得重新定义或推翻上层：

| 层级 | 角色 | 典型路径 | 写作口径 |
| --- | --- | --- | --- |
| 1 | 契约与技术参考 | `docs/protocol.md`、`docs/reference/`、`docs/architecture/`、`docs/product/` | 描述当前系统的确定行为、接口、配置与安全边界 |
| 2 | 部署、运维与开发指南 | `README.md`、`deploy/README.md`、`docs/migration.md`、`docs/fsusui.md`、`docs/web-validation.md`、`docs/development/`、`CONTRIBUTING.md`、`SECURITY.md` | 面向部署者与开发者，按可执行任务流组织 |
| 3 | 发布治理与变更记录 | `docs/releases/`、`CHANGELOG.md` | 精炼呈现当前发布就绪状态、剩余阻断项与版本变更 |

## 2. 语言与术语规范

- **面向人的文档统一使用简体中文**：覆盖 `README.md`、`docs/**`、`deploy/README.md`、`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`，避免维护中英双份同步副本。
- **技术标识符保留英文原文**：代码符号、文件路径、CLI 子命令、环境变量、HTTP 路由、AEDS 帧名、SQL 与通用术语（如 `Passkey`、`Outbox`、`CAS`、`Step-Up`、`Fail-Closed`、`DML/DDL`）不做强行意译。
- **英文例外**：`AGENTS.md`（与同生态仓库保持一致的 Agent 边界声明）、`LICENSE`（标准 MIT 许可文本）以及机器生成参考中的字段/类型名保持英文。

## 3. 目录归属与防蔓延规则

- `docs/` 根目录保持稳定，**禁止**随意新增平铺的 `docs/*.md`；新增文档按角色放入 `docs/architecture/`、`docs/reference/`、`docs/product/`、`docs/development/` 或 `docs/releases/`，并同步更新 [文档总索引](../index.md)。
- **禁止将本地测试证据目录 `artifacts/` 写入文档的 Markdown 链接**：`artifacts/` 属于 `.gitignore` 忽略的本地产物，在仓库或远端不可访问。验证方式应指向仓内真实可复现的测试脚本或命令。
- **禁止向仓库提交按日测试流水账或一次性采集快照**（例如带日期后缀的临时性能日志或已退役版本的 issue 转储）；历史过程由 Git 历史自然留存。

## 4. 现行文档标准格式

新写或重构现行文档时，在主标题下方声明 3 行元数据头：

```markdown
> **角色**：功能契约 / 技术参考 / 运维手册 / 架构说明
> **适用对象**：部署者 / 维护者 / 协议实现方
> **权威依据**：对应的源码、Schema 或配置解析器路径
```

功能契约类文档推荐采用五段式结构：

1. **概述与范围**：明确支持范围与当前明确不包含的边界。
2. **前提与配置**：所需 Schema、环境变量开关、角色与来源前提（优先表格）。
3. **行为契约**：路由/AEDS 帧、核心约束、状态转换（复杂流转用表格或 Mermaid 图）。
4. **安全与隐私边界**：认证隔离、缓存策略、失败闭合行为。
5. **验证入口**：指向仓内实际测试命令或脚本路径，不粘贴单次运行流水账。

## 5. 自动化校验门禁

修改文档、配置项或目录结构后，执行文档一致性检查：

```sh
python3 tools/check-docs.py
```

校验器强制执行以下规则：

1. 所有现行文档内的相对 Markdown 链接目标必须真实存在且已纳入仓库，禁止悬空链接；
2. 现行文档中禁止出现指向 `.gitignore` 忽略目录 `artifacts/` 的 Markdown 链接；
3. `docs/` 根目录仅允许白名单内的稳定入口文件；
4. 仓库中不得跟踪 `.DS_Store` 文件；
5. `docs/` 下的所有现行文档都必须在 [文档总索引](../index.md) 中登记，不允许孤立文档；
6. 当 `docs/reference/configuration.md` 存在时，`src/` 中的运行时 `FSUSBLOG_*` 配置键必须全部登记在配置参考中。

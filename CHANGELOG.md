# 变更日志

> **角色**：版本变更记录
> **适用对象**：部署者、站点管理员与维护者
> **权威依据**：本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格记录面向发布的重要变更；当前发布门槛与已知剩余边界见 [发布就绪矩阵](docs/releases/readiness.md)。

## [Unreleased]

### 新增

- **工程架构分层**：确立 .NET 10 / C# 14 模块化单体解决方案 [`FsusBlog.V2.slnx`](FsusBlog.V2.slnx)，拆分 `Contracts`、`Core`、`Platform`（严格单向依赖 `Platform -> Core`）、`Storage`、`Server`、`Cli` 与 Linux ARM64 专用 `PluginWorker`，并引入本地热重载开发脚本 `tools/dev.sh`。
- **在线/离线隔离与数据层**：落地统一 PostgreSQL 18 Schema（`src/Cli/Schema/01..04*.sql`）、`FsusBlog.V2.Cli` 原子化 `plan`/`apply`/`verify`、单机独占 PostgreSQL 租约与不可变 `PublicSnapshot`、备份恢复指纹验证（`tools/site-backup.py`）与物理备库交接演练。
- **跨栈 AEDS v2 协议与全文检索**：实现基于 `wire.schema.json` 的 C#/TS/C++ 代码生成与跨语言向量/Wasm 差分验证；支持公开搜索三模式（`auto`/`local`/`server`），涵盖本地 FSPK v4 分片、IndexedDB 复用、FSPT 增量补丁、宽语料暂存分片与零数据库查询服务端 FAS4。
- **统一单域名部署与双身份安全模型**：默认单域名 HTTPS 架构（提供 Nginx 与 Caddy 配置模板，并保留独立管理域名或纯只读公开节点选项）；严格隔离读者与管理员表/Passkey/Cookie/会话接口，支持 TOTP MFA、Recovery Key、持久会话续期、Passkey Step-Up、Scoped PoW 与 CSPRNG 密钥一键生成（`init-secrets`）。
- **创作工作区、社区互动与完整性证明**：实现基于 `@ozwasyd/element-plus`（FsusUI）的持久双栏编辑器、IndexedDB 草稿日志、八种封闭属性、保存视图、作者全文检索、万节点 Canvas、多格式异步导出（HTML/Markdown/DOCX/EPUB/PDF）、评论全生命周期与双人申诉复核、站内信/实时唤醒、公开验证密钥、透明日志与每日 Merkle 检查点归档。
- **文档体系正式化与 MIT 许可**：采用 MIT 开源协议（[`LICENSE`](LICENSE)），补齐 [`docs/index.md`](docs/index.md)、[系统架构总览](docs/architecture/overview.md)、[运行与部署配置参考](docs/reference/configuration.md)、[发布就绪矩阵](docs/releases/readiness.md)、[`SECURITY.md`](SECURITY.md)、[`CONTRIBUTING.md`](CONTRIBUTING.md)、文档治理规范及自动化校验门禁 `tools/check-docs.py`，并清理历史过渡基线与过期过程日记。

### 变更与移除

- **升级 FsusUI 至 `v1.6.0-preview.11`**：前端升级至 GitHub Packages 锁定的 `@ozwasyd/element-plus@1.6.0-preview.11`，同步更新 `src/Server/Authoring/FsusMarkdown/` 中 4 个上游 C++23 源码文件与 `UPSTREAM.json`；随上游修复 `#1129`（发布 `.d.ts` 缺失与 `icons-vue` 自引用循环）、`#1130`（Wasm LaTeX MathML 分词截断）、`#1131`（Wasm Mermaid 暗色主题与全局箭头 ID 冲突）与 `#1132`（`ElMarkdownEditor` 响应 `ElConfigProvider` locale），移除临时类型声明补丁 `src/Web/src/fsusui-published-types.d.ts`。
- **切换 FsusUI 为独立 npm 发布包与内嵌 C++ 标题解析器**：前端 `src/Web/` 切换为 GitHub Packages 锁定的 `@ozwasyd/element-plus` npm 包及其内置 6 个原生 Wasm 产物，移除对相邻 `../FsusUI` 检出的 Vite/TS alias、测试与发布脚本依赖；后端作者章节搜索所用的同版本 C++23 标题解析器源码内嵌至 `src/Server/Authoring/FsusMarkdown/`（附 MIT 许可与 `UPSTREAM.json` 校验清单），实现本仓独立构建与发布。
- **FsusUI `v1.6.0-preview.10` 对齐与复验**：同步 FsusUI `v1.6.0-preview.10` 基线（`#1123` 高亮围栏代码块片段 ID 保留、`#1125` 窄屏 `ElThreadPanel` 页头换行、`#1126` 窄屏 `ElCheckbox` 标签换行、`#1127` 原语具名插槽响应更新）；移除 `ArticleMedia.vue` 私有 `:deep(.el-checkbox*)` 覆写，补齐 `AdminSiteConfig.vue` 与 `EditorInspector.vue` 网格列 `minmax(0, 1fr)` 收缩约束，并补全对应原生浏览器回归断言与活跃文档状态。
- **V1 退役与旧迁移移除**：FsusBlog v1 正式退役并仅作只读历史参考，仓库已移除 V1 离线数据迁移命令与转换工具。

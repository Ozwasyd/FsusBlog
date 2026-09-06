# AGENTS.md: FsusBlog

FsusBlog 是面向真实部署、以 AEDS 二进制读取和可验证运行时契约为核心的内容系统。默认用中文沟通；代码名词、路径和命令保留英文。

## 范围与完成

尊重用户的任务范围和工作区既有改动。首次写入前检查 `git status`，不要覆盖、回退、格式化或提交无关改动。审阅或方案任务不自动升级为实现任务。

实现任务应完成请求范围内的闭环：修改、验证、修复本次变更引入的问题，以及必要的 current 文档同步；不要在第一版实现后等待例行批准。计划和进度记录按任务复杂度使用，不为小改动制造额外流程。

在已确认隔离、无生产访问且只影响本任务所拥有资源的本地环境中，可自主构建、运行相关检查、修复并重跑；仍须遵守当前任务的写入权限和资源生命周期契约。涉及生产或非本任务数据、密钥、破坏性迁移、发布或其他对外写入时，确认操作处于已有授权范围内；未获授权则不执行。真正的权限、环境或产品决策阻塞只暂停受影响部分，继续可独立完成的工作并说明缺口。

## 按需查证

[文档索引](docs/index.md)用于定位，不是必读清单。只加载与当前问题相关的章节、实现、测试和 Skill；上下文未变化时不重复通读。

文档权威性按[文档生命周期](docs/development/document-lifecycle.md)及 `config/development/document-lifecycle.json` 判断。`current` 表示维护中的权威位置，不保证内容已与实现一致；proposed、historical、retired 内容不能替代当前规范。generated 索引和证据用于导航或核验，应追溯其 producer，不手改产物。发现规范、实现和测试冲突时，查明预期行为，不凭“较新”或“当前能通过”自行改写契约。

| 任务涉及 | 上下文入口 |
| --- | --- |
| API、DTO、AEDS、POD、跨栈 ABI | [API contracts](docs/api/contracts.md)、[AEDS v2 protocol](src/core/Algorithms/AEDS_V2_PROTOCOL.md) |
| 鉴权、会话、隐私、安全 | [Security](docs/security.md)及对应 current 子文档 |
| 缓存、中间件、启动或运行时架构 | [Architecture](docs/architecture.md)及对应 current 边界文档 |
| 前端非视觉运行时、Wasm glue | [Architecture overview](docs/architecture/overview.md)及对应 current frontend 文档 |
| 可观察 UI、交互、视觉验收或设计契约 | [fsusblog-design-conformance](.agents/skills/fsusblog-design-conformance/SKILL.md) |
| 数据库迁移 | [Migration](docs/database-migration.md)、[Online migration](docs/online-database-migration.md) |
| 编码、source/generated/vendor 归属 | [Coding conventions](docs/development/coding-conventions.md)、[Repository ownership](docs/architecture/repository-layout.md) |
| 文档变更、提交或 PR | [Document lifecycle](docs/development/document-lifecycle.md)、[Change contract](docs/development/change-contract.md)，按本次任务选择 |

## 不可隐式突破的边界

- 公开运行时只接受 AEDS v2；不恢复旧文本 API、JSON fallback 或已编码帧的通用 stream 重组。协议修改须保持 C#、shared contract、POD、C++ decoder、TypeScript glue 和测试的 wire/ABI 一致。
- 保留 `X-Fsus-*`、PoW、统一响应和错误语义以及安全 fail-closed 行为；不以兼容、降级或测试便利绕过鉴权与隐私边界。
- `src/shared/Contracts/` 承载跨栈契约；`src/core/` 不引入 HTTP、Cookie 或路由语义。缓存失效、middleware/startup 及 Wasm glue 遵循既有 owner，不建立旁路或平行实现。
- UI 以实际生效的 FsusUI baseline 为准，而非仅看包版本。共享组件与通用 token 属于 FsusUI，产品编排属于 FsusBlog；不用私有选择器、伪造 token 或兼容包装掩盖上游缺陷。设计判断与证据要求由设计 Skill 路由到 current 权威文档。
- generated、vendor、fixture、lockfile 等按既有 ownership 分类处理。生成产物通过其 source/producer 修改，不把产物当手写源码。

## 验证与交付

检查入口为 `./tools/test.sh help`、`tests/matrix.yml` 和 [Testing](docs/testing.md) 的相关章节。先运行直接覆盖改动的检查，再按影响与风险扩展；这不豁免适用的强制矩阵、独立验收或提交合并门禁。编排任务继续遵循当前 domain stage policy、实现所有权隔离与候选绑定；模型/路由等共享编排由外部调度器负责，不能以自主执行为由跳过领域验收。

验证的是本次候选及实际影响的行为。需要视觉验收时检查真实渲染结果；不把编译、静态检查、mock、历史截图或 checker 自测当作当前端到端或 UX 验收。不为取得绿色结果弱化测试、fixture、阈值或门禁；预期契约确需变化时，按对应治理流程同步修改。

改变 public contract、架构、安全或运维语义时，更新对应 current 文档。文档生命周期、索引和 generated 输出通过既有 producer/checker 维护，不另建重复事实源。

只在任务已授权的范围内提交、推送、创建 PR 或合并，执行 [Change contract](docs/development/change-contract.md)，以执行时的 ruleset/checks 为准。远端检查缺失不等于通过，本地通过不自动构成合并授权。

交付说明实际完成内容、验证命令与结果、未验证项及阻塞；涉及兼容或数据风险时说明回退条件。区分本次引入的问题、既有失败和环境缺失，不声称超出证据覆盖范围的完成度。

## 维护本文件

只增加跨任务稳定、不能从现有入口可靠获得且值得常驻的决策边界，并链接其权威来源。不要在此复制实现符号表、命令全集、设计数值、完整测试矩阵、模型档位或临时 issue/编排状态。

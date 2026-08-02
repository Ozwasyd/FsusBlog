# AGENTS.md — FsusBlog 代码代理入口

FsusBlog 是面向真实部署、以二进制公开读取链路和可验证运行时契约为核心的个人内容系统。

本文件只保留仓库特有、无法从代码直接推断的决策边界和上下文入口；它不是仓库地图、编码规范副本或命令大全。长期事实源从 [`docs/index.md`](docs/index.md) 进入，并按[文档生命周期](docs/development/document-lifecycle.md)判断权威性。

首选语言为中文；代码名词、路径和命令保留英文。

## 工作方式

- 先理解用户目标、相邻实现和现有测试，再选择最小且完整的修改边界；不要把任务扩张成顺手重构。
- 让代码融入周围代码：匹配现有命名、注释密度、错误处理和抽象层级。通用风格只遵循[跨语言编码规范](docs/development/coding-conventions.md)，不在这里重复。
- 按任务渐进加载上下文。只阅读下表中与改动相关的事实源；遇到更具体的 current 文档、测试或契约时，以它们为准。
- 代码、测试和机器可读契约优先承载精确参考。不要把临时计划、issue 状态、历史结论或可从目录发现的事实追加到本文件。
- 开始修改前检查 `git status`。工作区中的既有改动属于用户；不得覆盖、回退、格式化或提交无关文件。

## 按改动加载上下文

| 改动类型 | 先读 | 同步核验 |
| --- | --- | --- |
| API / DTO / route | [`docs/api/design.md`](docs/api/design.md)、[`docs/api/contracts.md`](docs/api/contracts.md) | [`docs/api/quick-reference.md`](docs/api/quick-reference.md)、[`docs/api/schemas-and-errors.md`](docs/api/schemas-and-errors.md)、`src/backend/Program.cs`、相关 endpoint 与 contract tests |
| binary / AEDS / POD | [`src/core/Algorithms/AEDS_V2_PROTOCOL.md`](src/core/Algorithms/AEDS_V2_PROTOCOL.md)、[`docs/api/contracts.md`](docs/api/contracts.md) | `AedsFrameType.cs`、`AedsEncoder.cs`、`AedsDecoderValidator.cs`、`PodSizeCatalog.cs`、binary endpoint/middleware、C++/TypeScript decoder |
| auth / session / security | [`docs/security.md`](docs/security.md) | `JwtHelper.cs`、`AuthCookieService.cs`、`BannedUserMiddleware.cs`、`ServiceCollectionExtensions.cs`、`ProductionStartupValidator.cs` |
| cache / middleware / startup | [`docs/architecture.md`](docs/architecture.md) | `Program.cs` 的顺序、`Infrastructure/Cache/`、`IHttpCacheInvalidator`、output-cache policy、health/startup tests |
| frontend design / UI / UX | [`docs/design/governance.md`](docs/design/governance.md)、[`docs/design/surface-profiles.md`](docs/design/surface-profiles.md) | 实际生效的本地 FsusUI alias 与 `fsusui-design-conformance`、最近的 current 设计文档、`.agents/skills/fsusblog-design-conformance/`、对应 archetype/viewport/content fixtures 与 rendered evidence |
| frontend runtime / Wasm glue | [`docs/architecture/overview.md`](docs/architecture/overview.md) 和 [`docs/index.md`](docs/index.md) 中对应的 current frontend 文档 | worker 边界、Wasm ABI、fallback contract、相邻 unit/browser contract |
| schema migration | [`docs/database-migration.md`](docs/database-migration.md)、[`docs/online-database-migration.md`](docs/online-database-migration.md) | migration catalog、startup validator、真实 PostgreSQL integration tests 与 rollback window |
| source / generated / config 归属 | [`docs/architecture/repository-layout.md`](docs/architecture/repository-layout.md) | producer、生成命令、source/artifact hash、不得手改的 generated inventory |
| 文档 / commit / push | [`docs/development/document-lifecycle.md`](docs/development/document-lifecycle.md)、[`docs/development/change-contract.md`](docs/development/change-contract.md) | current/proposed/historical/generated 分类、commit footer、对应本地 checker |

如果表中入口与 `docs/index.md` 的 current 分类冲突，先修正理解，不要引用 proposed、historical、generated 或 retired 文档作为当前设计依据。

用户可观察 UI 的编排还必须消费
`.agents/skills/fsusblog-design-conformance/contracts/blog-ui-stage-policy.json`：
先冻结 `uiDecisionClass`、`verificationClass`、双设计 Skill 与当前 FsusUI
baseline，再绑定永久 work-plan/slice/compiled-prompt/route。实现只允许
Sol/low 或 Sol/medium 的单一 UI/UX owner；系统争议进入 fresh/read-only
裁决，真正的多合法产品方向才可生成 verified `human-decision` request。
test、UI implementation、documentation 的 write lease 按顺序互斥，
behavior/UX/adjudication 只读；没有实际 inspected rendered evidence
不得签 UX accepted。

## 不可隐式改变的边界

- 公开运行时只接受 AEDS v2；binary endpoint 是主 API。不得新增旧文本 API fallback，也不得用通用 stream response 重新拼装已编码帧。
- 新帧由 `BinaryResults.Frame` 返回 `BinaryFrameResult` 并通过 `AedsFrameBufferWriter` 构造；完整缓存帧由 `BinaryResults.PreencodedFrame` 返回 `BinaryPreencodedFrameResult`。`PodBinaryCodec.WriteArticlePage` 等 typed POD writer 是 payload 边界，不得退回通用 JSON/stream 拼装。
- 不得删除或弱化 `X-Fsus-*` 约定头、PoW 验证链、统一 `ApiResponse` / error-code 语义及现有安全 fail-closed 行为。
- 协议修改必须跨 C#、shared contract、POD 尺寸、C++ Wasm decoder、TypeScript glue 和测试保持 ABI/wire 一致；不能只修一端。
- 中间件顺序、production health endpoint 和 startup validation 是运行时契约。修改前必须证明现状，修改后同步架构文档和对应测试。
- 缓存修改必须保持 L1/L2 回填、output-cache policy 和 `IHttpCacheInvalidator` 失效路径一致；禁止从业务端点旁路创建第二套失效机制。
- `src/shared/Contracts/` 是跨栈契约事实源；`src/core/` 不引入 HTTP、Cookie 或 route 细节。
- `src/frontend/wasm/aeds/` 只负责解码器和 ABI；`src/frontend/wasm/web/aeds.ts` 与 workers 只承载解析、超时、回退和分发，不改变服务端业务或鉴权语义。
- generated、vendor、fixture、lockfile 和外部名称例外必须使用编码规范和 ownership 文档中的既有分类；修改 producer/source 后再重建产物。

## 实施与验证

1. 从相关 current 文档、实现、测试中形成一份短变更清单：新增、移除、重命名、语义或参数变化。
2. 在现有 service、filter、codec 或 adapter 边界内完成最小闭环；跨边界时同步所有 owner，不复制平行实现。
3. 先运行直接覆盖改动的 focused checks，再按风险扩大。测试入口和 tier 以 [`docs/testing.md`](docs/testing.md)、`tests/matrix.yml` 与 `./tools/test.sh help` 为准。
4. API 或安全改动必须显式评估匿名、登录、admin、notification stream、binary 五类路径；逐项给出已测结果或不适用理由，而不是笼统声称“全部通过”。
5. 修改 public contract、架构、安全或运维语义时，更新对应 current 文档；不要为了凑数量创建新文档。
6. 交付时列出实际运行的命令、结果、未运行项、风险和可执行回退路径。不得把历史 evidence、mock、静态检查或外部环境缺失描述成当前端到端验证。

文档改动至少运行与路径对应的 checker。修改本文件时优先运行：

```bash
node tools/style/check-native-tooling-style.mjs --operation lint --mode changed --domain docs --file AGENTS.md
node tools/docs/generate-document-lifecycle.mjs --check
node tools/docs/check-authoritative-development-docs.mjs
```

提交前按[变更契约](docs/development/change-contract.md)校验 commit message 和候选 range。除非用户另行要求，本仓库直接在 `master` 完成并推送；不要创建或遗留临时 `codex/*` branch 或 draft PR，也不要把无关工作区改动带入提交。

## 何时修改本文件

仅在出现以下情况时扩写 `AGENTS.md`：

- 代理反复踩到一个仅属于 FsusBlog 的非显然边界；
- 新增了需要在多个任务之间路由上下文的权威入口；
- 一个高风险操作需要在读取详细文档前就被阻止。

新增内容应尽量是一条判断准则和一个精确链接。可由代码、目录、tool description、编码规范或 current 文档表达的内容，不在这里复制。

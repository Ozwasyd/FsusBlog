# 冻结档外目标的当前状态与待决语义

在 2026-11-15 01:28:53–01:31:08 北京时间对冻结台账无独立状态的 183 个同仓编号作只读查询。13 批 GraphQL `issueOrPullRequest` 区分对象类型。REST 精确读取了四个 GraphQL 未解析编号，并对 12 个已识别目标作交叉检查。所有 183 个编号都有采集结果，冻结档中的 `ABSENT` 保留原时间含义。 [冻结关系台账](text-reference-dispositions.tsv) · [API 采集证据](target-observations.json) · [机器可读进度](target-observation-progress.json)

| 当前观测 | 目标 | 冻结引用位置 |
| --- | ---: | ---: |
| Issue 已关闭，167 个 `COMPLETED`、1 个 `NOT_PLANNED` | 168 | 573 |
| PR 已合并 | 6 | 22 |
| PR 已关闭、未合并 | 3 | 3 |
| PR 开放 | 2 | 3 |
| GraphQL 无对象，REST 410 并报告已删除 | 4 | 4 |

[目标逐号索引](target-observations.tsv) 记录 API 返回的对象 URL、创建和状态时间、关闭原因，以及适用的 PR head/base/merge 提交。合并对象的提交标识可查固定源码。编号 #2918 实际是关闭未合并的 PR。#4221 和 #4762 仍为开放 PR。四个 410 返回的旧包装 #2699–#2702 正文不可读取；冻结的 #2223/#2227/#2265/#2285 第 5 行分别记录旧包装，后续实际工作以这些开放直接任务的正文为准。 [#2918](https://github.com/Ozwasyd/FsusBlog/pull/2918) · [#4221](https://github.com/Ozwasyd/FsusBlog/pull/4221) · [#4762](https://github.com/Ozwasyd/FsusBlog/pull/4762) · [#2223](https://github.com/Ozwasyd/FsusBlog/issues/2223) · [#2227](https://github.com/Ozwasyd/FsusBlog/issues/2227) · [#2265](https://github.com/Ozwasyd/FsusBlog/issues/2265) · [#2285](https://github.com/Ozwasyd/FsusBlog/issues/2285)

## 已定位的契约与缺口

**规模查询生产者（C13）。** 冻结 #2549 正文 L2、L6、L18 对 Snowflake 分配的前置可追到 #1619；但 L12、L15、L45 也将查询运行器指向同一编号。#2555 L2、L15、L28、L49 和 #2561 L2、L6、L12、L28、L66 有相同的职责错配。#1618 关闭为已完成，固定源码确实有 seeded 数据进入缓存、搜索、AOT 和 HotRead 的语义证明，不能由此确定有完整的查询注册表。#1640 的冻结评论记录共用 runner 候选 `6d7c648f3d879d985352ff633426c49f1539e5a9`，其 registry 有 16 个用例，包括 4 个评论用例，交接还记载详情路径与真实端点不符。固定 v1 树可定位评论读取和权限受限的审核队列，未找到该候选的注册表或 runner。保留原目标及纠正依据，逐案补真实入口、场景、授权、顺序和 expected/actual 对照。 [#1619](https://github.com/Ozwasyd/FsusBlog/issues/1619) · [#1618](https://github.com/Ozwasyd/FsusBlog/issues/1618) · [#2549](https://github.com/Ozwasyd/FsusBlog/issues/2549) · [#2555 交接](https://github.com/Ozwasyd/FsusBlog/issues/2555#issuecomment-6053304616) · [#2561](https://github.com/Ozwasyd/FsusBlog/issues/2561) · [#1640 原调度器交接](https://github.com/Ozwasyd/FsusBlog/issues/1640#issuecomment-6053329791) · [历史注册表](https://github.com/Ozwasyd/FsusBlog/blob/6d7c648f3d879d985352ff633426c49f1539e5a9/tools/data-scale/query-case-registry.mjs#L33) · [固定 v1 查询边界](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/architecture/comment-query-boundary.md#L3)

**保存视图定义（C14）。** #2332 唯一关闭原因为 `NOT_PLANNED`。其正文 L6–22 定义按用户和站点存储、封闭 AST、CAS、默认及固定顺序和禁止自动执行。#2335/#2337/#2338/#2339 的冻结正文 L2 仍把它列为前置，分别用于编译、界面、迁移和终验。固定 v1 源码注册了 typed 验证、PostgreSQL 持久化及定义存储。现有 v2 精确属性查询仅覆盖 ad-hoc 过滤。仍需定位 v1 各入口的实际产品接线，并验收 v2 单一服务端视图定义、版本/CAS、真实查询及旧筛选迁移，四项下游保持开放追踪。 [#2332](https://github.com/Ozwasyd/FsusBlog/issues/2332) · [#1861](https://github.com/Ozwasyd/FsusBlog/issues/1861) · [#2335](https://github.com/Ozwasyd/FsusBlog/issues/2335) · [#2337](https://github.com/Ozwasyd/FsusBlog/issues/2337) · [#2338](https://github.com/Ozwasyd/FsusBlog/issues/2338) · [#2339](https://github.com/Ozwasyd/FsusBlog/issues/2339) · [固定 v1 组件注册](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs#L184) · [v2 属性范围](../product/properties.md)

**创作和 Canvas。** #2293、#2294 的关闭不减少 #2295 L6/L10/L72、#2296 L10/L19 对实际工作区与单所有者的要求。#2243 的历史代码给出选区上下文契约，当前消费者仍须验证来源、epoch、偏移与取消。#2440 提供唯一锚点身份、URL 与 Markdown codec 的历史职责；#2442 L64 和 #2490 L12 要求实际生产者，仍需权限与精确修订向量。#2482/#2484 是原 Canvas 文档和 CAS 定义，#2487/#2490 的实际事务、目标线协议和已有结构兼容各自验收。 [#2293](https://github.com/Ozwasyd/FsusBlog/issues/2293) · [#2294](https://github.com/Ozwasyd/FsusBlog/issues/2294) · [#2295](https://github.com/Ozwasyd/FsusBlog/issues/2295) · [#2243 固定源码](https://github.com/Ozwasyd/FsusBlog/blob/c5a1a8f2d47e97a1a1f429bfa3ec55109d905cd4/src/frontend/src/services/authoring/articleDocumentContext.ts) · [#2440](https://github.com/Ozwasyd/FsusBlog/issues/2440) · [#2482](https://github.com/Ozwasyd/FsusBlog/issues/2482) · [#2484](https://github.com/Ozwasyd/FsusBlog/issues/2484) · [v2 Canvas 范围](../product/canvas-workspace.md)

**私有附件与旧治理。** PR #3559 的真实合并提交是 `8d42b2d5da3ace962299aafd3ac63d2a11134305`，只证明旧编译检查整合。PR #3585 的真实合并提交是 `11afa8b16de7ecfc7c0814c4d96898914c3632f9`，为生产拓扑源证据。#1782 已关闭为完成，固定 v1 票据仍使用统一空 404，C9 的候选状态、HEAD/取消和跨实例消费待决。#3052 的状态为关闭 issue，不能填写 #3053 L2 要求的精确合并 SHA。 [PR #3559 固定合并](https://github.com/Ozwasyd/FsusBlog/commit/8d42b2d5da3ace962299aafd3ac63d2a11134305) · [PR #3585 固定合并](https://github.com/Ozwasyd/FsusBlog/commit/11afa8b16de7ecfc7c0814c4d96898914c3632f9) · [#1782](https://github.com/Ozwasyd/FsusBlog/issues/1782) · [#3052](https://github.com/Ozwasyd/FsusBlog/issues/3052) · [#3053](https://github.com/Ozwasyd/FsusBlog/issues/3053) · [C9](conflicts.md)

逐号核验只覆盖类型、状态及可取得的提交定位。P0 尚需复核冻结正文之外目标的完整条款和开放消费者的真实语义，将采用要求落实到 v2 模块、测试及预算。可用以下命令离线复算本次证据：

```sh
python3 tools/issue-target-check.py
```

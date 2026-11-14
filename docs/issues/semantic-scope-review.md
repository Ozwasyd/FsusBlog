# 规模查询、保存视图和私有沟通的语义核对

以冻结 issue/评论、固定 v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12`、当前 v2 `db53a07` 及明确标记的候选运行证据核对。本次收敛 20 个冻结开放 issue 的处置行，保留源正文、评论、关系与 `ABSENT` 状态。各处置有独立模块、附件阶段、预期与缺口。未执行产品测试或更改旧状态。 [冻结输入](README.md) · [跨时间状态证据](target-observation-review.md)

## 规模查询和标识

#1619 与 #1640 的冻结标签都为 `status:accepted`，没有显式优先级。其余受影响的六项无独立优先级。附件 §5.2、§7、§8 的性能安排使用两种可复验的证据。P2 验证发布/公开读取链与负载，P6 用真实查询和独立 expected 验证规模正确性、权限及链路。当前报告的 12,100 篇热读请求、冷读、分配诊断与其他运行各有自己的候选和样本，不能填充完整评论/查询矩阵。C3 的 PostgreSQL 服务和离线 provider 职责、C11 的规模口径仍按原裁决。 [P2 当前容量记录](../../tests/Performance/matrix-2026-11-15.md) · [C3、C11、C13](conflicts.md)

| 冻结来源 | 确定的处置与验收 |
| --- | --- |
| #1619 L7–9、31、35–107、121–132、164–181 | 合并采用生产等价的分配、可重放及真实键关系。固定 v1 生产评论使用 Snowflake，旧规模种子曾用 `MAX(id)`。当前 v2 的实际生产 ID 是 PostgreSQL bigint identity/nextval，AEDS 及网页按不透明 64 位值读取。P6 用实际分配、10 万级标识与跨线程和回复键、重复与并发、无碰撞、合成体不误入生产查询作正反验证。P5 迁移保全既有值、关系与 sequence 安全水位。Snowflake 位布局本身是否为外部接口约束还缺证据。 [#1619](https://github.com/Ozwasyd/FsusBlog/issues/1619) · [v1 种子](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tools/data-scale/seed.sh#L214) · [v1 生产分配](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/CommentService.cs#L431) · [v2 生产写入](../../src/Server/Comments/CommentWriteStore.cs#L54) |
| #1640 L16–55、69–78、97–103 | 采用一次有效运行对全/深分页、完全顺序、权限、当前 generation、实际查询计划及资源取证。HTTP-only 公开构件不虚构 SQL 计划，真实 DB 查询记录适用的 rows、buffers、temp 与 latency。历史 `6d7c648f` 的 16 个 registry case（含 4 个评论 case）只能定位候选。固定 v1 有真实生产读和审核路径，没找到这套注册表和 runner。当前用例清单与唯一运行器待逐条对齐。 [#1640](https://github.com/Ozwasyd/FsusBlog/issues/1640) · [历史交接](https://github.com/Ozwasyd/FsusBlog/issues/1640#issuecomment-6053329791) · [固定 v1 读取边界](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/architecture/comment-query-boundary.md#L3) |
| #2547 L10–23、29、34–50、56–57 与 #2549 L11–23、34–38、45 | 合并采用规模图真实物化、重放、失败恢复、外键、生产等价查询、清理和终验。#2549 L2/L18 的 #1619 分配/移除旧式种子依赖成立，L12/L15/L45 及 #2547 L29 查询归属需以实际读 producer 为准。写入者和查询矩阵各保持唯一。 [#2547](https://github.com/Ozwasyd/FsusBlog/issues/2547) · [#2549](https://github.com/Ozwasyd/FsusBlog/issues/2549) |
| #2555 L10–23、34–50；#2559 L10–23、29、34–51；#2561 L10–24、35–53；#2563 L10–23、33–37 | 各自合并同一条真实验收链。封闭 test-only catalog 从实际权限、排序、分布和图绑定唯一 case；独立生成 expected 并走真实查询校验，不得复制 actual。重复、过期、只测首行、均匀分布替代、缺/篡改产物导致误绿均须拒绝，生产装包不得读取测试预期。保留 #2555 L15 等各处现有措辞以溯源，#1618 独立保留 seeded 语义验证，#1619 不承担 catalog 或执行者。 [#2555](https://github.com/Ozwasyd/FsusBlog/issues/2555) · [#2559](https://github.com/Ozwasyd/FsusBlog/issues/2559) · [#2561](https://github.com/Ozwasyd/FsusBlog/issues/2561) · [#2563](https://github.com/Ozwasyd/FsusBlog/issues/2563) |

## 保存视图

#1861 在正文 L5–9 标记产品优先级 **P1**。旧四项开放叶及下述执行叶没有独立优先级声明，本次阶段分配来自附件 §7。#1861 的第一条冻结评论列出 #2332 → #2335 → #2337 → #2338 → #2339，后一条评论明文指定唯一执行 DAG。#2332 的 `NOT_PLANNED` 保留为当前观测。按后者确定执行者，合并先前各项的具体验收义务，父项仅用于跟踪。 [#1861 正文](https://github.com/Ozwasyd/FsusBlog/issues/1861) · [第一套拆分](https://github.com/Ozwasyd/FsusBlog/issues/1861#issuecomment-5174456730) · [唯一执行 DAG](https://github.com/Ozwasyd/FsusBlog/issues/1861#issuecomment-5174474530) · [#2332](https://github.com/Ozwasyd/FsusBlog/issues/2332)

| 阶段及执行者 | 保留的验收 |
| --- | --- |
| P4。#2341 合同 → #2343 持久定义；#2346 使用两者执行 | 合并旧 #2332 的封闭 AST、账户/站点隔离、并发 CAS、pin/default/reorder，并保留 #2335 L10–23、35–52 的视图、条件依赖、查询计划、权限、排序机制、时区/null 与游标代次。标签重命名可继续，退役/失权/未知明确拒绝，不丢弃条件。 [#2341](https://github.com/Ozwasyd/FsusBlog/issues/2341) · [#2343](https://github.com/Ozwasyd/FsusBlog/issues/2343) · [#2346](https://github.com/Ozwasyd/FsusBlog/issues/2346) · [#2335](https://github.com/Ozwasyd/FsusBlog/issues/2335) |
| P4。#2349 共享界面 | 合并 #2337 L10–26、38–56。Rail/List/全局搜索仅持有同一稳定 view ID、计划与结果。条件编辑、失效修复、窄屏、缩放、键盘与屏幕阅读器焦点、跨账号深链拒绝和实际 CAS 冲突/过期状态均验收。 [#2349](https://github.com/Ozwasyd/FsusBlog/issues/2349) · [#2337](https://github.com/Ozwasyd/FsusBlog/issues/2337) |
| P5。#2351 迁移 | 合并 #2338 L10–23、35–52。仅迁移有明确保存事实、归属且无歧义的旧项。普通临时 URL 不变成持久视图。CAS、幂等、部分失败继续、真实查询对照和旧源删除时点均需演练；决策不预设浏览器旧数据的迁移载体。 [#2351](https://github.com/Ozwasyd/FsusBlog/issues/2351) · [#2338](https://github.com/Ozwasyd/FsusBlog/issues/2338) |
| P6。#2354 终验 | 合并 #2339 L10–38、50–54。0/1/100/1000 个视图及 0/1/10,000 篇文章、有界延迟/DB/索引/内存/载荷/DOM、权限、两终端 CAS、三入口 exact order、异常及隐私与无障碍。正文要求测量而未给通用延迟上限，提前冻结实际负载门槛。保留首次失败，以源、环境、真实导入/查询/UI 和终态收据互证。 [#2354](https://github.com/Ozwasyd/FsusBlog/issues/2354) · [#2339](https://github.com/Ozwasyd/FsusBlog/issues/2339) |

固定 v1 注册验证、PostgreSQL 持久化和 Store，Facade 中已实现身份与 session 检查，已定位调用出现在测试。已定位的生产批处理保存视图消费者有真实读取，默认查询选择器会拒绝查询。固定树中未找到完整现行 SavedView HTTP、独立实际查询执行、前端挂载或上述规模终验。#2343/#2346/#2349 的冻结评论也分别保留接线或运行缺口。 [v1 注册](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs#L184) · [v1 Facade](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Authoring/AuthorSavedViewApplicationFacade.cs#L100) · [v1 查询选择器](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Articles/Bulk/ArticleBulkProductionAuthorities.cs#L131) · [#2343](https://github.com/Ozwasyd/FsusBlog/issues/2343#issuecomment-6053048772) · [#2346](https://github.com/Ozwasyd/FsusBlog/issues/2346#issuecomment-6052899563) · [#2349](https://github.com/Ozwasyd/FsusBlog/issues/2349#issuecomment-6215019221)

v2 `9815813` 的个人视图最多执行四个现有属性条件，已有 PostgreSQL 持久固定、默认、重排与稳定深链。现行游标绑定会话、视图版本、schema 和定义。#2346 的全文、关系、分类和日期统一执行、Rail/List/全局搜索之间的顺序一致性、#2351 旧源处置及 #2354 全矩阵仍需实际验收。本文静态核对新增实现的边界。 [v2 产品入口](../product/author-saved-views.md) · [数据库用例](../../tests/Integration/PropertyQueryPostgresTests.cs) · [浏览器用例](../../tests/EndToEnd/property-filter-flow.mjs)

## 私有工单和通知

附件 §7 将工单与通知列在 P3。冻结 #2050 L12–17、21–28、40–59 的目标是使用权威角色夹具验收实际双账号权限、列表、已读和通知；无独立优先级。它不改写 #1653 的通知交付职责。v2 在配置启用后用 AEDS、实际会话及绑定动作/会话/原帧的 PoW 映射到一次事务。浏览器对创建和回复都使用真实 Worker。提交 `08e1ee8` 的 WebSocket 只唤醒当前账号从持久回放读取，`6d60f51` 排空关闭握手；`902f75b` 的 Caddy TLS 浏览器记录覆盖桌面与窄屏下的断开续读、两条写动作和数据库校验。脚本仍用可识别的种子会话，独立角色来源及关闭边界只按实际行为计。 [#2050](https://github.com/Ozwasyd/FsusBlog/issues/2050) · [#1653](https://github.com/Ozwasyd/FsusBlog/issues/1653) · [P3 当前产品证据](../product/communication.md) · [TLS 浏览器结果](../../artifacts/candidate-902f75b/inbox-tls/inbox-browser.json)

固定 v1 还有自适应风险和通知匿名/管理受众的握手（#1772 L7、17、32、54–60）。v2 账号私有读写的成功不覆盖上述协议、管理员回复、状态与广播、保留期、多实例恢复及慢客户端压力。#2179 L6、15–17 的实际审批后评论回复通知也仍独立验收，离线运维 notice 或工单事件只能证明各自生产者。 [风险条款](risk-pow.tsv) · [#1772](https://github.com/Ozwasyd/FsusBlog/issues/1772) · [#2179](https://github.com/Ozwasyd/FsusBlog/issues/2179)

该切片处理了引用、原优先级、阶段和验收归属；其他自由文本及采用条款的完整验收和预算映射仍待审阅。

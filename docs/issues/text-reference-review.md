# 冻结同仓显式引用核对

输入是 2026-11-14 20:35–20:43 北京时间冻结的 [开放 issue 和评论](open-issues.ndjson.gz)。本轮只读冻结资料。原始索引仍有 3,516 条候选，其中 3,410 条属同仓，包括 2,611 次开放目标的 issue 正文引用、793 次正文对正文快照以外的目标引用和六次评论引用。其他 106 次指向 FsusUI。

[显式引用台账](text-reference-dispositions.tsv) 按冻结源文档、原文行、目标去重，保留两处重复的原始次数。共 3,594 个来源位置，覆盖 3,408 个原索引位置并补上 186 个精确位置。其中 524 个位置有逐项语境核对，包含原索引的六个评论位置。其余只按明确标记和字面编号清单确认文字所声明的关系，不能据此报告产品要求已采用或验收已通过。

- `issue=N.body:Lx` 为压缩档中编号 N 的正文第 x 行。`issue=N.comment=C.body:Lx` 为该 issue 评论 C 的第 x 行。补充证据用 `#N:x-y` 或 `#N@C:x-y` 定位。`rawOccurrences=0` 的行来自人工补充，包括斜杠相邻编号和原索引漏掉的显式变体。相同目标在不同源行的独立证据仍保留。
- `OPEN` 表示目标有冻结开放正文。`CLOSED` 表示冻结的正式关系元数据确认关闭。`ABSENT` 表示冻结输入没有独立状态，即使原文说它已关闭或称其为 PR。3,594 行中，607 行的目标在冻结元数据中无状态，涉及 183 个编号。其后单独采集的 [实时状态与语义复核](target-observation-review.md) 已逐号核验，保留冻结列的原时间口径。
- [正式关系](formal-relations.tsv) 从冻结的 GitHub 关系字段将 399 份记录合成 229 条有向关联，保留所有对向来源字段。`prerequisite` 从实际阻塞方指向被阻塞方，`parent` 从父项指向子项。`formalRelations` 在文本表中则从该行源 issue 的视角标明已存在的正式关系。空值表示冻结输入未观察到两个编号之间的正式关系。
- [语境处置](text-reference-qualifications.tsv) 保留直接前置、验收限定、跟踪关系、历史引用、源码交接、范围排除和目标冲突。它用于修正同一行内仅按行头定性的歧义。DAG 成员保留在原句，不将其扩写为跟踪票的平面依赖。

| 已核对的边界 | 处置 |
| --- | --- |
| #1810 和 #1907 的附件与标题集成 | #1810 总验收需要实际标题集成。#1907 消费 #1810 的五项执行结果及相应包基础收据；#2409/#2420 终验消费 #1907 成果。无需等待 #1810 或包跟踪票先关闭。 [#1810](https://github.com/Ozwasyd/FsusBlog/issues/1810) · [#1907](https://github.com/Ozwasyd/FsusBlog/issues/1907) |
| 文章包往返与多格式导出 | #2409/#2420 共用终验并保留各自用例，实际核对锚点重建和旧路径退役。#2415 复用资产、文章和索引权威。#2428 与 #2438 共用验收范围，核对真实隔离、各格式及私有下载。#2470 的导入和导出绑定原指令字节、冻结依赖图与目标站裁决。 [#2409](https://github.com/Ozwasyd/FsusBlog/issues/2409) · [#2415](https://github.com/Ozwasyd/FsusBlog/issues/2415) · [#2420](https://github.com/Ozwasyd/FsusBlog/issues/2420) · [#2428](https://github.com/Ozwasyd/FsusBlog/issues/2428#issuecomment-6052019841) · [#2470](https://github.com/Ozwasyd/FsusBlog/issues/2470) |
| #2659 和 #2679 的收据重拆 | 正式 blockedBy 仍保留。正文列出直接验证的六项及三项收据，原底层条件可沿实际生产者追踪。保留该差异供验收映射，无需凭历史关系推定旧实现必须再做。 [#2659](https://github.com/Ozwasyd/FsusBlog/issues/2659) · [#2679](https://github.com/Ozwasyd/FsusBlog/issues/2679) |
| #2549、#2555、#2561 的 #1619 | 三个标题栏明确引用 #1619，正文描述的是查询能力。冻结 #1619 的职责为 Snowflake fixture 分配器。保留冲突，实际查询权威尚需定位。 [#1619](https://github.com/Ozwasyd/FsusBlog/issues/1619) · [#2549](https://github.com/Ozwasyd/FsusBlog/issues/2549) · [#2555](https://github.com/Ozwasyd/FsusBlog/issues/2555) · [#2561](https://github.com/Ozwasyd/FsusBlog/issues/2561) |
| #1640 的实际查询与 #2556、#2561 的封存预期 | #1640 的正常请求可用同库独立排序核对，需保留 runtime、派生目录、搜索索引和逐请求证据。#2556 另要求从计划角色和场景统计生成文章预期，需词元与来源范围，明确排除数据库、缓存和实际接口作为预期生成输入。#2561 分域验证真实查询与该预期，并沿用 #2553 的场景适用性。历史 #1640 接线请求明确保留了这两种证据的职责。 [#1640](https://github.com/Ozwasyd/FsusBlog/issues/1640#issuecomment-6053329791) · [#2556](https://github.com/Ozwasyd/FsusBlog/issues/2556#issuecomment-6053564702) · [#2561](https://github.com/Ozwasyd/FsusBlog/issues/2561) |
| #2214 的正式阻塞方 #3523 | #2214 原始正文前置与 #3523 的正式追加同时成立。#3523 正文记载实际 MySQL DDL 前置。#3524 经 #3523 关联；没有把它上提为新的 #2214 直连依据。 [#2214](https://github.com/Ozwasyd/FsusBlog/issues/2214) · [#3523](https://github.com/Ozwasyd/FsusBlog/issues/3523) |
| #2220–#2223 的原文移交 | 媒体库存消费封存源文。数据库暂存只接受与媒体计划匹配的预计引用。联合提交复用同一 operation/checkpoint 和路径约束。终验独立读回收据及数据库和文件，不执行前置步骤。旧媒体分支的联合执行器补丁只有 apply-check，记录为源码交接。 [迁移实现和待验收项](risk-migration.tsv) · [原补丁记录](https://github.com/Ozwasyd/FsusBlog/issues/2222#issuecomment-6053454626) |
| #3654 的本次发布绑定及两个导入入口 | #2175 要从原始调用独立回读持久命令，再核对真实投影边。#2221 离线暂存沿用当前文章及发布坐标语义，数据库与媒体由 #2222 协调提交。#2415 应用包导入调用实际发布 writer，仍须独立证明 #2317 作者索引的原子写入、重建与回读。 [#3654](https://github.com/Ozwasyd/FsusBlog/issues/3654) · [#2221](https://github.com/Ozwasyd/FsusBlog/issues/2221) · [#2415 更正](https://github.com/Ozwasyd/FsusBlog/issues/2415#issuecomment-6051587903) |
| 公开检索、权利摘要及证明 | #1728 要求真实搜索消费精确命中和拒绝夹具。#2174 的生命周期回执由 #2175 用于核对每个公开投影的封存坐标及权利摘要。#2543 另验生产和批量的完整权利、proof 与 outbox 差分。词典、分片补丁及文章透明日志取证来自固定 v1 代码。 [公开搜索](risk-public-search.md) · [权利证明](risk-integrity.md) |
| #2324 类型查询与 #2341 保存视图 | 值状态沿用 #2323。全文、属性、关系和分类状态各沿用原 owner。改名保留稳定 ID，退役依赖使查询失效。#2351 允许有确证的旧身份进入迁移，在服务端实际查询和界面回读结束后才移除旧源。 [#2324](https://github.com/Ozwasyd/FsusBlog/issues/2324) · [#2341](https://github.com/Ozwasyd/FsusBlog/issues/2341) · [#2346](https://github.com/Ozwasyd/FsusBlog/issues/2346) · [#2351](https://github.com/Ozwasyd/FsusBlog/issues/2351) |
| 文章切换、命令面板与工作区终验 | #2233 消费有权查询、服务端最近访问和已验证缓存，并把选择交给原工作区命令。#2234 验证已有组命令在面板、菜单和其他输入路径中的一致行为。#2297 须实际经过文章切换入口，产品缺陷交回原行为负责项。#2283 另验预览文章、文档代次、修订和责任材料的绑定，保留对附件终态的前置验收。 [#2233](https://github.com/Ozwasyd/FsusBlog/issues/2233) · [#2234](https://github.com/Ozwasyd/FsusBlog/issues/2234) · [#2297](https://github.com/Ozwasyd/FsusBlog/issues/2297) · [#2283](https://github.com/Ozwasyd/FsusBlog/issues/2283) |
| 工作区关闭、作者全文、PDF 与 Canvas 引用 | #2296 关闭前要确认保存、崩溃恢复与附件义务。#2316 至 #2320 把作者全文检索、源定位及旧入口切换绑定到当前修订与权限。#2417 只读冻结输入，#2426 和 #2428 另行验证实际输出、私有结果及退役。#2483 和 #2485 的引用与精确坐标经同一 Canvas 写入权威校验，#2494 终验仍需批量和无障碍证据。 [#2296](https://github.com/Ozwasyd/FsusBlog/issues/2296) · [#2318](https://github.com/Ozwasyd/FsusBlog/issues/2318) · [#2417](https://github.com/Ozwasyd/FsusBlog/issues/2417) · [#2485](https://github.com/Ozwasyd/FsusBlog/issues/2485) |
| 动态风险、强匿名和私有媒体 | #1772 要核对策略发布、阶段性挑战和跨代证明失效。#1777 把产品就绪判断、签发和独立验证者分开取证。#2076 和固定 #1782 对拒绝状态及一次消费有冲突，详见既有裁决范围。 [风险与匿名条款](risk-strong-anonymous.md) · [C9](conflicts.md) |
| C11 预期与 P6 执行证据 | #2552 和 #2553 绑定场景真实统计与适用查询，#2556 和 #2559 使用封存计划生成独立预期，#2561 运行正常产品入口。#1950 和 #1952 将准入、退出及首因绑定到本次实际所有者。 [查询与规模](risk-scale-query-cases.md) · [#1950](https://github.com/Ozwasyd/FsusBlog/issues/1950) |
| 父项行中的 PR、下游与排除项 | #3560 的父项、编译检查前置和 PR 来源分开。#3534 的直接准入与下游清单分开。#4759 旧 PR 正文中的自指也不进入运行依赖。 [#3560](https://github.com/Ozwasyd/FsusBlog/issues/3560) · [#3534](https://github.com/Ozwasyd/FsusBlog/issues/3534) · [#4759 历史评论](https://github.com/Ozwasyd/FsusBlog/issues/4759#issuecomment-6876140834) |

P0 尚需完整审阅未被标记规则覆盖的段落、表格和后续评论，核实当前无法读取的对象及冻结档外各项的有效职责，并把明确采用的条款落到 v2 的模块、测试、预算和实际构建证据。已有高风险与 [跨仓依赖](dependency-fsusui.tsv) 细表补充部分输入。冻结状态和文字处置都保留原时间口径。

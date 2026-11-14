# 冻结同仓显式引用核对

输入是 2026-11-14 20:35–20:43 北京时间冻结的 [开放 issue 和评论](open-issues.ndjson.gz)。本轮只读冻结资料。原始索引仍有 3,516 条候选，其中 3,410 条属同仓，包括 2,611 次开放目标的 issue 正文引用、793 次正文对正文快照以外的目标引用和六次评论引用。其他 106 次指向 FsusUI。

[显式引用台账](text-reference-dispositions.tsv) 按冻结源文档、原文行、目标去重，保留两处重复的原始次数。共 3,511 个来源位置，覆盖 3,408 个原索引位置并补上 103 个精确位置。其中 328 个位置有逐项语境核对，包含原索引的六个评论位置。其余只按明确标记和字面编号清单确认文字所声明的关系，不能据此报告产品要求已采用或验收已通过。

- `issue=N.body:Lx` 为压缩档中编号 N 的正文第 x 行。`issue=N.comment=C.body:Lx` 为该 issue 评论 C 的第 x 行。补充证据用 `#N:x-y` 或 `#N@C:x-y` 定位。`rawOccurrences=0` 的行来自人工补充，包括斜杠相邻编号和原索引漏掉的显式变体。相同目标在不同源行的独立证据仍保留。
- `OPEN` 表示目标有冻结开放正文。`CLOSED` 表示冻结的正式关系元数据确认关闭。`ABSENT` 表示冻结输入没有独立状态，即使原文说它已关闭或称其为 PR。3,511 行中，605 行的目标在冻结元数据中无状态，涉及 183 个编号。其后单独采集的 [实时状态与语义复核](target-observation-review.md) 已逐号核验，保留冻结列的原时间口径。
- [正式关系](formal-relations.tsv) 从冻结的 GitHub 关系字段将 399 份记录合成 229 条有向关联，保留所有对向来源字段。`prerequisite` 从实际阻塞方指向被阻塞方，`parent` 从父项指向子项。`formalRelations` 在文本表中则从该行源 issue 的视角标明已存在的正式关系。空值表示冻结输入未观察到两个编号之间的正式关系。
- [语境处置](text-reference-qualifications.tsv) 保留直接前置、验收限定、跟踪关系、历史引用、源码交接、范围排除和目标冲突。它用于修正同一行内仅按行头定性的歧义。DAG 成员保留在原句，不将其扩写为跟踪票的平面依赖。

| 已核对的边界 | 处置 |
| --- | --- |
| #1810 和 #1907 的附件与标题集成 | #1810 总验收需要实际标题集成。#1907 消费 #1810 的五项执行结果及相应包基础收据；#2409/#2420 终验消费 #1907 成果。无需等待 #1810 或包跟踪票先关闭。 [#1810](https://github.com/Ozwasyd/FsusBlog/issues/1810) · [#1907](https://github.com/Ozwasyd/FsusBlog/issues/1907) |
| #2659 和 #2679 的收据重拆 | 正式 blockedBy 仍保留。正文列出直接验证的六项及三项收据，原底层条件可沿实际生产者追踪。保留该差异供验收映射，无需凭历史关系推定旧实现必须再做。 [#2659](https://github.com/Ozwasyd/FsusBlog/issues/2659) · [#2679](https://github.com/Ozwasyd/FsusBlog/issues/2679) |
| #2549、#2555、#2561 的 #1619 | 三个标题栏明确引用 #1619，正文描述的是查询能力。冻结 #1619 的职责为 Snowflake fixture 分配器。保留冲突，实际查询权威尚需定位。 [#1619](https://github.com/Ozwasyd/FsusBlog/issues/1619) · [#2549](https://github.com/Ozwasyd/FsusBlog/issues/2549) · [#2555](https://github.com/Ozwasyd/FsusBlog/issues/2555) · [#2561](https://github.com/Ozwasyd/FsusBlog/issues/2561) |
| #2214 的正式阻塞方 #3523 | #2214 原始正文前置与 #3523 的正式追加同时成立。#3523 正文记载实际 MySQL DDL 前置。#3524 经 #3523 关联；没有把它上提为新的 #2214 直连依据。 [#2214](https://github.com/Ozwasyd/FsusBlog/issues/2214) · [#3523](https://github.com/Ozwasyd/FsusBlog/issues/3523) |
| #3654 的本次发布绑定及两个导入入口 | #2175 要从原始调用独立回读持久命令，再核对真实投影边。#2221 离线暂存沿用当前文章及发布坐标语义，数据库与媒体由 #2222 协调提交。#2415 应用包导入调用实际发布 writer，仍须独立证明 #2317 作者索引的原子写入、重建与回读。 [#3654](https://github.com/Ozwasyd/FsusBlog/issues/3654) · [#2221](https://github.com/Ozwasyd/FsusBlog/issues/2221) · [#2415 更正](https://github.com/Ozwasyd/FsusBlog/issues/2415#issuecomment-6051587903) |
| #2324 类型查询与 #2341 保存视图 | 值状态沿用 #2323。全文、属性、关系和分类状态各沿用原 owner。改名保留稳定 ID，退役依赖使查询失效。#2351 允许有确证的旧身份进入迁移，在服务端实际查询和界面回读结束后才移除旧源。 [#2324](https://github.com/Ozwasyd/FsusBlog/issues/2324) · [#2341](https://github.com/Ozwasyd/FsusBlog/issues/2341) · [#2346](https://github.com/Ozwasyd/FsusBlog/issues/2346) · [#2351](https://github.com/Ozwasyd/FsusBlog/issues/2351) |
| 父项行中的 PR、下游与排除项 | #3560 的父项、编译检查前置和 PR 来源分开。#3534 的直接准入与下游清单分开。#4759 旧 PR 正文中的自指也不进入运行依赖。 [#3560](https://github.com/Ozwasyd/FsusBlog/issues/3560) · [#3534](https://github.com/Ozwasyd/FsusBlog/issues/3534) · [#4759 历史评论](https://github.com/Ozwasyd/FsusBlog/issues/4759#issuecomment-6876140834) |

P0 尚需完整审阅未被标记规则覆盖的段落、表格和后续评论，核实当前无法读取的对象及冻结档外各项的有效职责，并把明确采用的条款落到 v2 的模块、测试、预算和实际构建证据。已有高风险与 [跨仓依赖](dependency-fsusui.tsv) 细表补充部分输入。冻结状态和文字处置都保留原时间口径。

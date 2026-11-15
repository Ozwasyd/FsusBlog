# 冻结同仓显式引用核对

输入是 2026-11-14 20:35–20:43 北京时间冻结的 [开放 issue 和评论](open-issues.ndjson.gz)。本轮只读冻结资料。原始索引仍有 3,516 条候选，其中 3,410 条属同仓，包括 2,611 次开放目标的 issue 正文引用、793 次正文对正文快照以外的目标引用和六次评论引用。其他 106 次指向 FsusUI。

[显式引用台账](text-reference-dispositions.tsv) 按冻结源文档、原文行、目标去重，保留两处重复的原始次数。共 3,594 个来源位置，覆盖 3,408 个原索引位置并补上 186 个精确位置。其中 1,109 个位置有逐项语境核对，包含原索引的六个评论位置。其余只按明确标记和字面编号清单确认文字所声明的关系，不能据此报告产品要求已采用或验收已通过。

前一轮核对作者全文搜索与命中定位、Canvas 几何与历史、修订回滚，以及 Markdown 冻结输入与分页 PDF 的 30 个已有位置。#1803 和 #2484 的关系从冻结来源正文定位，目标状态继续保留为 `ABSENT`。

随后为 30 个已有位置补齐出处，涉及属性定义和类型值、权限过滤、保存视图查询复用、终态矩阵，以及语义位置如何用于访问历史和 Canvas 转换。#2243 的文档上下文职责据 #2246 正文定位，冻结目标状态仍为 `ABSENT`。

此前为 55 个已有位置补齐冻结出处。作者索引的发布和查询按 writer 身份、源代次与持久接续核对。C11 将同计划的生产与批量写入差分、实际分布统计、独立预期及正常产品查询绑定到各自的原始权威。#1619 的既有职责冲突继续保留。

此前核对 258 个已有父项位置。子项正文须写明父项及自身范围，父项的冻结拆分须明确列出同一子项的唯一职责。台账记录两端原文及位置，产品采用和验收继续逐项核对。

此前核对 151 个已有前置引用。源文必须指明所需能力及消费方向，或由冻结上游职责和下游的实际消费或收据条款共同印证。台账区分 92 个具体能力前置、11 个条件前置及 48 个验收条件，按原文记录适用范围。

本轮核对 61 个已有位置，覆盖作者工作区、多格式导出、迁移准入与保全、检索与保存视图、Canvas 及规模分布。终态行以冻结的消费、验证或收据条款匹配上游职责。原保存视图的已替代执行编号和导出私有存储排除项保留独立处置。

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

## 文档导出条款与 v2 证据

以 `6a02786` 源码为定位基底。以下只映射已有实现及保留的运行证据，平台和候选沿用各自记录。

| 冻结要求 | 当前路径与证据 | 待验收 |
| --- | --- | --- |
| #1866 L44、#2412 L6、#2423 L10–11 要求绑定文章、修订、来源及资产坐标。 | 已保存文章走 `revision` 和 `sourceRevision`。服务先核验当前作者与修订，再读所选历史版本。PDF 在渲染后重验当前作者与修订。实际 PostgreSQL 夹具覆盖选定正文、访问拒绝和过期版本。 [服务端](../../src/Server/Authoring/MarkdownExportEndpoints.cs#L27-L77) · [集成测试](../../tests/Integration/MarkdownExportPostgresTests.cs#L290-L333) | 完整冻结 metadata、属性与资产清单，发布坐标和任务运行期间的资产撤权、输入摘要与任务恢复。 |
| #2417 L10–19、#2429 L6–10 要求真实分页、固定工具和字体、受控版式及规范摘要。 | PDF 使用固定 WeasyPrint 和 Noto CJK SC。历史样本在 Debian 13 ARM64 上生成 3 页 A4、嵌入可提取文字的字体子集；另有实际 PostgreSQL 授权下载用例核对历史修订。 [提供方](../../src/Server/Authoring/PdfDocumentExport.cs#L24-L65) · [分页验证](../../artifacts/original-delivery-next/linux-pdf/pdf-validation.log) · [实际 HTTP](../../artifacts/original-delivery-next/linux-pdf/guest-http-native.log) | 完整版式、表格与图片、宽代码、脚注、混合文字方向、输出规范摘要和跨工具版本的可重算验证。 |
| #2425 L11–22、#2414 L6 要求固定包、无网络、限制资源、取消及清理子进程。 | PDF 在两平台分别采用固定工具清单和 OS 沙箱。Debian 固定只读 payload，实际限额为 256 MiB，验收保留子进程边界、取消、系统服务和清理记录。PDF 每进程并发 1，渲染上限 12 秒，输入 Markdown 最大 256 KiB，附件最大 4 MiB。 [Linux 执行](../../src/Server/Authoring/LinuxPdfRuntime.cs#L15-L40) · [执行合同](../product/markdown-export.md#L21-L27) · [取消结果](../../artifacts/original-delivery-next/linux-pdf/guest-cancel-retry.log) · [清理核对](../../artifacts/original-delivery-next/linux-pdf/guest-cleanup.log) | 四种格式共用的完整任务宿主、完整 CPU／RSS／输出并发边界、超限与隔离故障的终态矩阵。 |
| #2422 L10–25、#2424 L14–26、#2436 L6 要求私有输出、任务状态及授权下载。 | 保存与历史修订的固定格式按钮经同一服务读取，附件为 `private, no-store`。组件在切换文章、修订或凭据时取消下载。 [下载入口](../../src/Server/Authoring/MarkdownExportEndpoints.cs#L50-L66) · [界面](../../src/Web/src/authoring/MarkdownExportControl.vue#L25-L75) | 共享异步提交、状态、重试历史，短期下载票据、私有存储、TTL、配额、篡改检查、并发回收和大文件流式读取。 |
| #2428 L10–18、#2438 L10–18、L36–40 要求四格式内容语义、统一验收和量化预算。 | HTML、PDF、DOCX 和 EPUB 当前分别有下载路径。实际集成测试核对基础 HTML、Word、EPUB 及权限拒绝。HTML 与 EPUB 的基础 Markdown 不支持链接与图片，现有请求明确拒绝。PDF 的单篇分页及拒绝证据单列。 [格式分派](../../src/Server/Authoring/MarkdownExportEndpoints.cs#L19-L38) · [保存修订用例](../../tests/Integration/MarkdownExportPostgresTests.cs#L75-L177) | 完整格式支持矩阵、统一失败回执、1,000 任务与大文档预算、磁盘和 DOM 观测、隐私和无障碍、同一冻结构建端到端收据。 |

## 签名外观条款与 v2 证据

| 冻结要求 | 当前路径与证据 | 待验收 |
| --- | --- | --- |
| #3177 L14–30、L36–41 要求原字体及主题 AEDS 查询、权限与限流。 | `6a02786` 提供状态、组合目录、字体详情和全站历史。字体详情绑定原档 SHA-256，实时核验独立管理员来源与 `system.config`。HTTPS 浏览器覆盖授权、匿名、普通站点会话、来源和撤权。 [服务器端点](../../src/Server/Identity/AdminAppearanceEndpoints.cs#L15) · [浏览器用例](../../tests/EndToEnd/admin-appearance-flow.mjs#L34) · [HTTPS 结果](../../artifacts/font-registry-detail-0cf1757/browser/admin-identity-result.json#L206) | 原八个 GET 的逐条映射、主题单项读取、作用域内启用信息、旧 `fixed_ip` 限流语义及完整失败帧。 |
| #3177 L34–41、L48–51 要求唯一协议、跨栈边界和真实客户端。 | `AdminAppearanceFontDetail` 33039 由同一 schema 生成 C#、TS 与 C++ 帧登记。真实界面的 AEDS 用例核对归档、字体摘要和字节长度、许可证及来源。保存的通用协议日志包含 C#、C++、Wasm 与 3,847 项 JS/Wasm 差分。 [协议定义](../../src/Contracts/wire.schema.json#L999) · [客户端用例](../../tests/EndToEnd/admin-appearance-flow.mjs#L238) · [协议日志](../../artifacts/font-registry-detail-0cf1757/protocol.log) | 原八路逐字段 native 解码、畸形帧、原视图和作用域交互的正式矩阵。 |
| #3707 L1–15 保留原源码交接和未完成的运行资格。 | v2 的浏览器运行取 `0cf1757` 基底及审查用补丁，运行保存的 16 个变更文件摘要与 `6a02786` 对应源码一致。 [原交接](https://github.com/Ozwasyd/FsusBlog/issues/3707#issuecomment-6052830357) · [运行后提交](../../artifacts/font-registry-detail-0cf1757/verified-commit.txt) · [源码摘要](../../artifacts/font-registry-detail-0cf1757/source.sha256) | 同一封存候选的完整包验收及 #3177 原路由矩阵。 |

## 工作区终态条款与 v2 证据

| 冻结要求 | 当前路径与证据 | 待验收 |
| --- | --- | --- |
| #2297 L12–16 要求唯一会话、跨组打开和状态隔离。 | `6a02786` 由同一 workspace registry 打开或激活精确会话。单元覆盖 100 个会话与第 101 个拒绝。保留的早期浏览器运行覆盖两组、桌面和 375px、焦点与独立 undo。 [会话入口](../../src/Web/src/authoring/workspaceRegistry.ts#L368) · [容量用例](../../tests/Authoring/workspaceRegistry.test.ts#L437) · [浏览器观测](../../artifacts/original-authoring-batch/second-workspace/browser/workspace-split-result.json) | 0、20 和 100 标签的 CPU、RSS、DOM、监听器及输入延迟，对全部真实入口及富编辑状态恢复的同候选验收。 |
| #2297 L17、#2296 L10–23 要求保护关闭，结束保存和恢复义务。 | 当前 registry 划分关闭规划、预留及提交。保留的浏览器运行覆盖实际取消与焦点返回、恢复保留、变化后拒绝及保存成功。 [关闭规划](../../src/Web/src/authoring/workspaceRegistry.ts#L665) · [关闭预留](../../src/Web/src/authoring/workspaceRegistry.ts#L712) · [浏览器观测](../../artifacts/original-authoring-batch/single-close/browser/workspace-split-result.json) | 附件并发、失败和取消的完整关闭矩阵，以及独立的版本、持久化和恢复同源收据。 |

P0 尚需完整审阅未被标记规则覆盖的段落、表格和后续评论，核实当前无法读取的对象及冻结档外各项的有效职责，并把明确采用的条款落到 v2 的模块、测试、预算和实际构建证据。已有高风险与 [跨仓依赖](dependency-fsusui.tsv) 细表补充部分输入。冻结状态和文字处置都保留原时间口径。

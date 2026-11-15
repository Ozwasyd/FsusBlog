# P0 需求审阅完成度

统计口径 v1 固定于 v2 提交 `f52cd045e8dc11ac7e09d8da9c9f8f47d18f8dc9`，使用其中的 2026-11-14 冻结 issue、评论、正式关系和仓库台账。下列计数反映截至该提交的证据强度。产品候选按各自提交和运行日志单列。

| 审阅对象 | 已记录 | 剩余工作 |
| --- | --- | --- |
| 开放议题 | 808 个均有处置，共 885 行。788 个只有一行，20 个有多行。其中 `采用`、`合并采用` 合计 543 行、498 个来源 issue；另有 8 行 `待决冲突`。附件明确列出的 9 项有 65 行。 | issue 的处置行可以汇总多条要求。完整原子条款还未逐项编号，无法从 885 行推算仍缺几条采用裁断、测试或预算。 |
| 冻结评论 | 2,562 个唯一 URL 均有处置。197 条标记为 `人工内容复核`，613 条有明确的结构或历史标记，99 条通过字节相同的正文复用。另有 1,653 条默认方法记录，正文摘要及其他证据复用混在同一类。 | 712 条有单独历史来源依据。剩余方法未细分的 1,653 条不能直接当成已读或未读。414 条标为采用或合并采用，其中 51 条缺 `R-*` / `V2S-*` 字面条款 ID，部分含文字验收，须先核对映射再补结构化引用。另有 18 条待决冲突处置。 |
| 同仓显式文字引用 | 原规则找到 3,410 次，归并为 3,408 个位置。已给 225 个原位置增加逐项处置，并人工补入 115 个规则之外的位置，合计 340 个逐项核对。共 3,523 个已索引位置。 | 3,183 个原位置只按标记解释，分布在 634 篇正文的 1,142 行。涉及开放目标 2,472 个位置、正式关闭目标 193 个位置、冻结档缺状态目标 518 个位置。未索引的自由文本还没有审阅总量。 |
| 正式关系、跨仓、冻结档外 | 399 条正式元数据归并为 229 条有向关联。106 次跨仓引用指向 17 个 FsusUI 目标，已有逐目标核对。605 个同仓位置涉及 183 个原快照无状态目标，已逐号记录之后观测。 | 后续观测没有回填冻结状态。逐目标核对之后，只有改变采用、排序或验收的具体引用需要纳入逐行语义和真实依赖映射。 |

复算以 `accepted-priority.tsv`、`memory-review.tsv`、`review-<范围>.tsv` 中的唯一 `requirementId` 及标准化 issue 号计条款和来源。`review-queue.tsv` 是索引。评论按 URL 和 `reviewMethod` 去重，单独联结 `historical-comment-lineage.tsv` 中字节相同的 99 个 URL。`acceptanceLinks` 仅以 `\b(?:V2S-\d+|R-\d+-[A-Z]?\d+)\b` 探测显式条款 ID。按源文档、行号及目标合并文字引用。`rawOccurrences > 0` 代表属于原索引，`support` 有值代表该位置有台账语境处置；正式关系、运行证据和语义审阅分别计数。以下命令可在对应提交的本地工作树重建索引及后续观测，不重新读取 GitHub。

```sh
python3 tools/issue-index.py
python3 tools/issue-target-check.py
```

### 评论条款链接 v2

本轮从 51 条候选中为 14 条补上已有条款 ID 和冻结正文、评论行号，保留原处置、说明与验收文本。`comment-progress.json` 生成 `adoptedComments` 及 `adoptedCommentsMissingExplicitRequirementId`。当前 414 条采用或合并采用的评论中，仍有 37 条缺显式 ID。这个数只反映结构化追溯缺口。 [评论进度](comment-progress.json) · [创作及附件](comments-authoring-leaves-integration.tsv) · [语言与 AEDS](comments-quality.tsv) · [文件与事务](comments-recent-platform.tsv)

### 评论条款链接 v3

续审 37 条候选，为 26 条补上已有同源条款和冻结行号，覆盖创作、附件、语言、文件观察、AEDS 与 Canvas。当前 414 条采用或合并采用的评论中，11 条仍缺显式 ID。#2231、#2246、#2263 和 #3735 各有一条主要记录前端协调、跨模块映射、上游绑定或工作区快照。#3524 的六条和 #3764 的一条没有足以对应同一 issue 已采用条款的证据。保留这些评论的现有说明与处置，后续核对具体产品条款的归属。 [当前进度](comment-progress.json) · [创作及附件](comments-authoring-leaves-integration.tsv) · [语言、文件观察和 AEDS](comments-quality.tsv) · [Canvas](comments-recent-platform.tsv)

## 优先核对的验收

| 来源和条款 | 可定位的当前证据 | 仍需核对 |
| --- | --- | --- |
| `R-1728-R1`、`R-2175-R1`。#1728 L106–131 的词元与真实消费者，#2175 L10–19 的同代次公开投影。 | `e7d1117` 的独立候选 Chrome 测到 375px 下中英文混合词序及 NFKC、相反词序的排名变化、旧代 HEAD 拒绝和撤回后重新下载。协议及实库用例另验词长、停用词、代次稳定性、旧编码不可续页。 [候选 Chrome](../../artifacts/candidate-e7d1117/browser/browser-result.json) · [构建身份](../../artifacts/candidate-e7d1117/release/build.txt) · [词元和发布用例](risk-public-search.md) | 继续分别验证 FAS4 服务端及固定 v1 浏览器的匹配和排名语义、FSDL 互操作、差量传输与整代重建等价。 |
| `R-1724-R1`、`R-1762-R1`。#1724 L44–56、L103–114、L139 的最终摘要和证明义务，以及 #1762 L75–89 的离线合法发布图与缺快照拒绝。 | `7f26418` 的两个固定 v1 摘要向量比对完整载荷及摘要。PostgreSQL 隔离候选从已保留的 v1 来源坐标复算发布与排程摘要，拒绝被篡改的权利或内容摘要以及缺少精确来源的回滚。 [向量和负例](../../tests/Protocol/ArticleCanonicalHashVectors.cs#L9) · [隔离候选边界](../../tests/Integration/Migration/legacy-project.sh#L284) · [候选运行](../../artifacts/rights-canonical-v1-20261115/result.txt) | 原生 v2 的文章内修订号、可空分类及派生摘要尚未提供固定 v1 所需的规范来源。需在已提交的现行发布坐标上独立验证生产摘要、权利签发、读面、撤回和透明日志。 |
| `R-2063-R1`、`R-2064-R1` 和 `R-1679-R1`。#2064 L10–23 的 outbox、排程和 claim 观察。#1679 L17–64 的同次准入证据在台账中作为历史教训。 | `fe7d57a` 的 `audit.read` 端点以真实当前管理员权限读发布水位、欠处理数量和最老事件时间。定向 PostgreSQL 用例先真正发布，再人为加入一条 pending 项验证刷新的前后状态、精确时刻及撤权。双源 TLS 浏览器对权限授予、重登及撤销旧会话有实际结果。 [真实实现](../../src/Server/Identity/AdminOperationsStore.cs#L8) · [实库用例](../../tests/Integration/AdminOperationsPostgresTests.cs#L31) · [定向候选](../../artifacts/p3-admin-operations-tls/commit.txt) · [运行结果](../../artifacts/p3-admin-operations-tls/admin-identity-result.json) | 现有首页就绪和聚合 pending 数无法覆盖 actual queue observer 全部域。须分辨发布和评论 outbox、处理中和失败、排程 owner 与 lease、漂移以及执行入口前的实际 AEDS canary。保留真实当前场景，沿用历史测试原则。 |
| `R-1726-R1` 和 `R-4234-01` 至 `R-4234-05`。#1726 L89–120 的真实授权与 fixture 语义，#4234 的原 owner 同步授权及生命周期。 | `e7d1117` 候选的独立管理员经双 TLS 源使用真实 Passkey 登录。Chrome 验证普通 Cookie 隔离、派生会话引用绑定、实际授予并撤销 `audit.read`。两管理员实库用例核对静态种子的授权分离、撤回、重登后代次和未知权限拒绝。 [双源 TLS](../../artifacts/candidate-e7d1117/admin-identity/admin-identity-result.json) · [授权实库用例](../../tests/Integration/AdminEffectivePermissionsPostgresTests.cs#L24) · [固定语义](../product/admin-identity.md) | 继续覆盖实际操作的角色和二次验证组合、绝对过期、代次和 A→B→A 延迟结果。v1 完整权限清单及原有整个编辑器授权时序仍需各自验证。 |

以上只记录可复查的部分映射。完整 P0 仍需逐条裁断剩余自由文本和验收归属，并对采用条款绑定模块、场景及预算。

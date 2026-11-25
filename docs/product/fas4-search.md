# 公开 FAS4 服务端检索

`GET /api/binary/article/search/query.aeds?q=…` 返回当前公开快照的 FAS4 ArticleSearch 帧，使用相同的公开代次和 `Cache-Control: no-store`，并附带 `X-Fsus-Search-Total` 标头报告匹配总数。接口向后兼容可选参数 `sort`（`relevance` 默认或 `latest`）、`page`（1..10,000）与 `size`（1..100）；未传分页参数时沿用原有前 200 条返回，传入分页参数时在至多 1,000 条有序窗口内按页切片并在 `X-Fsus-Search-Total` 返回窗口上限内总数，非法参数返回 AEDS 400。空查询返回 AEDS 400。原始参数最多 256 个 UTF-16 单元。查询与索引共用同一版本化文本分析器（`SearchAnalyzerVersion = 1`，见 [`SearchTextAnalyzer.cs`](../../src/Contracts/SearchTextAnalyzer.cs)）与版本化概念查询计划（`SearchFas4Profile = 3`，见 [`SearchQueryPlan.cs`](../../src/Contracts/SearchQueryPlan.cs) 与 [`SearchScoringProfile.cs`](../../src/Contracts/SearchScoringProfile.cs)），正文经受限已发布 Markdown 提取（保留标题、正文、可见链接文本与代码，排除链接目标 URL、HTML 注释/属性及 `<script>`/`<style>`），CJK 词在简体折叠视图上做词典分词并发射相邻二元词及 `ScriptAlias`，索引侧额外发射单字项以支持显式单字查询，同时保留 `C#`、`C++`、`.NET`、`ASP.NET`、`HTTP/2`、`issue-2205` 等带标点技术词项与精确 UTF-16 源偏移，并将分析器与评分配置版本绑定至公开代次。

**FAS4 第 3 版（`SearchFas4Profile = 3`，#46）概念级匹配与全局一致 BM25F 排序契约**：
- **概念分组与去重**：同一查询中的原词、繁简别名、短前缀替代项、纯连字符复合词（`batch-item`）或未知中文连续二元词序列（如 `量子纠缠`、`林徽因`）归并为单一概念，重复查询词去重，绝不重复计分；其中未知中文片段须在**同一字段满足相邻二元词精确连续位置**，绝不因孤立单字误召回。
- **完整概念覆盖与确定性有界松弛**：短查询（1–2 个内容概念）要求覆盖全部概念（允许跨标题/小节标题/摘要/分类标签/正文命中）；3 个及以上概念且主层命中不足 5 篇时，启用确定性有界松弛层（`3` 概念至少命中 `2` 个且覆盖 ≥60% 查询 IDF，`4` 概念至少 `3` 个且 ≥50% IDF，`≥5` 概念至少 `max(3, ceil(0.30·N))` 个且 ≥20% IDF，松弛结果上限 50 篇）。**显式双引号短语（`"..."`）与严格精确标识符（如 `C#`、`.NET`、`issue-2205`）绝不自动松弛**。主层结果在 `relevance` 与 `latest` 两种排序下均严格排在松弛层之前，层间无重复。
- **全局 5 字段 BM25F 与信号**：在完整活动公开代次上统计全局文档频率与 5 字段平均长度，字段权重与长度归一化参数为：标题（`w=4.5, b=0.50`）、Markdown 小节标题（`w=2.6, b=0.55`）、摘要（`w=2.0, b=0.55`）、分类与标签（`w=2.5, b=0.40`）、正文含代码（`w=1.0, b=0.75`），`k1=1.2`。主源词元与衍生前缀/子词/内部单字按精确半步词频（`1.0` vs `0.5`）区分；精确字形/繁简匹配追加 `+0.15·idf`，多概念标题/小节精确短语追加 `+0.35·Σidf`、正文精确短语追加 `+0.20·Σidf`、紧邻窗口追加 `+0.10·Σidf`。平分按确定性规则（`relevance`：层级、得分、创建时间、ID 降序；`latest`：层级、发布时间、得分、创建时间、ID 降序）裁决。紧凑索引、宽索引与独立无剪枝参考评估器（[`ExhaustiveSearchOracle.cs`](../../src/Contracts/ExhaustiveSearchOracle.cs)）逐条严格等价。

超过 128 个 UTF-16 单元的完整复合编号查询直接返回空结果，避免截断后命中另一编号。查询不访问 SQL，公开代次绑定 `public-search-bm25-v3` 与 `public-search-analyzer-v1`。

40,000 篇以内使用紧凑结构（构建预算 262,144 词项、3,000,000 倒排记录、128 Mi 扫描 UTF-16 单元，内置有序 5 字段半步词频与压缩位置表）。40,001 至 100,000 篇按最多 20,000 篇分块，宽索引通过三角色（主精确/简繁别名/衍生词）共享源倒排与紧凑单/多字段编码保持总保留内存在 32 MiB 预算内，并在完整代次全局统计上与紧凑索引及参考评估器保持一致排序。任一预算不足均放弃整个检索投影，专用查询返回 AEDS 503。

分块仍使用完整公开代次的文档长度均值和词项文档频率，并按原顺序合并得分。一次请求只租用一个块的分数数组，跨全部块保留同一个 200 项结果堆。通过全部预算的宽语料增加公开代次格式标识。AEDS 帧仍只携带已返回条目数。浏览器 FSPK 使用原格式和容量，超过最大页数与每页条数的乘积时提前拒绝。 [浏览器全文检索](public-search.md)

查询保留现有 256 个 UTF-16 单元的 HTTP 输入上限和并发限流，评分前去重词项。同一查询中的前缀、子词和原词可引用同一条实际倒排；每条实际倒排至多解码一次，所以一次请求最多解码该代允许的 800 万条倒排，在至多 100,000 个候选位置选择结果。合并多个倒排区间或共享倒排的词项在该请求内暂存文档权重，每个此类词项最多占用一个全代长度的整数数组。稀有哨兵与常用词需分开记录。高频词仍可能遍历大部分倒排并占用 CPU，单条正确性或延迟样本只用于定位开销。

串行诊断构建了 100,000 篇包含分离的 `batch` 和 `1`、没有完整 `batch-1` 的公开文档，共 146,400,000 个索引 UTF-16 单元。七次完整编号查询全部返回空，范围为 28.79–40.53 ms。常规多词对照仍返回上限 200 条。该记录测量独立索引调用。

固定生成器的 85,000 篇公开语料至多扫描 134,374,732 个 UTF-16 单元并产生 259,540 个词元区间。独立使用生成器的实际公开行构建宽索引，结果为 134,360,854 个 UTF-16 单元、258,869 个词元区间和 7,162,692 条倒排。压缩倒排占 14,707,396 字节，三类保留缓冲合计 19,173,824 字节。SDK 10.0.404 的常规 CLR 使用两处理器连续诊断，索引构建 2.017 秒，整个诊断进程的峰值 RSS 为 769 MB。各 31 次串行查询中，单条倒排的稀有词与读取 170,000 条倒排的常用词中位数分别为 0.019 和 6.498 毫秒。诊断还核对等待定时更新的文章仍能命中旧公开正文，未来正文无命中。

PostgreSQL 与 Kestrel 的 40,002 篇用例验证末段命中及 64 位发布坐标、FSPK 预算失败、相同代次的深页摘要及详情，以及实际撤回后的结果和旧代次拒绝。七项检索验证通过。完整 nightly 的数据库语料、负载及端到端耗时仍单独验收。

两项 Release 检查通过。PostgreSQL 与 Kestrel 验证了 FAS4 字节布局及发布坐标、不同字段的排序、CJK 词典边界、并集和去重、200 条上限及撤回投影失败后的拒绝与重放。六次查询返回 200，其请求归因的 PostgreSQL 命令和物理连接增量均为零。独立索引诊断用 12,050 篇合成发布文章、61,708,288 字节正文，构建用时约 748 毫秒，分配约 71.5 MB，完整垃圾回收后净保留约 14.5 MB。该诊断记录独立索引开销，完整服务的容量和长时预算由 P2 矩阵验收。

面向代表性查询集的相关性、冷/热会话传输字节、延迟与能耗复现评估口径见 [公开搜索相关性、延迟与能耗评估基准](search-evaluation.md)。

## 公开搜索结果契约 v2（`/api/v2/public/search.aeds`，AEDS `33081`，#47）

在保持原有 `/api/binary/article/search/query.aeds`（FAS4）向后兼容的同时，服务端提供版本化的生成式 AEDS 检索端点 `GET /api/v2/public/search.aeds?q=…&sort=relevance|latest&size=1..100&cursor=…&profile=…`（帧类型 `FrameType.PublicSearchResult = 33081`，见 [`src/Contracts/wire.schema.json`](../../src/Contracts/wire.schema.json) 与 [`src/Contracts/Wire.PublicSearch.cs`](../../src/Contracts/Wire.PublicSearch.cs)）：

- **真实计数关系与检索窗口解耦**：响应显式返回 `generation`、`profileVersion`、`analyzerVersion`、`totalCount`、`totalRelation`（`Exact = 0` / `LowerBound = 1`）、`primaryCount`、`relaxedCount`、`hasMore` 与 `nextCursor`。命中数不超过阈值（默认 1,000）时返回 `Exact` 且满足 `primaryCount + relaxedCount == totalCount`；超过阈值或触发下界计数时绝不伪造为精确计数，而是标记 `LowerBound`。`hasMore` 与 `nextCursor` 仅在确实观察到当前窗口内的下一条合法结果时才为真/非空，绝不从下界计数反推伪造。
- **代次绑定认证游标**：`PublicSearchCursor` 使用每实例 256 位随机密钥的 AES-256-GCM 签发不透明游标（15 分钟有效期），绑定 `generation`、规范查询计划、排序、页大小、分析器与评分配置版本、结果层级及末条确定性排序元组 `(Tier, ScoreBits, PublishedAtTicks, CreatedAtTicks, Id)`。篡改、过期或参数不匹配的游标返回 AEDS `400`（`search_cursor_invalid`）；不支持的 `profile` 返回 `400`（`search_profile_unsupported`）；合法游标在翻页期间发生发布/编辑/撤回导致代次变更时返回明确 `409`（`search_generation_changed`）；超出显式工作预算时返回 `503`（`search_budget_exceeded`），索引不可用返回 `503`（`search_unavailable`），绝不以 `200` 精确空结果掩盖失败。
- **仅面向返回页的安全纯文本摘要与高亮**：[`SearchSnippetExtractor.cs`](../../src/Contracts/SearchSnippetExtractor.cs) 仅对当前返回页（≤ `size` 篇）提取有界纯文本片段（≤ 640 UTF-8 字节）与经排序、非重叠、不撕裂 UTF-16 代理对的高亮偏移列表（≤ 16 段），覆盖 `Title`、`Heading`、`Summary`、`Taxonomy`、`Code` 与 `Body` 字段命中；所有隐藏 HTML/脚本与 Markdown 目标 URL 均被剥离，前端仅渲染纯文本节点与 `<mark class="search-highlight">` 而绝不使用 `v-html`。

## 有界精确 Top-K 检索与安全块级剪枝（#48）

紧凑索引（[`ArticleSearchIndex.Pruning.cs`](../../src/Contracts/ArticleSearchIndex.Pruning.cs)）与宽索引（[`ArticleSearchIndex.Wide.cs`](../../src/Contracts/ArticleSearchIndex.Wide.cs)）在不改变 #46 匹配语义、得分与确定性平分排序的前提下，按查询选择度自适应路由执行路径：

- **可寻址块级元数据与预建短前缀索引**：紧凑索引按每 64 条升序倒排记录维护与代次统计解耦的原始块元数据 [`SearchPostingBlockMeta`](../../src/Contracts/SearchScoringProfile.cs)（`MaxOrdinal`、5 字段半步最大词频、5 字段最小文档长度、精确字形标志以及发布时间上下界），块上界在查询时依据活动代次的全局 `idf` 与 5 字段平均长度动态计算（`UpperBoundBm25F`，含 `+1e-11` 浮点保守余量），在全局统计变化与后续段合并（#51）后依然严格保守。1–2 字符 ASCII 短前缀在索引构建阶段一次性预建有序倒排与块元数据（`ShortPrefixTerm[]`），消除每查询 O(N) 元数据扫描。
- **选择性精确快路径 vs 块级剪枝**：低文档频率查询（驱动倒排 ≤ 256）直接走零剪枝开销的 `SelectiveExact` 跳跃交集；高频单概念查询利用 O(1) 精确 `df` 立即启用全块级剪枝（`BlockMaxConjunction` / `LatestBlockScan`）且仍保留精确总数；多概念查询优先执行主层交集，主层命中满 5 篇时完全跳过松弛层，不足 5 篇时松弛层在 `relevance` 模式下采用 Block-Max WAND（`BlockMaxWand`）、在 `latest` 模式下采用独立发布时间块剪枝（`LatestBlockScan`），并与 #47 真实 `LowerBound` 计数契约协同（跳过未计数块时绝不伪报 `Exact`，`hasMore` 仅由真实观察到的下一页首条结果决定）。
- **精确惰性位置读取与有界池化堆**：单查询 Top-K 结果堆由 `ArrayPool<ArticleSearchHit>` 租借并在 `finally` 中以 `clearArray: true` 归还（绝不泄漏缓冲或钉住旧公开代次）。位置表读取（及宽索引候选重分析）仅在准入必需（双引号短语 / 未知 CJK 连续二元词）或 `baseScore + maxPhraseBonus` 仍可能进入堆时触发，绝不使用固定初筛截断近似；默认不启用单查询多核扇出，并在块循环与候选循环中持续检查取消令牌与显式工作预算（超限抛出 `SearchBudgetExceededException` 返回 AEDS `503`）。

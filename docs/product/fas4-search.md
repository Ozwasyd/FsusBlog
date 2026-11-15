# 公开 FAS4 服务端检索

`GET /api/binary/article/search/query.aeds?q=…` 返回当前公开快照的 FAS4 ArticleSearch 帧，使用相同的公开代次和 `Cache-Control: no-store`。空查询返回 AEDS 400。原始参数最多 256 个 UTF-16 单元。查询先做 NFKC、压缩空白及小写转换，再按固定 v1 的 128 单元边界截取。文章字段以已有的正文和修订元数据建立词元，CJK 词保留命中的词典子词。 [固定 v1 路由](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs#L121) · [固定 v1 查询归一化](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleService.CacheAndInvalidation.cs#L414) · [固定 v1 词元来源](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.Dictionary.cs#L52)

独立查询词元采用并集召回，再计算整份公开语料的 BM25。标题、摘要、分类和标签、正文各次命中的权重分别为 16、8、5、2。文档长度使用前 256 Ki 个 UTF-16 单元的正文，清除 Markdown 链接目标、行内 HTML 标签和标记符号后计数。已选结果最多 200 篇，排序按得分、创建时间和文章 ID 降序。v2 用当前已发布摘要及分类标签。未录入分类的文章没有分类词元。旧站阅读次数和原始摘要字段尚待迁移对账。 [固定 v1 索引及候选排序](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.RuntimePersistence.cs#L65) · [固定 v1 BM25](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Search/SearchRuntimeScorer.cs)

FAS4 第 2 版查询规则对单个复合编号做完整匹配。归一化后，查询须由至少两段 ASCII 字母数字组成，段间用单个连字符或下划线分隔，且至少含一个数字。超过 128 个 UTF-16 单元的完整编号查询返回空结果，避免截断后命中另一编号。检索从现有倒排的最稀有段取候选，在当前公开字段核对原样 ASCII 编号、分隔符和两端边界，忽略 ASCII 大小写。仅完整命中的频次参与原有字段权重，筛选发生在 200 条结果上限之前。常规多词查询继续使用并集。紧凑和宽语料共享规则，无新增倒排或请求 SQL。最坏情况下会复查一个公开快照构建预算内的全部索引字段。公开代次绑定查询规则版本，FAS4 帧、浏览器全文语料格式及数据预算沿用原约定。

40,000 篇以内使用原紧凑结构，构建预算为 262,144 个词元、3,000,000 条倒排记录及 128 Mi 个扫描 UTF-16 单元。40,001 至 100,000 篇按最多 20,000 篇分块，倒排记录以块内文章序号差值和频次权重编码。单块最多 200 万条，全代最多 800 万条、262,144 个词元区间和 144 Mi 个扫描 UTF-16 单元。文章引用及归一化系数、词元区间和倒排缓冲合计最多 32 MiB。任一预算不足均放弃整个检索投影，专用查询返回 AEDS 503。

分块仍使用完整公开代次的文档长度均值和词项文档频率，并按原顺序合并得分。一次请求只租用一个块的分数数组，跨全部块保留同一个 200 项结果堆。通过全部预算的宽语料增加公开代次格式标识。AEDS 帧仍只携带已返回条目数。浏览器 FSPK 使用原格式和容量，超过最大页数与每页条数的乘积时提前拒绝。 [浏览器全文检索](public-search.md)

查询保留现有 256 个 UTF-16 单元的 HTTP 输入上限和并发限流，评分前去重词项。每个匹配词项在各块只读取一次对应倒排区间，所以一次最坏请求最多读取该代允许的 800 万条倒排，扫描至多 100,000 个候选位置。没有查询词项的块跳过评分数组初始化和候选扫描。稀有哨兵与常用词需分开记录。高频词仍可能遍历大部分倒排并占用 CPU，单条正确性或延迟样本只用于定位开销。

串行诊断构建了 100,000 篇包含分离的 `batch` 和 `1`、没有完整 `batch-1` 的公开文档，共 146,400,000 个索引 UTF-16 单元。七次完整编号查询全部返回空，范围为 28.79–40.53 ms。常规多词对照仍返回上限 200 条。该记录测量独立索引调用。 [原始样本](../../artifacts/goal-next-a19a819/fas4-ubiquitous-scan/profile.json)

固定生成器的 85,000 篇公开语料至多扫描 134,374,732 个 UTF-16 单元并产生 259,540 个词元区间。独立使用生成器的实际公开行构建宽索引，结果为 134,360,854 个 UTF-16 单元、258,869 个词元区间和 7,162,692 条倒排。压缩倒排占 14,707,396 字节，三类保留缓冲合计 19,173,824 字节。SDK 10.0.404 的常规 CLR 使用两处理器连续诊断，索引构建 2.017 秒，整个诊断进程的峰值 RSS 为 769 MB。各 31 次串行查询中，单条倒排的稀有词与读取 170,000 条倒排的常用词中位数分别为 0.019 和 6.498 毫秒。诊断还核对等待定时更新的文章仍能命中旧公开正文，未来正文无命中。 [生成器语料诊断](../../artifacts/fas4-wide-c11/profile.json)

PostgreSQL 与 Kestrel 的 40,002 篇用例验证末段命中及 64 位发布坐标、FSPK 预算失败、相同代次的深页摘要及详情，以及实际撤回后的结果和旧代次拒绝。七项检索验证通过。完整 nightly 的数据库语料、负载及端到端耗时仍单独验收。 [检索验证](../../artifacts/fas4-wide-c11/native.log)

两项 Release 检查通过。PostgreSQL 与 Kestrel 验证了 FAS4 字节布局及发布坐标、不同字段的排序、CJK 词典边界、并集和去重、200 条上限及撤回投影失败后的拒绝与重放。六次查询返回 200，其请求归因的 PostgreSQL 命令和物理连接增量均为零。独立索引诊断用 12,050 篇合成发布文章、61,708,288 字节正文，构建用时约 748 毫秒，分配约 71.5 MB，完整垃圾回收后净保留约 14.5 MB。该诊断记录独立索引开销，完整服务的容量和长时预算由 P2 矩阵验收。 [原生检查](../../artifacts/fas4-http-search/native.log) · [独立诊断证据](../../artifacts/fas4-http-search/profile.json)

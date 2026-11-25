# 公开本地全文检索与宽语料分片

> **角色**：功能契约
> **适用对象**：站点部署者、前后端与搜索维护者
> **权威依据**：默认模式与开关以 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 为准；编解码与浏览器检索以 [`src/Contracts/ArticleSearchIndex.cs`](../../src/Contracts/ArticleSearchIndex.cs)、[`src/Web/src/search.worker.ts`](../../src/Web/src/search.worker.ts)、[`src/Web/src/compactSearchStorage.ts`](../../src/Web/src/compactSearchStorage.ts) 与 [`src/Web/src/wideSearch.ts`](../../src/Web/src/wideSearch.ts) 为准。

## 1. 搜索模式与默认配置

- `FSUSBLOG_PUBLIC_SEARCH_MODE` 控制公开检索路由策略，支持 `server`（默认）、`auto` 与 `local`（非法值启动即失败）：
  - **`server`（默认，#49）**：省略页面覆盖标记（或显式设 `server`），前端直连服务端 `/api/v2/public/search.aeds`（AEDS `33081`），仅按显式提交发送有界单次查询请求，返回当前页命中、精确/下界计数、部分匹配提示、安全纯文本高亮摘要与代次绑定游标，**零搜索 Worker 启动、零紧凑/宽语料分片下载、零搜索 IndexedDB 写入**，且不依赖浏览器 `Worker`、`indexedDB` 或 `navigator.locks`（详见 [公开 FAS4 服务端检索](fas4-search.md)）。
  - **代次变更安全恢复（#50）**：在服务端检索遇到明确的 `409 search_generation_changed`（或显式启用紧凑本地检索时在最终代次 `HEAD` 校验遇 `409`）时，前端（[`localSearch.ts`](../../src/Web/src/localSearch.ts)、[`PublicListing.vue`](../../src/Web/src/views/PublicListing.vue)）立即丢弃过期游标/本地分片并在原请求截止时间内**至多自动重试一次**，统一从第 1 页重新开始并同步地址栏至第 1 页（绝不混拼新旧代次分页），同时展示轻提示；若连续第二次仍发生代次变更则立即停止重试并展示可操作的重置/重试状态（绝不展示过期结果、绝不形成重试死循环）。损坏帧/分片（`ProtocolError`）、篡改或过期游标（`400 search_cursor_invalid`）、鉴权失败（`401`/`403`）、预算超限（`503`）及普通传输错误均与安全代次重启严格隔离，直接 fail-closed，不静默回落或自动重试。
  - **`auto`（显式 opt-in）**：通过 `<meta name="fsus-public-search-mode" content="auto">` 指示前端按需启用客户端分片检索——中小语料使用紧凑档 FSPK v4 本地分片（冷首查需下载全站紧凑分片）；紧凑档超出预算返回 `503` 时切换至已启用的宽语料分片；宽语料未启用或存储/Worker 不可用时，在当前 `/search` 周期内回落至零数据库查询的服务端 V2 检索并释放 Worker（但宽档数据损坏或撤回 `409` 严格 fail-closed 拒绝，绝不静默回落）。
  - **`local`（显式 opt-in）**：通过 `<meta name="fsus-public-search-mode" content="local">` 强制仅走客户端分片检索路径（依赖浏览器 Web Worker，冷首查需下载完整分片并在展示结果前经网络 `HEAD` 复核当前公开代次；因此 `local`/`auto` **并非离线可用搜索**，而是以客户端首次下载与存储成本换取热会话本地执行）。
- `FSUSBLOG_WIDE_SEARCH_CORPUS` **默认开启**（可显式设为 `false` 关闭），为显式启用 `auto`/`local` 时的 25,601 至 100,000 篇公开文章构建离线暂存宽语料分片。

## 2. 统一文本分析、词表与短语评分

- C# 索引构建器（`SearchTextAnalyzer` / `SearchMarkdownExtractor`）与浏览器 TypeScript 查询路径（`src/Contracts/search-analyzer.ts`）共享同一版本化分析契约（`SearchAnalyzerVersion = 1`，绑定至 `PublicGeneration`）与共享黄金向量（`tests/Protocol/fixtures/search-analyzer-vectors.json`）。
- 合并词表（核心词表、领域词表、停用词表）随发布包产出标准 FSDL v2 词典 `search-lexicon.fsdl`（见 [`tools/fsdl-dictionary.py`](../../tools/fsdl-dictionary.py)），简繁映射独立维护在嵌入资源 [`src/Contracts/search-sc-tc-map.json`](../../src/Contracts/search-sc-tc-map.json) 中。
- 分析契约核心规则：
  - **受限已发布 Markdown 提取**：线性扫描提取可见标题、行内与围栏代码、可见正文、可见链接/图片标签与可见 HTML 内文，并按块插入位置间隔，排除链接目标 URL、引用定义、HTML 注释、标签属性及 `<script>`/`<style>` 隐藏内容；
  - **NFKC 与精确 UTF-16 偏移**：按簇执行 NFKC 并为每个输出词元保留不撕裂代理对的原始 `[SourceStart, SourceEnd)` 偏移；
  - **中文与繁简**：在简体折叠视图上对连续 CJK 片段执行词典 Viterbi 分词，为未知中文词与人名发射带精确位置的相邻二元词（`CjkBigram`），繁简差异同步发射 `ScriptAlias`，单字索引项（`CjkChar`）仅在索引侧发射以支持显式单字查询而不污染多字查询；超过 4,096 个连续 CJK 字符时退化为有界线性扫描；
  - **技术标识符与标点**：保留 `C#`、`C++`、`.NET`、`ASP.NET`、`HTTP/2`、`issue-2205`、`v2_schema` 等带标点精确词项，区分 `Exact` 与有界 `Prefix`/`Subword`，超长精确标识符（> 128 单元）显式拒绝而非静默截断，且同一源词跨度只计入一次字段长度；
  - **抗碰撞词项标识**：服务端索引使用 64 位 FNV-1a 哈希与规范词串联合键（`SearchTermKey`），消除纯 32 位哈希截断碰撞。
- **服务端权威执行与本地全局一致性（`local-fspk-v4-global-concept-v3`）**：
  - 服务端 5 字段无量化 BM25F（`SearchFas4Profile = 3`，见 [公开 FAS4 服务端检索](fas4-search.md)）为权威排序契约。
  - 保留的浏览器 FSPK v4 紧凑与宽语料路径在查询前**跨当前代次全部已准入分片汇总全局文档总数、全局平均长度与全局词项文档频率**（两遍扫描），彻底消除页内局部 IDF 导致的分片边界与合并排序漂移；同时复用与服务端共享黄金向量的 [`search-query-plan.ts`](../../src/Contracts/search-query-plan.ts)，执行相同的概念覆盖、未知中文连续二元词位置核验、显式引号短语校验、严格标识符保护与有界松弛策略，跨页输出 `relevance` 与 `latest`（主层恒优先于松弛层）。
  - **已声明支持范围与显式拒绝**：FSPK v4 仅存储标题/元数据/正文 3 档量化词频、32 位哈希及非停用词标题/正文位置；对于超出 FSPK v4 支持边界的查询（例如纯停用词引号短语），本地路径显式返回 `Unsupported local search query profile` 错误而非静默返回失真结果。

## 3. 紧凑档分片、缓存复用与 FSPT 增量补丁

- **容量预算**：单页上限 200 篇 / 8 MiB，紧凑档上限 128 页 / 64 MiB。
- **代次绑定与抗撤回泄漏**：公开代次同时绑定已发布文章坐标、分类标签状态与按序编码的分片页；旧代次 `HEAD` 与续页均返回 `409`，未变动快照重启后字节与代次保持一致。浏览器在复用缓存前及展示结果前分别通过 `HEAD` 复核当前代次。
- **缓存与增量更新**：紧凑档在 Worker 内存及安全上下文的同源 IndexedDB（`fsusblog-v2-compact-search-v1`，由 Web Lock 串行协调并附逐页 SHA-256）保留一代完整 FSPK 页。离开 `/search` 终止 Worker；重返、刷新或跨标签页可经代次 `HEAD` 复用封存页。代次变化时，以已存页摘要发送 `If-None-Match`（未变页返回空体 `304`，全路径保留 `Cache-Control: no-store`）并支持 FSPT v4 增量补丁刷新，损坏或失配时立即清除缓存重取。

## 4. 宽语料暂存与 HTTP 分发（25,601–100,000 篇）

- **服务端暂存所有权**：宽语料编码与紧凑档共用逐页生产者，构建于 PostgreSQL 写门外，在独占 `0700` 目录内以 `0600`、`CreateNew` 创建并 unlink 路径后仅凭文件句柄读写（`WideSearchCorpusStage` 独占所有权、`PageRead` 借用计数关闭）。单实例最多持有 2 个文件句柄槽位（候选/活动/退役待排空），封存后随当前快照与租约原子挂载；文章发布不阻塞旧文件读取。
- **HTTP 端点**：
  - `GET /api/v2/public/search-corpus/wide/v1/manifest.aeds`（AEDS `33004`）：返回当前代次、总篇数、页数、总字节数、内容摘要及每页范围/偏移/长度/SHA-256。
  - `HEAD` / `GET /api/v2/public/search-corpus/wide/v1/pages/{page}?generation=…&digest=…`：`HEAD` 校验当前代次返回 `204`；`GET` 返回原始 FSPK 与强 ETag（`no-store`，并发限 2 路无排队）；已知代次失效返回 `409`，完整语料不可用返回 `503`。
- **客户端宽档缓存**：独立同源 IndexedDB 经 Web Lock 串行协调，上限 512 页 / 256 MiB；全页下载校验与封存前 `HEAD` 全部通过后才开放查询，损坏页或失效代次立即清空缓存。

## 5. 验证入口

相关性、延迟与能耗基线方法论及复现入口见 [公开搜索相关性、延迟与能耗评估基准](search-evaluation.md)。

```bash
./tools/protocol-test.sh
node --test tests/Protocol/search-analyzer.test.ts tests/Protocol/search-ranking.test.ts tests/Protocol/search-contract.test.ts tests/Protocol/local-search.test.ts tests/Protocol/local-search-positions.test.ts tests/Protocol/v1-search-ranking-differential.test.mjs
dotnet test tests/Integration/FsusBlog.V2.Integration.Tests.csproj -c Release --filter "ArticleSearch"
```

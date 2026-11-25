# 公开本地全文检索与宽语料分片

> **角色**：功能契约
> **适用对象**：站点部署者、前后端与搜索维护者
> **权威依据**：默认模式与开关以 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 为准；编解码与浏览器检索以 [`src/Contracts/ArticleSearchIndex.cs`](../../src/Contracts/ArticleSearchIndex.cs)、[`src/Web/src/search.worker.ts`](../../src/Web/src/search.worker.ts)、[`src/Web/src/compactSearchStorage.ts`](../../src/Web/src/compactSearchStorage.ts) 与 [`src/Web/src/wideSearch.ts`](../../src/Web/src/wideSearch.ts) 为准。

## 1. 搜索模式与默认配置

- `FSUSBLOG_PUBLIC_SEARCH_MODE` 控制公开检索路由策略，支持 `auto`（默认）、`local` 与 `server`（非法值启动即失败）：
  - **`auto`（默认）**：中小语料优先使用紧凑档 FSPK v4 本地分片；紧凑档超出预算返回 `503` 时自动切换至已启用的宽语料分片；宽语料未启用或存储不可用时，在当前 `/search` 周期内无缝回落至零数据库查询的服务端 FAS4 并释放 Worker（但宽档数据损坏或撤回 `409` 严格 fail-closed 拒绝，绝不静默回落）。
  - **`local`**：强制仅走客户端分片检索路径。
  - **`server`**：通过 `<meta name="fsus-public-search-mode" content="server">` 指示前端直连服务端 FAS4，不启动浏览器搜索 Worker（详见 [公开 FAS4 服务端检索](fas4-search.md)）。
- `FSUSBLOG_WIDE_SEARCH_CORPUS` **默认开启**（可显式设为 `false` 关闭），为 25,601 至 100,000 篇公开文章构建离线暂存宽语料分片。

## 2. 分词、词表与短语评分

- C# 索引构建器与浏览器 Worker 共享同一份合并词表（核心词表、领域词表、停用词表），同时随发布包产出标准 FSDL v2 词典 `search-lexicon.fsdl`（见 [`tools/fsdl-dictionary.py`](../../tools/fsdl-dictionary.py)）。
- 两端先执行 NFKC 规范化，按统一权重对 CJK 连续字段分词并合并 ASCII 字母数字（小写化）；连续超过 4,096 个 CJK 字符时退化为单字加最大词宽内逐位置命中。词典词、子词与单字共享原文字段位置与跨度。
- 浏览器 Worker 计算页内 BM25 并结合短语位置加分（短语须在同一字段按查询顺序连续命中，停用词计入普通频次但跳过短语位置，每页位置表上限 200 KiB），跨页支持 `relevance`（默认：得分、发布时间、ID 降序）与 `latest`（发布时间、得分、ID 降序），输出 FSR4 结果；已准入页面评分走有序二分查找并仅延迟解码当前展示页卡片。

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
node --test tests/Protocol/local-search.test.ts tests/Protocol/local-search-positions.test.ts tests/Protocol/v1-search-ranking-differential.test.mjs
dotnet test tests/Integration/FsusBlog.V2.Integration.Tests.csproj -c Release --filter "ArticleSearch"
```

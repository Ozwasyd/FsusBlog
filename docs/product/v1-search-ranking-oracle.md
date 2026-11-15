# 固定 v1 原始 FSR4 排名对照

以 v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 的 `search_index.cpp` 为规范，在测试目录保留独立的 Python 对照。它解码独立构造的完整 core、recent、archive FSPK 分片，按指定时钟计算排名，输出原始 FSR4。固定 Git 树中没有提交 `search_basic.wasm`、`search_simd.wasm` 或其他可携带 Wasm 二进制。Emscripten 构建目标及导出存在。此次未构建或执行 v1。 [原源码](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp) · [原构建目标](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/CMakeLists.txt#L1-L50)

```sh
python3 -B tests/Protocol/v1-search-ranking.test.py -v
node --test tests/Protocol/v1-search-ranking-differential.test.mjs
```

| 边界 | 对照内容 |
| --- | --- |
| 查询词 | 合法 UTF-8 中的 ASCII 字母数字串转小写和固定范围内的单个 CJK 字。Murmur3 哈希排序并去重，短语亦按哈希顺序。向量验证输入词序、重复词、全角和补充平面差异。 [原 tokenizer](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L289-L439) |
| 评分元数据 | 已载入角色按各自的 `float32` IDF 和平均长度累加 BM25。title/meta/body 的权重为 2.5/0.9/1，`K1=1.2`、`B=.75`，量化码 11 解码为 12。文档位置按同字段覆盖标量来抑制重叠，meta 仍独立计分。同字段相邻短语增加 1.25。热度使用评论和浏览的加权和，按发布时间以 45 天指数衰减，未来发布时间的年龄按 0 计算。未命中文档即使热度高也不入页。 [量化与热度](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L442-L481) · [位置与 BM25](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L1176-L1265) · [分片累积](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L1472-L1529) |
| 三种原始排序 | 相关性依次比较最终分、热度、发布时间、ID。最新依次比较发布时间、最终分、ID。热门依次比较热度、最终分、ID。ID 升序，其余降序。完整各页成员及同分相对次序都有独立预期。 [比较器](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L632-L712) |
| ABI 与字节 | 原始输入为 UTF-8、排序整数、页号、页大小，没有查询 cursor、分类或标签过滤。原 raw 页号 0 与页大小 0 分别归为 1。深页空结果仍保留真实总数，输出为 24B 空页头。保留 76B 行、12B 标签与整数发布坐标，含大于 `2^53` 的精确例。另与既有共享 FSR4 单文档向量逐字节比对。 [页输出](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L567-L630) · [ABI](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L1338-L1361) |

测试输入 SHA-256 为 `c60673fb3bb7a764f1dea3ba7b7b7c3cfd614cef47b574d5a7c2517c1027bdc4`。其显式 IDF、词频和时间用于隔离评分分支。样本不对 v1 后端文章如何生成词表、角色统计或 FSPT 叠加作验证。 [固定 FSPK](../../tests/Protocol/fixtures/v1-search-ranking-fspk.hex) · [独立页和评分预期](../../tests/Protocol/fixtures/v1-search-ranking.json)

固定 `searchIndex` 本地服务在 Wasm 选择页成员之后才做 TypeScript 页内重排。两个显示、词频、热度和日期相同的 ID 在 raw 页为 `[10, 40]`，页内最终 ID 降序会给出 `[40, 10]`。这一规则不会把其他页文章换入。固定公开 Filter 另经 ArticleList，HTTP FAS4 也是独立入口。 [本地服务](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/services/localSearch.ts#L1004-L1032) · [页内最终顺序](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/services/searchRanking.ts#L351-L382) · [公开入口与议题](search-patch-audit.md)

当前 v2 的真实 TypeScript `searchCorpus` 在 Node 使用模拟响应对照同一份 core 分片字节。查询 `foo bar` 在 v1 源码对照的原始顺序是 `[10, 20, 30]`，v2 是 `[20, 30, 10]`，总数和成员一致。当前 v2 单 core 页读取器按设计拒绝原三角色包。这个差分未运行浏览器、旧 Wasm 或真实 HTTP，无法证明两端完整行为等价。 [Node 差分](../../tests/Protocol/v1-search-ranking-differential.test.mjs) · [Python 对照](../../tests/Protocol/v1-search-ranking.test.py)

# 本地全文检索

公开快照的 FSPK v4 页面使用固定 v1 核心词表、领域词表和停用词表。三份词表合并为一份仓库数据，C# 索引和浏览器 Worker 使用同一份输入。两端先做 NFKC，再按同一权重在中文、日文和韩文连续字段内选择分词。ASCII 字母数字按原有规则分组，并转换 ASCII 大写。补充平面文字仍按 Unicode 标量处理。索引连续超过 4,096 个中日韩字符时使用单字分词，避免大输入导致无界词典运算。 [固定词表源码](https://github.com/Ozwasyd/FsusBlog/tree/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Dictionaries/Search)

词典词、词内可识别子词和单字证据共用原文字段的位置。词长随 FSPK v4 位置编码。短语必须按位置顺序在同一字段连续命中，支持重复词。停用词保留普通匹配频次，跳过短语位置。查询有词典词时优先按词匹配，查询单字及部分新词时仍能查询单字证据。 [固定 v1 服务端分词](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.Dictionary.cs)

公开代次同时绑定已发布文章坐标、分类标签状态和按顺序编码的完整索引页。旧编码生成的代次不能与新页混用，携带旧代次的 HEAD 和续页均返回 `409`。未变动的快照重启后仍返回相同字节和代次。浏览器在复用缓存及显示结果前分别确认代次，撤回后不会继续展示旧词条。

公开代次变化时，Worker 使用当前页的强 ETag 检查内存里相同页码的分片。服务端从完整分片字节计算 SHA-256。页字节一致时返回 304，变化的页返回完整 200。Worker 以新代次重新校验跨页文章和结果有效性，全程保留 `Cache-Control: no-store`。

Chrome 157 用 220 篇实库文章验证两个分片。发布和撤回第 221 篇时，第一片的 40,205 字节均由 Worker 保留，第二片分别从网络读取 4,522 和 4,260 字节。两次查询均先收到旧代次 409，最后收到当前代次 204，再显示正确的 FsusUI 列表。首次运行发现 Chromium 把 HTTP 304 暴露为空流。验证器加入零字节上限后复跑通过，错误 ETag 和非空流仍拒绝。 [浏览器原始请求](../../artifacts/search-corpus-page-reuse/chromium/search-corpus-reuse.json) · [首次运行](../../artifacts/search-corpus-page-reuse/first-attempt/chromium/search-corpus-reuse.json)

独立 FSPK 向量验证中文词频、停用词频次、单字和多字位置。PostgreSQL 及 Kestrel 用例验证产物重启稳定、编码切换拒绝及公开表示的同一代次。浏览器覆盖 375 像素下的 NFKC 与中英文混合词序，另验证撤回竞态。

发布包附带 `search-lexicon.fsdl`，由同一份仓库词表生成 v1 FSDL v2 格式。节点、边、条目及字符串区按冻结格式生成，保留 UTF-8 排序、标量位置、权重及停用词标志。离线工具支持导出至新路径，或复验已有文件的完整字节。实际 C# 索引和浏览器 Worker 继续从共享词表构建和查询。固定十六进制向量、独立的 trie 读取器及 CLI 用例随原协议测试运行。独立从固定 v1 三份文本重建的 74 个词条和 217 个节点与发布字典逐字节一致，共 6,839 字节。 [离线验证](../../artifacts/fsdl-interoperability/test.log) · [FSDL 工具](../../tools/fsdl-dictionary.py) · [冻结编译器](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.Dictionary.cs#L469)

专用 FAS4 HTTP 查询已使用当前不可变快照的 BM25 倒排索引，回传前 200 条匹配。真实 PostgreSQL 与 Kestrel 验证排序、撤回和请求内零数据库调用。旧公开浏览计数和手工摘要暂未迁入，可能改变历史并列排序和摘要词权重。短语位置加分属于浏览器 Wasm 路径。 [FAS4 实现与验收](fas4-search.md) · [固定 v1 Wasm](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp)

离线工具验证固定 v1 FSIM、FSPT 和三个完整角色分片，可复现通过固定摘要认证的补丁。在线补丁传输、固定浏览器 Wasm 的原始分页和排名仍待验收。 [离线补丁审计](search-patch-audit.md)

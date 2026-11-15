# 本地全文检索

公开快照的 FSPK v4 页面使用固定 v1 核心词表、领域词表和停用词表。三份词表合并为一份仓库数据，C# 索引和浏览器 Worker 使用同一份输入。两端先做 NFKC，再按同一权重在中文、日文和韩文连续字段内选择分词。ASCII 字母数字按原有规则分组，并转换 ASCII 大写。补充平面文字仍按 Unicode 标量处理。索引连续超过 4,096 个中日韩字符时使用单字分词，避免大输入导致无界词典运算。 [固定词表源码](https://github.com/Ozwasyd/FsusBlog/tree/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Dictionaries/Search)

词典词、词内可识别子词和单字证据共用原文字段的位置。词长随 FSPK v4 位置编码。短语必须按位置顺序在同一字段连续命中，支持重复词。停用词保留普通匹配频次，跳过短语位置。查询有词典词时优先按词匹配，查询单字及部分新词时仍能查询单字证据。 [固定 v1 服务端分词](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.Dictionary.cs)

公开代次同时绑定已发布文章坐标、分类标签状态和按顺序编码的完整索引页。旧编码生成的代次不能与新页混用，携带旧代次的 HEAD 和续页均返回 `409`。未变动的快照重启后仍返回相同字节和代次。浏览器在复用缓存及显示结果前分别确认代次，撤回后不会继续展示旧词条。

公开代次变化时，Worker 使用当前页的强 ETag 检查内存里相同页码的分片。服务端从完整分片字节计算 SHA-256。页字节一致时返回 304，变化的页返回完整 200。Worker 以新代次重新校验跨页文章和结果有效性，全程保留 `Cache-Control: no-store`。

Chrome 157 用 220 篇实库文章验证两个分片。发布和撤回第 221 篇时，第一片的 40,205 字节均由 Worker 保留，第二片分别从网络读取 4,522 和 4,260 字节。两次查询均先收到旧代次 409，最后收到当前代次 204，再显示正确的 FsusUI 列表。首次运行发现 Chromium 把 HTTP 304 暴露为空流。验证器加入零字节上限后复跑通过，错误 ETag 和非空流仍拒绝。 [浏览器原始请求](../../artifacts/search-corpus-page-reuse/chromium/search-corpus-reuse.json) · [首次运行](../../artifacts/search-corpus-page-reuse/first-attempt/chromium/search-corpus-reuse.json)

独立 FSPK 向量验证中文词频、停用词频次、单字和多字位置。PostgreSQL 及 Kestrel 用例验证产物重启稳定、编码切换拒绝及公开表示的同一代次。浏览器覆盖 375 像素下的 NFKC 与中英文混合词序，另验证撤回竞态。

发布包附带 `search-lexicon.fsdl`，由同一份仓库词表生成 v1 FSDL v2 格式。节点、边、条目及字符串区按冻结格式生成，保留 UTF-8 排序、标量位置、权重及停用词标志。离线工具支持导出至新路径，或复验已有文件的完整字节。实际 C# 索引和浏览器 Worker 继续从共享词表构建和查询。固定十六进制向量、独立的 trie 读取器及 CLI 用例随原协议测试运行。独立从固定 v1 三份文本重建的 74 个词条和 217 个节点与发布字典逐字节一致，共 6,839 字节。 [离线验证](../../artifacts/fsdl-interoperability/test.log) · [FSDL 工具](../../tools/fsdl-dictionary.py) · [冻结编译器](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.Dictionary.cs#L469)

专用 FAS4 HTTP 查询已使用当前不可变快照的 BM25 倒排索引，回传前 200 条匹配。真实 PostgreSQL 与 Kestrel 验证排序、撤回和请求内零数据库调用。旧公开浏览计数和手工摘要暂未迁入，可能改变历史并列排序和摘要词权重。浏览器本地 FSR4 路径计算短语位置加分。 [FAS4 实现与验收](fas4-search.md) · [固定 v1 Wasm](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp)

离线工具验证固定 v1 FSIM、FSPT 和三个完整角色分片，可复现通过固定摘要认证的补丁。在线补丁传输、固定浏览器 Wasm 的原始分页和排名仍待验收。 [离线补丁审计](search-patch-audit.md)

## 大语料前置

生产搜索由 TypeScript Worker 生成 FSR4，页内使用原浮点 IDF、平均长度和位置数据，跨页按得分、发布时间和 ID 合并。当前 Worker 只在内存保留一代完整 FSPK 页，复用前和显示前各检查一次代次。旧代页只有在当前页返回匹配的强 ETag 且响应为空的 304 后才重新校验。网络或代次检查失败后清除活动缓存。IndexedDB 当前用于作者草稿恢复。固定 v1 则通过 Emscripten runtime 加载角色分片，使用 Service Worker 的 CacheStorage 保存资产。固定原始排序与当前 Worker 排序的差分仍由各自的向量验收。 [当前 Worker](../../src/Web/src/search.worker.ts) · [固定 v1 排名](v1-search-ranking-oracle.md) · [同一 core 分片的差分](../../tests/Protocol/v1-search-ranking-differential.test.mjs)

FSPK 编码器使用同一逐页生产者服务现有内存收集器与诊断暂存目标。每次输出包含页号、文章数、首末文章 ID 和完整原始页。单页仍最多 200 篇和 8 MiB，现有 HTTP 路径仍最多 128 页和 64 MiB。暂存调用显式给出界限，最多接受 512 页和 256 MiB，这组上限供独立测量使用。预算未满足、取消或暂存方拒绝时丢弃全部暂存页。

以同一组生成器输入运行两个独立 CLR 进程。每次均编码 85,000 篇公开文章及其发布坐标，得到字节相同的 425 页。单程原始载荷为 136,868,326 字节，约 130.5 MiB。最大页为 323,645 字节。含逐页校验、摘要、文件写入和同步的两次运行分别用时 2.896 和 2.910 秒。单次暂存文件实际占用最多 151,392,256 字节。进程峰值 RSS 约 808 MB，包含输入语料。每次累计分配约 2.73 GB 托管内存，密集发布下的重建开销仍需单独测量。原始暂存文件均已清理，C# 和 Node 相关用例分别通过 17 项和 7 项。 [两次字节比对](../../artifacts/search-corpus-staging/first-verification/comparison.json) · [运行和清理记录](../../artifacts/search-corpus-staging/first-verification/run.txt)

内部暂存组件在 Linux 和 macOS 的独占 0700 目录内以 0600 和 `CreateNew` 创建文件。成功移除文件路径与临时目录后再写入正文，后续操作限于同一文件句柄。完成时封存总篇数、总长度以及每页连续偏移、文章范围、长度和 SHA-256。内容身份使用固定字节布局和独立的 v1 摘要域。失败或取消后关闭暂存句柄。退役组件停止接收新的页读取，已借用的读取完成或取消后释放句柄。定位读取核对封存长度及摘要。

以 macOS 普通用户和 `022` 掩码执行真实文件系统测试。锁定 Release 构建通过，共 17 项通过，其中 5 项直接验证了清单、定位读取、取消和退役后的句柄释放。临时目录清理完成。首次构建的 Unix 平台判断触发 CA1416，改用显式平台守卫后通过。 [通过记录](../../artifacts/fspk-private-spool/macos-verified/run.txt) · [首次构建](../../artifacts/fspk-private-spool/macos-first/build.log)

`FSUSBLOG_WIDE_SEARCH_CORPUS=true` 为 25,601 至 100,000 篇公开文章启用宽语料构建，默认关闭。构建在 PostgreSQL 写入门外进行，最多持有两个实际文件句柄，涵盖候选、活动及仍被读者持有的退役代。达到上限时处理合并后的最新快照，等待一个已确认关闭的槽位。封存后以当前快照引用和租约原子挂载。文章发布不会等待读取旧文件。清单失败时当前宽语料保持不可用，普通公开路由和原 FSPK 预算沿用既有契约。

`GET /api/v2/public/search-corpus/wide/v1/manifest.aeds` 以 AEDS 33004 返回当前完整清单。清单包含公开代次、总篇数、页数、总字节数和内容摘要，随后列出每页范围、偏移、长度和 SHA-256。相同入口的 `HEAD` 与 `GET /api/v2/public/search-corpus/wide/v1/pages/{page}` 都要求精确的 `generation` 和 `digest` 查询参数。当前 HEAD 返回空体 204。每页 GET 返回原始 FSPK 和强 ETag，使用 `no-store`。只有封存代次匹配时才发送代次和摘要标头，已知代次失效返回 409，当前完整语料不可用返回 503。读取校验后释放文件借用，并在响应开始前重新核对原快照和实例租约。页面请求使用两路无排队并发限制。

macOS PostgreSQL 18.7 和 Debian ARM64 PostgreSQL 17.12 各通过 26 项宽语料及回归验证。两端运行的托管程序集 SHA-256 一致。40,002 篇实库用例核对了清单、首中末页、HEAD 和撤回后的旧代次。撤回前后字节及 ETag 相同的页面仍拒绝旧代次。受控竞态也验证了最终响应检查和双文件槽位。两端的临时库、暂存文件均已清理，Debian 虚拟机已停止。GNU tar 解包时忽略了 macOS 文件来源扩展属性，程序集校验通过。 [macOS 原始结果](../../artifacts/fspk-wide-http/macos-first/native.log) · [Debian 原始结果](../../artifacts/fspk-wide-http/debian-first/native.log)

产品浏览器仍使用原 FSPK 路径。后续可按当前清单顺序下载并校验全代，浏览器用紧凑数组记录得分、发布时间、ID 和来源页，再从同代本地数据解码当前页所需卡片。显示前通过宽档 HEAD 检查代次。持久缓存配额和完整 85,000 篇端到端验证分别验收。

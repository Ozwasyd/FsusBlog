# AEDS v2 协议

外层帧使用固定提交 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 的 [AEDS v2 协议](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/core/Algorithms/AEDS_V2_PROTOCOL.md)。16 字节小端标头包含魔数、版本 2、标头大小、零标志、帧类型、载荷字节数、载荷 CRC-16。未知类型、其他版本、非零标志、超出预算和 CRC 不符均拒绝。HTTP 业务消息使用 `application/octet-stream`。

`src/Contracts/wire.schema.json` 保存首条链路公开路由、帧类型、布局常量与新记录定义。运行 `node tools/protocol-generate.mjs` 更新 C#、TypeScript 和 C++ 构件，`--check` 校验生成物。C#/TypeScript 的扩展载荷字段读写由定义生成，公开文章的可变偏移和校验逻辑保留在编解码器。

| 路径 | 载荷 |
| --- | --- |
| GET `/api/binary/article/list/home/{page}/{size}.aeds` | ArticleList (1)，FSPA v2、100 字节记录 |
| GET `/api/binary/article/list/archive/{page}/{size}.aeds` | ArticleList (1)，独立的归档游标作用域 |
| GET `/api/binary/article/{id}.aeds` | ArticleDetail (2)，ARD5 |
| GET `/api/binary/article/search/query.aeds?q=…` | ArticleSearch (4)，FAS4 HTTP 本体 |
| GET `/api/v2/public/index.aeds?page=…&generation=…` | ArticleSearch (4)，同代次 FAS4 静态索引页 |
| GET `/api/v2/public/search-corpus?page=…&generation=…` | 静态 FSPK v4 包，内含完整 FHS2 v4 分片 |
| HEAD `/api/v2/public/search-corpus?generation=…` | 204 复核当前代次，409 拒绝旧代次 |
| POST `/api/v2/identity/sign-in.aeds` | OperatorSignIn (32768) → OperatorSession (32769) |
| GET `/api/v2/identity/session.aeds` | OperatorSession (32769) |
| POST `/api/v2/identity/sign-out.aeds` | EmptySuccess (240) |
| GET `/api/v2/authoring/draft/{id}.aeds` | Draft (32770) |
| POST `/api/v2/authoring/{save,publish,retract}.aeds` | ArticleCommand (32771) → Draft (32770) |
| POST `/api/v2/authoring/delete.aeds` | ArticleCommand (32771) → EmptySuccess (240) |
| POST `/api/v2/authoring/canvas/{create,link/preview,link/confirm}.aeds` | 私有 Canvas 创建、预览与确认 (32773–32778) |
| POST `/api/v2/authoring/properties/{definition,workspace,text}.aeds` | 私有文本属性定义、编辑上下文及文本值 (32779–32783) |

扩展类型使用新的高位编号。UUID 是标准文本顺序的 16 字节。文本字段使用紧邻在前的有符号 LE int32 字节数与严格 UTF-8。代次、修订采用 int64，浏览器以 `bigint` 处理。布尔值使用字节 0 或 1。ApiError (251) 保留 584 字节 POD，输出代码、分类、状态、消息、详情和 trace ID；EmptySuccess 保留四字节 POD。HTTP 状态必须与错误 POD 一致。

#1764 和 #1766 的当前格式准入排除 56/76 字节列表记录、cursor v1、ARD3 和 ARD4。公开 HTTP 搜索保留 FAS4。浏览器本地搜索读取独立的 FSPK/FHS2 v4 分片，由 Worker 对标题、摘要、分类、标签和正文的倒排索引评分、分页，以 FSR4 结果交给 Vue。分片不附带正文原文。当前实现支持 ASCII 词和 CJK 单字搜索，使用简化 BM25 评分。字典分词、词组位置、增量 patch 与搜索专用 Wasm 引擎尚未复刻。

两种静态索引逐页绑定首页的公开代次和总页数。浏览器 Worker 检查发布坐标、分页和重复文章，并在页数或字节超出预算时停止。正文搜索分片按单页 8 MiB、总量 64 MiB、最多 128 页准入。浏览器不缓存搜索分片，取消时终止 Worker。加载、评分和解析完成后，主线程用 HEAD 复核同一代次，再显示结果。已送达客户端的旧公开结果无法远程擦除，重新搜索会重新读取并复核。

首页和归档列表签发 15 分钟有效的加密游标。第 1 页不传游标，第 2 页起使用上一页的 `nextCursor`。游标绑定当前公开代次、路由作用域、页码、页大小、关键词、排序和最后一篇文章的发布坐标。服务重启或公开代次变化后，旧游标返回 `400 article_cursor_invalid`。

列表 `latest` 根据创建时间和文章 ID 倒序，有关键词时默认采用 `relevance`，依次按标题等于、以…开头、包含和仅摘要包含匹配。关键词按字面匹配，保留大小写，避免 v1 SQL LIKE 的通配符扩展。排序 `hot` 有效输入会返回 `503 article_hot_unavailable`，等待真实的文章浏览量投影。列表首屏的常用页大小通过预编码响应提供。

登录扩展使用一次性运维票据。Passkey、Recovery、MFA、风险决策和 PoW 仍按产品台账追踪。其余固定提交声明的业务帧和路由未通过本阶段验收。

运行 `FSUS_DOTNET=/path/to/dotnet tools/protocol-test.sh`。测试对比 C#、TypeScript 和独立固定向量，使用本机 C++ 验证标头，并使用可离线构建的 wasm32 模块，在 Node 的 WebAssembly 引擎验证标头与 CRC。模块源于同一 C++ 帧验证代码，通过本地 Clang 和 wasm-ld 构建。网页的本地搜索 Worker 使用 TypeScript 读取 FSPK 并输出 FSR4，通用 AEDS Wasm 模块的网页接入和业务载荷解码仍待验收。

ApiError 和历史文章向量来自固定提交的 `tests/fixtures/protocol/`。新命令和当前公开 ArticleDetail、ArticleList、ArticleSearch 向量按相应字节布局由 Python 标准库 struct 和逐位 CRC 独立组装，再核对编码字节和解码结果。详情保留规范要求的空权限记录，权限快照、分类和标签接入属于后续交付范围。

FSPK 和 FSR4 向量按固定提交的 [分片和包 writer](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.ArtifactCodec.cs#L565) 与 [搜索结果 writer](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L567) 用 Python 标准库 struct 独立组装。固定数据包含只存在于正文的 `needle`、CJK 标签和大于 JavaScript 安全整数的发布坐标。

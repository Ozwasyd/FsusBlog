# 搜索分片补丁离线验收

`tools/fspt-patch.py` 读取固定 v1 生产格式 FSPT v3 及可选的 FHS2 v4 小分片。输入可带旧完整分片、目标完整分片和独立提供的摘要。同角色补丁仅比较文档 ID 与各词 posting 的成员关系。工具未接入公开端点、Worker 或发行版运行时。

```sh
python3 tools/fspt-patch.py change.patch --role recent \
  --base previous.bin --base-sha256 "$base_digest" \
  --patch-sha256 "$patch_digest" --target current.bin
python3 -B tests/Protocol/fspt-patch.test.py -v
```

固定来源为 v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12`。以下范围仅使用源码和独立构造字节，未运行 v1 产品。

| 层 | 固定生产格式与行为 |
| --- | --- |
| FSPT v3 | 24B 小端头依次为 `FSPT`、版本 3、tombstone 数量、tombstone 字节数、小分片字节数、保留零。tombstone 是升序文章 ID 的无符号 base-128 差值。末尾附原始 FHS2 v4 字节，可为空。文件内没有角色、基代、摘要或自身压缩层。 [写入器](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexDeltaCodec.cs#L10-L55) |
| FHS2 v4 | 72B 头，角色 0/1/2 对应 core/recent/archive。位置依次指向 24B term、76B document、16B 分类及标签、2B 标签引用、UTF-8 字符串和 posting，段落按 8B 对齐。每个 posting 有 ID 差值、三个词频字节和位置序列。位置的差值、长度和字段均为 varint。同位置可记录不同字段或长度。body-only 的最简 document 可在空分类表中携带分类索引 0。 [写入器](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.ArtifactCodec.cs#L565-L755) · [角色与最简文档](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.Models.cs#L252-L285) |
| 归属及发布 | FSPK v4 的 entry 可提供 kind/role/offset/size。单文件发布用 FSIM 二进制 v1、索引 schema 4，按角色记录 full URL/SHA-256 和可选 patch URL/SHA-256。补丁名仅含上一完整分片摘要前 16 位及目标整组 full generation。发布先落资产再换清单。生成器用更新与删除 ID 的并集作 tombstone，同时从目标角色复制仍存在的变更项。补丁文档、tombstone、字节最多分别为目标角色的 20%、15%、25%。旧文件检查只确认路径范围和存在性。 [生产与发布](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.cs#L491-L616) · [清单](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.ArtifactCodec.cs#L52-L76) · [阈值](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.ArtifactCodec.cs#L497-L527) |
| 读取 | Wasm 每角色保留一个补丁覆盖层，完整角色更新取代旧资料。tombstone 抑制同角色旧 posting，新增或替换的 posting 从小分片进入查询。旧解析器没有核对基代摘要、保留位和段落精确消费。固定浏览器虽解码清单的补丁字段，实际只请求 `fullUrl`。 [Wasm 叠加](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L970-L1108) · [Wasm 查询](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L1385-L1464) · [浏览器读取](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/services/localSearch.ts#L320-L414) |

离线检查拒绝越界、尾字节、非零保留值、重复或溢出的 ID、非最短 varint、错误角色及坏的内层引用。旧 writer 单元测试中的小分片是 FHS2 v3 假载荷，且可包含不在 tombstone 中的新文档。独立测试用生产 FHS2 v4 重现后一边界，正常解码并输出 `appendedWithoutTombstone`。这类字节单凭补丁不能证明由生产发布者生成。若同 ID 的更新漏写 tombstone，目标比对会暴露未被屏蔽的旧 posting。 [旧 writer 测试](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tests/backend/Unit/SearchIndexDeltaCodecTests.cs#L13-L40) · [独立向量](../../tests/Protocol/fspt-patch.test.py)

目标成员一致仍可能有排名差异。小分片复制目标角色的 IDF 和平均文档长度，未被替换的 base posting 继续沿用旧数值。进入或退出 recent/archive 边界也需真实验证两个角色。工具的 `rankingChecked` 始终为 `false`。 [变更项统计](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/SearchIndexService.cs#L706-L767) · [Wasm 每角色评分](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L1472-L1507)

## 固定搜索入口与后续验收

固定公开 Filter 页面通过生成式 ArticleList 路由使用 FSPA，保留 `keyword`、`sort` 和 query-bound cursor。独立 HTTP `/api/binary/article/search/query.aeds` 接受 `q` 并发送 FAS4。独立本地 `searchIndex` 服务才用 Wasm 选择 FSR4 页成员，再以 TypeScript 重排本页。冻结调用图未发现公开页面调用本地服务。 [Filter 调用](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/composables/useFilterView.ts#L428-L475) · [ArticleList](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/api/article.ts#L304-L366) · [FAS4 入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs#L121-L153) · [本地服务](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/services/localSearch.ts#L1004-L1032)

原 Wasm `search_articles` 接受 UTF-8、排序模式、页号和页大小，无分类、标签过滤或游标输入。它合计每载入角色的 BM25，按 title/meta/body 2.5/0.9/1 权重，位置证据去重。热度用 `(12 × comments + 0.15 × views) × exp(-age / 45d)`，相关性叠加 0.35 倍热度和同字段邻接短语。查询 hash 在短语匹配前升序去重。排序的最后比较项为 ID 升序。默认先比较最终分数、热度、发布时间，最新模式先比较发布时间，热门模式先比较热度。后续 TypeScript 页内重排按分数、日期、ID 降序。v2 增加共享词典、原输入词序和重复词，并且当前本地 Worker 不消费 v1 的公开浏览量/评论热度数据。 [排序键](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L632-L672) · [查询词](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L389-L439) · [评分与页 ABI](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/src/search_index.cpp#L1338-L1538) · [页内重排](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/services/searchRanking.ts#L250-L375) · [v2 Worker](../../src/Contracts/local-search.ts#L593)

1. 先用独立 FSPK ASCII 向量记录三种模式各页 FSR4 的总数、成员、顺序和发布坐标，单列 BM25、热度、同分 ID、空查询和深页。原 Emscripten `FsusSearchRuntime` 是可独立验证的目标。页内重排和现有 v2 词典语义分别验收。 [固定构建入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/wasm/search/CMakeLists.txt#L1-L50)
2. 若后续加入 v2 在线补丁，先在已有当前代次校验和强 ETag 路径后验证完整 base/target 摘要、角色、预算与实际发布坐标。验证目标 membership、排序统计和整代查询一致后才允许显示。损坏或统计漂移时回到已验证的当前完整页。并发测试应覆盖 same-ID 替换、撤回、角色移动、请求取消、错代和回退。浏览器 Worker 不以过时补丁恢复已撤回结果。 [当前代次验证](../../src/Contracts/local-search.ts#L580) · [现有浏览器撤回与重用](../../tests/EndToEnd/search-worker-reuse-flow.mjs#L89)

## 议题对应

| 条款 | 当前验收边界 |
| --- | --- |
| `V2-006`、`R-1724-R1`、`R-2174-R1`、`R-2175-R1` | 正式发布 writer/outbox 的 revision、publication、权利、代次与字节闭环。撤回、计划时间和重试之前后使用实际 PostgreSQL 与浏览器。#2175 评论 `6000289977` 明确拒绝从 latest 倒推。 [真实投影链](https://github.com/Ozwasyd/FsusBlog/issues/2175#issuecomment-6000289977) · [正式生命周期](https://github.com/Ozwasyd/FsusBlog/issues/2174) |
| `R-1765-R1`、`R-1773-R1`、C1 | FAS4 HTTP 和 FSR4 本地各自验证当前 wire、坐标、拒绝样本、解码分配及 Worker 包预算。实际新资源须使用生成式操作和受限路径参数。#1765 正文 L7 明确不改变排名、分词与索引生成。 [#1765](https://github.com/Ozwasyd/FsusBlog/issues/1765) · [#1773](https://github.com/Ozwasyd/FsusBlog/issues/1773) · [C1](../issues/conflicts.md) |
| `R-1728-R1`、`R-2508-01`、`R-2510-01`、`R-2511-01` | 独立生成 CJK、大小写、重音、混合脚本、长词、标点、must/not-match 和长度边界。实际消费者须绑定来源与摘要。作者全文的 source-range 合同另由 #2316 跟踪。 [内容样本拆分](https://github.com/Ozwasyd/FsusBlog/issues/1728#issuecomment-5174835861) |
| `R-1640-R1`、`R-2555-01`、`R-2556-01`、`R-2563-01` | 真实查询使用预先独立生成的排序、分页和正负成员预期。#2556 在台账保留为测试经验；规模夹具既有验收不能代替在线 FSPT 或 Wasm 对照。 [查询规模](https://github.com/Ozwasyd/FsusBlog/issues/1640) · [独立预期](https://github.com/Ozwasyd/FsusBlog/issues/2556) · [最终验证](https://github.com/Ozwasyd/FsusBlog/issues/2563) |
| `R-3456-01`、`R-3554-01` | 公开热读仍遵循已有 artifact 路径、容量和失效边界。#3554 单列真实入口验证经验。两条均未指定 FSPT 或排名算法。 [#3456](https://github.com/Ozwasyd/FsusBlog/issues/3456) · [#3554](https://github.com/Ozwasyd/FsusBlog/issues/3554) |

冻结正文与评论未发现独立规定 FSPT 格式或原 Wasm 排名的开放议题。二者按实际固定源码追踪。这次 9 项 Python 测试通过，包括 27 个畸形子样本。原 Wasm、真实补丁传输以及全量排名等价仍是独立证据缺口。 [公开搜索需求台账](../issues/risk-public-search.md)

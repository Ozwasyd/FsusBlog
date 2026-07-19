# 评论树查询计划与基准证据

> 2026-07-19；对应 issue #1201。该证据只使用本机临时 PostgreSQL 16 容器，不连接生产数据库。

## 结论

评论树继续使用已有的 adjacency list（`parent_id`、`root_id`、`depth`）和 PostgreSQL recursive CTE。路径读取按主键逐级回溯；根节点、直接子节点和同级窗口都使用现有 `(article_id, parent_id, id)` 索引。没有为了 #1201 新增 closure table、物化路径列或写放大索引。

节点的 `childCount` 必须批量计算。最初的逐节点相关子查询在 1,001,001 行数据上产生 101 次全表扫描，耗时约 12.9 秒；实现因此改成“先取当前 cursor 窗口，再用同一个 `visible_chain` 批量按 `parent_id` 聚合”，禁止 N+1 count。

## 可复现数据集

脚本：`tools/performance/comment-tree-benchmark.sql`

- PostgreSQL 16 Alpine，本机缓存镜像；`jit=off`，`work_mem=64MB`。
- 宽树：5,000 个根节点，每个根 199 个直接子节点，共 1,000,000 行。
- 深树：单独文章中的 1,001 层链，用于验证递归路径的最坏形状。
- 两个既有索引等价物：`(article_id, parent_id, id)`、`(article_id, root_id, id)`。
- 每条查询使用 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`；数据表在脚本结束时删除。

## 测量结果

| 查询 | 返回规模 | Execution Time | 主要计划 | 临时块 |
| --- | ---: | ---: | --- | ---: |
| 根评论 keyset cursor | 51 | 2.520 ms | `idx_comment_tree_article_parent_id` Index Scan + top-N | 0 |
| 直接子节点 cursor + 批量 child count | 101 | 1.171 ms | parent index page + batched count join | 0 |
| 1,001 层祖先路径 | 1,001 | 3.271 ms | Recursive Union + primary-key Index Scan | 0 |
| 永久链接同级窗口 | 11 | 0.144 ms | parent index forward/backward scans + Merge Append | 0 |

以上是开发机单次、缓存已热的查询计划证据，不替代 #1202 的生产等价 p50/p95/p99 门禁。#1201 的门禁关注计划形状：禁止 cursor `OFFSET`、禁止逐节点 count、祖先每层必须走主键、同级窗口必须走 parent keyset index。

## 风险与回退

- `CommentThreads:RecursiveReadsEnabled=false` 会通过 reloadable configuration 立即关闭 roots/children/permalink 递归读取，统一返回 AEDS `ApiError` 503；不需要重启。
- `CommentThreads:MaxDepth` 默认 32，范围 2–256；`CommentThreads:MaxChildrenPerNode` 默认 500，范围 1–10,000。下调后只限制新写入，不破坏已有祖先链。
- 每个父节点的直接回复额度在事务内使用 PostgreSQL advisory transaction lock 串行检查；删除、隐藏或拒绝不返还槽位，避免并发绕过。
- 永久链接递归 CTE 记录已访问 ID、拒绝环路并在 257 个节点停止；服务端随后校验 root/parent/depth 连续性，损坏链统一降级为 `unavailable`。
- 旧的 thread-wide 扁平 reply 端点暂留给滚动发布兼容，但新前端不调用；关闭 recursive reads 后公共文章正文仍可用。
